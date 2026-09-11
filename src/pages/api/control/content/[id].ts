export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { authorizeControlRead } from '@/server/control-plane/auth';
import { controlError } from '@/server/control-plane/http';
import { contractVersion } from '@/server/control-plane/contracts';

/**
 * Return the current stored body of one content item.
 *
 * The operator (ChatGPT) cannot read D1, so without this route the only way to
 * obtain the existing body before an update is to reconstruct it from the
 * rendered HTML. Anything that rendering drops -- inline emphasis markers, for
 * example -- is lost there, and every update degrades the stored content a
 * little further.
 *
 * scripts/refresh-state-index.mjs reads this route and writes the result to
 * state/bodies/, so the operator edits the stored value rather than a
 * reconstruction of it.
 */
export const GET: APIRoute = async ({ request, params }) => {
  try {
    await authorizeControlRead(request, 'content:read');
    const id = params.id;
    if (!id) return Response.json({ success: false, error: { code: 'CONTENT_ID_REQUIRED', message: 'content id is required' } }, { status: 400 });

    const row = await env.DB.prepare(
      `SELECT id, slug, title, excerpt, blocks_json, content_type, status,
              published_at, starts_at, ends_at, seo_title, seo_description, version
       FROM news WHERE id = ? LIMIT 1`
    ).bind(id).first<{
      id: string; slug: string; title: string; excerpt: string | null; blocks_json: string;
      content_type: string; status: string; published_at: string | null; starts_at: string | null;
      ends_at: string | null; seo_title: string | null; seo_description: string | null; version: number;
    }>();

    if (!row) return Response.json({ success: false, error: { code: 'CONTENT_NOT_FOUND', message: 'content not found' } }, { status: 404 });

    const terms = await env.DB.prepare(
      `SELECT term_id FROM content_term_links WHERE content_type = ? AND content_id = ?`
    ).bind(row.content_type, row.id).all<{ term_id: string }>();

    return Response.json({
      success: true,
      contractVersion: contractVersion(),
      content: {
        id: row.id,
        slug: row.slug,
        title: row.title,
        excerpt: row.excerpt,
        contentType: row.content_type,
        status: row.status,
        version: row.version,
        publishedAt: row.published_at,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        seoTitle: row.seo_title,
        seoDescription: row.seo_description,
        termIds: (terms.results || []).map((term: { term_id: string }) => term.term_id),
        blocks: JSON.parse(row.blocks_json),
      },
    });
  } catch (error) {
    return controlError(error);
  }
};
