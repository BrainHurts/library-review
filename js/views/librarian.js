// Librarian screens: Add a book · Add many · My submissions · Search all books
import { OBJ, F, AGE_LEVELS, CAMPUSES, BOARD_MEETINGS, DEFAULT_BOARD_MEETING, STATUSES, MAX_AUTO_ALTERNATES } from '../config.js';
import { h, mount, append, clear, toast, errorBox, alertBox, modal, statusBadge, statusKey, busy, download, readTable, field, select, checkGroup, progress, tabs, cover, bookCell, skeleton, emptyState, pageHead, responsive, statusBar } from '../ui.js';
import { list, update, pool, text, arr, countBy } from '../api.js';
import { normalize, extract, display } from '../isbn.js';
import { lookupIsbn } from '../lookup.js';
import { findIsbnMatches, findSimilarTitles, booksById, titleKey } from '../dupes.js';
import { createBook, parseAges, parseCampuses } from '../books.js';
import { stringify } from '../csv.js';

const TABS = [['add', 'Add a book'], ['bulk', 'Add many'], ['mine', 'My submissions'], ['search', 'Search all books']];
const HEADS = {
  add: ['Add a book', 'Scan or type an ISBN. Details and other editions fill in automatically, and duplicates are checked as you go.'],
  bulk: ['Add many books', 'Upload your order spreadsheet or paste rows. Every row is checked before anything is submitted.'],
  mine: ['My submissions', 'Track the books you’ve requested. You can edit or withdraw a book until it’s sent for review.'],
  search: ['Search all books', 'Check whether a title is already requested at any campus before you submit it.'],
};

export function renderLibrarian(root, ctx, sub = 'add') {
  if (!TABS.some(([k]) => k === sub)) sub = 'add';
  const body = h('div', { class: 'tab-body' });
  mount(root, tabs(TABS, sub, (k) => { location.hash = `#/librarian/${k}`; }), pageHead(...HEADS[sub]), body);
  ({ add: addBook, bulk: bulkAdd, mine: mySubmissions, search: searchAll })[sub](body, ctx);
}

// ─── shared bits ────────────────────────────────────────────────────
function bookLine(b, withCover = true) {
  return h('div', { class: 'dup-book' },
    withCover ? cover(text(b, F.isbn), text(b, F.title)) : null,
    h('div', { class: 'dup-main' },
      h('div', { class: 'dup-title' }, h('strong', null, text(b, F.title)), ' ', statusBadge(text(b, F.status))),
      h('div', { class: 'muted small' },
        [text(b, F.authors), `ISBN ${display(text(b, F.isbn))}`, text(b, F.meeting), text(b, F.campus), text(b, F.submittedBy) && `by ${text(b, F.submittedBy)}`].filter(Boolean).join(' · '))));
}

/** Title + author cell with a small cover. */
function titleCell(b) {
  return h('td', { class: 'title-cell' }, bookCell(text(b, F.isbn), text(b, F.title), text(b, F.authors)));
}

