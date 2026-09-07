import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { COMMAND_PAYLOAD_SCHEMAS, CommandEnvelope, ImportWordPressAssetPayload, CreateNewsPayload, CreateTaxonomyTermPayload, CreateTimedContentPayload, UpdateContentPayload, ArchiveContentPayload, RollbackContentPayload, ScheduleContentPayload, AttachAssetPayload, ReplaceAssetPayload, UpdateSeoPayload, type ReplaceAssetCommand } from './command-schema';
import { slugify, uuid } from './util';
import { CommandError } from './core/errors';
import { resolvePermalink, resolveSeo, resolveTemplate, validateTaxonomyTerms } from './core/resolvers';
import { ingestAsset, compensateUnassociatedAsset } from './core/assets';
import { fetchGoogleDriveAsset, refreshGoogleDriveAccessToken } from './adapters/assets/google-drive';
import { getServiceAccountAccessToken } from './adapters/assets/google-service-account';
import { ingestWordPressAsset } from './adapters/assets/wordpress';
import { fetchGeneratedArtifact, createGeneratedArtifactFetcher, type GeneratedArtifactFetcher } from './adapters/assets/generated-artifact';
import { executePageCommand } from './page-composition/mutations';
import { executeProductCommand } from './product/mutations';
import { commandDigest } from './control-plane/digest';
import { evaluateClaim, evaluateExistingJob } from './control-plane/replay';
import { claimCommand, readJob, reopenFailedJob, reclaimExpiredLease, recordFailure, fencedBatch, successStatement, guardedSuccessStatement, assertOwnedRowAffected, type CommandExecution } from './control-plane/job-store';
import { SITE_ID, SiteIdentityMismatch, assertCommandTargetsThisSite } from './site-identity';
import { contractVersion } from './control-plane/contracts';
import { RULE_VERSION } from './rule-version';


type ContentRow = { id:string; content_type:'news'|'article'; slug:string; title:string; excerpt:string|null; blocks_json:string; status:string; published_at:string|null; starts_at:string|null; ends_at:string|null; seo_title:string|null; seo_description:string|null; version:number; };
export type TrustedAuthorization = { actor:string; scopes:string[] };
type CommandRuntime = { trustedAuthorization?: TrustedAuthorization; googleDriveAccessToken?: string; googleDriveFetchImpl?: Parameters<typeof fetchGoogleDriveAsset>[1]['fetchImpl']; generatedArtifactFetcher?: GeneratedArtifactFetcher };

export function trustedCommandRuntime(defaultActor = 'github-actions'): CommandRuntime {
  const configured = (env as typeof env & { COMMAND_TRUSTED_SCOPES?: string; COMMAND_TRUSTED_ACTOR?: string });
  const scopes = (configured.COMMAND_TRUSTED_SCOPES || '').split(',').map((value) => value.trim()).filter(Boolean);
  return { trustedAuthorization: { actor: configured.COMMAND_TRUSTED_ACTOR || defaultActor, scopes } };
}

function authorize(runtime:CommandRuntime, scope:string) {
  const authorization = runtime.trustedAuthorization;
  if (!authorization || (!authorization.scopes.includes(scope) && !authorization.scopes.includes('*'))) throw new CommandError('USER_CONFIRMATION_REQUIRED','COMMAND_AUTHORIZATION_REQUIRED',`Authorization scope is required: ${scope}`);
  return authorization.actor;
}

type MutationCommand = 'create_news'|'create_taxonomy_term'|'create_timed_content'|'import_wordpress_asset'|'update_content'|'archive_content'|'rollback_content'|'schedule_content'|'attach_asset'|'replace_asset'|'update_seo'|'create_product'|'update_product'|'publish_product'|'archive_product'|'replace_product_asset'|'attach_product_asset'|'remove_product_asset'|'reorder_product_assets'|'rollback_product'|'create_page'|'update_page'|'insert_page_section'|'update_page_section'|'remove_page_section'|'reorder_page_sections'|'replace_page_section_asset'|'rollback_page'|'insert_page_section_item'|'update_page_section_item'|'remove_page_section_item'|'reorder_page_section_items'|'replace_page_section_item_asset';
export const MUTATION_SCOPES: Record<MutationCommand, string | string[]> = {
  create_news: 'content:write',
  create_taxonomy_term: 'taxonomy:write',
  create_timed_content: 'content:write',
  import_wordpress_asset: 'asset:write',
  update_content: 'content:write',
  archive_content: 'content:archive',
  rollback_content: 'content:rollback',
  schedule_content: 'content:write',
  attach_asset: 'asset:write',
  replace_asset: 'asset:write',
  update_seo: 'content:write',
  create_product: 'product:create',
  update_product: 'product:update',
  publish_product: 'product:update',
  archive_product: 'product:archive',
  replace_product_asset: 'product:asset',
  attach_product_asset: 'product:asset',
  remove_product_asset: 'product:asset',
  reorder_product_assets: 'product:asset',
  rollback_product: 'product:rollback',
  create_page: 'page:write',
  update_page: 'page:write',
  insert_page_section: 'page:structure',
  update_page_section: 'page:write',
  remove_page_section: 'page:structure',
  reorder_page_sections: 'page:structure',
  replace_page_section_asset: ['page:write', 'asset:write'],
  rollback_page: 'page:rollback',
  insert_page_section_item: 'page:item:write',
  update_page_section_item: 'page:item:write',
  remove_page_section_item: 'page:item:write',
  reorder_page_section_items: 'page:item:write',
  replace_page_section_item_asset: ['page:item:write', 'asset:write']
};

