// Admin screens: Review · Send to Luma · Import Luma results
import { OBJ, F, IF, AGE_LEVELS, CAMPUSES, BOARD_MEETINGS, DEFAULT_BOARD_MEETING, STATUSES } from '../config.js';
import { h, mount, clear, toast, errorBox, alertBox, modal, statusBadge, busy, download, readTable, field, select, checkGroup, progress, tabs } from '../ui.js';
import { list, listAll, update, create, remove, count, pool, today, text, arr } from '../api.js';
import { extract, display } from '../isbn.js';
import { findIsbnMatches, findSimilarTitles } from '../dupes.js';
import { isbnRecordsFor, deleteBook } from '../books.js';
import { stringify, parse } from '../csv.js';
import { LUMA_EXPORT_HEADER, lumaExportRows, parseLumaResults, guessStatus, resolveStatus, NO_CHANGE } from '../luma.js';
import { pager } from './librarian.js';

const TABS = [['review', 'Review books'], ['export', 'Send to Luma'], ['import', 'Import Luma results']];

export function renderAdmin(root, ctx, sub = 'review') {
  if (!TABS.some(([k]) => k === sub)) sub = 'review';
  const body = h('div', { class: 'tab-body' });
  mount(root, tabs(TABS, sub, (k) => { location.hash = `#/admin/${k}`; }), body);
  ({ review, export: exportLuma, import: importLuma })[sub](body, ctx);
}

/** Knack filters can't nest AND/OR, so fetch one status at a time and merge. */
async function booksFor(meeting, statuses) {
  const out = [];
  for (const s of statuses) {
    const rules = [{ field: F.status, operator: 'is', value: s }];
    if (meeting) rules.push({ field: F.meeting, operator: 'is', value: meeting });
    out.push(...(await listAll(OBJ.books, { filters: { match: 'and', rules }, sortField: F.title })));
  }
  return out;
}