// ─── Add a book ─────────────────────────────────────────────────────
function addBook(root, ctx) {
  const state = { primary: null, alternates: new Map(), workIsbns: [], blocking: [], soft: [], similar: [], checking: 0, lastLookup: '' };

  const isbnIn = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Scan or type ISBN (10 or 13 digits, hyphens OK)', class: 'isbn-input' });
  const isbnMsg = h('div', { class: 'hint', 'aria-live': 'polite' });
  const lookupBtn = h('button', { type: 'button', class: 'btn btn-secondary' }, 'Look up');
  const titleIn = h('input', { type: 'text', required: true });
  const authorsIn = h('input', { type: 'text', placeholder: 'Last, First; Last, First' });
  const pubIn = h('input', { type: 'text', placeholder: 'e.g. 2024' });
  const altList = h('div', { class: 'alt-list' });
  const altIn = h('input', { type: 'text', placeholder: 'Paste one or more ISBNs, then press Enter' });
  const altAdd = h('button', { type: 'button', class: 'btn btn-secondary' }, 'Add');
  const ageGrp = checkGroup('age', AGE_LEVELS, ctx.lastAge || []);
  const campusGrp = checkGroup('campus', CAMPUSES, ctx.lastCampus || (ctx.campus ? [ctx.campus] : []));
  const meetingSel = select(BOARD_MEETINGS, ctx.lastMeeting || DEFAULT_BOARD_MEETING);
  const notesIn = h('textarea', { rows: 2, placeholder: 'Optional — anything the reviewers should know' });
  const dupPanel = h('div', { class: 'dup-panel', 'aria-live': 'polite' });
  const ackSimilar = h('input', { type: 'checkbox' });
  const ackWrap = h('label', { class: 'chk ack', hidden: true }, ackSimilar, ' I checked — this is a different book and should still be reviewed.');
  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Submit for review');
  const formErr = h('div');
  const preview = h('div', { class: 'book-preview', hidden: true });

  function renderPreview() {
    const t = titleIn.value.trim();
    preview.hidden = !state.primary && !t;
    if (preview.hidden) return;
    mount(preview, cover(state.primary, t, 'L'),
      h('div', { class: 'bp-body' },
        h('div', { class: 'bp-title' }, t || h('span', { class: 'muted' }, 'Title not filled in yet')),
        h('div', { class: 'muted' }, authorsIn.value.trim() || '—'),
        h('div', { class: 'bp-meta' },
          state.primary ? h('span', { class: 'mono' }, display(state.primary)) : null,
          pubIn.value.trim() ? h('span', null, pubIn.value.trim()) : null,
          state.alternates.size ? h('span', null, `${[...state.alternates.values()].filter((a) => a.checked).length} other edition ISBN(s)`) : null)));
  }

  function renderAlts() {
    clear(altList);
    if (!state.alternates.size) { altList.append(h('span', { class: 'muted small' }, 'None yet. Look up the ISBN to find other editions automatically, or add them below.')); return; }
    for (const [isbn, a] of state.alternates) {
      const cb = h('input', { type: 'checkbox', checked: a.checked, onchange: () => { a.checked = cb.checked; renderPreview(); } });
      altList.append(h('label', { class: `alt-chip${a.dup ? ' alt-dup' : ''}`, title: a.dup ? 'Already on another book — won’t be saved' : a.source }, cb, ' ', display(isbn)));
    }
    renderPreview();
  }

  function renderDup() {
    clear(dupPanel);
    ackWrap.hidden = !(state.soft.length || state.similar.length) || state.blocking.length > 0;
    if (state.checking) { dupPanel.append(h('div', { class: 'checking' }, h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), 'Checking for duplicates…')); return; }
    if (!state.primary) return;
    if (state.blocking.length) {
      dupPanel.append(alertBox('error', h('strong', null, 'Already submitted — this book can’t be added again.'),
        h('div', { class: 'small' }, 'Matching ISBN found on:'), state.blocking.map((b) => bookLine(b)),
        h('div', { class: 'small muted' }, 'If your campus also needs it, ask an admin to add your campus to the existing entry.')));
      return;
    }
    if (state.soft.length) {
      dupPanel.append(alertBox('warn', h('strong', null, 'Possible duplicate: another edition of this work is already in the system.'),
        h('div', { class: 'small' }, 'Online catalogs group these together — it may be a different format or translation.'), state.soft.map((b) => bookLine(b))));
    }
    if (state.similar.length) {
      dupPanel.append(alertBox('warn', h('strong', null, 'A book with the same title is already in the system (different ISBN).'), state.similar.map((b) => bookLine(b))));
    }
    if (!state.soft.length && !state.similar.length) dupPanel.append(alertBox('ok', h('strong', null, '✓ No duplicates found.'), ' This book hasn’t been requested at any campus.'));
  }

  async function checkDuplicates() {
    if (!state.primary) return;
    state.checking++;
    renderDup();
    try {
      const saved = [state.primary, ...[...state.alternates].filter(([, a]) => a.checked).map(([i]) => i)];
      const everything = [...new Set([...saved, ...state.alternates.keys(), ...state.workIsbns])];
      const hits = await findIsbnMatches(everything);
      for (const [i, a] of state.alternates) a.dup = hits.has(i);
      const hardIds = new Set(saved.filter((i) => hits.has(i)).map((i) => hits.get(i).bookId));
      const softIds = new Set([...hits.entries()].filter(([i]) => !saved.includes(i)).map(([, v]) => v.bookId).filter((id) => !hardIds.has(id)));
      const books = await booksById([...hardIds, ...softIds]);
      state.blocking = [...hardIds].map((id) => books.get(id)).filter(Boolean);
      state.soft = [...softIds].map((id) => books.get(id)).filter(Boolean);
      const title = titleIn.value.trim();
      state.similar = title ? await findSimilarTitles(title, [...hardIds, ...softIds]) : [];
      renderAlts();
    } catch (err) {
      clear(dupPanel).append(errorBox(err, 'Duplicate check failed'));
      state.checking--;
      return;
    }
    state.checking--;
    renderDup();
  }

  async function onIsbn(force = false) {
    const n = normalize(isbnIn.value);
    isbnMsg.className = 'hint';
    if (!isbnIn.value.trim()) { isbnMsg.textContent = ''; state.primary = null; renderDup(); return; }
    if (!n.valid) { isbnMsg.className = 'hint hint-error'; isbnMsg.textContent = n.error; state.primary = null; renderDup(); return; }
    isbnMsg.textContent = n.converted ? `ISBN-10 converted to ISBN-13: ${display(n.isbn13)}` : `✓ Valid ISBN-13: ${display(n.isbn13)}`;
    if (n.isbn13 === state.lastLookup && !force) return;
    state.primary = n.isbn13;
    state.lastLookup = n.isbn13;
    state.alternates.delete(n.isbn13);
    for (const [i, a] of state.alternates) if (a.source === 'Found online') state.alternates.delete(i);
    await busy(lookupBtn, 'Looking up…', async () => {
      const info = await lookupIsbn(n.isbn13);
      if (state.primary !== n.isbn13) return; // user typed a new one meanwhile
      if (info.found) {
        // Overwrite a field if it's empty or still holds what a previous lookup filled in.
        const fill = (el, v) => { if (force || !el.value.trim() || el.value === el.dataset.auto) { el.value = v || ''; el.dataset.auto = el.value; } };
        fill(titleIn, info.title); fill(authorsIn, info.authors); fill(pubIn, info.published);
        isbnMsg.textContent += ` · Found in ${info.sources.join(' & ')}${info.workIsbns.length ? ` · ${info.workIsbns.length} other edition ISBN(s)` : ''}`;
      } else {
        isbnMsg.textContent += info.errors.length ? ' · Online lookup unavailable — please type the details.' : ' · Not found online — please type the details.';
      }
      state.workIsbns = info.workIsbns;
      let auto = 0;
      for (const i of info.workIsbns) {
        if (!state.alternates.has(i)) state.alternates.set(i, { checked: auto++ < MAX_AUTO_ALTERNATES, source: 'Found online' });
      }
      renderAlts();
    });
    await checkDuplicates();
  }

  function addAlternates() {
    const results = extract(altIn.value);
    const bad = results.filter((r) => !r.valid);
    for (const r of results.filter((x) => x.valid && x.isbn13 !== state.primary)) state.alternates.set(r.isbn13, { checked: true, source: 'Added by you' });
    altIn.value = bad.map((b) => b.input).join(' ');
    if (bad.length) toast(`Not added (invalid): ${bad.map((b) => `${b.input} — ${b.error}`).join('; ')}`, 'error', 8000);
    renderAlts();
    checkDuplicates();
  }

  let timer;
  isbnIn.addEventListener('input', () => {
    clearTimeout(timer);
    const n = normalize(isbnIn.value);
    timer = setTimeout(() => onIsbn(), n.valid ? 150 : 700);
  });
  isbnIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); onIsbn(); } });
  lookupBtn.addEventListener('click', () => { clearTimeout(timer); onIsbn(true); });
  titleIn.addEventListener('change', () => checkDuplicates());
  for (const el of [titleIn, authorsIn, pubIn]) el.addEventListener('input', renderPreview);
  altIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAlternates(); } });
  altAdd.addEventListener('click', addAlternates);

  function reset() {
    ctx.lastAge = ageGrp.values();
    ctx.lastCampus = campusGrp.values();
    ctx.lastMeeting = meetingSel.value;
    Object.assign(state, { primary: null, workIsbns: [], blocking: [], soft: [], similar: [], lastLookup: '' });
    state.alternates.clear();
    for (const el of [isbnIn, titleIn, authorsIn, pubIn, altIn, notesIn]) el.value = '';
    ackSimilar.checked = false;
    isbnMsg.textContent = '';
    renderAlts(); renderDup(); clear(formErr); renderPreview();
    isbnIn.focus();
  }

  const form = h('form', { class: 'card form', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    clear(formErr);
    const problems = [];
    if (!state.primary) problems.push('Enter a valid ISBN.');
    if (!titleIn.value.trim()) problems.push('Title is required.');
    if (!ageGrp.values().length) problems.push('Pick at least one age level.');
    if (!campusGrp.values().length) problems.push('Pick at least one campus.');
    if (problems.length) { formErr.append(alertBox('error', problems.join(' '))); return; }
    await busy(submitBtn, 'Submitting…', async () => {
      await checkDuplicates(); // re-check right before saving
      if (state.blocking.length) { formErr.append(alertBox('error', 'This book is already in the system — see above.')); return; }
      if ((state.soft.length || state.similar.length) && !ackSimilar.checked) { formErr.append(alertBox('error', 'Please review the possible duplicate above and tick the confirmation box.')); return; }
      try {
        const { isbnErrors } = await createBook(ctx, {
          title: titleIn.value, isbn: state.primary, authors: authorsIn.value, published: pubIn.value,
          age: ageGrp.values(), campus: campusGrp.values(), meeting: meetingSel.value, notes: notesIn.value,
          alternates: [...state.alternates].filter(([, a]) => a.checked && !a.dup).map(([i]) => i),
        });
        toast(`Submitted “${titleIn.value.trim()}”.`, 'success');
        if (isbnErrors.length) toast(`Some alternate ISBNs weren’t saved: ${isbnErrors.join('; ')}`, 'error', 10000);
        reset();
      } catch (err) {
        formErr.append(errorBox(err, 'Could not submit'));
      }
    });
  } },
    h('section', { class: 'form-section' },
      h('h2', { class: 'section-title' }, h('span', { class: 'step-n' }, '1'), 'Find the book'),
      h('div', { class: 'row' }, field('ISBN *', h('div', { class: 'inline' }, isbnIn, lookupBtn)), isbnMsg),
      preview,
      dupPanel),
    h('section', { class: 'form-section' },
      h('h2', { class: 'section-title' }, h('span', { class: 'step-n' }, '2'), 'Book details'),
      h('div', { class: 'grid-2' }, field('Title *', titleIn), field('Author(s)', authorsIn)),
      h('div', { class: 'grid-2' }, field('Date published', pubIn), field('Board meeting *', meetingSel)),
      h('fieldset', null, h('legend', null, 'Other ISBNs for this book'),
        h('p', { class: 'hint' }, 'Checked ISBNs are saved so nobody can submit another edition of this book. Uncheck any that are a genuinely different book.'),
        altList, h('div', { class: 'inline' }, altIn, altAdd))),
    h('section', { class: 'form-section' },
      h('h2', { class: 'section-title' }, h('span', { class: 'step-n' }, '3'), 'Who it’s for'),
      h('div', { class: 'grid-2' },
        h('fieldset', null, h('legend', null, 'Age level *'), ageGrp),
        h('fieldset', null, h('legend', null, 'Campus *'), campusGrp)),
      field('Notes', notesIn)),
    ackWrap,
    formErr,
    h('div', { class: 'actions form-actions' }, submitBtn, h('button', { type: 'button', class: 'btn btn-ghost', onclick: reset }, 'Clear form')));

  mount(root, form);
  renderAlts();
  isbnIn.focus();
}

