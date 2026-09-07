import type { APIRoute } from 'astro';

export const prerender = true;
export const GET: APIRoute = ({ site, url }) => new Response(`User-agent: *\nAllow: /\nSitemap: ${new URL('/sitemap.xml', site ?? url).toString()}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