function authorizeMutation(runtime: CommandRuntime, command: MutationCommand) {
  const scopes = MUTATION_SCOPES[command];
  for (const scope of Array.isArray(scopes) ? scopes : [scopes]) authorize(runtime, scope);
}

async function getContent(contentType:string, contentId:string) {
  const row = await env.DB.prepare(`SELECT id,content_type,slug,title,excerpt,blocks_json,status,published_at,starts_at,ends_at,seo_title,seo_description,version FROM news WHERE id=? AND content_type=? LIMIT 1`).bind(contentId,contentType).first<ContentRow>();
  if (!row) throw new CommandError('USER_CORRECTABLE','CONTENT_NOT_FOUND','Content was not found.');
  return row;
}

function checkVersion(row:ContentRow, expected:number) {
  if (row.version !== expected) throw new CommandError('CONFLICT','CONTENT_VERSION_CONFLICT','Content version does not match expectedVersion.',false,{expectedVersion:expected,currentVersion:row.version});
}

function snapshot(row:ContentRow) { return { ...row, blocks: JSON.parse(row.blocks_json || '[]') }; }

async function fullSnapshot(row:ContentRow) {
  const [terms, assets] = await Promise.all([
    env.DB.prepare(`SELECT term_id FROM content_term_links WHERE content_type=? AND content_id=? ORDER BY term_id`).bind(row.content_type,row.id).all<{term_id:string}>(),
    env.DB.prepare(`SELECT asset_id,role,position FROM content_assets WHERE content_type=? AND content_id=? ORDER BY role,position`).bind(row.content_type,row.id).all<{asset_id:string;role:string;position:number}>()
  ]);
  return { ...snapshot(row), taxonomyTermIds:(terms.results || []).map((term: { term_id:string }) => term.term_id), assetAssociations:assets.results || [] };
}

// Content search is a derived projection. Keep it in the same transaction as
// the source mutation so a News/Article change cannot leave a stale card.
function contentSearchProjection(contentId:string, contentType:ContentRow['content_type'], now:string) {
  return env.DB.prepare(`
    INSERT INTO search_documents
      (id,content_type,content_id,title,description,url,thumbnail,category,keywords_json,updated_at)
    SELECT
      lower(n.content_type || ':' || n.id),
      n.content_type,
      n.id,
      n.title,
      n.excerpt,
      CASE WHEN n.content_type='article' THEN '/column/' || n.slug || '/' ELSE '/news/' || n.slug || '/' END,
      CASE WHEN a.r2_key IS NULL THEN NULL ELSE '/api/assets/' || replace(a.r2_key,'/','~') END,
      NULL,
      '[]',
      ?
    FROM news n
    LEFT JOIN content_assets ca
      ON ca.content_type=n.content_type AND ca.content_id=n.id AND ca.role='thumbnail' AND ca.position=0
    LEFT JOIN assets a ON a.id=ca.asset_id
    WHERE n.id=? AND n.content_type=?
    ON CONFLICT(content_type,content_id) DO UPDATE SET
      title=excluded.title,
      description=excluded.description,
      url=excluded.url,
      thumbnail=excluded.thumbnail,
      updated_at=excluded.updated_at
  `).bind(now, contentId, contentType);
}

async function commitContentMutation(execution:CommandExecution, row:ContentRow, expectedVersion:number, action:string, updates:string, binds:unknown[], after:Record<string,unknown>, extraStatements:unknown[] = [], before:Record<string,unknown> = snapshot(row)) {
  const nextVersion = expectedVersion + 1;
  const now = new Date().toISOString();
  const setClause = updates ? `${updates}, version=?, updated_at=?` : 'version=?, updated_at=?';
  const update = env.DB.prepare(`UPDATE news SET ${setClause} WHERE id=? AND content_type=? AND version=?`).bind(...binds, nextVersion, now, row.id, row.content_type, expectedVersion);
  const revision = env.DB.prepare(`INSERT INTO content_revisions (id,content_type,content_id,action,before_json,after_json,command_id,created_at) SELECT ?,?,?,?,?,?,?,? FROM news WHERE id=? AND content_type=? AND version=?`).bind(uuid(),row.content_type,row.id,action,JSON.stringify(before),JSON.stringify(after),execution.commandId,now,row.id,row.content_type,nextVersion);
  const result = { contentType:row.content_type, contentId:row.id, version:nextVersion, action };
  const job = guardedSuccessStatement(execution, result, { table: 'news', id: row.id, contentType: row.content_type, version: nextVersion }, now);
  const batch = await fencedBatch(execution, [update,...extraStatements,contentSearchProjection(row.id,row.content_type,now),revision,job] as never[]);
  // batch[0] is the lease fence; the guarded UPDATE is next. Its affected-row
  // count is what proves the version guard held.
  const changes = (batch[1] as { meta?: { changes?: number } })?.meta?.changes;
  if (changes !== 1) throw new CommandError('CONFLICT','CONTENT_VERSION_CONFLICT','Content changed during the command.',false,{expectedVersion,currentVersion:row.version});
  assertOwnedRowAffected(execution, batch[batch.length - 1]);
  return result;
}