// ─── Add many ───────────────────────────────────────────────────────
const TEMPLATE_HEADER = ['ISBN', 'Title', 'Author(s)', 'Date Published', 'Age Level', 'Campus', 'Alternate ISBNs', 'Notes'];

export function mapColumns(header) {
  const idx = { alts: [] };
  header.forEach((raw, i) => {
    const hd = String(raw || '').toLowerCase().trim();
    if (!hd || /already|approved with/.test(hd)) return; // old sheet's flag column
    if (/alt|other/.test(hd) && /isbn/.test(hd)) idx.alts.push(i);
    else if (/isbn/.test(hd) && idx.isbn === undefined) idx.isbn = i;
    else if (/title/.test(hd) && idx.title === undefined) idx.title = i;
    else if (/author/.test(hd) && idx.authors === undefined) idx.authors = i;
    else if (/publish|pub date|year/.test(hd) && idx.published === undefined) idx.published = i;
    else if (/age|level|grade/.test(hd) && idx.age === undefined) idx.age = i;
    else if (/campus|school/.test(hd) && idx.campus === undefined) idx.campus = i;
    else if (/note|comment/.test(hd) && idx.notes === undefined) idx.notes = i;
  });
  return idx;
}

export function rowsToItems(rows, defaults) {
  if (!rows.length) return [];
  const hasHeader = rows[0].some((c) => /isbn|title/i.test(String(c)));
  const idx = hasHeader ? mapColumns(rows[0]) : { isbn: 0, title: 1, authors: 2, published: 3, age: 4, campus: 5, alts: [6], notes: 7 };
  const data = hasHeader ? rows.slice(1) : rows;
  const get = (r, i) => (i === undefined ? '' : String(r[i] ?? '').trim());
  const meaningful = (r) => [idx.isbn, idx.title, idx.authors, ...idx.alts].some((i) => get(r, i));
  return data.map((r, n) => ({ r, n })).filter(({ r }) => meaningful(r)).map(({ r, n }) => {
    const problems = [];
    const isbn = normalize(get(r, idx.isbn));
    if (!isbn.valid) problems.push(`ISBN: ${isbn.error}`);
    const title = get(r, idx.title);
    const ageText = get(r, idx.age);
    const { ages, bad: badAge } = ageText ? parseAges(ageText) : { ages: defaults.age, bad: [] };
    if (badAge.length) problems.push(`Unknown age level “${badAge.join(', ')}”`);
    if (!ages.length) problems.push('Age level missing');
    const campusText = get(r, idx.campus);
    const { campuses, bad: badCampus } = campusText ? parseCampuses(campusText) : { campuses: defaults.campus, bad: [] };
    if (badCampus.length) problems.push(`Unknown campus “${badCampus.join(', ')}”`);
    if (!campuses.length) problems.push('Campus missing');
    const altResults = idx.alts.flatMap((i) => extract(get(r, i)));
    const alternates = [...new Set(altResults.filter((a) => a.valid).map((a) => a.isbn13))].filter((a) => a !== isbn.isbn13);
    const altBad = altResults.filter((a) => !a.valid).map((a) => a.input);
    return {
      n: n + (hasHeader ? 2 : 1), isbn: isbn.isbn13, isbnInput: isbn.input, title, authors: get(r, idx.authors), published: get(r, idx.published),
      age: ages, campus: campuses, alternates, onlineAlts: [], saveAlts: null, altBad, notes: get(r, idx.notes), problems, warnings: [], workIsbns: [], selected: false, result: null,
    };
  });
}

