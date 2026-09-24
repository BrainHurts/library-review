// Per-book row actions: refresh details from the online catalogs, and view the raw API data.
import { API_BASE, OBJ, F, IF, MAX_AUTO_ALTERNATES } from './config.js';
import { h, mount, toast, errorBox, alertBox, modal, busy, cover, skeleton, rowMenu } from './ui.js';
import { create, update, pool, text, raw } from './api.js';
import { display } from './isbn.js';
import { lookupIsbn, googleUrl, openLibraryUrl, fetchRaw } from './lookup.js';
import { findIsbnMatches } from './dupes.js';
import { isbnRecordsFor } from './books.js';

/** Admins can change any book; librarians only their own, and only while it's still "Submitted". */
export function canEditBook(ctx, b) {
  if (ctx.isAdmin) return true;
  const mine = (raw(b, F.submittedBy) || []).some((x) => x && x.id === ctx.librarianId);
  return mine && text(b, F.status) === 'Submitted';
}

/**
 * The "⋯" menu for a book row.
 * @param {object} ctx     app context
 * @param {object} b       the Knack book record already on screen
 * @param {Function} onSaved  called with the updated record after a refresh is applied
 * @param {object[]} extra   extra menu items placed first (e.g. "Open")
 */
export function bookMenu(ctx, b, onSaved, extra = []) {
  return rowMenu(`Actions for “${text(b, F.title)}”`, [
    ...extra,
    { icon: '↻', label: 'Refresh book data', hint: 'Check Google Books & Open Library', onSelect: () => refreshBook(ctx, b, onSaved) },
    { icon: '{ }', label: 'View raw data', hint: 'Opens the API results in a new tab', onSelect: () => openRawData(b) },
  ]);
}

// ─── Refresh book data ──────────────────────────────────────────────
export function refreshBook(ctx, b, onSaved) {
  const isbn = text(b, F.isbn);
  const editable = canEditBook(ctx, b);
  const body = h('div', { class: 'form' }, skeleton(3));
  const save = h('button', { class: 'btn btn-primary', disabled: true }, 'Apply selected');
  const m = modal(`Refresh book data`, body, editable ? [save] : []);

  (async () => {
    let info;
    let isbnRecs;
    let hits;
    try {
      [info, isbnRecs] = await Promise.all([lookupIsbn(isbn), isbnRecordsFor(b.id)]);
    } catch (err) { mount(body, errorBox(err, 'Could not refresh')); return; }

    const head = h('div', { class: 'modal-book' }, cover(isbn, text(b, F.title), 'L'),
      h('div', null, h('strong', null, text(b, F.title)), h('span', { class: 'mono small' }, `ISBN ${display(isbn)}`),
        h('span', { class: 'muted small' }, info.found ? `Found in ${info.sources.join(' & ')}` : 'Not found online')));

    if (!info.found) {
      mount(body, head, info.errors.length
        ? alertBox('error', h('strong', null, 'The online lookup failed. '), info.errors.join(' · '), h('div', { class: 'small' }, 'The district web filter may be blocking these sites.'))
        : alertBox('warn', `Neither Google Books nor Open Library has a record for ISBN ${display(isbn)}.`));
      return;
    }

    const known = new Set(isbnRecs.map((r) => String(raw(r, IF.isbn))));
    known.add(isbn);
    const fresh = info.workIsbns.filter((i) => !known.has(i));
    try { hits = fresh.length ? await findIsbnMatches(fresh) : new Map(); }
    catch (err) { mount(body, head, errorBox(err, 'Duplicate check failed')); return; }

    const changes = [['Title', F.title, info.title], ['Author(s)', F.authors, info.authors], ['Date published', F.published, info.published]]
      .map(([label, key, online]) => ({ label, key, current: text(b, key), online: String(online || '').trim() }))
      .filter((c) => c.online && c.online !== c.current.trim());
    let auto = 0;
    const alts = fresh.map((i) => ({ isbn: i, taken: hits.get(i), checked: !hits.has(i) && auto++ < MAX_AUTO_ALTERNATES }));

    const refreshSave = () => { save.disabled = !changes.some((c) => c.checked) && !alts.some((a) => a.checked); };

    const changeTable = changes.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table cmp' },
      h('thead', null, h('tr', null, h('th', null, h('span', { class: 'sr-only' }, 'Apply')), h('th', null, 'Field'), h('th', null, 'Now'), h('th', null, 'Online'))),
      h('tbody', null, changes.map((c) => {
        c.checked = editable;
        const cb = h('input', { type: 'checkbox', checked: c.checked, disabled: !editable, 'aria-label': `Use the online ${c.label.toLowerCase()}`, onchange: () => { c.checked = cb.checked; refreshSave(); } });
        return h('tr', null, h('td', null, cb), h('th', { scope: 'row' }, c.label),
          h('td', { class: 'cmp-old' }, c.current || h('em', { class: 'muted' }, 'blank')), h('td', { class: 'cmp-new' }, c.online));
      })))) : null;

    const altList = alts.length ? h('div', { class: 'alt-list' }, alts.map((a) => {
      const cb = h('input', { type: 'checkbox', checked: a.checked, disabled: !editable || !!a.taken, onchange: () => { a.checked = cb.checked; refreshSave(); } });
      return h('label', { class: `alt-chip${a.taken ? ' alt-dup' : ''}`, title: a.taken ? `Already on “${a.taken.bookTitle}”` : 'Another edition found online' }, cb, ' ', display(a.isbn));
    })) : null;

    const upToDate = !changes.length && !alts.some((a) => !a.taken);
    mount(body, head,
      upToDate ? alertBox('ok', h('strong', null, '✓ Up to date. '), 'The title, authors, date and other-edition ISBNs already match the online catalogs.') : null,
      changeTable ? [h('h3', null, 'Details that differ'), changeTable] : null,
      altList ? [h('h3', null, `Other editions found online (${alts.length})`),
        h('p', { class: 'hint' }, 'Checked ISBNs are added to this book so nobody can submit another edition. Crossed-out ones are already on a different book.'), altList] : null,
      h('p', { class: 'hint' }, `${known.size} ISBN(s) already saved for this book.`),
      editable ? null : alertBox('warn', 'You can only apply changes to your own books while they are still “Submitted”. Ask an admin to update this one.'));
    refreshSave();

    save.addEventListener('click', () => busy(save, 'Saving…', async () => {
      const data = {};
      for (const c of changes) if (c.checked) data[c.key] = c.online;
      const add = alts.filter((a) => a.checked).map((a) => a.isbn);
      const res = await pool(add, 3, (i) => create(OBJ.isbns, { [IF.isbn]: i, [IF.type]: 'Alternate', [IF.book]: [{ id: b.id }] }));
      const failed = res.map((r, n) => (r.ok ? null : `${add[n]}: ${r.error.message}`)).filter(Boolean);
      const added = add.length - failed.length;
      try {
        if (Object.keys(data).length) Object.assign(b, await update(OBJ.books, b.id, data)); // the PUT response is the fresh record
        else if (added) { // no field changes: keep the on-screen ISBN count right without another request
          const n = (Number(text(b, F.isbnCount)) || 0) + added;
          b[F.isbnCount] = n; b[`${F.isbnCount}_raw`] = n;
        }
      } catch (err) { mount(body, errorBox(err, 'Could not save')); return; }
      m.close();
      const bits = [Object.keys(data).length && `${Object.keys(data).length} field(s) updated`, added && `${added} ISBN(s) added`].filter(Boolean);
      toast(bits.length ? `“${text(b, F.title)}”: ${bits.join(', ')}.` : 'Nothing changed.', 'success');
      if (failed.length) toast(`Some ISBNs weren’t added: ${failed.join('; ')}`, 'error', 10000);
      if (onSaved) onSaved(b);
    }));
  })();
}

