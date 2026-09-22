// Tiny DOM helpers — no framework.
import { parse } from './csv.js';
import { readXlsx } from './xlsx.js';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
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
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions) : null);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  backdrop.append(dlg);
  document.body.append(backdrop);
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