async function resolveReferenceAsset(reference: ReplaceAssetCommand['reference'], runtime:CommandRuntime, execution:CommandExecution, role:string) {
  if (!reference) throw new CommandError('USER_CORRECTABLE','ASSET_REFERENCE_REQUIRED','Asset reference is required.');
  if (reference.provider === 'google_drive') {
    const configured = env as typeof env & { GOOGLE_DRIVE_ACCESS_TOKEN?: string; GOOGLE_DRIVE_REFRESH_TOKEN?: string; GOOGLE_DRIVE_CLIENT_ID?: string; GOOGLE_DRIVE_CLIENT_SECRET?: string; GOOGLE_DRIVE_SA_CLIENT_EMAIL?: string; GOOGLE_DRIVE_SA_PRIVATE_KEY?: string };
    // Precedence is append-only: the service account is reached only when no
    // OAuth user credential is configured, so removing the refresh token is
    // what performs the cutover, and restoring it is what reverts.
    const token = runtime.googleDriveAccessToken || configured.GOOGLE_DRIVE_ACCESS_TOKEN
      || (configured.GOOGLE_DRIVE_REFRESH_TOKEN && configured.GOOGLE_DRIVE_CLIENT_ID && configured.GOOGLE_DRIVE_CLIENT_SECRET ? await refreshGoogleDriveAccessToken({ refreshToken: configured.GOOGLE_DRIVE_REFRESH_TOKEN, clientId: configured.GOOGLE_DRIVE_CLIENT_ID, clientSecret: configured.GOOGLE_DRIVE_CLIENT_SECRET }) : undefined)
      || (configured.GOOGLE_DRIVE_SA_CLIENT_EMAIL && configured.GOOGLE_DRIVE_SA_PRIVATE_KEY ? await getServiceAccountAccessToken({ clientEmail: configured.GOOGLE_DRIVE_SA_CLIENT_EMAIL, privateKey: configured.GOOGLE_DRIVE_SA_PRIVATE_KEY }) : undefined);
    if (!token) throw new CommandError('USER_CONFIRMATION_REQUIRED','DRIVE_ACCESS_TOKEN_REQUIRED','Google Drive access is not provisioned for this runtime.');
    const fetched = await fetchGoogleDriveAsset({ provider:'google_drive', fileId:reference.providerAssetId, expectedSha256:reference.expectedChecksum }, { accessToken:token, fetchImpl:runtime.googleDriveFetchImpl });
    return ingestAsset({ ...fetched.descriptor, variant:'original', alt:reference.alt, sourceMetadata:{ ...fetched.descriptor.sourceMetadata, ...reference.metadata, intendedRole:role } }, fetched.bytes, execution);
  }
  const generatedArtifactFetcher = runtime.generatedArtifactFetcher || (() => {
    const origin=(env as typeof env & { GENERATED_ARTIFACT_ORIGIN?: string }).GENERATED_ARTIFACT_ORIGIN;
    const token=(env as typeof env & { GENERATED_ARTIFACT_TOKEN?: string }).GENERATED_ARTIFACT_TOKEN;
    return origin && token ? createGeneratedArtifactFetcher({ origin, token }) : undefined;
  })();
  if (!generatedArtifactFetcher) throw new CommandError('USER_CONFIRMATION_REQUIRED','GENERATED_ARTIFACT_FETCHER_REQUIRED','Generated artifact transfer is not provisioned for this runtime.');
  const fetched = await fetchGeneratedArtifact({ provider:'generated', artifactId:reference.providerAssetId, expectedSha256:reference.expectedChecksum }, { fetchArtifact:generatedArtifactFetcher });
  return ingestAsset({ ...fetched.descriptor, variant:'original', alt:reference.alt, sourceMetadata:{ ...fetched.descriptor.sourceMetadata, ...reference.metadata, intendedRole:role } }, fetched.bytes, execution);
}

async function uniqueSlug(base:string, fallbackKey:string) {
  let slug=slugify(base, fallbackKey), n=1;
  while (await env.DB.prepare('SELECT 1 FROM news WHERE slug=? LIMIT 1').bind(slug).first()) slug=`${slugify(base)}-${++n}`;
  return slug;
}

async function resolveCreateSlug(explicitSlug:string|undefined, title:string, fallbackKey:string) {
  if (!explicitSlug) return uniqueSlug(title, fallbackKey);

  const existing = await env.DB
    .prepare('SELECT 1 FROM news WHERE slug=? LIMIT 1')
    .bind(explicitSlug)
    .first();

  if (existing) {
    throw new CommandError(
      'USER_CORRECTABLE',
      'EXPLICIT_SLUG_CONFLICT',
      `The requested slug already exists: ${explicitSlug}`
    );
  }

  return explicitSlug;
}

