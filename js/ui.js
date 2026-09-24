// Tiny DOM helpers — no framework.
import { parse } from './csv.js';
import { readXlsx } from './xlsx.js';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [p, pv] of Object.entries(v)) { if (p.startsWith('--')) el.style.setProperty(p, pv); else el.style[p] = pv; }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'html') el.innerHTML = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  return append(el, children);
}

let toastHost;
export function toast(message, kind = 'info', ms = 4500) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
}

/** A visible, copyable error box — never swallow API errors. */
export function errorBox(err, prefix = 'Something went wrong') {
  const msg = err && err.message ? err.message : String(err);
  return h('div', { class: 'alert alert-error', role: 'alert' },
    h('strong', null, `${prefix}: `), h('span', { class: 'selectable' }, msg));
}

export function alertBox(kind, ...children) {
  return h('div', { class: `alert alert-${kind}` }, ...children);
}

export function modal(title, body, actions = []) {
  const opener = document.activeElement;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (!document.querySelector('.modal-backdrop')) document.body.classList.remove('no-scroll');
    if (opener && opener.isConnected) opener.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') { // keep focus inside the dialog
      const f = [...dlg.querySelectorAll('button, input, select, textarea, a[href]')].filter((x) => !x.disabled && x.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  document.addEventListener('keydown', onKey);
  const dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions) : null);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  backdrop.append(dlg);
  document.body.append(backdrop);
  document.body.classList.add('no-scroll');
  const first = dlg.querySelector('input, select, textarea, button.btn');
  if (first) first.focus();
  return { close, el: dlg };
}

export function statusBadge(status) {
  const cls = {
    Submitted: 'b-submitted', 'Sent to Luma': 'b-sent', Approved: 'b-approved',
    'Approved with Conditions': 'b-cond', 'Not Approved': 'b-denied', Withdrawn: 'b-withdrawn',
  }[status] || 'b-neutral';
  return h('span', { class: `badge ${cls}` }, status || '—');
}

/** CSS class suffix for a status (used by badges, stat cards and the status bar). */
export function statusKey(status) {
  return {
    Submitted: 'submitted', 'Sent to Luma': 'sent', Approved: 'approved',
    'Approved with Conditions': 'cond', 'Not Approved': 'denied', Withdrawn: 'withdrawn',
  }[status] || 'neutral';
}

// Open Library rate-limits ISBN cover lookups (~100 per 5 min per network), so covers are
// lazy-loaded (only rows on screen are fetched), known misses aren't re-requested, and a burst
// of failures pauses cover requests for a while — books then show a lettered tile instead.
const coverMisses = new Set();
const coverErrors = [];
const PAUSE_KEY = 'lbr.coversPausedUntil';
function coversPaused() {
  try { return Number(sessionStorage.getItem(PAUSE_KEY) || 0) > Date.now(); } catch { return false; }
}
function noteCoverError(isbn) {
  coverMisses.add(isbn);
  const now = Date.now();
  coverErrors.push(now);
  while (coverErrors.length && now - coverErrors[0] > 20_000) coverErrors.shift();
  if (coverErrors.length >= 12) { // looks like throttling rather than genuinely missing covers
    try { sessionStorage.setItem(PAUSE_KEY, String(now + 5 * 60_000)); } catch { /* storage blocked */ }
    coverErrors.length = 0;
  }
}

