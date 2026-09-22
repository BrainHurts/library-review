// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, extract, to13 } from '../js/isbn.js';
import { parse, stringify } from '../js/csv.js';
import { parseLumaResults, guessStatus, resolveStatus, lumaExportRows, NO_CHANGE } from '../js/luma.js';
import { invertName } from '../js/lookup.js';
import { titleKey } from '../js/dupes.js';
import { parseAges, parseCampuses } from '../js/books.js';
import { rowsToItems, mapColumns } from '../js/views/librarian.js';

test('ISBN normalize', () => {
  assert.equal(normalize('978-0-593-42843-6').isbn13, '9780593428436');
  assert.equal(normalize('9780593428436.0').isbn13, '9780593428436');
  assert.equal(normalize('0-306-40615-2').isbn13, '9780306406157'); // ISBN-10 -> 13
  assert.equal(normalize('0306406152').converted, true);
  assert.equal(normalize('9780593428437').valid, false); // bad check digit
  assert.equal(normalize('978593380086').valid, false); // 12 digits
  assert.match(normalize('9.78059390238797E25').error, /Excel/);
  assert.equal(normalize('').error, 'Blank');
  assert.equal(to13('080442957X'), '9780804429573');
});

test('ISBN extract from free text', () => {
  const r = extract('9780593428429, 978-0-593-42844-3; bad123');
  assert.deepEqual(r.filter((x) => x.valid).map((x) => x.isbn13), ['9780593428429', '9780593428443']);
  assert.equal(r.filter((x) => !x.valid).length, 1);
});

test('CSV round trip + TSV detection', () => {
  const rows = [['ISBN', 'Title'], ['978', 'A "quoted", title\nwith newline']];
  assert.deepEqual(parse(stringify(rows)), rows);
  assert.deepEqual(parse('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
});

test('Luma export column order', () => {
  assert.deepEqual(lumaExportRows([{ isbn: '1', title: 'T', authors: 'A', published: '2020' }]), [['1', 'T', 'A', '2020']]);
});

test('Luma results parsing by header name', () => {
  const rows = parseLumaResults([
    ['ISBN13', 'Title', 'Author', 'Review Status', 'Conditions', 'Booklist Name', 'Date Added', 'Added By', 'Organization', 'Campus'],
    ['978-0-593-42843-6', 'A gift of dust', 'Brockenbrough', 'Approved', '', 'Nov 2026', '11/3/2026', 'Jane', 'NBISD', 'CLE'],
    ['', 'Night', 'Wiesel', 'Approved', 'Grades 9+', '', '', '', '', ''],
  ]);
  assert.equal(rows[0].isbn, '9780593428436');
  assert.equal(rows[0].campus, 'CLE');
  assert.equal(rows[1].isbn, null);
  assert.equal(rows[1].conditions, 'Grades 9+');
  assert.equal(rows[0].n, 2);
});

test('Luma status guessing', () => {
  assert.equal(guessStatus('Approved'), 'Approved');
  assert.equal(guessStatus('Not Approved'), 'Not Approved');
  assert.equal(guessStatus('Denied'), 'Not Approved');
  assert.equal(guessStatus('Approved with Conditions'), 'Approved with Conditions');
  assert.equal(guessStatus('In Review'), NO_CHANGE);
  assert.equal(resolveStatus({ status: 'Approved', conditions: 'Grades 9+' }, {}, true), 'Approved with Conditions');
  assert.equal(resolveStatus({ status: 'Approved', conditions: 'Grades 9+' }, {}, false), 'Approved');
});

test('Names, titles, ages, campuses', () => {
  assert.equal(invertName('Martha Brockenbrough'), 'Brockenbrough, Martha');
  assert.equal(invertName('Martin Luther King Jr.'), 'King, Martin Luther, Jr.');
  assert.equal(invertName('Wiesel, Elie'), 'Wiesel, Elie');
  assert.equal(titleKey('The Space Race : a history'), 'space race');
  assert.equal(titleKey('A gift of dust : how Saharan plumes feed the planet'), 'gift of dust');
  assert.deepEqual(parseAges('Middle School, Elementary').ages, ['Elementary', 'Middle School']);
  assert.deepEqual(parseAges('HS').ages, ['High School']);
  assert.deepEqual(parseCampuses('NBHS, LCHS').campuses, ['LCHS', 'NBHS']);
  assert.deepEqual(parseCampuses('SE ').campuses, ['SE']);
  assert.deepEqual(parseCampuses('XYZ').bad, ['XYZ']);
});

test('Bulk rows from the old order sheet layout', () => {
  const header = ['Title is already approved with different ISBN', 'ISBN', 'Book Title', 'Book Author(s)', 'Age', 'Campus', 'Alternative ISBN 1', 'Alternative ISBN 2'];
  const idx = mapColumns(header);
  assert.equal(idx.isbn, 1); assert.equal(idx.title, 2); assert.equal(idx.authors, 3); assert.equal(idx.age, 4); assert.equal(idx.campus, 5);
  assert.deepEqual(idx.alts, [6, 7]);
  const items = rowsToItems([header, ['FALSE', '9780593428436', 'A gift of dust', 'Brockenbrough, Martha', 'Elementary', 'CLE', '9780593428436', '9780593428429']], { age: [], campus: [] });
  assert.equal(items[0].isbn, '9780593428436');
  assert.deepEqual(items[0].alternates, ['9780593428429']); // primary removed from alternates
  assert.deepEqual(items[0].problems, []);
  const bad = rowsToItems([header, ['FALSE', '978593380086', 'X', '', '', '', '', '']], { age: [], campus: [] });
  assert.ok(bad[0].problems.some((p) => /ISBN/.test(p)));
  assert.ok(bad[0].problems.some((p) => /Age/.test(p)));
});
