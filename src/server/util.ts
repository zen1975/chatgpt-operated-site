export function slugify(input:string, fallbackKey='content') {
  const ascii = input.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  const safeKey = fallbackKey.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,24) || 'content';
  return ascii || `item-${safeKey}`;
}
export function uuid() { return crypto.randomUUID(); }
