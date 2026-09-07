import { db } from './db';
import { getContentMedia, type ContentMedia } from './content-assets';

export type News = { id:string; slug:string; title:string; excerpt:string|null; blocks_json:string; content_type?:'news'|'article'; status:string; published_at:string|null; starts_at:string|null; ends_at:string|null; seo_title:string|null; seo_description:string|null; version:number; };
export type NewsWithMedia = News & { media: ContentMedia };
export type TimedContent = { id:string; placement:string; title:string|null; body:string|null; link_label:string|null; link_url:string|null; starts_at:string; ends_at:string|null; priority:number; status:string; };

const nowIso = () => new Date().toISOString();

export async function getLatestNews(limit=3): Promise<News[]> {
  const now=nowIso();
  const result = await db().prepare(`SELECT * FROM news WHERE (content_type='news' OR content_type IS NULL) AND status='published' AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?) ORDER BY published_at DESC LIMIT ?`).bind(now, now, limit).all<News>();
  return result.results;
}

export async function getNewsBySlug(slug:string): Promise<News|null> {
  const now=nowIso();
  return await db().prepare(`SELECT * FROM news WHERE slug=? AND (content_type='news' OR content_type IS NULL) AND status='published' AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?) LIMIT 1`).bind(slug,now,now).first<News>();
}

export async function getLatestArticles(limit=3): Promise<News[]> {
  const now=nowIso();
  const result = await db().prepare(`SELECT * FROM news WHERE content_type='article' AND status='published' AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?) ORDER BY published_at DESC LIMIT ?`).bind(now, now, limit).all<News>();
  return result.results;
}

export async function getArticleBySlug(slug:string): Promise<News|null> {
  const now=nowIso();
  return await db().prepare(`SELECT * FROM news WHERE slug=? AND content_type='article' AND status='published' AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?) LIMIT 1`).bind(slug,now,now).first<News>();
}

export async function getNewsWithMedia(limit=3): Promise<NewsWithMedia[]> {
  const items = await getLatestNews(limit);
  return Promise.all(items.map(async (item) => ({ ...item, media: await getContentMedia('news', item.id) })));
}

export async function getArticlesWithMedia(limit=3): Promise<NewsWithMedia[]> {
  const items = await getLatestArticles(limit);
  return Promise.all(items.map(async (item) => ({ ...item, media: await getContentMedia('article', item.id) })));
}

export async function getNewsBySlugWithMedia(slug:string): Promise<NewsWithMedia|null> {
  const item = await getNewsBySlug(slug);
  return item ? { ...item, media: await getContentMedia('news', item.id) } : null;
}

export async function getArticleBySlugWithMedia(slug:string): Promise<NewsWithMedia|null> {
  const item = await getArticleBySlug(slug);
  return item ? { ...item, media: await getContentMedia('article', item.id) } : null;
}

export async function getActiveTimedContent(placement:string): Promise<TimedContent|null> {
  const now=nowIso();
  return await db().prepare(`SELECT * FROM timed_contents WHERE placement=? AND status='published' AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?) ORDER BY priority DESC, starts_at DESC LIMIT 1`).bind(placement,now,now).first<TimedContent>();
}
