// Knack Live-App OAuth 2.0 (authorization code + PKCE), entirely in the browser.
import { API_BASE, APP_ID, CLIENT_ID, REDIRECT_URI, APP_BASE } from './config.js';

const TOKENS_KEY = 'knack.tokens';
const PKCE_KEY = 'knack_pkce';
const SESSION_KEY = 'knack.session';

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export function getTokens() {
  try { return JSON.parse(sessionStorage.getItem(TOKENS_KEY) || 'null'); } catch { return null; }
}
function saveTokens(t) {
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify({
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (Number(t.expires_in) || 3599) * 1000,
  }));
}

async function oauthError(res) {
  let body = {};
  try { body = await res.json(); } catch { /* ignore */ }
  const e = new Error(`${body.error_description || body.error || res.statusText} (HTTP ${res.status}${body.error ? `, ${body.error}` : ''})`);
  e.status = res.status; e.code = body.error;
  return e;
}

export async function startLogin(returnTo = location.hash || '') {
  if (CLIENT_ID.startsWith('REPLACE')) throw new Error('CLIENT_ID is not set in js/config.js yet.');
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(await sha256(verifier));
  const state = b64url(randomBytes(16));
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, returnTo }));
  const url = new URL(`${API_BASE}/v1/oauth/authorize`);
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  window.location.assign(url.toString());
}

/** Runs on /auth/callback/. Exchanges the code and returns to the app. */
export async function handleCallback() {
  const params = new URLSearchParams(location.search);
  if (params.get('error')) throw new Error(`${params.get('error_description') || params.get('error')}`);
  const raw = sessionStorage.getItem(PKCE_KEY);
  sessionStorage.removeItem(PKCE_KEY);
  if (!raw) throw new Error('Login session expired. Please start again.');
  const pkce = JSON.parse(raw);
  if (params.get('state') !== pkce.state) throw new Error('Login state did not match (possible stale tab). Please start again.');
  const res = await fetch(`${API_BASE}/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.get('code') || '',
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pkce.verifier,
    }).toString(),
  });
  if (!res.ok) throw await oauthError(res);
  saveTokens(await res.json());
  window.location.replace(APP_BASE + (pkce.returnTo || ''));
}

let refreshing = null;
export async function refreshTokens() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const t = getTokens();
    if (!t) throw new Error('Not signed in.');
    const res = await fetch(`${API_BASE}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: CLIENT_ID }).toString(),
    });
    if (!res.ok) {
      sessionStorage.removeItem(TOKENS_KEY);
      throw await oauthError(res);
    }
    saveTokens(await res.json());
  })();
  try { await refreshing; } finally { refreshing = null; }
}

export async function validAccessToken() {
  const t = getTokens();
  if (!t) return null;
  if (t.expiresAt - Date.now() < 60_000) await refreshTokens();
  return getTokens().accessToken;
}

export async function fetchSession(force = false) {
  if (!force) {
    const cached = sessionStorage.getItem(SESSION_KEY);
    if (cached) return JSON.parse(cached);
  }
  const token = await validAccessToken();
  const res = await fetch(`${API_BASE}/v1/live-app/${APP_ID}/session`, {
    headers: { 'X-Knack-Application-Id': APP_ID, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await oauthError(res);
  const body = await res.json();
  const user = (body.session && body.session.user) || body.user || {};
  const session = {
    id: user.id,
    name: (user.name && (user.name.fullName || user.name.full)) || user.name || user.email || 'Signed in',
    email: user.email || (user.values && user.values.email) || '',
    profileKeys: user.profileKeys || user.profile_keys || [],
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function cacheSessionExtras(extra) {
  const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}');
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, ...extra }));
}

export async function logout() {
  const t = getTokens();
  sessionStorage.clear();
  if (t) {
    fetch(`${API_BASE}/v1/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.accessToken, client_id: CLIENT_ID }).toString(),
    }).catch(() => {});
  }
  window.location.assign(APP_BASE);
}