function bulkAdd(root, ctx) {
  let items = [];
  const fileIn = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.xlsx', class: 'file-input' });
  const pasteIn = h('textarea', { rows: 5, placeholder: 'Or copy rows from Excel/Google Sheets (including the header row) and paste here' });
  const ageGrp = checkGroup('bage', AGE_LEVELS, ctx.lastAge || []);
  const campusGrp = checkGroup('bcampus', CAMPUSES, ctx.campus ? [ctx.campus] : []);
  const meetingSel = select(BOARD_MEETINGS, ctx.lastMeeting || DEFAULT_BOARD_MEETING);
  const onlineChk = h('input', { type: 'checkbox', checked: true });
  const titleChk = h('input', { type: 'checkbox', checked: true });
  const checkBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Check rows');
  const submitBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: true }, 'Submit selected');
  const prog = progress();
  const msg = h('div');
  const tableWrap = h('div', { class: 'table-wrap' });
  const summary = h('div', { class: 'summary' });

  async function loadRows() {
    const defaults = { age: ageGrp.values(), campus: campusGrp.values() };
    let rows = [];
    if (fileIn.files[0]) rows = await readTable(fileIn.files[0]);
    else if (pasteIn.value.trim()) rows = (await import('../csv.js')).parse(pasteIn.value);
    if (!rows.length) throw new Error('Choose a file or paste some rows first.');
    return rowsToItems(rows, defaults);
  }

  function renderTable() {
    const ready = items.filter((i) => !i.problems.length && !i.result);
    const sel = items.filter((i) => i.selected);
    const pill = (n, label, cls) => h('span', { class: `pill ${cls}` }, h('strong', null, n), ` ${label}`);
    mount(summary,
      pill(items.length, 'rows', ''),
      pill(ready.length, 'ready', 'pill-ok'),
      pill(items.filter((i) => i.problems.length).length, 'with problems', 'pill-err'),
      pill(items.filter((i) => i.warnings.length && !i.problems.length).length, 'to double-check', 'pill-warn'),
      pill(items.filter((i) => i.result === 'ok').length, 'submitted', 'pill-primary'));
    submitBtn.disabled = !sel.length;
    submitBtn.textContent = sel.length ? `Submit ${sel.length} selected` : 'Submit selected';
    const allCb = h('input', { type: 'checkbox', 'aria-label': 'Select all ready rows', onchange: () => { items.forEach((i) => { if (!i.problems.length && !i.result && !i.warnings.length) i.selected = allCb.checked; }); renderTable(); } });
    mount(tableWrap, responsive(h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, allCb), ['Row', 'ISBN', 'Title / Author', 'Age', 'Campus', 'Alt ISBNs', 'Check result'].map((t) => h('th', null, t)))),
      h('tbody', null, items.map((it) => {
        const cb = h('input', { type: 'checkbox', checked: it.selected, disabled: !!it.problems.length || !!it.result, onchange: () => { it.selected = cb.checked; renderTable(); } });
        const cls = it.result === 'ok' ? 'row-ok' : it.problems.length ? 'row-bad' : it.warnings.length ? 'row-warn' : '';
        return h('tr', { class: cls },
          h('td', { class: 'cell-check' }, cb), h('td', null, it.n), h('td', { class: 'mono' }, it.isbn ? display(it.isbn) : it.isbnInput),
          h('td', { class: 'title-cell' }, bookCell(it.isbn, it.title, it.authors)),
          h('td', null, it.age.join(', ')), h('td', null, it.campus.join(', ')), h('td', null, (it.saveAlts || it.alternates).length || ''),
          h('td', { class: 'small' },
            it.result === 'ok' ? '✓ Submitted' : null,
            it.result && it.result !== 'ok' ? h('span', { class: 'text-error' }, it.result) : null,
            it.problems.map((p) => h('div', { class: 'text-error' }, p)),
            it.warnings.map((p) => h('div', { class: 'text-warn' }, p)),
            !it.result && !it.problems.length && !it.warnings.length ? (it.checked ? 'Ready' : '') : null,
            it.altBad.length ? h('div', { class: 'muted' }, `Ignored bad alt ISBN(s): ${it.altBad.join(', ')}`) : null));
      })))));
  }

  checkBtn.addEventListener('click', () => busy(checkBtn, 'Checking…', async () => {
    clear(msg);
    try {
      items = await loadRows();
      summary.parentElement.hidden = false;
      renderTable();
      // Online fill-in
      if (onlineChk.checked) {
        const need = items.filter((i) => i.isbn);
        await pool(need, 4, async (it) => {
          try {
            const info = await lookupIsbn(it.isbn);
            if (!it.title && info.title) it.title = info.title;
            if (!it.authors && info.authors) it.authors = info.authors;
            if (!it.published && info.published) it.published = info.published;
            it.workIsbns = info.workIsbns;
            it.onlineAlts = info.workIsbns.filter((w) => !it.alternates.includes(w) && w !== it.isbn).slice(0, Math.max(0, MAX_AUTO_ALTERNATES - it.alternates.length));
          } catch { /* lookup is best-effort */ }
        }, (d, t) => prog.set(d, t, `Looking up books online… ${d}/${t}`));
      }
      for (const it of items) if (!it.title && !it.problems.includes('Title missing')) it.problems.push('Title missing');
      // Duplicates within the file
      const owner = new Map();
      for (const it of items) {
        if (!it.isbn) continue;
        const mine = [it.isbn, ...it.alternates];
        const clash = mine.map((i) => owner.get(i)).find((o) => o && o !== it);
        if (clash) it.problems.push(`Same book as row ${clash.n} in this file`);
        else mine.forEach((i) => owner.set(i, it));
      }
      const byTitle = new Map();
      for (const it of items) {
        const k = titleKey(it.title);
        if (!k || it.problems.length) continue;
        if (byTitle.has(k)) it.warnings.push(`Same title as row ${byTitle.get(k).n} (different ISBN)`);
        else byTitle.set(k, it);
      }
      // Duplicates in Knack
      const valid = items.filter((i) => i.isbn);
      const allIsbns = valid.flatMap((i) => [i.isbn, ...i.alternates, ...i.workIsbns]);
      const hits = await findIsbnMatches(allIsbns, { checkBooks: false, onProgress: (d, t) => prog.set(d, t, `Checking ISBNs against existing books… ${d}/${t}`) });
      for (const it of valid) {
        const hard = [it.isbn, ...it.alternates].find((i) => hits.has(i));
        const soft = it.workIsbns.find((i) => hits.has(i));
        if (hard) it.problems.push(`Already submitted: “${hits.get(hard).bookTitle}” (ISBN ${hard})`);
        else if (soft) it.warnings.push(`Another edition is already submitted: “${hits.get(soft).bookTitle}”`);
        it.saveAlts = [...it.alternates, ...(it.onlineAlts || [])].filter((i) => !hits.has(i));
      }
      if (titleChk.checked) {
        const todo = items.filter((i) => i.title && !i.problems.length);
        await pool(todo, 4, async (it) => {
          const sim = await findSimilarTitles(it.title);
          if (sim.length) it.warnings.push(`Same title already in system: “${text(sim[0], F.title)}” (${text(sim[0], F.status)})`);
        }, (d, t) => prog.set(d, t, `Checking titles… ${d}/${t}`));
      }
      for (const it of items) { it.checked = true; it.selected = !it.problems.length && !it.warnings.length; }
      prog.hidden = true;
      renderTable();
    } catch (err) {
      prog.hidden = true;
      msg.append(errorBox(err, 'Check failed'));
    }
  }));

  submitBtn.addEventListener('click', () => busy(submitBtn, 'Submitting…', async () => {
    const todo = items.filter((i) => i.selected);
    if (!todo.length) return;
    ctx.lastMeeting = meetingSel.value;
    const res = await pool(todo, 2, (it) => createBook(ctx, { ...it, alternates: it.saveAlts || it.alternates, meeting: meetingSel.value }), (d, t) => prog.set(d, t, `Submitting… ${d}/${t}`));
    res.forEach((r, i) => {
      const it = todo[i];
      it.selected = false;
      it.result = r.ok ? 'ok' : r.error.message;
      if (r.ok && r.value.isbnErrors.length) it.warnings.push(`Some alternate ISBNs not saved: ${r.value.isbnErrors.join('; ')}`);
    });
    prog.hidden = true;
    const ok = res.filter((r) => r.ok).length;
    toast(`${ok} of ${todo.length} books submitted.`, ok === todo.length ? 'success' : 'error');
    renderTable();
  }));

  const templateBtn = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => download('book-submission-template.csv', stringify([TEMPLATE_HEADER, ['9780593428436', 'A gift of dust : how Saharan plumes feed the planet', 'Brockenbrough, Martha', '2025', 'Elementary', 'CLE', '9780593428429 9780593428443', '']])) }, 'Download template');
  const resultsBtn = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => download('bulk-check-results.csv', stringify([['Row', 'ISBN', 'Title', 'Authors', 'Problems', 'Warnings', 'Result'], ...items.map((i) => [i.n, i.isbn || i.isbnInput, i.title, i.authors, i.problems.join(' | '), i.warnings.join(' | '), i.result === 'ok' ? 'Submitted' : i.result || ''])])) }, 'Download results');

  mount(root,
    h('div', { class: 'card' },
      h('p', null, 'Upload a spreadsheet (.xlsx or .csv) or paste rows. Columns are matched by header name — ISBN, Title, Author(s), Date Published, Age Level, Campus, and any number of “Alternative ISBN” columns. Your old order sheet works as-is.'),
      h('div', { class: 'grid-2' }, dropZone(fileIn, 'Drop your spreadsheet here', '.xlsx or .csv'), h('div', { class: 'align-end' }, templateBtn)),
      field('…or paste', pasteIn),
      h('div', { class: 'grid-3' },
        h('fieldset', null, h('legend', null, 'Age level (for rows that leave it blank)'), ageGrp),
        h('fieldset', null, h('legend', null, 'Campus (for rows that leave it blank)'), campusGrp),
        field('Board meeting for all rows *', meetingSel)),
      h('label', { class: 'chk' }, onlineChk, ' Fill in missing titles/authors and find other-edition ISBNs online'),
      h('label', { class: 'chk' }, titleChk, ' Also check for matching titles (slower)'),
      h('div', { class: 'actions' }, checkBtn, submitBtn, resultsBtn), prog, msg),
    h('div', { class: 'card', hidden: true }, summary, tableWrap));
}

