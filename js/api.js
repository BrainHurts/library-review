// Thin Knack record API client with token refresh, 429 back-off and readable errors.
import { API_BASE, APP_ID } from './config.js';
import { validAccessToken, refreshTokens } from './auth.js';

export class KnackError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function describe(status, body) {
  if (!body) return `HTTP ${status}`;
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors.map((e) => (typeof e === 'string' ? e : e.message || JSON.stringify(e))).join(' · ');
  }
  if (body.message) return body.message;
  if (body.errorCode) return `${body.errorCode}`;
  if (body.error_description || body.error) return body.error_description || body.error;
  return JSON.stringify(body).slice(0, 400);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function request(method, path, body, attempt = 0) {
  const token = await validAccessToken();
  if (!token) throw new KnackError('You are signed out. Reload the page to sign in again.', 401);
  const res = await fetch(`${API_BASE}/v1${path}`, {
    method,
    headers: {
      'X-Knack-Application-Id': APP_ID,
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && attempt === 0) {
    await refreshTokens();
    return request(method, path, body, 1);
  }
  if (res.status === 429 && attempt < 5) {
    await sleep(800 * (attempt + 1));
    return request(method, path, body, attempt + 1);
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) {
    let msg = describe(res.status, data);
    if (res.status === 403) msg = `You don't have permission to do that. (${msg})`;
    throw new KnackError(`${msg} [HTTP ${res.status} ${method} ${path.split('?')[0]}]`, res.status, data);
  }
  return data;
}

export function list(objectKey, { filters, page = 1, rowsPerPage = 50, sortField, sortOrder } = {}) {
  const q = new URLSearchParams({ page: String(page), rows_per_page: String(rowsPerPage) });
  if (filters && filters.rules && filters.rules.length) q.set('filters', JSON.stringify(filters));
  if (sortField) { q.set('sort_field', sortField); q.set('sort_order', sortOrder || 'asc'); }
  return request('GET', `/objects/${objectKey}/records?${q}`);
}

export async function listAll(objectKey, opts = {}, onProgress) {
  const out = [];
  let page = 1;
  for (;;) {
    const r = await list(objectKey, { ...opts, page, rowsPerPage: 1000 });
    out.push(...(r.records || []));
    if (onProgress) onProgress(out.length, r.total_records);
    if (page >= (r.total_pages || 1)) break;
    page++;
  }
  return out;
}

export async function count(objectKey, filters) {
  const r = await list(objectKey, { filters, rowsPerPage: 1 });
  return r.total_records || 0;
}

/**
 * Count records per value of a field in ONE call (Knack aggregate endpoint).
 * @returns {Promise<Map<string, number>>}
 */
export async function countBy(objectKey, field, filters) {
  const body = { groupBy: [{ field }], aggregations: [{ calculation: 'count' }] };
  if (filters && filters.rules && filters.rules.length) body.filters = filters;
  const r = await request('POST', `/objects/${objectKey}/records/aggregate`, body);
  const rows = Array.isArray(r) ? r : r.records || r.rows || r.data || [];
  const out = new Map();
  for (const row of rows) {
    const g = row.group_0_raw ?? row.group_0;
    const n = Number(row.agg_0_raw ?? row.agg_0) || 0;
    for (const k of (Array.isArray(g) ? g : [g])) {
      const key = k && typeof k === 'object' ? k.identifier ?? '' : String(k ?? '');
      out.set(key, (out.get(key) || 0) + n);
    }
  }
  return out;
}

export const getRecord = (o, id) => request('GET', `/objects/${o}/records/${id}`);
export const create = (o, data) => request('POST', `/objects/${o}/records`, data);
export const update = (o, id, data) => request('PUT', `/objects/${o}/records/${id}`, data);
export const remove = (o, id) => request('DELETE', `/objects/${o}/records/${id}`);

/** Run fn over items with limited concurrency (Knack allows ~10 req/sec). */
export async function pool(items, limit, fn, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { ok: true, value: await fn(items[i], i) }; }
      catch (err) { results[i] = { ok: false, error: err }; }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Knack date write format. */
export function today() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return { date: `${mm}/${dd}/${d.getFullYear()}` };
}

/** Read helpers for record values. */
export const raw = (rec, key) => (rec ? rec[`${key}_raw`] : undefined);
export function text(rec, key) {
  const v = raw(rec, key);
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? x.identifier ?? '' : x)).join(', ');
  if (typeof v === 'object') return v.date_formatted || v.date || v.identifier || v.full || '';
  return String(v);
}
export function arr(rec, key) {
  const v = raw(rec, key);
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}