// ─── Review ────────────────────────────────────────────────────────
function review(root, ctx) {
  const st = { meeting: ctx.adminMeeting ?? DEFAULT_BOARD_MEETING, status: '', campus: '', q: '', page: 1, selected: new Set() };
  const meetingSel = select([['', 'All meetings'], ...BOARD_MEETINGS], st.meeting);
  const statusSel = select([['', 'All statuses'], ...STATUSES], '');
  const campusSel = select([['', 'All campuses'], ...CAMPUSES], '');
  const qIn = h('input', { type: 'search', placeholder: 'Title or author' });
  const cards = h('div', { class: 'stat-cards' });
  const out = h('div');
  const bulkSel = select([['', 'Set status for selected…'], ...STATUSES], '');
  const bulkBar = h('div', { class: 'bulk-bar', hidden: true }, h('span', { class: 'bulk-count' }), bulkSel);

  async function loadCounts() {
    clear(cards);
    const base = st.meeting ? [{ field: F.meeting, operator: 'is', value: st.meeting }] : [];
    try {
      const counts = await Promise.all(STATUSES.map((s) => count(OBJ.books, { match: 'and', rules: [...base, { field: F.status, operator: 'is', value: s }] })));
      const total = counts.reduce((a, b) => a + b, 0);
      mount(cards,
        h('button', { class: `stat${!st.status ? ' active' : ''}`, onclick: () => { statusSel.value = ''; st.status = ''; st.page = 1; load(); } }, h('span', { class: 'stat-n' }, total), h('span', { class: 'stat-l' }, 'All')),
        STATUSES.map((s, i) => h('button', { class: `stat${st.status === s ? ' active' : ''}`, onclick: () => { statusSel.value = s; st.status = s; st.page = 1; load(); } }, h('span', { class: 'stat-n' }, counts[i]), h('span', { class: 'stat-l' }, s))));
    } catch (err) { mount(cards, errorBox(err, 'Could not load counts')); }
  }

  async function load() {
    st.selected.clear();
    updateBulk();
    mount(out, h('div', { class: 'muted' }, 'Loading…'));
    loadCounts();
    const rules = [];
    if (st.meeting) rules.push({ field: F.meeting, operator: 'is', value: st.meeting });
    if (st.status) rules.push({ field: F.status, operator: 'is', value: st.status });
    if (st.campus) rules.push({ field: F.campus, operator: 'contains', value: st.campus });
    let records;
    try {
      if (st.q) {
        // Title OR author, combined with the other filters (AND) — do two queries and merge.
        const a = await list(OBJ.books, { filters: { match: 'and', rules: [...rules, { field: F.title, operator: 'contains', value: st.q }] }, rowsPerPage: 200, sortField: F.title });
        const b = await list(OBJ.books, { filters: { match: 'and', rules: [...rules, { field: F.authors, operator: 'contains', value: st.q }] }, rowsPerPage: 200, sortField: F.title });
        const seen = new Set();
        records = [...a.records, ...b.records].filter((r) => !seen.has(r.id) && seen.add(r.id));
        renderTable({ records, total_records: records.length, total_pages: 1, current_page: 1 });
      } else {
        renderTable(await list(OBJ.books, { filters: { match: 'and', rules }, page: st.page, rowsPerPage: 50, sortField: F.title }));
      }
    } catch (err) { mount(out, errorBox(err, 'Could not load books')); }
  }

  function updateBulk() {
    bulkBar.hidden = !st.selected.size;
    bulkBar.querySelector('.bulk-count').textContent = `${st.selected.size} selected`;
  }

  bulkSel.addEventListener('change', async () => {
    const s = bulkSel.value;
    if (!s || !st.selected.size) return;
    const ids = [...st.selected];
    const res = await pool(ids, 3, (id) => update(OBJ.books, id, { [F.status]: s }));
    const bad = res.filter((r) => !r.ok);
    toast(bad.length ? `${ids.length - bad.length} updated; ${bad.length} failed: ${bad[0].error.message}` : `${ids.length} book(s) set to “${s}”.`, bad.length ? 'error' : 'success', 8000);
    bulkSel.value = '';
    load();
  });

  function renderTable(r) {
    if (!r.records.length) { mount(out, h('p', { class: 'muted' }, 'No books match these filters.')); return; }
    const all = h('input', { type: 'checkbox', 'aria-label': 'Select all on this page', onchange: () => {
      out.querySelectorAll('tbody input[type=checkbox]').forEach((cb) => { cb.checked = all.checked; cb.dispatchEvent(new Event('change')); });
    } });
    mount(out,
      h('div', { class: 'muted small' }, `${r.total_records} book(s)`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, all), ['Title / Author', 'ISBN', 'Age', 'Campus', 'Meeting', 'Submitted by', 'Status', 'Luma', ''].map((t) => h('th', null, t)))),
        h('tbody', null, r.records.map((b) => {
          const cb = h('input', { type: 'checkbox', onchange: () => { if (cb.checked) st.selected.add(b.id); else st.selected.delete(b.id); updateBulk(); } });
          const sSel = select(STATUSES, text(b, F.status), { class: 'status-select', 'aria-label': 'Status' });
          sSel.addEventListener('change', async () => {
            try { await update(OBJ.books, b.id, { [F.status]: sSel.value }); toast(`“${text(b, F.title)}” → ${sSel.value}`, 'success'); loadCounts(); }
            catch (err) { toast(err.message, 'error', 10000); sSel.value = text(b, F.status); }
          });
          const n = Number(text(b, F.isbnCount)) || 0;
          return h('tr', null,
            h('td', null, cb),
            h('td', null, h('div', null, text(b, F.title)), h('div', { class: 'muted small' }, text(b, F.authors))),
            h('td', { class: 'mono' }, display(text(b, F.isbn)), n > 1 ? h('div', { class: 'muted small' }, `+${n - 1} alt`) : null),
            h('td', null, arr(b, F.age).join(', ')), h('td', null, arr(b, F.campus).join(', ')), h('td', null, text(b, F.meeting)),
            h('td', { class: 'small' }, text(b, F.submittedBy)),
            h('td', null, sSel),
            h('td', { class: 'small' }, text(b, F.lumaStatus), text(b, F.lumaConditions) ? h('div', { class: 'muted' }, text(b, F.lumaConditions)) : null),
            h('td', null, h('button', { class: 'btn btn-small btn-ghost', onclick: () => editBook(b.id, load) }, 'Open')));
        })))),
      pager(r, (p) => { st.page = p; load(); }));
  }

  meetingSel.addEventListener('change', () => { st.meeting = meetingSel.value; ctx.adminMeeting = st.meeting; st.page = 1; load(); });
  statusSel.addEventListener('change', () => { st.status = statusSel.value; st.page = 1; load(); });
  campusSel.addEventListener('change', () => { st.campus = campusSel.value; st.page = 1; load(); });
  let t;
  qIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { st.q = qIn.value.trim(); st.page = 1; load(); }, 400); });

  mount(root, h('div', { class: 'card' },
    h('div', { class: 'filters' }, field('Board meeting', meetingSel), field('Status', statusSel), field('Campus', campusSel), field('Search', qIn)),
    cards, bulkBar, out));
  load();
}

