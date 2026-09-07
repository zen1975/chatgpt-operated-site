import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../scripts/repo-root.mjs';
import { loadServerModule } from '../scripts/load-command-contracts.mjs';
import { installWorkerRuntime } from './support/workers-runtime.mjs';

// The Worker must enforce the image-operation contract itself. /api/v1/commands
// is an authenticated ingress that does not pass through the dispatch gate, so
// a rule enforced only there is bypassed by dispatching directly.
const { RULE_VERSION } = await loadServerModule('src/server/rule-version.ts');
const SITE_ID = JSON.parse(await readFile(path.join(repoRoot, 'config/site-profile.json'), 'utf8')).site.id;

const REFERENCE = { provider: 'generated', providerAssetId: 'artifact-1', intendedRole: 'hero' };
const CONTENT = { contentType: 'news', contentId: 'content_1', expectedVersion: 1 };

const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0x64, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
const generatedArtifactFetcher = async () => ({
  bytes,
  metadata: { sourceProvider: 'generated', sourceId: 'artifact-1', originalFilename: 'a.jpg', mimeType: 'image/jpeg', bytes: bytes.byteLength, sourceMetadata: {} }
});

const envelope = (payload, context = {}, commandId = 'receipt-command-0001') => ({
  schemaVersion: 1,
  commandId,
  command: 'replace_asset',
  issuedAt: '2026-09-07T00:00:00Z',
  context: { ruleVersion: RULE_VERSION, targetSite: SITE_ID, ...context },
  payload
});

const providerCommand = (context = {}, commandId) => envelope({ ...CONTENT, role: 'hero', position: 0, reference: REFERENCE }, { requiresAssetIntake: true, ...context }, commandId);

async function withRuntime(run, overrides) {
  const runtime = await installWorkerRuntime(overrides);
  try {
    const { executeCommand, trustedCommandRuntime } = await loadServerModule('src/server/commands.ts');
    const { issueReadinessReceipt } = await loadServerModule('src/server/control-plane/readiness-receipt.ts');
    const { commandDigest } = await loadServerModule('src/server/control-plane/digest.ts');
    const { contractVersion } = await loadServerModule('src/server/control-plane/contracts.ts');

    runtime.db.prepare(`INSERT INTO news (id,slug,title,blocks_json,status,version,created_at,updated_at,content_type) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('content_1', 'headline', 'Headline', '[]', 'published', 1, 'now', 'now', 'news');

    /** A receipt this installation would actually issue for that command. */
    const receiptFor = async (command, overrides = {}) => ({
      ...(await issueReadinessReceipt({ commandDigest: await commandDigest(command), contractVersion: contractVersion(), provider: 'generated', readiness: 'READY' })),
      ...overrides
    });

    const fetches = [];
    const execute = (command, extra = {}) => executeCommand(command, {
      ...trustedCommandRuntime(),
      generatedArtifactFetcher: async (...args) => { fetches.push(args); return generatedArtifactFetcher(...args); },
      ...extra
    });

    return await run({ ...runtime, execute, receiptFor, fetches, commandDigest, contractVersion });
  } finally {
    runtime.dispose();
  }
}

/** Nothing may have happened: no provider fetch, no object, no row, no job. */
function assertNothingHappened(ctx) {
  assert.deepEqual(ctx.fetches, [], 'no provider fetch may occur');
  assert.equal(ctx.storage.store.size, 0, 'no R2 object may be written');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0, 'no asset row may be written');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM content_assets').get().n, 0, 'no attachment may be written');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0, 'no job may be claimed');
}

// ------------------------------------------------------------ happy path

test('a provider command with a valid receipt succeeds', async () => {
  await withRuntime(async (ctx) => {
    const command = providerCommand();
    const result = await ctx.execute({ ...command, context: { ...command.context, readinessReceipt: await ctx.receiptFor(command) } });

    assert.equal(result.success, true);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
    assert.equal(ctx.fetches.length, 1, 'the provider is fetched exactly once');
  });
});

test('a canonical-asset command needs no receipt', async () => {
  await withRuntime(async (ctx) => {
    const assetId = `asset_${'c'.repeat(64)}_original`;
    ctx.db.prepare(`INSERT INTO assets (id,r2_key,original_filename,mime_type,bytes,alt,variant,created_at,source_provider,sha256,logical_asset_id,validation_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(assetId, 'assets/c.jpg', 'c.jpg', 'image/jpeg', 4, '', 'original', 'now', 'generated', 'c'.repeat(64), `logical_${'c'.repeat(64)}`, 'validated');

    const result = await ctx.execute(envelope({ ...CONTENT, role: 'hero', position: 0, assetId }, { requiresAssetIntake: true }));
    assert.equal(result.success, true, 'a canonical asset requires no readiness evidence');
    assert.deepEqual(ctx.fetches, [], 'and no provider is contacted');
  });
});

