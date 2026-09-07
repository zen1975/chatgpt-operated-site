export const prerender = false;
export const trailingSlash = 'never';
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

const PUBLIC_ASSET_KEY = /^assets\/[0-9a-f]{2}\/[0-9a-f]{64}\/(original|large|medium|thumbnail|ogp)\.(jpg|png|webp|avif|pdf)$/;

export const GET: APIRoute = async ({ params, request }) => {
  const encodedKey = params.key;
  if (!encodedKey) return new Response('Not found', { status: 404 });
  let key: string;
  try {
    key = encodedKey.split('~').map((part) => decodeURIComponent(part)).join('/');
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!PUBLIC_ASSET_KEY.test(key)) return new Response('Not found', { status: 404 });
  if (key.includes('..') || key.startsWith('private/') || key.startsWith('internal/')) return new Response('Not found', { status: 404 });
  if (request.headers.has('range')) return new Response('Range requests are not supported', { status: 416 });
  const object = await env.ASSETS_BUCKET.get(key);
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('content-disposition', 'inline');
  headers.set('accept-ranges', 'none');
  return new Response(object.body, { headers });
};
