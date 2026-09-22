// Shared book operations used by both librarian and admin screens.
import { OBJ, F, IF, AGE_LEVELS, CAMPUSES } from './config.js';
import { create, pool, listAll, remove } from './api.js';

/**
 * Create a book and one ISBNs record per ISBN (primary + alternates).
 * @returns {Promise<{book:object, isbnErrors:string[]}>}
 */
export async function createBook(ctx, d) {
  const payload = {
    [F.title]: d.title.trim(),
    [F.isbn]: d.isbn,
    [F.authors]: (d.authors || '').trim(),
    [F.published]: (d.published || '').trim(),
    [F.age]: d.age,
    [F.campus]: d.campus,
    [F.meeting]: d.meeting,
    [F.status]: 'Submitted',
    [F.libNotes]: (d.notes || '').trim(),
  };
  if (ctx.librarianId) payload[F.submittedBy] = [{ id: ctx.librarianId }];
  const book = await create(OBJ.books, payload);
  const all = [{ isbn: d.isbn, type: 'Primary' }, ...[...new Set(d.alternates || [])].filter((i) => i !== d.isbn).map((isbn) => ({ isbn, type: 'Alternate' }))];
  const res = await pool(all, 3, (x) => create(OBJ.isbns, { [IF.isbn]: x.isbn, [IF.type]: x.type, [IF.book]: [{ id: book.id }] }));
  const isbnErrors = res.map((r, i) => (r.ok ? null : `${all[i].isbn}: ${r.error.message}`)).filter(Boolean);
  return { book, isbnErrors };
}

export async function isbnRecordsFor(bookId) {
  return listAll(OBJ.isbns, { filters: { match: 'and', rules: [{ field: IF.book, operator: 'is', value: bookId }] } });
}

export async function deleteBook(bookId) {
  const isbns = await isbnRecordsFor(bookId);
  await pool(isbns, 3, (r) => remove(OBJ.isbns, r.id));
  await remove(OBJ.books, bookId);
}

/** "Elementary, Middle School" / "HS" / "elem/ms" -> canonical age levels. */
export function parseAges(text) {
  const out = new Set();
  const bad = [];
  for (const part of String(text || '').split(/[,;/|&+]|\band\b/i).map((s) => s.trim()).filter(Boolean)) {
    const p = part.toLowerCase();
    if (/^(elem|es\b|k-?5|primary)/.test(p)) out.add('Elementary');
    else if (/^(mid|ms\b|jr|junior|6-?8)/.test(p)) out.add('Middle School');
    else if (/^(high|hs\b|9-?12|sec)/.test(p)) out.add('High School');
    else bad.push(part);
  }
  return { ages: AGE_LEVELS.filter((a) => out.has(a)), bad };
}

export function parseCampuses(text) {
  const out = new Set();
  const bad = [];
  for (const part of String(text || '').split(/[,;/|&+\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)) {
    if (CAMPUSES.includes(part)) out.add(part);
    else bad.push(part);
  }
  return { campuses: CAMPUSES.filter((c) => out.has(c)), bad };
}
