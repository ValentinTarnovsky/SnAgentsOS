// Share, host side (app 2.4.0, item 8, S4): the production ShareDialog,
// ShareJoinPrompt, ShareHostBanner, Settings > Sharing and the sidebar
// ShareHostIndicator in an isolated hidden Electron window. window.snApi.share.host
// is a fake that records every call and pushes scripted ShareHostState and
// share:panes events; nothing listens on a port, runs PowerShell or touches
// DPAPI. Checks: the dialog defaults (perm from settings.share.defaultPerm),
// password rules and the DPAPI-unavailable path, create turns
// settings.share.enabled on and reaches main before the create call, a
// workspace scope mounts its workspace, the invite with Copy, the endpoints,
// the no-Tailscale hint and the share-port firewall row, inline errors; stacked
// join prompts with fingerprint, known guest, wrong-password note, perm
// dropdown, Allow/Deny and the countdown, Enter never confirming; the banner
// with guests, perm and who is typing; every Settings action by id; the
// indicator; Spanish strings; no horizontal overflow. Requires npm run build (CSS).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-share-host-ui-'))
const assets = path.join(root, 'out/renderer/assets')
const css = fs.existsSync(assets) && fs.readdirSync(assets).find(f => /^index-.*\.css$/.test(f))
if (!css) throw new Error('Run npm run build first')
buildSync({ stdin: { contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { I18nProvider } from './src/renderer/i18n';
import { useAppStore } from './src/renderer/lib/store';
import { useShareHostStore, initShareHostEvents, openShareDialog, EMPTY_SHARE_HOST } from './src/renderer/lib/shareHostStore';
import { ShareDialog } from './src/renderer/components/share/ShareDialog';
import { ShareJoinPrompt } from './src/renderer/components/share/ShareJoinPrompt';
import { ShareHostBanner } from './src/renderer/components/share/ShareHostBanner';
import { ShareHostIndicator } from './src/renderer/components/sidebar/ShareHostIndicator';
import { SharingSection } from './src/renderer/components/settings/sections/SharingSection';
import { applyTheme } from './src/renderer/themes/applyTheme';

const calls = [];
const log = (name, arg) => calls.push({ name, arg });
const listeners = { state: new Set(), panes: new Set() };
const replies = { create: null, invite: { ok: true, invite: 'snaos-share:1:INVITE' }, rotate: { ok: true, invite: 'snaos-share:1:ROTATED' }, op: { ok: true } };
const fwStatus = { ok: true, state: 'ok', profile: 'Private', ruleFound: true, port: 4527, endpoints: [], blockingRules: [], ruleScope: 'program', fixable: false, checkedAt: 1 };
const clipboard = [];
let initial = null;
const host = {
  state: async () => { log('state'); return initial },
  onEvent: (cb) => { listeners.state.add(cb); return () => listeners.state.delete(cb) },
  onPanes: (cb) => { listeners.panes.add(cb); return () => listeners.panes.delete(cb) },
  create: async (req) => { log('create', req); return replies.create },
  invite: async (id) => { log('invite', id); return replies.invite },
  rotate: async (id) => { log('rotate', id); return replies.rotate },
  update: async (req) => { log('update', req); return replies.op },
  setPassword: async (id, pw) => { log('setPassword', { id, pw }); return replies.op },
  revoke: async (id) => { log('revoke', id); return replies.op },
  kick: async (id) => { log('kick', id); return replies.op },
  sessionPerm: async (id, perm) => { log('sessionPerm', { id, perm }); return replies.op },
  pauseAll: async (on) => { log('pauseAll', on); return replies.op },
  resolve: (req) => log('resolve', req),
  setConfig: (cfg) => log('setConfig', cfg),
  firewallCheck: async (force) => { log('shareFwCheck', force); return fwStatus },
  firewallFix: async () => { log('shareFwFix'); return { ok: true, status: fwStatus } },
};
const noop = () => () => {};
const fallback = (base) => new Proxy(base, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? fallback(noop) : undefined) });
window.snApi = fallback({
  platform: 'win32',
  share: { host, guest: fallback({}) },
  clipboard: fallback({ writeText: (v) => clipboard.push(v), readText: async () => '' }),
  remote: fallback({ firewallCheck: async () => { log('remoteFwCheck'); return fwStatus }, firewallFix: async () => ({ ok: true }) }),
});

const ws = { id: 'ws-1', name: 'Backend', cwd: '', panes: [{ id: 'pane-1', type: 'claude', title: 'Claude API', icon: 'bot' }, { id: 'pane-2', type: 'shell', title: 'Shell', icon: 'terminal' }] };
const mounted = [];
useAppStore.setState({ hydrated: true, activeWorkspaceId: 'ws-1', workspaces: [ws], ensureMounted: (id, opts) => mounted.push({ id, opts }) });
useAppStore.setState((s) => ({ settings: { ...s.settings, language: 'en', share: { enabled: false, port: 4527, guestName: '', defaultPerm: 'type' } } }));
applyTheme('midnight');

const session = (over = {}) => ({ id: 'sess-1', grantId: 'g-1', name: 'Ana', ip: '100.64.0.7', fingerprint: 'AB12-CD34-EF56-7890', perm: 'type', since: Date.now() - 120000, watching: 1, typing: true, ...over });
const grant = (over = {}) => ({ id: 'g-1', label: 'Claude API', scope: { kind: 'pane', paneId: 'pane-1', workspaceId: 'ws-1' }, perm: 'type', hasPassword: false, createdAt: Date.now() - 60000, paused: false, expired: false, suspended: false, knownGuests: 1, sessions: [session()], ...over });
const stateOf = (over = {}) => ({ ...EMPTY_SHARE_HOST, enabled: true, port: 4527, listening: 'running', encryption: true, fingerprint: '1111-2222-3333-4444', endpoints: [{ a: '192.168.1.20', p: 4527, t: 'lan' }], grants: [], approvals: [], ...over });

window.result = (async () => {
  const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  let checks = 0;
  const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const click = async (sel) => { const el = typeof sel === 'string' ? $(sel) : sel; if (!el) throw new Error('missing ' + sel); el.click(); await wait() };
  const setValue = async (sel, v) => {
    const el = $(sel); if (!el) throw new Error('missing ' + sel);
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    await wait();
  };
  // A hidden window never holds focus, so React's onBlur is driven by its focusout event.
  const blur = async (sel) => { $(sel).dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await wait() };
  const emit = async (s) => { listeners.state.forEach((cb) => cb(s)); await wait() };
  const emitPanes = async (p) => { listeners.panes.forEach((cb) => cb(p)); await wait() };
  const take = (name) => calls.filter((c) => c.name === name);
  const clear = () => { calls.length = 0 };
  const noOverflow = () => document.documentElement.scrollWidth <= window.innerWidth;
  const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  const el = document.getElementById('root');
  const rootR = createRoot(el);
  let lang = 'en';
  let view = 'dialog';
  const render = () => flushSync(() => rootR.render(
    <I18nProvider lang={lang}>
      <div style={{ width: 420 }}>
        {view === 'settings' && <SharingSection />}
        {view === 'banner' && <div style={{ height: 120, display: 'flex', flexDirection: 'column' }}><ShareHostBanner paneId="pane-1" /></div>}
        {view === 'indicator' && <div style={{ width: 240 }}><ShareHostIndicator /></div>}
      </div>
      <ShareDialog />
      <ShareJoinPrompt />
    </I18nProvider>
  ));
  const show = async (v, l = 'en') => { view = v; lang = l; render(); await wait() };

  // --- Wiring: the store pulls main's state once and follows the event stream.
  initial = stateOf({ encryption: true, endpoints: [{ a: '192.168.1.20', p: 4527, t: 'lan' }] });
  initShareHostEvents();
  await wait();
  check(take('state').length === 1 && useShareHostStore.getState().loaded, 'the store pulls main state once on init');
  check(listeners.state.size === 1 && listeners.panes.size === 1, 'state and panes streams are wired once');
  initShareHostEvents();
  check(listeners.state.size === 1, 'init is idempotent');

  // --- ShareDialog on a console.
  await show('dialog');
  openShareDialog({ kind: 'pane', paneId: 'pane-1', workspaceId: 'ws-1' });
  await wait();
  check(!!$('[data-share-dialog=pane]'), 'the dialog opens on a console');
  check($('[data-share-dialog]').textContent.includes('Share console') && $('[data-share-dialog]').textContent.includes('Claude API'), 'title and console name');
  check($('[data-share-perm=type]').getAttribute('aria-checked') === 'true', 'the perm radio defaults to settings.share.defaultPerm');
  check($('[data-share-expiry]').value === 'never', 'expiry defaults to until revoked');
  check($('[data-share-label]').placeholder === 'Claude API', 'the label placeholder is the console name');
  await click('[data-share-perm=view]');
  check($('[data-share-perm=view]').getAttribute('aria-checked') === 'true' && $('[data-share-perm=type]').getAttribute('aria-checked') === 'false', 'picking a perm moves the radio');
  await setValue('[data-share-password]', 'short');
  check($('[data-share-create]').disabled && $('[data-share-password-note]').textContent.includes('At least 8'), 'a short password blocks Create with an inline note');
  await setValue('[data-share-password]', 'longenough1');
  check(!$('[data-share-create]').disabled, 'a valid password enables Create');
  await setValue('[data-share-expiry]', '8h');
  await setValue('[data-share-label]', '  Ana pairing  ');
  replies.create = { ok: true, grant: grant({ id: 'g-new', label: 'Ana pairing', perm: 'view', hasPassword: true, sessions: [] }), invite: 'snaos-share:1:NEWINVITE' };
  clear();
  await click('[data-share-create]');
  const order = calls.map((c) => c.name).filter((n) => n === 'setConfig' || n === 'create');
  check(order[0] === 'setConfig' && order[1] === 'create', 'main gets enabled before the create call');
  check(take('setConfig')[0].arg.enabled === true && take('setConfig')[0].arg.port === 4527, 'setConfig carries enabled and the port');
  check(useAppStore.getState().settings.share.enabled === true, 'creating turns settings.share.enabled on');
  const req = take('create')[0].arg;
  check(req.scope.kind === 'pane' && req.scope.paneId === 'pane-1' && !('workspaceId' in req.scope), 'create names the console by id only');
  check(req.perm === 'view' && req.expiry === '8h' && req.label === 'Ana pairing' && req.password === 'longenough1', 'create carries perm, expiry, trimmed label and password');
  check(mounted.length === 0, 'a console scope does not mount a workspace');
  check(!!$('[data-share-result]') && $('[data-share-invite]').textContent === 'snaos-share:1:NEWINVITE', 'the result shows the invite');
  check($('[data-share-summary]').textContent.includes('View only') && $('[data-share-summary]').textContent.includes('With password'), 'the summary names perm and password');
  check($$('[data-share-endpoint]').length === 1 && $('[data-share-endpoint=lan]').textContent.includes('192.168.1.20:4527'), 'the LAN endpoint is listed');
  check(!!$('[data-share-no-tailscale]'), 'no Tailscale endpoint shows the hint');
  await wait(60);
  check(take('shareFwCheck').length >= 1 && take('remoteFwCheck').length === 0, 'the firewall row checks the share port, not the phone server');
  check(!!$('[data-share-result] [data-fw-state=ok]') && $('[data-share-result] [data-fw-state]').textContent.includes('4527'), 'the firewall row shows the share port');
  await click('[data-share-copy]');
  check(clipboard.at(-1) === 'snaos-share:1:NEWINVITE' && $('[data-share-copy]').textContent.includes('Copied'), 'Copy puts the invite on the clipboard');
  check(noOverflow(), 'the dialog fits');
  key('Escape'); await wait();
  check(!$('[data-share-dialog]'), 'Esc closes the dialog');

  // --- Tailscale present, DPAPI missing, and an error from main.
  await emit(stateOf({ encryption: false, endpoints: [{ a: '100.64.0.2', p: 4527, t: 'ts' }, { a: '192.168.1.20', p: 4527, t: 'lan' }] }));
  openShareDialog({ kind: 'pane', paneId: 'pane-1', workspaceId: 'ws-1' });
  await wait();
  check($('[data-share-password]').disabled && $('[data-share-password-note]').textContent.includes('DPAPI'), 'without DPAPI the password is disabled with a note');
  replies.create = { ok: false, error: 'no_endpoint' };
  clear();
  await click('[data-share-create]');
  check(!('password' in take('create')[0].arg), 'no password is sent without DPAPI');
  check(!!$('[data-share-error]') && $('[data-share-error]').textContent.includes('No Tailscale or LAN address'), 'a main error shows inline');
  check(!!$('[data-share-dialog]') && !$('[data-share-result]'), 'the form stays open after an error');
  replies.create = { ok: true, grant: grant({ id: 'g-ts', sessions: [] }), invite: 'snaos-share:1:TS' };
  await click('[data-share-create]');
  check(!$('[data-share-no-tailscale]') && !!$('[data-share-endpoint=ts]'), 'with a Tailscale endpoint there is no hint');
  await click('[data-share-close]');
  check(!$('[data-share-dialog]'), 'Close closes the dialog');

  // --- Workspace scope mounts its workspace; existing shares are counted.
  await emit(stateOf({ grants: [grant({ id: 'g-ws', label: 'Backend', scope: { kind: 'workspace', workspaceId: 'ws-1' }, sessions: [] })] }));
  openShareDialog({ kind: 'workspace', workspaceId: 'ws-1' });
  await wait();
  check(!!$('[data-share-dialog=workspace]') && $('[data-share-dialog]').textContent.includes('Share workspace'), 'the workspace dialog opens');
  check(!!$('[data-share-existing]') && $('[data-share-existing]').textContent.includes('once'), 'an existing workspace share is mentioned');
  replies.create = { ok: true, grant: grant({ id: 'g-ws2', scope: { kind: 'workspace', workspaceId: 'ws-1' }, sessions: [] }), invite: 'snaos-share:1:WS' };
  clear();
  await click('[data-share-create]');
  check(mounted.length === 1 && mounted[0].id === 'ws-1', 'a workspace scope runs ensureMounted(workspaceId)');
  check(take('create')[0].arg.scope.kind === 'workspace' && take('create')[0].arg.scope.workspaceId === 'ws-1', 'create names the workspace by id');
  await click('[data-share-manage]');
  check(!$('[data-share-dialog]') && useAppStore.getState().settingsOpen && useAppStore.getState().settingsCategory === 'share', 'Manage opens Settings > Sharing');
  useAppStore.getState().setSettingsOpen(false);

  // A console that goes away closes its open dialog.
  openShareDialog({ kind: 'pane', paneId: 'gone', workspaceId: 'ws-1' });
  await wait();
  check(!$('[data-share-dialog]') && useShareHostStore.getState().dialog === null, 'a dialog on a missing console closes itself');

  // --- Join prompts.
  const now = Date.now();
  const approvals = [
    { requestId: 'r1', grantId: 'g-1', grantLabel: 'Claude API', scopeKind: 'pane', guestName: 'Ana', ip: '100.64.0.7', fingerprint: 'AB12-CD34-EF56-7890', known: true, passwordFailed: true, perm: 'type', expiresAt: now + 45000 },
    { requestId: 'r2', grantId: 'g-ws', grantLabel: 'Backend', scopeKind: 'workspace', guestName: 'Bob', ip: '192.168.1.44', fingerprint: '9999-8888-7777-6666', known: false, passwordFailed: false, perm: 'view', expiresAt: now + 60000 },
  ];
  await emit(stateOf({ approvals }));
  check($$('[data-share-prompt]').length === 2, 'two requests stack as two cards');
  const p1 = $('[data-share-prompt=r1]'), p2 = $('[data-share-prompt=r2]');
  check(p1.textContent.includes('"Ana" wants to join the console "Claude API"'), 'the card names the guest and the console');
  check(p2.textContent.includes('the workspace "Backend"'), 'a workspace request says workspace');
  check(p1.querySelector('[data-share-prompt-fp]').textContent === 'AB12-CD34' && p1.querySelector('[data-share-prompt-fp]').title === 'AB12-CD34-EF56-7890', 'the short fingerprint, full one on hover');
  check(p1.querySelector('[data-share-prompt-known]').dataset.sharePromptKnown === 'yes' && p1.textContent.includes('Joined before'), 'a known guest is marked');
  check(p2.textContent.includes('New device'), 'a new guest is marked');
  check(!!p1.querySelector('[data-share-prompt-pwfail]') && !p2.querySelector('[data-share-prompt-pwfail]'), 'the wrong-password note only where it happened');
  check(/Expires in (4[0-5])s/.test(p1.querySelector('[data-share-prompt-left]').textContent), 'the countdown shows the seconds left');
  check(p1.querySelector('[data-share-prompt-perm]').value === 'type' && p2.querySelector('[data-share-prompt-perm]').value === 'view', 'the perm dropdown defaults to the grant perm');
  clear();
  key('Enter'); await wait();
  check(take('resolve').length === 0 && $$('[data-share-prompt]').length === 2, 'Enter never confirms');
  await setValue('[data-share-prompt=r1] [data-share-prompt-perm]', 'full');
  await click('[data-share-prompt=r1] [data-share-prompt-allow]');
  check(JSON.stringify(take('resolve')[0].arg) === JSON.stringify({ requestId: 'r1', allow: true, perm: 'full' }), 'Allow sends the picked perm');
  check(!$('[data-share-prompt=r1]') && !!$('[data-share-prompt=r2]'), 'an answered card goes away, the other stays');
  await click('[data-share-prompt=r2] [data-share-prompt-deny]');
  check(JSON.stringify(take('resolve')[1].arg) === JSON.stringify({ requestId: 'r2', allow: false }), 'Deny sends no perm');
  check(!$('[data-share-prompts]'), 'no cards left');
  await click('[data-share-prompt=r2] [data-share-prompt-deny]').catch(() => undefined);
  check(take('resolve').length === 2, 'an answered request is never sent twice');
  await emit(stateOf({ approvals: [] }));
  check(useShareHostStore.getState().answered.length === 0, 'answers main dropped are forgotten');
  await emit(stateOf({ approvals: [{ ...approvals[0], requestId: 'r3', expiresAt: Date.now() - 1 }] }));
  check(!$('[data-share-prompts]'), 'an expired request is not shown');
  await emit(stateOf({ approvals: [] }));

  // --- Banner over a shared console.
  await show('banner');
  check(!$('[data-share-host-banner]'), 'no banner without guests');
  await emitPanes([{ paneId: 'pane-1', guests: [{ sessionId: 's1', name: 'Ana', perm: 'type' }, { sessionId: 's2', name: 'Bob', perm: 'view' }], typing: 'Ana' }, { paneId: 'other', guests: [] }]);
  check(!!$('[data-share-host-banner=pane-1]'), 'the banner shows while guests are connected');
  check($('[data-share-host-banner]').textContent.includes('Shared with Ana (Type only), Bob (View only)'), 'names and perms');
  check($('[data-share-host-typing]').textContent.includes('Ana is typing'), 'who is typing');
  check(!useShareHostStore.getState().panes.other, 'a pane with no guests is dropped');
  await click('[data-share-host-manage]');
  check(useAppStore.getState().settingsOpen && useAppStore.getState().settingsCategory === 'share', 'Manage opens Settings > Sharing');
  useAppStore.getState().setSettingsOpen(false);
  await emitPanes([{ paneId: 'pane-1', guests: [{ sessionId: 's1', name: 'Ana', perm: 'full' }] }]);
  check(!$('[data-share-host-typing]') && $('[data-share-host-banner]').textContent.includes('Ana (Full control)'), 'nobody typing, perm updated live');
  await show('banner', 'es');
  check($('[data-share-host-banner]').textContent.includes('Compartido con Ana (Control total)'), 'the banner is translated');
  await emitPanes([]);
  check(!$('[data-share-host-banner]'), 'the banner goes away with the last guest');

  // --- Sidebar indicator.
  await emit(stateOf({ grants: [] }));
  await show('indicator');
  check(!$('[data-share-indicator]'), 'no indicator without a share');
  await emit(stateOf({ grants: [grant(), grant({ id: 'g-2', sessions: [session({ id: 'sess-2', name: 'Bob' })] })] }));
  check($('[data-share-indicator]').textContent.includes('Sharing: 2 guests'), 'Sharing: N guests');
  await emit(stateOf({ grants: [grant()] }));
  check($('[data-share-indicator]').textContent.includes('Sharing: 1 guest'), 'singular');
  await click('[data-share-indicator]');
  check(useAppStore.getState().settingsCategory === 'share', 'the indicator opens Settings > Sharing');
  useAppStore.getState().setSettingsOpen(false);
  useAppStore.setState((s) => ({ settings: { ...s.settings, share: { ...s.settings.share, enabled: false } } }));
  await wait();
  check(!$('[data-share-indicator]'), 'hidden while sharing is off');
  useAppStore.setState((s) => ({ settings: { ...s.settings, share: { ...s.settings.share, enabled: true } } }));

  // --- Settings > Sharing.
  await emit(stateOf({ endpoints: [{ a: '100.64.0.2', p: 4527, t: 'ts' }], grants: [grant({ hasPassword: true, expiresAt: Date.now() + 3 * 3600000 }), grant({ id: 'g-2', label: 'Backend', scope: { kind: 'workspace', workspaceId: 'ws-1' }, paused: true, sessions: [] })] }));
  await show('settings');
  check(!!$('[data-sharing-section]') && $('[data-share-listen]').dataset.shareListen === 'running', 'the section shows the listener state');
  check($$('[data-share-grant]').length === 2 && $('[data-share-grant=g-1]').textContent.includes('Claude API'), 'every grant is listed');
  check(!!$('[data-share-grant=g-1] [data-share-grant-pw]') && !!$('[data-share-grant=g-2] [data-share-grant-paused]'), 'password and paused are marked');
  check($('[data-share-grant=g-1]').textContent.includes('Expires'), 'the expiry is shown');
  check($('[data-share-host-fp]').textContent.includes('1111-2222-3333-4444'), 'the host key fingerprint is shown');
  check($('[data-share-endpoint=ts]').textContent.includes('100.64.0.2:4527') && !$('[data-sharing-section] [data-share-no-tailscale]'), 'endpoints, no hint with Tailscale');
  check(!!$('[data-sharing-section] [data-fw-state]'), 'the share firewall row is in the section');
  clear();
  await setValue('[data-share-grant=g-1] [data-share-grant-perm]', 'full');
  check(JSON.stringify(take('update')[0].arg) === JSON.stringify({ grantId: 'g-1', perm: 'full' }), 'grant perm select calls update');
  await click('[data-share-grant=g-2] [data-share-grant-pause]');
  check(JSON.stringify(take('update')[1].arg) === JSON.stringify({ grantId: 'g-2', paused: false }), 'Resume a paused grant');
  await setValue('[data-share-grant=g-1] [data-share-grant-expiry]', '24h');
  check(JSON.stringify(take('update')[2].arg) === JSON.stringify({ grantId: 'g-1', expiry: '24h' }), 'expiry select calls update');
  await click('[data-share-grant=g-1] [data-share-grant-copy]');
  check(take('invite')[0].arg === 'g-1' && clipboard.at(-1) === 'snaos-share:1:INVITE', 'Copy invite asks main and copies');
  await click('[data-share-grant=g-1] [data-share-grant-rotate]');
  check(take('rotate').length === 0, 'New invite asks first');
  key('Enter'); await wait();
  check(take('rotate')[0].arg === 'g-1' && clipboard.at(-1) === 'snaos-share:1:ROTATED', 'confirming rotates and copies the new invite');
  await click('[data-share-grant=g-1] [data-share-grant-pw-open]');
  await setValue('[data-share-grant=g-1] [data-share-grant-pw-input]', 'abc');
  check($('[data-share-grant=g-1] [data-share-grant-pw-save]').disabled, 'a short password cannot be saved');
  await setValue('[data-share-grant=g-1] [data-share-grant-pw-input]', 'a-good-password');
  await click('[data-share-grant=g-1] [data-share-grant-pw-save]');
  check(JSON.stringify(take('setPassword')[0].arg) === JSON.stringify({ id: 'g-1', pw: 'a-good-password' }) && !$('[data-share-grant=g-1] [data-share-grant-pw-form]'), 'Save sets the password and closes the form');
  await click('[data-share-grant=g-1] [data-share-grant-pw-open]');
  await click('[data-share-grant=g-1] [data-share-grant-pw-clear]');
  check(JSON.stringify(take('setPassword')[1].arg) === JSON.stringify({ id: 'g-1', pw: null }), 'Remove password sends null');
  await setValue('[data-share-session=sess-1] [data-share-session-perm]', 'view');
  check(JSON.stringify(take('sessionPerm')[0].arg) === JSON.stringify({ id: 'sess-1', perm: 'view' }), 'per-session perm override');
  check($('[data-share-session=sess-1]').textContent.includes('Ana') && $('[data-share-session=sess-1]').textContent.includes('AB12-CD34') && !!$('[data-share-session-typing]'), 'the session row shows name, fingerprint and typing');
  await click('[data-share-session=sess-1] [data-share-session-kick]');
  check(take('kick')[0].arg === 'sess-1', 'Disconnect kicks the session');
  await click('[data-share-grant=g-2] [data-share-grant-revoke]');
  check(take('revoke').length === 0, 'Revoke asks first');
  key('Escape'); await wait();
  check(take('revoke').length === 0, 'Esc cancels the revoke');
  await click('[data-share-grant=g-2] [data-share-grant-revoke]');
  key('Enter'); await wait();
  check(take('revoke')[0].arg === 'g-2', 'confirming revokes');
  replies.op = { ok: false, error: 'not_found' };
  await click('[data-share-grant=g-2] [data-share-grant-pause]');
  check($('[data-share-grant=g-2] [data-share-grant-error]').textContent.includes('no longer exists'), 'a failed op shows inline on its grant');
  replies.op = { ok: true };
  await click('[data-setting-id="share.pauseAll"] [role=switch]');
  check(take('pauseAll')[0].arg === true, 'Pause all asks main');
  await click('[data-setting-id="share.enable"] [role=switch]');
  check(useAppStore.getState().settings.share.enabled === false, 'the master switch writes settings.share.enabled');
  await setValue('[data-share-port]', '4600');
  await blur('[data-share-port]');
  check(useAppStore.getState().settings.share.port === 4600, 'the port commits on blur');
  await setValue('[data-share-port]', '80');
  await blur('[data-share-port]');
  check(useAppStore.getState().settings.share.port === 4600 && $('[data-share-port]').value === '4600', 'an invalid port is reverted');
  await setValue('[data-share-guest-name]', '  Vale PC  ');
  await blur('[data-share-guest-name]');
  check(useAppStore.getState().settings.share.guestName === 'Vale PC', 'the guest name commits trimmed');
  await setValue('[data-share-default-perm]', 'full');
  check(useAppStore.getState().settings.share.defaultPerm === 'full', 'the default perm select');
  check(noOverflow(), 'the section fits 420px');
  await emit(stateOf({ encryption: false, grants: [grant({ sessions: [] })] }));
  check(!!$('[data-share-no-encryption]'), 'DPAPI missing is explained');
  await emit(stateOf({ grants: [] }));
  check($('[data-share-grants]').textContent.includes('Nothing shared yet') && $('[data-setting-id="share.pauseAll"] [role=switch]').disabled, 'empty list and Pause all disabled');
  await emit(stateOf({ listening: 'error', error: 'Port 4527 is already in use.', grants: [grant({ sessions: [] })] }));
  check($('[data-share-listen]').textContent.includes('Port 4527 is already in use by another program'), 'a listen error is shown inline and translated');
  await show('settings', 'es');
  check($('[data-sharing-section]').textContent.includes('Permitir compartir') && $('[data-sharing-section]').textContent.includes('Copiar invitación'), 'the section is translated');
  return checks;
})();
`, resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'renderer.js'), alias: { '@shared': path.join(root, 'src/shared'), '@': path.join(root, 'src/renderer') }, jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css))}"></head><body class="bg-bg-primary text-text-primary"><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:460,height:720,useContentSize:true,webPreferences:{sandbox:true,backgroundThrottling:false}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.result');
 console.log('PASS: '+checks+' share host UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
fs.rmSync(dir, { recursive: true, force: true })
