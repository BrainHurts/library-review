// Duplicate detection against Knack: ISBN (primary + alternates) and similar titles.
import { OBJ, F, IF } from './config.js';
import { listAll, list, getRecord, pool } from './api.js';

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/**
 * Find which of the given ISBN-13s already exist anywhere (ISBNs table or a book's primary ISBN).
 * @returns {Promise<Map<string, {bookId:string, bookTitle:string}>>}
 */
export async function findIsbnMatches(isbns, { checkBooks = true, onProgress } = {}) {
  const unique = [...new Set(isbns.filter(Boolean))];
  const hits = new Map();
  const parts = chunk(unique, 25);
  await pool(parts, 3, async (part) => {
    const rules = part.map((v) => ({ field: IF.isbn, operator: 'is', value: v }));
    const recs = await listAll(OBJ.isbns, { filters: { match: 'or', rules } });
    for (const r of recs) {
      const book = (r[`${IF.book}_raw`] || [])[0];
      if (book) hits.set(String(r[`${IF.isbn}_raw`]), { bookId: book.id, bookTitle: book.identifier });
    }
    // Safety net: a book's primary ISBN field (covers books added in the Knack builder).
    const missing = part.filter((v) => !hits.has(v));
    if (checkBooks && missing.length) {
      const brules = missing.map((v) => ({ field: F.isbn, operator: 'is', value: v }));
      const books = await listAll(OBJ.books, { filters: { match: 'or', rules: brules } });
      for (const b of books) hits.set(String(b[`${F.isbn}_raw`]), { bookId: b.id, bookTitle: b[`${F.title}_raw`] });
    }
  }, onProgress).then((res) => {
    const failed = res.find((r) => !r.ok);
    if (failed) throw failed.error;
  });
  return hits;
}

/** Fetch full book records for a set of ids (for showing status/meeting/campus). */
export async function booksById(ids) {
  const out = new Map();
  for (const id of [...new Set(ids)]) {
    try { out.set(id, await getRecord(OBJ.books, id)); }
    catch (err) { if (err.status !== 404) throw err; } // a deleted book is fine to skip
  }
  return out;
}

export function titleKey(title) {
  return String(title || '')
    .split(/\s[:;/]\s|:\s|\s\(/)[0]
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/^(the|a|an|el|la|los|las|le|les)\s+/, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Books whose main title matches (ignoring subtitle, case, punctuation, leading article). */
export async function findSimilarTitles(title, excludeIds = []) {
  const key = titleKey(title);
  if (key.length < 3) return [];
  // Knack "contains" is a substring match; probe with the longest plain word (most selective,
  // and free of punctuation/accents so it matches the stored title), then compare keys locally.
  const probe = key.split(' ').filter((w) => /^[a-z0-9]+$/.test(w)).sort((a, b) => b.length - a.length)[0] || key;
  const r = await list(OBJ.books, { filters: { match: 'and', rules: [{ field: F.title, operator: 'contains', value: probe }] }, rowsPerPage: 1000 });
  return (r.records || []).filter((b) => !excludeIds.includes(b.id) && titleKey(b[`${F.title}_raw`]) === key);
}