async function editBook(id, onDone) {
  const { getRecord } = await import('../api.js');
  let b;
  let isbns;
  try { [b, isbns] = await Promise.all([getRecord(OBJ.books, id), isbnRecordsFor(id)]); }
  catch (err) { toast(err.message, 'error', 10000); return; }
  const titleIn = h('input', { type: 'text', value: text(b, F.title) });
  const authorsIn = h('input', { type: 'text', value: text(b, F.authors) });
  const pubIn = h('input', { type: 'text', value: text(b, F.published) });
  const ageGrp = checkGroup('aage', AGE_LEVELS, arr(b, F.age));
  const campusGrp = checkGroup('acampus', CAMPUSES, arr(b, F.campus));
  const meetingSel = select(BOARD_MEETINGS, text(b, F.meeting));
  const statusSel = select(STATUSES, text(b, F.status));
  const adminNotes = h('textarea', { rows: 2, value: text(b, F.adminNotes) });
  const err = h('div');
  const isbnList = h('div', { class: 'alt-list' });
  const addIsbnIn = h('input', { type: 'text', placeholder: 'Add alternate ISBN(s)' });

  function renderIsbns() {
    mount(isbnList, isbns.map((r) => {
      const isPrimary = text(r, IF.type) === 'Primary' || text(r, IF.isbn) === text(b, F.isbn);
      return h('span', { class: 'alt-chip' }, display(text(r, IF.isbn)), isPrimary ? h('em', { class: 'muted small' }, ' primary') :
        h('button', { class: 'chip-x', 'aria-label': `Remove ${text(r, IF.isbn)}`, onclick: async () => {
          try { await remove(OBJ.isbns, r.id); isbns = isbns.filter((x) => x.id !== r.id); renderIsbns(); }
          catch (e) { toast(e.message, 'error', 10000); }
        } }, '×'));
    }));
  }
  async function addIsbns() {
    const good = extract(addIsbnIn.value).filter((x) => x.valid).map((x) => x.isbn13);
    if (!good.length) { toast('No valid ISBNs to add.', 'error'); return; }
    const hits = await findIsbnMatches(good);
    const clash = good.filter((i) => hits.has(i));
    if (clash.length) toast(`Already used by another book: ${clash.map((i) => `${i} (“${hits.get(i).bookTitle}”)`).join('; ')}`, 'error', 10000);
    for (const i of good.filter((x) => !hits.has(x))) {
      try { isbns.push(await create(OBJ.isbns, { [IF.isbn]: i, [IF.type]: 'Alternate', [IF.book]: [{ id }] })); }
      catch (e) { toast(`${i}: ${e.message}`, 'error', 10000); }
    }
    addIsbnIn.value = '';
    renderIsbns();
  }
  addIsbnIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addIsbns(); } });
  renderIsbns();

  const luma = [['Review status', F.lumaStatus], ['Conditions', F.lumaConditions], ['Booklist', F.lumaBooklist], ['Date added', F.lumaDateAdded], ['Added by', F.lumaAddedBy], ['Organization', F.lumaOrg], ['Campus', F.lumaCampus], ['Sent to Luma', F.sentOn], ['Results imported', F.lumaImportedOn]]
    .filter(([, k]) => text(b, k));

  const save = h('button', { class: 'btn btn-primary' }, 'Save');
  const del = h('button', { class: 'btn btn-danger-ghost' }, 'Delete book');
  const m = modal(text(b, F.title) || 'Book', h('div', { class: 'form' },
    h('div', { class: 'grid-2' }, field('Title', titleIn), field('Author(s)', authorsIn)),
    h('div', { class: 'grid-3' }, field('Date published', pubIn), field('Board meeting', meetingSel), field('Status', statusSel)),
    h('fieldset', null, h('legend', null, 'Age level'), ageGrp),
    h('fieldset', null, h('legend', null, 'Campus'), campusGrp),
    h('fieldset', null, h('legend', null, 'ISBNs'), isbnList, h('div', { class: 'inline' }, addIsbnIn, h('button', { class: 'btn btn-secondary', onclick: addIsbns }, 'Add'))),
    text(b, F.libNotes) ? h('div', { class: 'note' }, h('strong', null, 'Librarian notes: '), text(b, F.libNotes)) : null,
    field('Admin notes (visible to the librarian)', adminNotes),
    luma.length ? h('fieldset', null, h('legend', null, 'Luma'), h('dl', { class: 'dl' }, luma.flatMap(([l, k]) => [h('dt', null, l), h('dd', null, text(b, k))]))) : null,
    h('div', { class: 'muted small' }, `Submitted by ${text(b, F.submittedBy) || 'unknown'} on ${text(b, F.createdOn)}`),
    err), [del, save]);

  save.addEventListener('click', () => busy(save, 'Saving…', async () => {
    clear(err);
    try {
      await update(OBJ.books, id, { [F.title]: titleIn.value.trim(), [F.authors]: authorsIn.value.trim(), [F.published]: pubIn.value.trim(), [F.age]: ageGrp.values(), [F.campus]: campusGrp.values(), [F.meeting]: meetingSel.value, [F.status]: statusSel.value, [F.adminNotes]: adminNotes.value.trim() });
      m.close(); toast('Saved.', 'success'); onDone();
    } catch (e) { err.append(errorBox(e, 'Could not save')); }
  }));
  del.addEventListener('click', () => {
    if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Click again to permanently delete'; return; }
    busy(del, 'Deleting…', async () => {
      try { await deleteBook(id); m.close(); toast('Book deleted.', 'success'); onDone(); }
      catch (e) { err.append(errorBox(e, 'Could not delete')); }
    });
  });
}

