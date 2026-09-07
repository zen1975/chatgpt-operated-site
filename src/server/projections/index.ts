import { resolvePermalink } from '@/server/core/resolvers';

export type ProjectionSite = { name: string; origin: string; defaultOgImage: string };
export type ProjectionAsset = { path: string } | null;
export type ProjectionProduct = {
  id: string; slug: string; title: string; description: string; category: string;
  priceAmount: number | null; priceCurrency: string; priceDisplay: string | null;
  minimumOrderQuantity: string | null; status: string; publishedAt: string | null;
  primaryAsset: ProjectionAsset; seoTitleOverride?: string | null; seoDescriptionOverride?: string | null;
  ogImageOverride?: string | null; thumbnailOverride?: string | null; breadcrumbLabelOverride?: string | null;
  cardExcerptOverride?: string | null;
};
export type ProjectionContent = {
  id: string; contentType: 'news' | 'article'; slug: string; title: string;
  excerpt: string | null; seoTitle: string | null; seoDescription: string | null;
  publishedAt: string | null; media?: { hero: ProjectionAsset; thumbnail: ProjectionAsset; ogp: ProjectionAsset };
};

const fallback = (value: string | null | undefined, derived: string) => value && value.trim() ? value : derived;
const absolute = (site: ProjectionSite, path: string | null | undefined) => path ? new URL(path, site.origin).toString() : undefined;

export function deriveCanonical(site: ProjectionSite, path: string) { return new URL(path, site.origin).toString(); }

export function deriveSeo(source: { title: string; description?: string | null; seoTitleOverride?: string | null; seoDescriptionOverride?: string | null }, site: ProjectionSite) {
  return {
    title: fallback(source.seoTitleOverride, `${source.title} | ${site.name}`),
    description: fallback(source.seoDescriptionOverride, source.description || source.title)
  };
}

export function deriveOpenGraph(source: { title: string; description?: string | null; ogImageOverride?: string | null; primaryAsset?: ProjectionAsset; media?: { ogp: ProjectionAsset; hero: ProjectionAsset; thumbnail: ProjectionAsset } }, site: ProjectionSite) {
  const image = source.ogImageOverride || source.media?.ogp?.path || source.media?.hero?.path || source.media?.thumbnail?.path || source.primaryAsset?.path || site.defaultOgImage;
  return { title: source.title, description: source.description || '', image: absolute(site, image) };
}

export function deriveThumbnail(source: { thumbnailOverride?: string | null; primaryAsset?: ProjectionAsset; media?: { thumbnail: ProjectionAsset; hero: ProjectionAsset } }) {
  return source.thumbnailOverride || source.media?.thumbnail?.path || source.primaryAsset?.path || source.media?.hero?.path || null;
}

export function deriveBreadcrumbs(site: ProjectionSite, items: Array<{ name: string; path: string }>) {
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: deriveCanonical(site, item.path) })) };
}

export function deriveStructuredData(source: ProjectionProduct | ProjectionContent, site: ProjectionSite, path: string) {
  const image = deriveOpenGraph(source, site).image;
  if ('priceCurrency' in source) return { '@context': 'https://schema.org', '@type': 'Product', name: source.title, description: source.description, image, category: source.category || undefined, offers: source.priceAmount === null ? undefined : { '@type': 'Offer', priceCurrency: source.priceCurrency, price: source.priceAmount, availability: source.status === 'published' ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder' } };
  return { '@context': 'https://schema.org', '@type': source.contentType === 'news' ? 'NewsArticle' : 'Article', headline: source.title, description: source.excerpt || '', image, datePublished: source.publishedAt || undefined, mainEntityOfPage: { '@type': 'WebPage', '@id': deriveCanonical(site, path) } };
}

export function deriveFaqStructuredData(items: Array<{ question: string; answer: string }> | undefined) {
  if (!items?.length) return null;
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map((item) => ({ '@type': 'Question', name: item.question, acceptedAnswer: { '@type': 'Answer', text: item.answer } })) };
}

/** Uses the validated composition that also feeds the visible FAQ module. */
export function derivePageStructuredData(composition: { sections: Array<{ sectionType: string; props: unknown }> }) {
  const faq = composition.sections.find((section) => section.sectionType === 'faq');
  const items = faq?.props && typeof faq.props === 'object' && !Array.isArray(faq.props) ? (faq.props as { items?: Array<{ question: string; answer: string }> }).items : undefined;
  return deriveFaqStructuredData(items);
}

export function deriveCardProjection(source: ProjectionProduct | ProjectionContent, site: ProjectionSite, path: string) {
  const product = 'priceCurrency' in source;
  return { id: source.id, title: source.title, excerpt: product ? source.cardExcerptOverride || source.description : source.excerpt, href: path, thumbnail: deriveThumbnail(source), meta: product ? source.priceDisplay : source.publishedAt ? new Date(source.publishedAt).toLocaleDateString('ja-JP') : undefined, canonical: deriveCanonical(site, path) };
}

export function deriveSitemapEntry(site: ProjectionSite, path: string, updatedAt?: string | null) { return { loc: deriveCanonical(site, path), lastmod: updatedAt || undefined }; }
export function deriveRssEntry(site: ProjectionSite, source: ProjectionContent) { const path = source.contentType === 'article' ? `/column/${source.slug}/` : `/news/${source.slug}/`; return { title: source.title, link: deriveCanonical(site, path), description: source.excerpt || '', publishedAt: source.publishedAt || undefined }; }
export function deriveSearchDocument(site: ProjectionSite, source: ProjectionProduct | ProjectionContent, path: string) { const card = deriveCardProjection(source, site, path); return { id: source.id, type: 'priceCurrency' in source ? 'product' : source.contentType, title: source.title, description: card.excerpt, url: card.canonical, thumbnail: card.thumbnail, category: 'category' in source ? source.category : null, updatedAt: new Date().toISOString() }; }

export function derivePageSeo(title: string, description: string | null | undefined, site: ProjectionSite) { return deriveSeo({ title, description }, site); }
export function deriveProductPermalink(slug: string) { return `/products/${slug}/`; }
export { resolvePermalink };
