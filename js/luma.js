// Luma export/import logic (pure functions — unit tested).
import { normalize } from './isbn.js';

/** Luma upload template: ISBN | Title | Authors | Date Published (headers ignored by Luma). */
export const LUMA_EXPORT_HEADER = ['ISBN', 'Title', 'Authors', 'Date Published'];

export function lumaExportRows(books) {
  return books.map((b) => [b.isbn || '', b.title || '', b.authors || '', b.published || '']);
}

const COLS = {
  isbn: /isbn/,
  title: /^title|book title/,
  author: /author/,
  status: /review status|^status/,
  conditions: /condition/,
  booklist: /booklist|book list|list name/,
  dateAdded: /date added|added on/,
  addedBy: /added by/,
  org: /organi[sz]ation|district/,
  campus: /campus|school/,
};
const DEFAULT_ORDER = ['isbn', 'title', 'author', 'status', 'conditions', 'booklist', 'dateAdded', 'addedBy', 'org', 'campus'];

/** Parse rows of a Luma results file into objects. Works with or without a header row. */
export function parseLumaResults(rows) {
  if (!rows.length) return [];
  const header = rows[0].map((c) => String(c || '').toLowerCase().trim());
  const hasHeader = header.some((c) => /isbn|title|review/.test(c));
  const idx = {};
  if (hasHeader) {
    header.forEach((c, i) => {
      for (const [k, re] of Object.entries(COLS)) {
        if (idx[k] === undefined && re.test(c)) { idx[k] = i; break; }
      }
    });
  } else DEFAULT_ORDER.forEach((k, i) => { idx[k] = i; });
  const get = (r, k) => (idx[k] === undefined ? '' : String(r[idx[k]] ?? '').trim());
  return (hasHeader ? rows.slice(1) : rows).map((r, n) => {
    const iso = normalize(get(r, 'isbn'));
    return {
      n: n + (hasHeader ? 2 : 1),
      isbnInput: get(r, 'isbn'),
      isbn: iso.valid ? iso.isbn13 : null,
      title: get(r, 'title'),
      author: get(r, 'author'),
      status: get(r, 'status'),
      conditions: get(r, 'conditions'),
      booklist: get(r, 'booklist'),
      dateAdded: get(r, 'dateAdded'),
      addedBy: get(r, 'addedBy'),
      org: get(r, 'org'),
      campus: get(r, 'campus'),
    };
  });
}

export const NO_CHANGE = '(leave status as is)';

/** Best guess at mapping a Luma "Review Status" value to our Status. */
export function guessStatus(lumaStatus) {
  const s = String(lumaStatus || '').toLowerCase();
  if (!s) return NO_CHANGE;
  if (/not approved|unapproved|disapprov|denied|deny|reject|declin|remov|fail|inappropriate/.test(s)) return 'Not Approved';
  if (/condition|restrict|with note|limited|parent/.test(s)) return 'Approved with Conditions';
  if (/approv|accept|pass|cleared/.test(s)) return 'Approved';
  return NO_CHANGE;
}

/** Final status for one row given the admin's mapping. */
export function resolveStatus(row, mapping, conditionsUpgrade) {
  const mapped = mapping[row.status] ?? guessStatus(row.status);
  if (mapped === 'Approved' && conditionsUpgrade && row.conditions) return 'Approved with Conditions';
  return mapped;
}
