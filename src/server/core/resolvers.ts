import { env } from 'cloudflare:workers';
import { CommandError } from './errors';

const ALLOWED_NEWS_TEMPLATES = new Set(['news-default','article-default','article-professional']);

export function resolveTemplate(templateProfile?: string | null) {
  const value = templateProfile || 'news-default';
  if (!ALLOWED_NEWS_TEMPLATES.has(value)) throw new CommandError('USER_CORRECTABLE','INVALID_TEMPLATE_PROFILE',`Template profile is not allowed: ${value}`);
  return value;
}

export function resolvePermalink(contentType:string, slug:string) {
  if(contentType==='news') return `/news/${slug}/`;
  if(contentType==='article') return `/column/${slug}/`;
  throw new CommandError('FATAL_SYSTEM_ERROR','PERMALINK_PROFILE_MISSING',`No permalink profile for ${contentType}`);
}

export function resolveSeo(title:string, excerpt:string|null|undefined, seoTitle?:string|null, seoDescription?:string|null) {
  return {
    seoTitle: seoTitle || title,
    seoDescription: seoDescription || excerpt || null
  };
}

export async function validateTaxonomyTerms(categoryTermIds:string[] = [], tagTermIds:string[] = []) {
  const all=[...new Set([...categoryTermIds,...tagTermIds])];
  if(!all.length) return;
  const placeholders=all.map(()=>'?').join(',');
  const rows=await env.DB.prepare(`SELECT id FROM taxonomy_terms WHERE id IN (${placeholders}) AND status='published'`).bind(...all).all<{id:string}>();
  const found = new Set((rows.results || []).map((r: { id: string }) => r.id));
  const missing=all.filter(id=>!found.has(id));
  if(missing.length) throw new CommandError('USER_CORRECTABLE','UNKNOWN_TAXONOMY_TERM','One or more taxonomy terms do not exist.',false,{missing});
}
