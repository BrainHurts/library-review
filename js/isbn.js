// ISBN helpers: clean, validate, convert ISBN-10 -> ISBN-13, extract from free text.

/** Strip everything except digits and X. Handles Excel artefacts like "9780593428436.0". */
export function clean(input) {
  if (input === null || input === undefined) return '';
  let s = String(input).trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  // Scientific notation (Excel number formatting) — only safe if it round-trips to <= 13 digits.
  if (/^\d(\.\d+)?e\+?\d+$/i.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) s = String(n);
    else return s.replace(/[^0-9Xx]/g, '').toUpperCase() + '!'; // mark as corrupt
  }
  return s.replace(/[^0-9Xx]/g, '').toUpperCase();
}

export function isValid13(s) {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(s[12]);
}

export function isValid10(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i);
  return sum % 11 === 0;
}

export function to13(isbn10) {
  const core = '978' + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  return core + ((10 - (sum % 10)) % 10);
}

/**
 * Normalize any ISBN-ish input.
 * @returns {{input:string, isbn13:string|null, valid:boolean, converted:boolean, error?:string}}
 */
export function normalize(input) {
  const raw = input === null || input === undefined ? '' : String(input).trim();
  const c = clean(raw);
  if (!c) return { input: raw, isbn13: null, valid: false, converted: false, error: 'Blank' };
  if (c.endsWith('!')) return { input: raw, isbn13: null, valid: false, converted: false, error: 'Number was corrupted by Excel (scientific notation) — retype it' };
  if (c.length === 13) {
    return isValid13(c)
      ? { input: raw, isbn13: c, valid: true, converted: false }
      : { input: raw, isbn13: null, valid: false, converted: false, error: 'Check digit is wrong — likely a typo' };
  }
  if (c.length === 10) {
    return isValid10(c)
      ? { input: raw, isbn13: to13(c), valid: true, converted: true }
      : { input: raw, isbn13: null, valid: false, converted: false, error: 'Check digit is wrong — likely a typo' };
  }
  return { input: raw, isbn13: null, valid: false, converted: false, error: `Has ${c.length} digits; ISBNs have 10 or 13` };
}

/** Split free text (commas, semicolons, whitespace, newlines) into normalized results. */
export function extract(text) {
  if (!text) return [];
  return String(text)
    .split(/[\s,;|]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map(normalize);
}

/** Display form: plain 13 digits (what catalogs and Luma use). */
export function display(isbn13) {
  return isbn13 || '';
}