test('a text command needs no receipt and refuses the flag', async () => {
  await withRuntime(async (ctx) => {
    const create = { ...envelope({ title: 'Headline', blocks: [{ type: 'paragraph', content: 'body' }] }, {}, 'text-command-0001'), command: 'create_news' };
    const result = await ctx.execute(create);
    assert.equal(result.success, true);

    await assert.rejects(
      () => ctx.execute({ ...create, commandId: 'text-command-0002', context: { ...create.context, requiresAssetIntake: true } }),
      (error) => error.code === 'ASSET_INTAKE_FLAG_UNEXPECTED'
    );
  });
});

// -------------------------------------------------------------- rejections

const REJECTIONS = [
  { name: 'the contract flag is missing', code: 'ASSET_INTAKE_FLAG_MISSING',
    build: async (ctx) => { const command = providerCommand(); const { requiresAssetIntake, ...context } = command.context; return { ...command, context: { ...context, readinessReceipt: await ctx.receiptFor(command) } }; } },

  { name: 'the receipt is missing', code: 'READINESS_RECEIPT_REQUIRED',
    build: async () => providerCommand() },

  { name: 'the signature is forged', code: 'READINESS_RECEIPT_SIGNATURE_INVALID',
    build: async (ctx) => { const command = providerCommand(); return { ...command, context: { ...command.context, readinessReceipt: await ctx.receiptFor(command, { signature: 'f'.repeat(64) }) } }; } },

  { name: 'the digest is for another command', code: 'READINESS_RECEIPT_DIGEST_MISMATCH',
    build: async (ctx) => { const command = providerCommand(); return { ...command, context: { ...command.context, readinessReceipt: await ctx.receiptFor(providerCommand({}, 'a-different-command-0001')) } }; } },

  { name: 'the provider does not match', code: 'READINESS_RECEIPT_PROVIDER_MISMATCH',
    build: async (ctx) => { const command = providerCommand(); return { ...command, context: { ...command.context, readinessReceipt: await ctx.receiptFor(command, { provider: 'google_drive' }) } }; } },

  { name: 'the site does not match', code: 'READINESS_RECEIPT_SITE_MISMATCH',
    build: async (ctx) => { const command = providerCommand(); return { ...command, context: { ...command.context, readinessReceipt: await ctx.receiptFor(command, { siteId: 'another-installation' }) } }; } },

  { name: 'the contract version drifted', code: 'READINESS_RECEIPT_CONTRACT_DRIFT',
    build: async (ctx) => { const command = providerCommand(); return { ...command, context: { ...command.context, readinessReceipt: await ctx.receiptFor(command, { contractVersion: 'some-other-contract' }) } }; } },

  { name: 'the receipt has expired', code: 'READINESS_RECEIPT_EXPIRED',
    build: async (ctx) => { const command = providerCommand(); return { ...command, context: { ...command.context, readinessReceipt: await ctx.receiptFor(command, { issuedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:10:00.000Z' }) } }; } },

  { name: 'the receipt is dated in the future', code: 'READINESS_RECEIPT_NOT_YET_VALID',
    build: async (ctx) => { const command = providerCommand(); return { ...command, context: { ...command.context, readinessReceipt: await ctx.receiptFor(command, { issuedAt: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:10:00.000Z' }) } }; } },

  { name: 'the receipt does not attest READY', code: 'READINESS_RECEIPT_NOT_READY',
    build: async (ctx) => { const command = providerCommand(); return { ...command, context: { ...command.context, readinessReceipt: await ctx.receiptFor(command, { readiness: 'NOT_READY' }) } }; } }
];

for (const { name, code, build } of REJECTIONS) {
  test(`rejected when ${name}, with nothing written`, async () => {
    await withRuntime(async (ctx) => {
      await assert.rejects(async () => ctx.execute(await build(ctx)), (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
        return true;
      });
      assertNothingHappened(ctx);
    });
  });
}

// Every tampered field changes the signed payload, so even a "valid-looking"
// alteration fails the signature rather than only the field check.
test('tampering with any bound field invalidates the signature', async () => {
  await withRuntime(async (ctx) => {
    const { verifyReadinessReceipt } = await loadServerModule('src/server/control-plane/readiness-receipt.ts');
    const command = providerCommand();
    const digest = await ctx.commandDigest(command);
    const receipt = await ctx.receiptFor(command);

    for (const field of ['commandDigest', 'contractVersion', 'siteId', 'provider', 'readiness', 'issuedAt', 'expiresAt']) {
      const tampered = { ...receipt, [field]: field.endsWith('At') ? new Date(Date.now() + 60_000).toISOString() : `tampered-${field}` };
      await assert.rejects(
        () => verifyReadinessReceipt({ receipt: tampered, commandDigest: digest, contractVersion: ctx.contractVersion(), provider: 'generated' }),
        (error) => String(error.code).startsWith('READINESS_RECEIPT_'),
        `${field}: a tampered receipt must be refused`
      );
    }
  });
});

// The command secret is the one an authenticated ingress holds. It must not be
// enough to mint readiness evidence.
test('the command secret cannot mint a readiness receipt', async () => {
  await withRuntime(async (ctx) => {
    const { canonicalReceiptPayload, verifyReadinessReceipt } = await loadServerModule('src/server/control-plane/readiness-receipt.ts');
    const command = providerCommand();
    const claims = {
      receiptVersion: 1,
      commandDigest: await ctx.commandDigest(command),
      contractVersion: ctx.contractVersion(),
      siteId: SITE_ID,
      provider: 'generated',
      readiness: 'READY',
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };

    // Signed with the command secret rather than the receipt secret.
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonicalReceiptPayload(claims))))]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');

    await assert.rejects(
      () => verifyReadinessReceipt({ receipt: { ...claims, signature }, commandDigest: claims.commandDigest, contractVersion: claims.contractVersion, provider: 'generated' }),
      (error) => error.code === 'READINESS_RECEIPT_SIGNATURE_INVALID',
      'the two secrets must be genuinely separate'
    );
  }, { COMMAND_HMAC_SECRET: 'test-secret', READINESS_RECEIPT_HMAC_SECRET: 'a-different-receipt-secret' });
});

test('provider intake fails closed when receipts are not provisioned', async () => {
  await withRuntime(async (ctx) => {
    await assert.rejects(
      async () => ctx.execute(providerCommand({ readinessReceipt: { receiptVersion: 1, commandDigest: `sha256:${'a'.repeat(64)}`, contractVersion: 'v1', siteId: SITE_ID, provider: 'generated', readiness: 'READY', issuedAt: '2026-09-07T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', signature: 'a'.repeat(64) } })),
      (error) => error.code === 'READINESS_RECEIPT_UNAVAILABLE'
    );
    assertNothingHappened(ctx);
  }, { READINESS_RECEIPT_HMAC_SECRET: undefined });
});

// ------------------------------------------------------------------ replay

test('a completed command replays even with an expired receipt', async () => {
  await withRuntime(async (ctx) => {
    const command = providerCommand();
    const first = await ctx.execute({ ...command, context: { ...command.context, readinessReceipt: await ctx.receiptFor(command) } });
    assert.equal(first.success, true);

    // The same immutable command, re-sent long after its receipt lapsed.
    const replay = await ctx.execute({
      ...command,
      context: { ...command.context, readinessReceipt: await ctx.receiptFor(command, { issuedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:10:00.000Z' }) }
    });

    assert.equal(replay.idempotent, true, 'a completed command must replay regardless of receipt age');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1, 'and must not mutate again');
    assert.equal(ctx.fetches.length, 1, 'nor fetch the provider again');
  });
});

test('an unknown command is not admitted by a spent receipt', async () => {
  await withRuntime(async (ctx) => {
    const command = providerCommand({}, 'never-executed-0001');
    await assert.rejects(
      async () => ctx.execute({ ...command, context: { ...command.context, readinessReceipt: await ctx.receiptFor(command, { issuedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:10:00.000Z' }) } }),
      (error) => error.code === 'READINESS_RECEIPT_EXPIRED',
      'an unknown command still passes full admission'
    );
    assertNothingHappened(ctx);
  });
});

// ------------------------------------------------------- enforcement ordering

test('the contract is enforced before the claim, the fetch and any write', async () => {
  const source = await readFile(path.join(repoRoot, 'src/server/commands.ts'), 'utf8');
  const body = source.slice(source.indexOf('export async function executeCommand'));
  const at = (needle) => {
    const index = body.indexOf(needle);
    assert.notEqual(index, -1, `expected ${needle}`);
    return index;
  };

  const enforcement = at('verifyReadinessReceipt(');
  assert.ok(at('isImageBearingOperation(') < enforcement, 'the semantics are decided before the receipt is verified');
  assert.ok(enforcement < at('claimCommand('), 'enforcement must precede the job claim');
  assert.ok(enforcement < at('// From here the job is `running`'), 'and precede the handler, where provider fetches and writes happen');
  assert.match(body, /const validatedPayload = payloadSchema\.parse\(cmd\.payload\)/, 'the payload is parsed once and reused');
});

test('the Worker uses the shared asset semantics, not its own', async () => {
  const source = await readFile(path.join(repoRoot, 'src/server/commands.ts'), 'utf8');
  assert.match(source, /import \{ isImageBearingOperation, providerIntake \} from '\.\/command-assets'/, 'the Worker must use the shared contract');
  assert.ok(!/IMAGE_BEARING_COMMANDS|REFERENCE_BEARING_COMMANDS/.test(source), 'and must not restate it');
});