// ─── My submissions ────────────────────────────────────────────────
function mySubmissions(root, ctx) {
  const meetingSel = select([['', 'All meetings'], ...BOARD_MEETINGS], ctx.lastMeeting || '');
  const statusSel = select([['', 'All statuses'], ...STATUSES], '');
  const cards = h('div', { class: 'stat-cards' });
  const out = h('div');
  let page = 1;
  let lastCounts = null;

  // One aggregate call per meeting change (not per page or status click).
  async function loadCounts() {
    if (!ctx.librarianId) return;
    mount(cards, STATUSES.slice(0, 5).map(() => h('div', { class: 'stat stat-loading' }, h('span', { class: 'sk sk-line' }))));
    const rules = [{ field: F.submittedBy, operator: 'is', value: ctx.librarianId }];
    if (meetingSel.value) rules.push({ field: F.meeting, operator: 'is', value: meetingSel.value });
    try {
      const counts = await countBy(OBJ.books, F.status, { match: 'and', rules });
      renderCards(counts);
    } catch { clear(cards); } // counts are a nice-to-have; the list below still works
  }

  function renderCards(counts) {
    lastCounts = counts;
    const total = STATUSES.reduce((a, s) => a + (counts.get(s) || 0), 0);
    const pick = (s) => { statusSel.value = s; page = 1; renderCards(counts); load(); };
    mount(cards,
      h('button', { class: `stat${!statusSel.value ? ' active' : ''}`, onclick: () => pick('') }, h('span', { class: 'stat-n' }, total), h('span', { class: 'stat-l' }, 'All my books')),
      STATUSES.filter((s) => s !== 'Withdrawn' || counts.get(s)).map((s) => h('button', { class: `stat s-${statusKey(s)}${statusSel.value === s ? ' active' : ''}`, onclick: () => pick(s) },
        h('span', { class: 'stat-n' }, counts.get(s) || 0), h('span', { class: 'stat-l' }, s))),
      h('div', { class: 'stat-bar-wrap' }, statusBar(STATUSES, counts)));
  }

  async function load() {
    mount(out, skeleton(4));
    if (!ctx.librarianId) { mount(out, alertBox('warn', 'Your account is not linked to a librarian record, so submissions can’t be listed.')); return; }
    const rules = [{ field: F.submittedBy, operator: 'is', value: ctx.librarianId }];
    if (meetingSel.value) rules.push({ field: F.meeting, operator: 'is', value: meetingSel.value });
    if (statusSel.value) rules.push({ field: F.status, operator: 'is', value: statusSel.value });
    try {
      const r = await list(OBJ.books, { filters: { match: 'and', rules }, page, rowsPerPage: 50, sortField: F.createdOn, sortOrder: 'desc' });
      renderList(r);
    } catch (err) { mount(out, errorBox(err, 'Could not load your submissions')); }
  }

  function renderList(r) {
    if (!r.records.length) {
      mount(out, emptyState('📭', statusSel.value || meetingSel.value ? 'No books match these filters' : 'You haven’t submitted any books yet',
        statusSel.value || meetingSel.value ? 'Try a different board meeting or status.' : 'Books you submit will appear here with their review status.',
        statusSel.value || meetingSel.value ? null : h('a', { class: 'btn btn-primary', href: '#/librarian/add' }, 'Add a book')));
      return;
    }
    mount(out,
      h('div', { class: 'muted small' }, `${r.total_records} book(s)`),
      h('div', { class: 'table-wrap' }, responsive(h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Title / Author', 'ISBN', 'Age', 'Campus', 'Meeting', 'Status', 'Review notes', ''].map((t) => h('th', null, t)))),
        h('tbody', null, r.records.map((b) => h('tr', null,
          titleCell(b),
          h('td', { class: 'mono' }, display(text(b, F.isbn))),
          h('td', null, arr(b, F.age).join(', ')), h('td', null, arr(b, F.campus).join(', ')), h('td', null, text(b, F.meeting)),
          h('td', null, statusBadge(text(b, F.status))),
          h('td', { class: 'small' }, text(b, F.lumaConditions) || text(b, F.adminNotes)),
          h('td', { class: 'row-actions' }, text(b, F.status) === 'Submitted' ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => editMine(b) }, 'Edit') : null))))))),
      pager(r, (p) => { page = p; load(); }));
  }

  function editMine(b) {
    const titleIn = h('input', { type: 'text', value: text(b, F.title) });
    const authorsIn = h('input', { type: 'text', value: text(b, F.authors) });
    const pubIn = h('input', { type: 'text', value: text(b, F.published) });
    const ageGrp = checkGroup('eage', AGE_LEVELS, arr(b, F.age));
    const campusGrp = checkGroup('ecampus', CAMPUSES, arr(b, F.campus));
    const meetingSel2 = select(BOARD_MEETINGS, text(b, F.meeting));
    const notesIn = h('textarea', { rows: 2, value: text(b, F.libNotes) });
    const err = h('div');
    const save = h('button', { class: 'btn btn-primary' }, 'Save');
    const withdraw = h('button', { class: 'btn btn-danger-ghost' }, 'Withdraw request');
    const m = modal('Edit submission', h('div', { class: 'form' },
      field('Title', titleIn), field('Author(s)', authorsIn), field('Date published', pubIn), field('Board meeting', meetingSel2),
      h('fieldset', null, h('legend', null, 'Age level'), ageGrp), h('fieldset', null, h('legend', null, 'Campus'), campusGrp),
      field('Notes', notesIn), h('p', { class: 'hint' }, 'To change the ISBN, withdraw this request and submit again.'), err), [withdraw, save]);
    save.addEventListener('click', () => busy(save, 'Saving…', async () => {
      clear(err);
      if (!titleIn.value.trim() || !ageGrp.values().length || !campusGrp.values().length) { err.append(alertBox('error', 'Title, age level and campus are required.')); return; }
      try {
        await update(OBJ.books, b.id, { [F.title]: titleIn.value.trim(), [F.authors]: authorsIn.value.trim(), [F.published]: pubIn.value.trim(), [F.age]: ageGrp.values(), [F.campus]: campusGrp.values(), [F.meeting]: meetingSel2.value, [F.libNotes]: notesIn.value.trim() });
        m.close(); toast('Saved.', 'success'); load();
      } catch (e) { err.append(errorBox(e, 'Could not save')); }
    }));
    withdraw.addEventListener('click', () => busy(withdraw, 'Withdrawing…', async () => {
      clear(err);
      try { await update(OBJ.books, b.id, { [F.status]: 'Withdrawn' }); m.close(); toast('Request withdrawn.', 'success'); loadCounts(); load(); }
      catch (e) { err.append(errorBox(e, 'Could not withdraw')); }
    }));
  }

  meetingSel.addEventListener('change', () => { page = 1; loadCounts(); load(); });
  statusSel.addEventListener('change', () => { page = 1; if (lastCounts) renderCards(lastCounts); load(); });
  mount(root, cards, h('div', { class: 'card' }, h('div', { class: 'filters' }, field('Board meeting', meetingSel), field('Status', statusSel)), out));
  loadCounts();
  load();
}