/** Book cover from Open Library, falling back to a colored tile with the title's first letter. */
export function cover(isbn, title, size = 'S') {
  const letter = (String(title || '?').replace(/^(the|a|an)\s+/i, '').match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
  let hash = 0;
  for (const ch of String(title || '')) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  const tile = h('div', { class: `cover cover-${size} cover-blank`, style: { '--hue': hash }, 'aria-hidden': 'true' }, letter);
  const id = String(isbn || '').replace(/[^0-9X]/gi, '');
  if (!/^(\d{9}[\dX]|\d{13})$/i.test(id) || coverMisses.has(id) || coversPaused()) return tile;
  const img = h('img', { class: `cover cover-${size}`, alt: '', loading: 'lazy', decoding: 'async', src: `https://covers.openlibrary.org/b/isbn/${id}-${size === 'L' ? 'M' : 'S'}.jpg?default=false` });
  img.addEventListener('error', () => { noteCoverError(id); img.replaceWith(tile); });
  // Open Library sometimes returns a 1×1 placeholder instead of a 404.
  img.addEventListener('load', () => { if (img.naturalWidth < 5) { coverMisses.add(id); img.replaceWith(tile); } });
  return img;
}

/** Cover + title/author block used in table title cells. */
export function bookCell(isbn, title, authors, titleEl) {
  return h('div', { class: 'title-wrap' }, cover(isbn, title),
    h('div', null, titleEl || h('div', { class: 'book-title' }, title || h('em', { class: 'muted' }, 'no title')),
      authors ? h('div', { class: 'muted small' }, authors) : null));
}

/** Placeholder rows shown while data loads. */
export function skeleton(rows = 5) {
  return h('div', { class: 'skeleton', 'aria-busy': 'true', 'aria-label': 'Loading' },
    Array.from({ length: rows }, () => h('div', { class: 'sk-row' }, h('div', { class: 'sk sk-cover' }), h('div', { class: 'sk-lines' }, h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line sk-short' })))));
}

/** App mark: three book spines on a shelf, the last one leaning. Drawn in currentColor. */
const LOGO_SVG = `<svg viewBox="0 0 32 32" width="100%" height="100%" fill="currentColor" role="img" aria-hidden="true">
  <rect x="5" y="8" width="5" height="17" rx="1"/>
  <rect x="11.5" y="5" width="5.5" height="20" rx="1"/>
  <rect x="19" y="9" width="5" height="16" rx="1" transform="rotate(14 19 25)"/>
  <rect x="3" y="25.5" width="26" height="2" rx="1"/>
  <g class="logo-band"><rect x="5" y="11" width="5" height="1.2"/><rect x="5" y="21" width="5" height="1.2"/>
  <rect x="11.5" y="8" width="5.5" height="1.2"/><rect x="11.5" y="21" width="5.5" height="1.2"/></g>
</svg>`;

export function logoMark(cls = 'brand-mark') {
  return h('span', { class: cls, 'aria-hidden': 'true', html: LOGO_SVG });
}

export function emptyState(icon, title, message, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon', 'aria-hidden': 'true' }, icon), h('h3', null, title), message ? h('p', { class: 'muted' }, message) : null, action || null);
}

/** Heading block at the top of a tab. */
export function pageHead(title, subtitle, ...actions) {
  return h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null);
}

/** Copy each column header into its cells so tables can stack into cards on phones. */
export function responsive(table) {
  const labels = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  table.classList.add('table-stack');
  table.querySelectorAll('tbody tr').forEach((tr) => [...tr.children].forEach((td, i) => { if (labels[i]) td.dataset.label = labels[i]; }));
  return table;
}

/** Stacked bar showing how many books are in each status. */
export function statusBar(statuses, counts) {
  const total = statuses.reduce((a, s) => a + (counts.get(s) || 0), 0);
  if (!total) return null;
  return h('div', { class: 'status-bar', role: 'img', 'aria-label': statuses.map((s) => `${s}: ${counts.get(s) || 0}`).join(', ') },
    statuses.filter((s) => counts.get(s)).map((s) => h('span', { class: `seg s-${statusKey(s)}`, style: { flexGrow: counts.get(s) }, title: `${s}: ${counts.get(s)}` })));
}

/** Light/dark theme override, remembered per browser. */
const THEME_KEY = 'lbr.theme';
export function applySavedTheme() {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch { /* storage blocked */ }
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
}
export function themeToggle() {
  const dark = () => document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const btn = h('button', { class: 'icon-btn theme-btn', type: 'button' });
  const paint = () => { btn.textContent = dark() ? '☀' : '☾'; btn.setAttribute('aria-label', dark() ? 'Switch to light theme' : 'Switch to dark theme'); btn.title = btn.getAttribute('aria-label'); };
  btn.addEventListener('click', () => {
    const next = dark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked */ }
    paint();
  });
  paint();
  return btn;
}

/** Disable a button and show a busy label while fn runs. */
export async function busy(button, label, fn) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try { return await fn(); } finally { button.disabled = false; button.textContent = old; }
}

export function download(filename, content, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Read an uploaded .csv/.tsv/.txt/.xlsx file into rows. */
export async function readTable(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx')) return readXlsx(await file.arrayBuffer());
  if (name.endsWith('.xls')) throw new Error('Old .xls files are not supported — in Excel choose File › Save As › .xlsx or .csv.');
  return parse(await file.text());
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function select(options, value, attrs = {}) {
  return h('select', attrs, options.map((o) => {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    return h('option', { value: v, selected: v === value }, l);
  }));
}

export function checkGroup(name, options, selected = []) {
  const wrap = h('div', { class: 'check-group', role: 'group' });
  for (const o of options) {
    wrap.append(h('label', { class: 'chk' }, h('input', { type: 'checkbox', name, value: o, checked: selected.includes(o) }), ' ', o));
  }
  wrap.values = () => [...wrap.querySelectorAll('input:checked')].map((i) => i.value);
  wrap.setValues = (vals) => wrap.querySelectorAll('input').forEach((i) => { i.checked = vals.includes(i.value); });
  return wrap;
}

export function progress() {
  const bar = h('div', { class: 'progress-bar' });
  const label = h('span', { class: 'progress-label' });
  const el = h('div', { class: 'progress', hidden: true }, h('div', { class: 'progress-track' }, bar), label);
  el.set = (done, total, text) => {
    el.hidden = false;
    bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    label.textContent = text || `${done} / ${total}`;
  };
  return el;
}

export function tabs(items, active, onChange) {
  return h('nav', { class: 'tabs', role: 'tablist' }, items.map(([key, label]) =>
    h('button', { role: 'tab', class: `tab${key === active ? ' active' : ''}`, 'aria-selected': key === active ? 'true' : 'false', onclick: () => onChange(key) }, label)));
}

// ─── Row "⋯" menu ───────────────────────────────────────────────────
// The menu is attached to <body> with fixed positioning so table scroll areas can't clip it.
let openMenu = null;
function closeMenu(focusButton = false) {
  if (!openMenu) return;
  const { menu, btn, cleanup } = openMenu;
  openMenu = null;
  menu.remove();
  cleanup();
  btn.setAttribute('aria-expanded', 'false');
  if (focusButton) btn.focus();
}

/**
 * A "⋯" button that opens a small action menu.
 * @param {string} label  accessible name, e.g. 'Actions for “Wonder”'
 * @param {{label:string, hint?:string, icon?:string, onSelect:Function}[]} items  falsy items are skipped
 */
export function rowMenu(label, items) {
  const btn = h('button', { type: 'button', class: 'menu-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': label, title: 'More actions' }, '⋯');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasMine = openMenu && openMenu.btn === btn;
    closeMenu();
    if (!wasMine) showMenu(btn, items.filter(Boolean));
  });
  return btn;
}

function showMenu(btn, items) {
  const buttons = items.map((it) => h('button', { type: 'button', role: 'menuitem', class: 'menu-item', tabindex: '-1',
    // onSelect runs inside the click so it may open a new tab without the pop-up blocker stepping in.
    onclick: () => { closeMenu(); it.onSelect(); } },
  h('span', { class: 'mi-icon', 'aria-hidden': 'true' }, it.icon || ''),
  h('span', { class: 'mi-text' }, h('span', { class: 'mi-label' }, it.label), it.hint ? h('span', { class: 'mi-hint' }, it.hint) : null)));
  const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': btn.getAttribute('aria-label') }, buttons);
  document.body.append(menu);

  const place = () => {
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const below = r.bottom + 4 + mh <= window.innerHeight - 8;
    menu.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - mh - 4)}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8))}px`;
  };
  place();

  const onDoc = (e) => { if (!menu.contains(e.target) && e.target !== btn) closeMenu(); };
  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); buttons[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); buttons[buttons.length - 1].focus(); }
    else if (e.key === 'Tab') closeMenu();
  };
  const onMove = () => closeMenu();
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onMove);
  window.addEventListener('scroll', onMove, true);
  openMenu = { menu, btn, cleanup: () => {
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onMove);
    window.removeEventListener('scroll', onMove, true);
  } };
  btn.setAttribute('aria-expanded', 'true');
  if (buttons[0]) buttons[0].focus();
}
