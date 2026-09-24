// Online book lookup: Google Books (edition details) + Open Library (all ISBNs of the same work).
// Both APIs are free, keyless and CORS-enabled. Failures are non-fatal — staff can type details.
import { normalize } from './isbn.js';

const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'phd', 'md']);

/** "Martha Brockenbrough" -> "Brockenbrough, Martha" (catalog style). */
export function invertName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n || n.includes(',')) return n;
  const parts = n.split(' ');
  if (parts.length < 2) return n;
  let suffix = '';
  if (SUFFIXES.has(parts[parts.length - 1].toLowerCase())) suffix = parts.pop();
  const last = parts.pop();
  return `${last}, ${parts.join(' ')}${suffix ? `, ${suffix}` : ''}`;
}

async function getJson(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export const googleUrl = (isbn13) => `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn13}&maxResults=1`;
export const openLibraryUrl = (isbn13) => `https://openlibrary.org/search.json?isbn=${isbn13}&fields=key,title,subtitle,author_name,first_publish_year,isbn&limit=1`;

/** Fetch a URL and report exactly what came back (for the raw-data view). Never throws. */
export async function fetchRaw(url, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const started = performance.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const txt = await res.text();
    let body;
    try { body = JSON.parse(txt); } catch { body = txt; }
    return { ok: res.ok, status: res.status, ms: Math.round(performance.now() - started), body };
  } catch (err) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - started), error: err.name === 'AbortError' ? 'Timed out' : err.message };
  } finally {
    clearTimeout(t);
  }
}

async function google(isbn13) {
  const j = await getJson(googleUrl(isbn13));
  const v = j.items && j.items[0] && j.items[0].volumeInfo;
  if (!v) return null;
  const ids = (v.industryIdentifiers || []).map((x) => normalize(x.identifier)).filter((n) => n.valid).map((n) => n.isbn13);
  return {
    title: v.subtitle ? `${v.title} : ${v.subtitle}` : v.title,
    authors: (v.authors || []).map(invertName).join('; '),
    published: v.publishedDate || '',
    isbns: ids,
  };
}

async function openLibrary(isbn13) {
  const j = await getJson(openLibraryUrl(isbn13));
  const d = j.docs && j.docs[0];
  if (!d) return null;
  const isbns = [...new Set((d.isbn || []).map((x) => normalize(x)).filter((n) => n.valid).map((n) => n.isbn13))];
  return {
    title: d.subtitle ? `${d.title} : ${d.subtitle}` : d.title,
    authors: (d.author_name || []).map(invertName).join('; '),
    published: d.first_publish_year ? String(d.first_publish_year) : '',
    isbns,
  };
}

/**
 * @returns {Promise<{found:boolean, title?:string, authors?:string, published?:string, workIsbns:string[], sources:string[], errors:string[]}>}
 */
export async function lookupIsbn(isbn13) {
  const [g, o] = await Promise.allSettled([google(isbn13), openLibrary(isbn13)]);
  const gv = g.status === 'fulfilled' ? g.value : null;
  const ov = o.status === 'fulfilled' ? o.value : null;
  const errors = [];
  if (g.status === 'rejected') errors.push(`Google Books: ${g.reason.message}`);
  if (o.status === 'rejected') errors.push(`Open Library: ${o.reason.message}`);
  const src = gv || ov;
  const workIsbns = [...new Set([...(ov ? ov.isbns : []), ...(gv ? gv.isbns : [])])].filter((i) => i !== isbn13);
  return {
    found: !!src,
    title: src ? src.title : undefined,
    authors: (gv && gv.authors) || (ov && ov.authors) || '',
    published: (gv && gv.published) || (ov && ov.published) || '',
    workIsbns,
    sources: [gv && 'Google Books', ov && 'Open Library'].filter(Boolean),
    errors,
  };
}
