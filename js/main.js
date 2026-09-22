// App shell: sign-in, role detection, hash routing.
import { OBJ, LF, PROFILE, CLIENT_ID } from './config.js';
import { getTokens, startLogin, fetchSession, logout, cacheSessionExtras } from './auth.js';
import { list } from './api.js';
import { h, mount, errorBox, alertBox } from './ui.js';
import { renderLibrarian } from './views/librarian.js';
import { renderAdmin } from './views/admin.js';

const root = document.getElementById('app');

function signInPage(err) {
  const btn = h('button', { class: 'btn btn-primary btn-lg' }, 'Sign in');
  const msg = h('div');
  btn.addEventListener('click', () => startLogin().catch((e) => mount(msg, errorBox(e, 'Cannot start sign-in'))));
  mount(root, h('main', { class: 'signin' },
    h('div', { class: 'card signin-card' },
      h('div', { class: 'logo', 'aria-hidden': 'true' }, '📚'),
      h('h1', null, 'Library Book Review'),
      h('p', null, 'Submit books for board review, check for duplicates, and track approval status.'),
      CLIENT_ID.startsWith('REPLACE') ? alertBox('warn', 'Setup not finished: the OAuth client ID is missing from js/config.js.') : null,
      err ? errorBox(err, 'Sign-in problem') : null,
      btn, msg,
      h('p', { class: 'hint' }, 'New librarian? Choose “Sign up” on the sign-in page. An admin approves new accounts.'))));
}

function header(session, roles, active) {
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('span', { 'aria-hidden': 'true' }, '📚'), ' Library Book Review'),
    roles.length > 1 ? h('nav', { class: 'role-switch' }, roles.map(([key, label]) =>
      h('a', { href: `#/${key}`, class: key === active ? 'active' : '' }, label))) : null,
    h('div', { class: 'user' }, h('span', { class: 'muted' }, session.name), h('button', { class: 'btn btn-small btn-ghost', onclick: logout }, 'Sign out')));
}

async function boot() {
  if (!getTokens()) { signInPage(); return; }
  let session;
  try {
    session = await fetchSession();
  } catch (err) {
    sessionStorage.clear();
    signInPage(err);
    return;
  }
  const keys = session.profileKeys || [];
  const roles = [];
  if (keys.includes(PROFILE.admin)) roles.push(['admin', 'Admin']);
  if (keys.includes(PROFILE.librarian)) roles.push(['librarian', 'Librarian']);

  const ctx = { session, librarianId: session.librarianId, campus: session.campus };
  if (keys.includes(PROFILE.librarian) && !ctx.librarianId) {
    try {
      // DAC limits librarians to their own record; admins can see all, so match on email when we have it.
      const filters = session.email ? { match: 'and', rules: [{ field: LF.email, operator: 'is', value: session.email }] } : undefined;
      const r = await list(OBJ.librarians, { filters, rowsPerPage: 2 });
      if (r.records && r.records.length > 1) throw new Error('More than one librarian record matched this account; ask an admin to check the Librarians table.');
      const me = r.records && r.records[0];
      if (me) {
        ctx.librarianId = me.id;
        const c = me[`${LF.campus}_raw`];
        ctx.campus = Array.isArray(c) ? c[0] : c || '';
        cacheSessionExtras({ librarianId: ctx.librarianId, campus: ctx.campus });
      }
    } catch (err) {
      ctx.bootError = err;
    }
  }

  const main = h('main', { class: 'container' });
  function route() {
    const [, role, sub] = (location.hash || '').split('/');
    const allowed = roles.map(([k]) => k);
    if (!allowed.length) {
      mount(root, header(session, roles, ''), h('main', { class: 'container' }, h('div', { class: 'card' },
        h('h2', null, 'Your account is waiting for access'),
        h('p', null, 'You’re signed in, but your account hasn’t been given the Librarian or Admin role yet. Ask a Library Book Review admin to approve your account, then sign out and back in.'))));
      return;
    }
    const current = allowed.includes(role) ? role : allowed[0];
    if (current !== role) { location.replace(`#/${current}`); return; }
    const banner = ctx.bootError && current === 'librarian'
      ? h('div', { class: 'container' }, errorBox(ctx.bootError, 'Could not load your librarian profile (submissions won’t be linked to you)'))
      : null;
    mount(root, header(session, roles, current), banner, main);
    if (current === 'admin') renderAdmin(main, ctx, sub);
    else renderLibrarian(main, ctx, sub);
  }
  window.addEventListener('hashchange', route);
  route();
}

boot();