async function canonicalTaxonomyTermId(taxonomy:'category'|'tag', slug:string) {
  const bytes = new TextEncoder().encode(`${taxonomy}:${slug}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `term_${hex}`;
}

function assertRuleVersion(version:string){
  if(version!==RULE_VERSION) throw new CommandError('CONFLICT','RULE_VERSION_CONFLICT',`Command rule version ${version} does not match runtime ${RULE_VERSION}`);
}

const PREFLIGHT_REQUIRED_COMMANDS = new Set<MutationCommand>([
  'import_wordpress_asset'
]);

async function verifyPreflightBinding(command: z.infer<typeof CommandEnvelope>) {
  const receipt = command.context.preflight;

  if (
    PREFLIGHT_REQUIRED_COMMANDS.has(command.command) &&
    !receipt
  ) {
    throw new CommandError(
      'USER_CONFIRMATION_REQUIRED',
      'COMMAND_PREFLIGHT_REQUIRED',
      `Preflight is required before executing ${command.command}.`
    );
  }

  if (!receipt) return;
  const currentContractVersion = contractVersion();
  if (receipt.contractVersion !== currentContractVersion) throw new CommandError('CONFLICT', 'COMMAND_CONTRACT_DRIFT', 'The preflight contract is no longer current.', false, { expectedContractVersion: receipt.contractVersion, currentContractVersion });
  const actualDigest = await commandDigest(command);
  if (actualDigest !== receipt.commandDigest) throw new CommandError('CONFLICT', 'COMMAND_DIGEST_MISMATCH', 'The queued command differs from the command that passed preflight.', false, { expectedDigest: receipt.commandDigest, actualDigest });
}

export async function executeCommand(input:unknown, runtime:CommandRuntime = {}) {
  // Fixed pipeline, in this order and for these reasons:
  //
  //   envelope -> authorization -> site identity -> digest
  //     -> read-only idempotency check
  //     -> admission (rule version, preflight binding, payload schema)
  //     -> atomic transition to running
  //     -> handler, with every later failure recorded as terminal
  //
  // Nothing before the transition writes to `jobs`. An admission check that
  // refuses a command must not leave a `running` row behind, because that row
  // would make every later retry of that immutable command fail as
  // COMMAND_IN_PROGRESS forever.
  const cmd = CommandEnvelope.parse(input);

  // Authorization first: a caller without the scope is refused whether or not
  // the command already ran.
  authorizeMutation(runtime, cmd.command);

  // This installation's identity, before idempotency resolution and before any
  // mutation, so a command addressed to another site is refused however it
  // arrived and a replay cannot slip past it.
  try {
    assertCommandTargetsThisSite(cmd.context.targetSite);
  } catch (error) {
    if (error instanceof SiteIdentityMismatch) {
      throw new CommandError('CONFLICT','COMMAND_TARGET_SITE_MISMATCH',error.message,false,{ targetSite: cmd.context.targetSite ?? null, installation: SITE_ID });
    }
    throw error;
  }

  // The digest of the complete immutable command, with the preflight receipt
  // excluded -- the same canonicalization the preflight receipt attests.
  const digest = await commandDigest(cmd);

  // Read-only. A completed command is answered from its recorded result: after
  // the first success the state has moved on, so a re-sent command's
  // expectedVersion is legitimately stale and its preflight receipt legitimately
  // spent, and requiring it to re-pass admission would strand a dispatch whose
  // response was merely lost.
  const existing = evaluateExistingJob(cmd.commandId, cmd.command, digest, await readJob(cmd.commandId));
  if (existing.kind === 'replay') {
    return { success:true, commandId:cmd.commandId, idempotent:true, result: existing.result };
  }

  // Admission. All non-mutating, all before anything is claimed.
  await verifyPreflightBinding(cmd);
  assertRuleVersion(cmd.context.ruleVersion);
  const payloadSchema = COMMAND_PAYLOAD_SCHEMAS[cmd.command as keyof typeof COMMAND_PAYLOAD_SCHEMAS];
  if (!payloadSchema) throw new CommandError('FATAL_SYSTEM_ERROR','COMMAND_NOT_IMPLEMENTED',`Command not implemented: ${cmd.command}`);
  payloadSchema.parse(cmd.payload);

  // Transition to running, atomically. Each branch returns the lease this
  // attempt holds; completion is refused unless it still holds it.
  //
  // The result is an immutable execution context carrying this attempt's own
  // lease. It is threaded explicitly from here through every handler and every
  // completion write: a token recovered by looking up a commandId would hand a
  // superseded attempt the lease of the attempt that replaced it.
  let execution: CommandExecution;
  if (existing.kind === 'proceed-after-failure') {
    execution = await reopenFailedJob(cmd.commandId, cmd.command, digest);
  } else if (existing.kind === 'reclaim-expired-lease') {
    // The previous attempt died without recording a terminal status. Only the
    // same command can take it over, and only while the lease is still expired.
    execution = await reclaimExpiredLease(cmd.commandId, cmd.command, digest);
  } else {
    const claim = await claimCommand(cmd.commandId, cmd.command, digest);
    // Another submission may have claimed the id between the read above and
    // this insert. The stored row decides, so a loser is refused rather than
    // executing alongside the winner.
    const outcome = evaluateClaim(cmd.commandId, cmd.command, digest, claim.stored, claim.claimId);
    if (outcome.kind === 'replay') return { success:true, commandId:cmd.commandId, idempotent:true, result: outcome.result };
    execution = outcome.kind === 'retry-after-failure'
      ? await reopenFailedJob(cmd.commandId, cmd.command, digest)
      : claim.execution;
  }

  // From here the job is `running`, so every exit must be terminal.
  try {
    if (cmd.command === 'create_taxonomy_term') {
      const p = CreateTaxonomyTermPayload.parse(cmd.payload);

      const taxonomyId =
        p.taxonomy === 'category'
          ? 'taxonomy_category'
          : 'taxonomy_tag';

      if (p.taxonomy === 'tag' && p.parentTermId) {
        throw new CommandError(
          'USER_CORRECTABLE',
          'TAXONOMY_PARENT_NOT_ALLOWED',
          'Tag terms cannot have a parent.'
        );
      }

      if (p.parentTermId) {
        const parent = await env.DB.prepare(
          `SELECT id,taxonomy_id
           FROM taxonomy_terms
           WHERE id=? AND status='published'
           LIMIT 1`
        ).bind(p.parentTermId).first<{
          id:string;
          taxonomy_id:string;
        }>();

        if (!parent) {
          throw new CommandError(
            'USER_CORRECTABLE',
            'TAXONOMY_PARENT_NOT_FOUND',
            'The requested parent taxonomy term does not exist.'
          );
        }

        if (parent.taxonomy_id !== taxonomyId) {
          throw new CommandError(
            'USER_CORRECTABLE',
            'TAXONOMY_PARENT_MISMATCH',
            'The parent term belongs to a different taxonomy.'
          );
        }
      }

      const existing = await env.DB.prepare(
        `SELECT id,name,parent_id,description,seo_title,seo_description
         FROM taxonomy_terms
         WHERE taxonomy_id=? AND slug=?
         LIMIT 1`
      ).bind(taxonomyId, p.slug).first<{
        id:string;
        name:string;
        parent_id:string|null;
        description:string|null;
        seo_title:string|null;
        seo_description:string|null;
      }>();

      const requested = {
        name: p.name,
        parentId: p.parentTermId ?? null,
        description: p.description ?? null,
        seoTitle: p.seoTitle ?? null,
        seoDescription: p.seoDescription ?? null
      };

      const now = new Date().toISOString();

      if (existing) {
        const compatible =
          existing.name === requested.name &&
          existing.parent_id === requested.parentId &&
          existing.description === requested.description &&
          existing.seo_title === requested.seoTitle &&
          existing.seo_description === requested.seoDescription;

        if (!compatible) {
          throw new CommandError(
            'CONFLICT',
            'TAXONOMY_TERM_CONFLICT',
            `A taxonomy term with slug "${p.slug}" already exists with different canonical data.`
          );
        }

        const result = {
          contentType: 'taxonomy_term',
          contentId: existing.id,
          termId: existing.id,
          taxonomy: p.taxonomy,
          slug: p.slug,
          reused: true
        };

        await successStatement(execution, result, now).run();

        return {
          success: true,
          commandId: cmd.commandId,
          result
        };
      }

      const termId = await canonicalTaxonomyTermId(
        p.taxonomy,
        p.slug
      );

      const result = {
        contentType: 'taxonomy_term',
        contentId: termId,
        termId,
        taxonomy: p.taxonomy,
        slug: p.slug,
        reused: false
      };

      const after = {
        id: termId,
        taxonomyId,
        taxonomy: p.taxonomy,
        name: p.name,
        slug: p.slug,
        parentTermId: p.parentTermId ?? null,
        description: p.description ?? null,
        seoTitle: p.seoTitle ?? null,
        seoDescription: p.seoDescription ?? null,
        status: 'published'
      };

      await fencedBatch(execution, [
        env.DB.prepare(
          `INSERT INTO taxonomy_terms
           (id,taxonomy_id,parent_id,name,slug,description,canonical_path,sort_order,seo_title,seo_description,status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          termId,
          taxonomyId,
          p.parentTermId ?? null,
          p.name,
          p.slug,
          p.description ?? null,
          null,
          0,
          p.seoTitle ?? null,
          p.seoDescription ?? null,
          'published'
        ),

        env.DB.prepare(
          `INSERT INTO content_revisions
           (id,content_type,content_id,action,before_json,after_json,command_id,created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        ).bind(
          uuid(),
          'taxonomy_term',
          termId,
          'create',
          null,
          JSON.stringify(after),
          cmd.commandId,
          now
        ),

        successStatement(execution, result, now),
      ]);

      return {
        success: true,
        commandId: cmd.commandId,
        result
      };
    }

    if (cmd.command === 'create_news') {
      const p=CreateNewsPayload.parse(cmd.payload);
      if (p.startsAt && p.endsAt && p.endsAt <= p.startsAt) throw new CommandError('USER_CORRECTABLE','INVALID_PUBLISH_WINDOW','endsAt must be after startsAt');
      const templateProfile=resolveTemplate(p.templateProfile);
      await validateTaxonomyTerms(p.categoryTermIds,p.tagTermIds);
      const id=uuid(), slug=await resolveCreateSlug(p.slug, p.title, cmd.commandId), now=new Date().toISOString();
      const publishedAt=p.publishedAt || p.startsAt || now;
      const status = p.startsAt && p.startsAt > now ? 'scheduled' : 'published';
      const url=resolvePermalink(p.contentType,slug);
      const seo=resolveSeo(p.title,p.excerpt,p.seoTitle,p.seoDescription);
      const result={contentType:p.contentType,contentId:id,status,url,templateProfile};
      const statements=[
        env.DB.prepare(`INSERT INTO news (id,slug,title,excerpt,blocks_json,content_type,status,published_at,starts_at,ends_at,seo_title,seo_description,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,slug,p.title,p.excerpt||null,JSON.stringify(p.blocks),p.contentType,status,publishedAt,p.startsAt||now,p.endsAt||null,seo.seoTitle,seo.seoDescription,1,now,now),
        contentSearchProjection(id,p.contentType,now),
        ...[...p.categoryTermIds,...p.tagTermIds].map(termId=>env.DB.prepare(`INSERT INTO content_term_links (content_type,content_id,term_id) VALUES (?,?,?)`).bind(p.contentType,id,termId)),
        env.DB.prepare(`INSERT INTO content_revisions (id,content_type,content_id,action,before_json,after_json,command_id,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(uuid(),p.contentType,id,'create',null,JSON.stringify({...p,id,slug,status,url,templateProfile,seo,taxonomyTermIds:[...p.categoryTermIds,...p.tagTermIds],assetAssociations:[]}),cmd.commandId,now),
        successStatement(execution, result, now)
      ];
      const batch = await fencedBatch(execution, statements);
      assertOwnedRowAffected(execution, batch[batch.length - 1]);
      return {success:true,commandId:cmd.commandId,result};
    }

    if (cmd.command === 'create_product' || cmd.command === 'update_product' || cmd.command === 'publish_product' || cmd.command === 'archive_product' || cmd.command === 'replace_product_asset' || cmd.command === 'attach_product_asset' || cmd.command === 'remove_product_asset' || cmd.command === 'reorder_product_assets' || cmd.command === 'rollback_product') {
      const result = await executeProductCommand(execution, cmd.payload, {
        resolveAssetReference: (reference: unknown, role: string) => resolveReferenceAsset(reference as ReplaceAssetCommand['reference'], runtime, execution, role)
      });
      return { success: true, commandId: cmd.commandId, result };
    }

    if (cmd.command === 'create_page' || cmd.command === 'update_page' || cmd.command === 'insert_page_section' || cmd.command === 'update_page_section' || cmd.command === 'remove_page_section' || cmd.command === 'reorder_page_sections' || cmd.command === 'replace_page_section_asset' || cmd.command === 'rollback_page' || cmd.command === 'insert_page_section_item' || cmd.command === 'update_page_section_item' || cmd.command === 'remove_page_section_item' || cmd.command === 'reorder_page_section_items' || cmd.command === 'replace_page_section_item_asset') {
      const result = await executePageCommand(execution, cmd.payload, {
        resolveAssetReference: (reference: unknown, role: string) => resolveReferenceAsset(reference as ReplaceAssetCommand['reference'], runtime, execution, role)
      });
      return { success: true, commandId: cmd.commandId, result };
    }

    if (cmd.command === 'update_content') {
      const p=UpdateContentPayload.parse(cmd.payload), row=await getContent(p.contentType,p.contentId), before=await fullSnapshot(row);
      checkVersion(row,p.expectedVersion);
      const fields:string[]=[]; const binds:unknown[]=[]; const changes=p.changes;
      if (changes.title !== undefined) { fields.push('title=?'); binds.push(changes.title); }
      if (changes.excerpt !== undefined) { fields.push('excerpt=?'); binds.push(changes.excerpt); }
      if (changes.blocks !== undefined) { fields.push('blocks_json=?'); binds.push(JSON.stringify(changes.blocks)); }
      const after={...before,...changes,blocks:changes.blocks ?? JSON.parse(row.blocks_json)};
      const result=await commitContentMutation(execution, row,p.expectedVersion,'update',fields.join(','),binds,after,[],before);
      return {success:true,commandId:cmd.commandId,result};
    }

    if (cmd.command === 'archive_content') {
      const p=ArchiveContentPayload.parse(cmd.payload), row=await getContent(p.contentType,p.contentId), before=await fullSnapshot(row);
      checkVersion(row,p.expectedVersion);
      const result=await commitContentMutation(execution, row,p.expectedVersion,'archive','status=?',['archived'],{...before,status:'archived'},[],before);
      return {success:true,commandId:cmd.commandId,result};
    }

    if (cmd.command === 'schedule_content') {
      const p=ScheduleContentPayload.parse(cmd.payload);
      if (p.endsAt && p.endsAt <= p.startsAt) throw new CommandError('USER_CORRECTABLE','INVALID_PUBLISH_WINDOW','endsAt must be after startsAt');
      const row=await getContent(p.contentType,p.contentId), before=await fullSnapshot(row); checkVersion(row,p.expectedVersion);
      const now=new Date().toISOString(), status=p.startsAt > now ? 'scheduled' : 'published';
      const result=await commitContentMutation(execution, row,p.expectedVersion,'schedule','starts_at=?,ends_at=?,published_at=?,status=?',[p.startsAt,p.endsAt ?? null,p.startsAt,status],{...before,starts_at:p.startsAt,ends_at:p.endsAt ?? null,published_at:p.startsAt,status},[],before);
      return {success:true,commandId:cmd.commandId,result};
    }

    if (cmd.command === 'update_seo') {
      const p=UpdateSeoPayload.parse(cmd.payload), row=await getContent(p.contentType,p.contentId), before=await fullSnapshot(row); checkVersion(row,p.expectedVersion);
      const result=await commitContentMutation(execution, row,p.expectedVersion,'update_seo','seo_title=?,seo_description=?',[p.seoTitle,p.seoDescription],{...before,seo_title:p.seoTitle,seo_description:p.seoDescription},[],before);
      return {success:true,commandId:cmd.commandId,result};
    }

    if (cmd.command === 'rollback_content') {
      const p=RollbackContentPayload.parse(cmd.payload), row=await getContent(p.contentType,p.contentId), before=await fullSnapshot(row); checkVersion(row,p.expectedVersion);
      const revision=await env.DB.prepare(`SELECT id,after_json FROM content_revisions WHERE id=? AND content_type=? AND content_id=? LIMIT 1`).bind(p.revisionId,p.contentType,p.contentId).first<{id:string;after_json:string|null}>();
      if (!revision?.after_json) throw new CommandError('USER_CORRECTABLE','REVISION_NOT_FOUND','The requested content revision was not found.');
      const restored=JSON.parse(revision.after_json) as Record<string,any>;
      const blocks=restored.blocks ?? (restored.blocks_json ? JSON.parse(restored.blocks_json) : null);
      if (typeof restored.title !== 'string' || !Array.isArray(blocks)) throw new CommandError('USER_CORRECTABLE','REVISION_INVALID','The requested revision cannot restore this content.');
      const taxonomyTermIds=Array.isArray(restored.taxonomyTermIds) ? restored.taxonomyTermIds.filter((value): value is string => typeof value === 'string') : [];
      const assetAssociations=Array.isArray(restored.assetAssociations) ? restored.assetAssociations.filter((value) => value && typeof value.asset_id === 'string' && typeof value.role === 'string' && Number.isInteger(value.position)) : [];
      const termRows=taxonomyTermIds.length ? await env.DB.prepare(`SELECT id FROM taxonomy_terms WHERE id IN (${taxonomyTermIds.map(()=>'?').join(',')})`).bind(...taxonomyTermIds).all<{id:string}>() : { results:[] };
      if ((termRows.results || []).length !== taxonomyTermIds.length) throw new CommandError('USER_CORRECTABLE','REVISION_TAXONOMY_MISSING','A taxonomy term from the requested revision is no longer available.');
      if (assetAssociations.length) {
        const assetIds=[...new Set(assetAssociations.map((value) => value.asset_id))];
        const assetRows=await env.DB.prepare(`SELECT id FROM assets WHERE id IN (${assetIds.map(()=>'?').join(',')})`).bind(...assetIds).all<{id:string}>();
        if ((assetRows.results || []).length !== assetIds.length) throw new CommandError('USER_CORRECTABLE','REVISION_ASSET_MISSING','An asset from the requested revision is no longer available.');
      }
      const nextVersion=p.expectedVersion+1;
      const relationStatements=[
        env.DB.prepare(`DELETE FROM content_term_links WHERE content_type=? AND content_id=? AND EXISTS (SELECT 1 FROM news WHERE id=? AND content_type=? AND version=?)`).bind(p.contentType,p.contentId,p.contentId,p.contentType,nextVersion),
        ...taxonomyTermIds.map((termId) => env.DB.prepare(`INSERT INTO content_term_links (content_type,content_id,term_id) SELECT ?,?,? FROM news WHERE id=? AND content_type=? AND version=?`).bind(p.contentType,p.contentId,termId,p.contentId,p.contentType,nextVersion)),
        env.DB.prepare(`DELETE FROM content_assets WHERE content_type=? AND content_id=? AND EXISTS (SELECT 1 FROM news WHERE id=? AND content_type=? AND version=?)`).bind(p.contentType,p.contentId,p.contentId,p.contentType,nextVersion),
        ...assetAssociations.map((value) => env.DB.prepare(`INSERT INTO content_assets (content_type,content_id,asset_id,role,position,created_at) SELECT ?,?,?,?,?,? FROM news WHERE id=? AND content_type=? AND version=?`).bind(p.contentType,p.contentId,value.asset_id,value.role,value.position,new Date().toISOString(),p.contentId,p.contentType,nextVersion))
      ];
      const result=await commitContentMutation(execution, row,p.expectedVersion,'rollback','title=?,excerpt=?,blocks_json=?,status=?,published_at=?,starts_at=?,ends_at=?,seo_title=?,seo_description=?',[restored.title,restored.excerpt ?? null,JSON.stringify(blocks),restored.status ?? row.status,restored.published_at ?? restored.publishedAt ?? row.published_at,restored.starts_at ?? restored.startsAt ?? row.starts_at,restored.ends_at ?? restored.endsAt ?? row.ends_at,restored.seo_title ?? restored.seo?.seoTitle ?? row.seo_title,restored.seo_description ?? restored.seo?.seoDescription ?? row.seo_description],{...restored,taxonomyTermIds,assetAssociations,blocks},relationStatements,before);
      return {success:true,commandId:cmd.commandId,result:{...result,revisionId:p.revisionId}};
    }

    if (cmd.command === 'attach_asset') {
      const p=AttachAssetPayload.parse(cmd.payload), row=await getContent(p.contentType,p.contentId), before=await fullSnapshot(row); checkVersion(row,p.expectedVersion);
      const asset=await env.DB.prepare('SELECT id FROM assets WHERE id=? LIMIT 1').bind(p.assetId).first<{id:string}>();
      if (!asset) throw new CommandError('USER_CORRECTABLE','ASSET_NOT_FOUND','The requested asset was not found.');
      const extra=env.DB.prepare(`INSERT OR IGNORE INTO content_assets (content_type,content_id,asset_id,role,position,created_at) SELECT ?,?,?,?,?,? FROM news WHERE id=? AND content_type=? AND version=?`).bind(p.contentType,p.contentId,p.assetId,p.role,p.position,new Date().toISOString(),p.contentId,p.contentType,p.expectedVersion+1);
      const result=await commitContentMutation(execution, row,p.expectedVersion,'attach_asset','',[],{...before,assetAssociations:[...before.assetAssociations as Array<Record<string,unknown>>,{asset_id:p.assetId,role:p.role,position:p.position}]},[extra],before);
      return {success:true,commandId:cmd.commandId,result};
    }

    if (cmd.command === 'replace_asset') {
      const p=ReplaceAssetPayload.parse(cmd.payload), row=await getContent(p.contentType,p.contentId), before=await fullSnapshot(row); checkVersion(row,p.expectedVersion);
      let ingestedAsset=false;
      const assetId=p.assetId || (ingestedAsset=true, (await resolveReferenceAsset(p.reference, runtime, execution, p.role)).assetId);
      const asset=await env.DB.prepare('SELECT id FROM assets WHERE id=? LIMIT 1').bind(assetId).first<{id:string}>();
      if (!asset) throw new CommandError('USER_CORRECTABLE','ASSET_NOT_FOUND','The requested asset was not found.');
      const when=new Date().toISOString();
      const remove=env.DB.prepare(`DELETE FROM content_assets WHERE content_type=? AND content_id=? AND role=? AND position=? AND EXISTS (SELECT 1 FROM news WHERE id=? AND content_type=? AND version=?)`).bind(p.contentType,p.contentId,p.role,p.position,p.contentId,p.contentType,p.expectedVersion+1);
      const add=env.DB.prepare(`INSERT INTO content_assets (content_type,content_id,asset_id,role,position,created_at) SELECT ?,?,?,?,?,? FROM news WHERE id=? AND content_type=? AND version=?`).bind(p.contentType,p.contentId,assetId,p.role,p.position,when,p.contentId,p.contentType,p.expectedVersion+1);
      try {
        const associations=(before.assetAssociations as Array<Record<string,unknown>>).filter((association) => !(association.role === p.role && association.position === p.position));
        const result=await commitContentMutation(execution, row,p.expectedVersion,'replace_asset','',[],{...before,assetAssociations:[...associations,{asset_id:assetId,role:p.role,position:p.position}]},[remove,add],before);
        return {success:true,commandId:cmd.commandId,result};
      } catch (error) {
        if (ingestedAsset) {
          try { await compensateUnassociatedAsset(assetId); }
          catch (compensationError) { throw new CommandError('FATAL_SYSTEM_ERROR','ASSET_COMPENSATION_FAILED','Asset replacement failed and compensation did not complete.',false,{cause:compensationError instanceof Error ? compensationError.message : 'unknown'}); }
        }
        throw error;
      }
    }

    if (cmd.command === 'create_timed_content') {
      const p=CreateTimedContentPayload.parse(cmd.payload);
      if (p.endsAt && p.endsAt <= p.startsAt) throw new CommandError('USER_CORRECTABLE','INVALID_PUBLISH_WINDOW','endsAt must be after startsAt');
      const id=uuid(), now=new Date().toISOString(), status=p.startsAt > now ? 'scheduled':'published';
      const result={contentType:'timed_content',contentId:id,status};
      await fencedBatch(execution, [
        env.DB.prepare(`INSERT INTO timed_contents (id,type,placement,title,body,link_label,link_url,starts_at,ends_at,priority,status,dismissible,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,p.type,p.placement,p.title||null,p.body||null,p.linkLabel||null,p.linkUrl||null,p.startsAt,p.endsAt||null,p.priority,status,p.dismissible?1:0,1,now,now),
        env.DB.prepare(`INSERT INTO content_revisions (id,content_type,content_id,action,before_json,after_json,command_id,created_at) VALUES (?,?,?,?,?,?,?,?)`).bind(uuid(),'timed_content',id,'create',null,JSON.stringify({...p,id,status}),cmd.commandId,now),
        successStatement(execution, result, now)
      ]);
      return {success:true,commandId:cmd.commandId,result};
    }

    if (cmd.command === 'import_wordpress_asset') {
      const p = ImportWordPressAssetPayload.parse(cmd.payload);

      const configured = env as typeof env & {
        WORDPRESS_ASSET_ALLOWED_ORIGINS?: string;
      };

      const allowedOrigins = (
        configured.WORDPRESS_ASSET_ALLOWED_ORIGINS || ''
      )
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      if (!allowedOrigins.length) {
        throw new CommandError(
          'USER_CONFIRMATION_REQUIRED',
          'WORDPRESS_ASSET_ORIGIN_ALLOWLIST_REQUIRED',
          'WORDPRESS_ASSET_ALLOWED_ORIGINS must be configured before importing WordPress media.'
        );
      }

      const result = await ingestWordPressAsset(
        p.reference,
        {
          allowedOrigins,
          ingest: (descriptor, bytes, asExecution) =>
            ingestAsset(descriptor, bytes, asExecution)
        },
        execution
      );

      return {
        success: true,
        commandId: cmd.commandId,
        result
      };
    }

    throw new CommandError('FATAL_SYSTEM_ERROR','COMMAND_NOT_IMPLEMENTED',`Command not implemented: ${cmd.command}`);
  } catch (e) {
    // The job is running; it must not stay that way. The write carries this
    // attempt's own lease, so a superseded attempt cannot overwrite the result
    // of the one that replaced it -- its failure simply affects no rows.
    await recordFailure(execution, e);
    throw e;
  }
}