export function pager(r, go) {
  if ((r.total_pages || 1) <= 1) return null;
  return h('div', { class: 'pager' },
    h('button', { class: 'btn btn-small btn-ghost', disabled: r.current_page <= 1, onclick: () => go(r.current_page - 1) }, '‹ Prev'),
    h('span', { class: 'muted small' }, `Page ${r.current_page} of ${r.total_pages}`),
    h('button', { class: 'btn btn-small btn-ghost', disabled: r.current_page >= r.total_pages, onclick: () => go(Number(r.current_page) + 1) }, 'Next ›'));
}

// ─── Search all ─────────────────────────────────────────────────────
function searchAll(root) {
  const q = h('input', { type: 'search', placeholder: 'Title, author, or any ISBN', class: 'search-input', 'aria-label': 'Search books' });
  const btn = h('button', { class: 'btn btn-primary' }, 'Search');
  const out = h('div', null, emptyState('🔎', 'Search before you submit', 'ISBN searches also match the alternate ISBNs of every submitted book.'));
  async function run() {
    const term = q.value.trim();
    if (!term) return;
    mount(out, skeleton(3));
    try {
      const n = normalize(term);
      let records;
      if (n.valid) {
        const hits = await findIsbnMatches([n.isbn13]);
        records = [...(await booksById([...hits.values()].map((v) => v.bookId))).values()];
      } else {
        const r = await list(OBJ.books, { filters: { match: 'or', rules: [{ field: F.title, operator: 'contains', value: term }, { field: F.authors, operator: 'contains', value: term }] }, rowsPerPage: 100, sortField: F.title });
        records = r.records;
      }
      if (!records.length) {
        mount(out, n.valid
          ? h('div', { class: 'result-clear' }, cover(n.isbn13, term, 'L'), h('div', null, h('h3', null, '✓ Not in the system yet'), h('p', null, `No book uses ISBN ${display(n.isbn13)}, as its main ISBN or as another edition. It’s OK to submit.`), h('a', { class: 'btn btn-primary', href: '#/librarian/add' }, 'Add this book')))
          : emptyState('📚', 'No matches', `Nothing matched “${term}”. Try a shorter word, or search by ISBN.`));
        return;
      }
      mount(out, h('div', { class: 'muted small' }, `${records.length} result(s)${records.length === 100 ? ' (showing the first 100; try a more specific search)' : ''}`),
        h('div', { class: 'result-grid' }, records.map((b) => h('article', { class: 'result-card' },
          cover(text(b, F.isbn), text(b, F.title), 'L'),
          h('div', { class: 'rc-body' },
            h('div', { class: 'rc-title' }, text(b, F.title)),
            h('div', { class: 'muted small' }, text(b, F.authors)),
            statusBadge(text(b, F.status)),
            h('dl', { class: 'rc-meta' },
              h('dt', null, 'ISBN'), h('dd', { class: 'mono' }, display(text(b, F.isbn))),
              h('dt', null, 'Meeting'), h('dd', null, text(b, F.meeting) || '—'),
              h('dt', null, 'Campus'), h('dd', null, arr(b, F.campus).join(', ') || '—'),
              text(b, F.submittedBy) ? [h('dt', null, 'By'), h('dd', null, text(b, F.submittedBy))] : null))))));
    } catch (err) { mount(out, errorBox(err, 'Search failed')); }
  }
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  btn.addEventListener('click', run);
  mount(root, h('div', { class: 'card search-card' }, h('div', { class: 'inline' }, q, btn)), out);
  q.focus();
}

/** Styled drag-and-drop wrapper around a file input. */
export function dropZone(input, title, sub) {
  const name = h('span', { class: 'dz-file' });
  const zone = h('label', { class: 'dropzone' },
    input,
    h('span', { class: 'dz-icon', 'aria-hidden': 'true' }, '⬆'),
    h('span', { class: 'dz-title' }, title),
    h('span', { class: 'muted small' }, `or click to choose · ${sub}`),
    name);
  const show = () => { name.textContent = input.files[0] ? `Selected: ${input.files[0].name}` : ''; zone.classList.toggle('has-file', !!input.files[0]); };
  input.addEventListener('change', show);
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    if (e.dataTransfer.files.length) { input.files = e.dataTransfer.files; show(); input.dispatchEvent(new Event('change')); }
  });
  return zone;
}