// ─── Send to Luma ──────────────────────────────────────────────────
function exportLuma(root, ctx) {
  const meetingSel = select([['', 'All meetings'], ...BOARD_MEETINGS], ctx.adminMeeting ?? DEFAULT_BOARD_MEETING);
  const statusGrp = checkGroup('xstatus', STATUSES, ['Submitted']);
  const headerChk = h('input', { type: 'checkbox', checked: true });
  const prepBtn = h('button', { class: 'btn btn-primary' }, 'Prepare file');
  const out = h('div');
  let books = [];

  prepBtn.addEventListener('click', () => busy(prepBtn, 'Loading…', async () => {
    clear(out);
    try {
      const statuses = statusGrp.values();
      if (!statuses.length) { out.append(alertBox('error', 'Pick at least one status.')); return; }
      books = await booksFor(meetingSel.value, statuses);
      renderPreview();
    } catch (err) { out.append(errorBox(err, 'Could not load books')); }
  }));

  function renderPreview() {
    if (!books.length) { mount(out, alertBox('warn', 'No books match — nothing to send.')); return; }
    const rows = lumaExportRows(books.map((b) => ({ isbn: text(b, F.isbn), title: text(b, F.title), authors: text(b, F.authors), published: text(b, F.published) })));
    const fname = `luma-${(meetingSel.value || 'all').replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    const dl = h('button', { class: 'btn btn-primary', onclick: () => download(fname, stringify(headerChk.checked ? [LUMA_EXPORT_HEADER, ...rows] : rows)) }, `Download ${books.length} books for Luma (.csv)`);
    const prog = progress();
    const mark = h('button', { class: 'btn btn-secondary' }, `Mark these ${books.length} as “Sent to Luma”`);
    mark.addEventListener('click', () => busy(mark, 'Updating…', async () => {
      const res = await pool(books, 3, (b) => update(OBJ.books, b.id, { [F.status]: 'Sent to Luma', [F.sentOn]: today() }), (d, t) => prog.set(d, t, `Updating… ${d}/${t}`));
      const bad = res.filter((r) => !r.ok);
      prog.hidden = true;
      toast(bad.length ? `${books.length - bad.length} marked; ${bad.length} failed: ${bad[0].error.message}` : `${books.length} books marked as Sent to Luma.`, bad.length ? 'error' : 'success', 8000);
      mark.disabled = true;
    }));
    mount(out,
      h('p', null, `${books.length} book(s). Columns match Luma’s template: ISBN | Title | Authors | Date Published.`),
      h('div', { class: 'actions' }, dl, mark), prog,
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, LUMA_EXPORT_HEADER.map((c) => h('th', null, c)))),
        h('tbody', null, rows.slice(0, 25).map((r) => h('tr', null, r.map((c, i) => h('td', { class: i === 0 ? 'mono' : '' }, c))))))),
      books.length > 25 ? h('p', { class: 'muted small' }, `…and ${books.length - 25} more in the file.`) : null);
  }

  mount(root, h('div', { class: 'card' },
    h('p', null, 'Builds the upload file for Luma. After uploading it to Luma, mark the books as “Sent to Luma” so they aren’t sent twice.'),
    h('div', { class: 'filters' }, field('Board meeting', meetingSel)),
    h('fieldset', null, h('legend', null, 'Include books with status'), statusGrp),
    h('label', { class: 'chk' }, headerChk, ' Include a header row (Luma ignores it)'),
    h('div', { class: 'actions' }, prepBtn), out));
}

// ─── Import Luma results ───────────────────────────────────────────
function importLuma(root) {
  const fileIn = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx' });
  const pasteIn = h('textarea', { rows: 4, placeholder: 'Or paste the Luma results (including the header row)' });
  const readBtn = h('button', { class: 'btn btn-primary' }, 'Read results');
  const condChk = h('input', { type: 'checkbox', checked: true });
  const out = h('div');
  const prog = progress();
  let rows = [];
  const mapping = {};

  readBtn.addEventListener('click', () => busy(readBtn, 'Matching…', async () => {
    clear(out);
    try {
      let raw;
      if (fileIn.files[0]) raw = await readTable(fileIn.files[0]);
      else if (pasteIn.value.trim()) raw = parse(pasteIn.value);
      else { out.append(alertBox('error', 'Choose a file or paste the results first.')); return; }
      rows = parseLumaResults(raw);
      if (!rows.length) { out.append(alertBox('error', 'No rows found in that file.')); return; }
      // 1) match by ISBN (primary or any alternate)
      const hits = await findIsbnMatches(rows.map((r) => r.isbn).filter(Boolean), { onProgress: (d, t) => prog.set(d, t, `Matching ISBNs… ${d}/${t}`) });
      for (const r of rows) if (r.isbn && hits.has(r.isbn)) { r.bookId = hits.get(r.isbn).bookId; r.bookTitle = hits.get(r.isbn).bookTitle; r.how = 'ISBN'; }
      // 2) fall back to exact title match
      const left = rows.filter((r) => !r.bookId && r.title);
      await pool(left, 3, async (r) => {
        const sim = await findSimilarTitles(r.title);
        if (sim.length === 1) { r.bookId = sim[0].id; r.bookTitle = text(sim[0], F.title); r.how = 'Title'; }
        else if (sim.length > 1) r.ambiguous = sim.length;
      }, (d, t) => prog.set(d, t, `Matching titles… ${d}/${t}`));
      prog.hidden = true;
      for (const s of new Set(rows.map((r) => r.status))) if (!(s in mapping)) mapping[s] = guessStatus(s);
      render();
    } catch (err) { prog.hidden = true; out.append(errorBox(err, 'Could not read results')); }
  }));

  function render() {
    const matched = rows.filter((r) => r.bookId);
    const unmatched = rows.filter((r) => !r.bookId);
    const dupTargets = matched.filter((r, i) => matched.findIndex((x) => x.bookId === r.bookId) !== i);
    const mapTable = h('table', { class: 'table compact' },
      h('thead', null, h('tr', null, h('th', null, 'Luma review status'), h('th', null, 'Rows'), h('th', null, 'Set our status to'))),
      h('tbody', null, Object.keys(mapping).map((s) => {
        const sel = select([NO_CHANGE, ...STATUSES], mapping[s]);
        sel.addEventListener('change', () => { mapping[s] = sel.value; render(); });
        return h('tr', null, h('td', null, s || h('em', { class: 'muted' }, '(blank)')), h('td', null, rows.filter((r) => r.status === s).length), h('td', null, sel));
      })));
    const apply = h('button', { class: 'btn btn-primary', disabled: !matched.length }, `Update ${matched.length} matched book(s)`);
    apply.addEventListener('click', () => busy(apply, 'Updating…', async () => {
      const res = await pool(matched, 3, (r) => {
        const data = {
          [F.lumaStatus]: r.status, [F.lumaConditions]: r.conditions, [F.lumaBooklist]: r.booklist, [F.lumaDateAdded]: r.dateAdded,
          [F.lumaAddedBy]: r.addedBy, [F.lumaOrg]: r.org, [F.lumaCampus]: r.campus, [F.lumaImportedOn]: today(),
        };
        const s = resolveStatus(r, mapping, condChk.checked);
        if (s !== NO_CHANGE) data[F.status] = s;
        return update(OBJ.books, r.bookId, data);
      }, (d, t) => prog.set(d, t, `Updating… ${d}/${t}`));
      prog.hidden = true;
      res.forEach((x, i) => { matched[i].result = x.ok ? 'ok' : x.error.message; });
      const bad = res.filter((x) => !x.ok).length;
      toast(bad ? `${matched.length - bad} updated, ${bad} failed — see table.` : `${matched.length} books updated from Luma.`, bad ? 'error' : 'success', 8000);
      render();
    }));
    const dlUnmatched = unmatched.length ? h('button', { class: 'btn btn-ghost', onclick: () => download('luma-unmatched.csv', stringify([['Row', 'ISBN', 'Title', 'Author', 'Review Status', 'Conditions', 'Reason'], ...unmatched.map((r) => [r.n, r.isbnInput, r.title, r.author, r.status, r.conditions, r.ambiguous ? `${r.ambiguous} books share this title` : 'No matching ISBN or title'])])) }, `Download ${unmatched.length} unmatched rows`) : null;

    mount(out,
      h('div', { class: 'summary' }, `${rows.length} rows · ${matched.length} matched (${matched.filter((r) => r.how === 'ISBN').length} by ISBN, ${matched.filter((r) => r.how === 'Title').length} by title) · ${unmatched.length} not matched`),
      dupTargets.length ? alertBox('warn', `${dupTargets.length} row(s) point at a book that another row already matched — the last one wins.`) : null,
      h('h3', null, 'Status mapping'), mapTable,
      h('label', { class: 'chk' }, condChk, ' Use “Approved with Conditions” when an approved row has text in Conditions'),
      h('div', { class: 'actions' }, apply, dlUnmatched), prog,
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Row', 'ISBN', 'Luma title', 'Matched book', 'Luma status', 'New status', 'Conditions', 'Result'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((r) => {
          const ns = r.bookId ? resolveStatus(r, mapping, condChk.checked) : '';
          return h('tr', { class: !r.bookId ? 'row-bad' : r.result && r.result !== 'ok' ? 'row-bad' : r.result === 'ok' ? 'row-ok' : '' },
            h('td', null, r.n), h('td', { class: 'mono' }, r.isbn ? display(r.isbn) : r.isbnInput),
            h('td', null, r.title), h('td', null, r.bookId ? [r.bookTitle, h('div', { class: 'muted small' }, `by ${r.how}`)] : h('span', { class: 'text-error' }, r.ambiguous ? `${r.ambiguous} books share this title` : 'No match')),
            h('td', null, r.status), h('td', null, ns && ns !== NO_CHANGE ? statusBadge(ns) : h('span', { class: 'muted small' }, ns ? 'unchanged' : '')),
            h('td', { class: 'small' }, r.conditions),
            h('td', { class: 'small' }, r.result === 'ok' ? '✓' : r.result ? h('span', { class: 'text-error' }, r.result) : ''));
        })))));
  }

  mount(root, h('div', { class: 'card' },
    h('p', null, 'Upload the results file exported from Luma (.xlsx or .csv). Rows are matched to books by ISBN — including alternate ISBNs — and by title when the ISBN doesn’t match. Nothing is changed until you click Update.'),
    field('Luma results file', fileIn), field('…or paste', pasteIn),
    h('div', { class: 'actions' }, readBtn), prog, out));
}