// ─── View raw data ──────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Pretty-print JSON with light syntax colouring (escaped token by token). */
function highlight(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let out = '';
  let last = 0;
  for (const m of json.matchAll(re)) {
    out += esc(json.slice(last, m.index));
    if (m[1]) out += `<span class="${m[2] ? 'k' : 's'}">${esc(m[1])}</span>${m[2] ? esc(m[2]) : ''}`;
    else out += `<span class="${m[3] ? 'b' : 'n'}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(json.slice(last));
}

function currentTheme() {
  const t = document.documentElement.dataset.theme;
  if (t) return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function rawPage(title, isbn, sections) {
  const now = new Date().toLocaleString();
  const body = sections
    ? sections.map((s, i) => `
      <details open>
        <summary>
          <span class="name">${esc(s.name)}</span>
          <span class="st ${s.ok ? 'ok' : 'bad'}">${s.ok ? esc(s.status) : esc(s.status ? `HTTP ${s.status}` : 'Failed')}</span>
          ${s.ms != null ? `<span class="ms">${s.ms} ms</span>` : ''}
        </summary>
        <div class="req"><code>${esc(s.request)}</code>${s.link ? ` <a href="${esc(s.link)}" target="_blank" rel="noopener">open ↗</a>` : ''}</div>
        ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
        <div class="tools"><button type="button" data-copy="${i}">Copy JSON</button></div>
        <pre>${s.error ? `<span class="err">${esc(s.error)}</span>` : highlight(s.body)}</pre>
      </details>`).join('')
    : '<p class="loading">Loading the API results…</p>';
  return `<!doctype html><html lang="en" data-theme="${currentTheme()}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raw data · ${esc(title)}</title>
<style>
  :root { --bg:#f4f6f9; --surface:#fff; --text:#17202c; --muted:#5b6676; --border:#dfe4eb; --primary:#1f5fae; --ok:#1a7443; --okbg:#e6f5ec; --err:#b42318; --errbg:#fdecea;
    --k:#1f5fae; --s:#1a7443; --n:#b45309; --b:#7c3aed; color-scheme: light; }
  [data-theme="dark"] { --bg:#0f1318; --surface:#1a2029; --text:#e7eaef; --muted:#9ba6b5; --border:#2b3441; --primary:#6aa5f2; --ok:#62d394; --okbg:#15301f; --err:#ff8f85; --errbg:#3a1c1a;
    --k:#8ab8f5; --s:#62d394; --n:#f0c060; --b:#c5a6f6; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 "Inter", system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 1.5rem 16px 4rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .2rem; } .sub { color: var(--muted); margin: 0 0 1.25rem; }
  .bar { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
  button { font: inherit; font-weight: 600; font-size: .85rem; padding: .35rem .75rem; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
  button:hover { border-color: var(--primary); }
  details { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; margin-bottom: .9rem; overflow: hidden; }
  summary { display: flex; gap: .6rem; align-items: center; padding: .8rem 1rem; cursor: pointer; font-weight: 650; }
  .name { flex: 1; } .ms { color: var(--muted); font-weight: 500; font-size: .85rem; }
  .st { font-size: .75rem; padding: .1rem .55rem; border-radius: 999px; }
  .st.ok { background: var(--okbg); color: var(--ok); } .st.bad { background: var(--errbg); color: var(--err); }
  .req { padding: 0 1rem; font-size: .82rem; color: var(--muted); word-break: break-all; }
  .req a { color: var(--primary); white-space: nowrap; }
  .note { padding: 0 1rem; margin: .3rem 0 0; font-size: .85rem; color: var(--muted); }
  .tools { padding: .5rem 1rem 0; }
  pre { margin: .6rem 0 0; padding: 1rem; border-top: 1px solid var(--border); overflow: auto; max-height: 70vh; font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .k { color: var(--k); } .s { color: var(--s); } .n { color: var(--n); } .b { color: var(--b); } .err { color: var(--err); }
  .loading { color: var(--muted); }
</style></head><body><main>
<h1>Raw data: ${esc(title)}</h1>
<p class="sub">ISBN ${esc(isbn)} · retrieved ${esc(now)}</p>
${sections ? '<div class="bar"><button type="button" id="copyAll">Copy all</button><button type="button" id="dl">Download .json</button><button type="button" id="toggle">Collapse all</button></div>' : ''}
${body}
</main>
${sections ? `<script>
  const data = ${JSON.stringify(sections.map((s) => ({ source: s.name, request: s.request, status: s.status, ok: s.ok, error: s.error, body: s.body }))).replace(/</g, '\\u003c')};
  const copy = (txt, btn) => navigator.clipboard.writeText(txt).then(() => { const o = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = o; }, 1500); }, () => alert('Copy failed — select the text and copy it manually.'));
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(JSON.stringify(data[b.dataset.copy].body, null, 2), b)));
  document.getElementById('copyAll').addEventListener('click', (e) => copy(JSON.stringify(data, null, 2), e.currentTarget));
  document.getElementById('dl').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = ${JSON.stringify(`book-${isbn}-raw.json`)};
    a.click();
  });
  document.getElementById('toggle').addEventListener('click', (e) => {
    const all = [...document.querySelectorAll('details')];
    const open = all.some((d) => d.open);
    all.forEach((d) => { d.open = !open; });
    e.currentTarget.textContent = open ? 'Expand all' : 'Collapse all';
  });
</script>` : ''}
</body></html>`;
}

/**
 * Open a new tab showing exactly what each API returns for this book: the Knack record already
 * loaded on screen (no extra request), its ISBN records, and the Google Books / Open Library results.
 */
export function openRawData(b) {
  const w = window.open('', '_blank'); // must happen synchronously inside the click
  if (!w) { toast('Your browser blocked the new tab. Allow pop-ups for this site and try again.', 'error', 8000); return; }
  const isbn = text(b, F.isbn);
  const title = text(b, F.title) || 'Book';
  const write = (sections) => { w.document.open(); w.document.write(rawPage(title, isbn, sections)); w.document.close(); };
  write(null);

  const knackIsbns = isbnRecordsFor(b.id).then(
    (body) => ({ ok: true, status: `${body.length} record(s)`, body }),
    (err) => ({ ok: false, status: err.status || 0, error: err.message }));
  Promise.all([knackIsbns, fetchRaw(googleUrl(isbn)), fetchRaw(openLibraryUrl(isbn))]).then(([isbns, g, o]) => {
    if (w.closed) return;
    const fmt = (r) => ({ ...r, status: r.ok ? `HTTP ${r.status}` : r.status });
    write([
      { name: 'Knack · Books record', ok: true, status: 'loaded', request: `GET ${API_BASE}/v1/objects/${OBJ.books}/records/${b.id}`,
        note: 'The record exactly as the list on the previous page received it (no extra request).', body: b },
      { name: 'Knack · ISBNs linked to this book', request: `GET ${API_BASE}/v1/objects/${OBJ.isbns}/records?filters=[${IF.book} is ${b.id}]`, ...isbns },
      { name: 'Google Books', request: `GET ${googleUrl(isbn)}`, link: googleUrl(isbn), ...fmt(g) },
      { name: 'Open Library', request: `GET ${openLibraryUrl(isbn)}`, link: openLibraryUrl(isbn), ...fmt(o) },
    ]);
  });
}
