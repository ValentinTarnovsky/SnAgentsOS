// The phone's 2.7.0 attention surfaces (A8) with the production CSS in an
// isolated offscreen browser at 360px: the real LiveShell with a stubbed
// control plane (no socket). Home's "Waiting for you" across workspaces in
// the shared order with needsYouCount's count (the workspace badges add up to
// it); each row signal (doing now, failure with its reset, silence, needs in
// amber, muted, context with "est.", a bare status that only shows its
// request); the ctls of Ignore this turn, Mark as read, Mute / Unmute and the
// workspace's Mark all read, plus the toast of a failed ack; a 2.6.0 desktop
// hides every new action; the Plan card's "View full plan" sheet (happy path,
// truncated, no longer available, no answer with Retry, hidden on 2.6.0 or
// offline); no horizontal overflow, measured inside Home's list, the rows and
// the open sheet (a too wide row and a too wide plan prove the check fails),
// and Spanish labels.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-attention-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LiveShell } from './src/mobile/src/components/LiveShell';
import { PlanCard } from './src/mobile/src/components/prompts/PlanCard';
import { BackStackHost } from './src/mobile/src/lib/useBackClaim';
import { store } from './src/mobile/src/lib/store';
import { client } from './src/mobile/src/lib/client';
import { setLang } from './src/mobile/src/lib/i18n';
import { attentionItems } from './src/mobile/src/lib/workspace';
import { needsYouCount, needsYouRows } from './src/shared/attention';
const wait = ms => new Promise(r => setTimeout(r, ms));
const frames = () => wait(40);
let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
// Too wide content never widens the document on these screens: Home scrolls
// inside [data-home-list] and a sheet inside its [data-sheet-panel] (their
// overflow-y auto makes overflow-x auto too). So measure the content itself:
// each scroll box and each row fits its own width, and no element in a box
// ends outside the 360px viewport (an inner box that scrolls sideways on
// purpose, data-scrollable, holds its own content).
const wideAt360 = () => {
 const bad = [];
 const tag = e => e.tagName.toLowerCase() + [...e.attributes].filter(a => a.name.startsWith('data-')).map(a => '[' + a.name + ']').join('');
 const fits = e => { if (e.scrollWidth > e.clientWidth + 1) bad.push(tag(e) + ' scrollWidth ' + e.scrollWidth + ' > ' + e.clientWidth) };
 for (const box of $$('[data-home-list], [data-sheet][data-open=true] [data-sheet-panel]')) {
  fits(box);
  for (const e of box.querySelectorAll('*')) {
   if (e.parentElement.closest('[data-scrollable]') !== box || e.classList.contains('sr-only')) continue;
   const r = e.getBoundingClientRect();
   if ((r.width || r.height) && (r.left < -0.5 || r.right > innerWidth + 0.5)) bad.push(tag(e) + ' spans ' + Math.round(r.left) + '..' + Math.round(r.right));
  }
 }
 for (const row of $$('[data-pane], [data-needs-row], [data-prompt-card], [data-plan-sheet]')) fits(row);
 return bad;
};
let wide = [];
const noOverflow = () => { wide = wideAt360(); return document.documentElement.scrollWidth <= innerWidth && wide.length === 0 };
const wideNote = () => ' ' + JSON.stringify(wide.slice(0, 4));
const ptr = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0 }));
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
const tap = el => { ptr(el, 'pointerdown', 10, 10); ptr(el, 'pointerup', 10, 10); click(el) };
async function hold(el) { ptr(el, 'pointerdown', 10, 10); await wait(480); ptr(el, 'pointerup', 10, 10); click(el) }
const ctls = [];
let failKind = null;
client.sendCtl = async action => {
 ctls.push(action);
 if (failKind && action.kind === failKind) { failKind = null; return { ok: false, error: 'not_found' } }
 return { ok: true };
};
const planCalls = [];
let planReply = null;
client.requestPlan = async (paneId, requestId) => { planCalls.push(paneId + ':' + requestId); return planReply };
const now = Date.now(), MIN = 60000;
const pane = (id, title, type, extra = {}) => ({ id, title, type, color: '', icon: '', running: true, ...extra });
const statuses = {
 a1: { state: 'action', reason: 'permission', stateSince: now - 5 * MIN, provider: 'claude' },
 a2: { state: 'done', stateSince: now - 3 * MIN, provider: 'claude', attention: true, lastMessage: 'All green' },
 a3: { state: 'working', stateSince: now - 12 * MIN, provider: 'claude', toolFamily: 'edit', activity: 'Edit src/a.ts', silence: { level: 'quiet', since: now - 12 * MIN }, context: { pct: 0.42, used: 84000, window: 200000, exact: false } },
 a4: { state: 'error', stateSince: now - 2 * MIN, provider: 'claude', attention: true, failure: { kind: 'limit', until: now + 2 * 60 * MIN, code: 'rate_limit' } },
 a5: { state: 'working', stateSince: now - MIN, provider: 'claude', needs: { text: 'Approve the deploy', at: now - 7 * MIN } },
 a6: { state: 'action', reason: 'question', stateSince: now - 9 * MIN, provider: 'claude', attention: false, muted: true },
 b1: { state: 'idle', precise: false, pendingCount: 0, stateSince: now - 4 * MIN, attention: true, needs: { text: 'Check the PR', at: now - 4 * MIN }, bare: true },
 b2: { state: 'done', stateSince: now - MIN, provider: 'claude', attention: false },
 b3: { state: 'done', stateSince: now - 6 * MIN, provider: 'claude', attention: false, muted: true },
 b4: { state: 'working', stateSince: now - MIN, provider: 'codex', context: { pct: 0.9, used: 9000, window: 10000, exact: true } },
 c1: { state: 'done', stateSince: now - 8 * MIN, provider: 'claude', attention: false },
};
const snapshot = {
 language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, activeWorkspaceId: 'w1', hostName: 'ESTUDIO-PC', keyButtons: [], mountedWorkspaceIds: ['w1', 'w2', 'w3'],
 workspaces: [
  { id: 'w1', name: 'Front', layoutOrder: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], panes: [
   pane('a1', 'Asker', 'claude'), pane('a2', 'Builder', 'claude'), pane('a3', 'Editor', 'claude'),
   pane('a4', 'Limited', 'claude'), pane('a5', 'Deployer', 'claude'), pane('a6', 'Quiet one', 'claude'),
  ] },
  { id: 'w2', name: 'Back', layoutOrder: ['b1', 'b2', 'b3', 'b4'], panes: [
   pane('b1', 'Shell with a request', 'shell'), pane('b2', 'Seen', 'claude'), pane('b3', 'Muted done', 'claude'), pane('b4', 'Codex worker', 'codex'),
  ] },
  { id: 'w3', name: 'Docs', layoutOrder: ['c1'], panes: [pane('c1', 'Writer', 'claude')] },
 ],
};
const copy = v => JSON.parse(JSON.stringify(v));
window.runMain = async () => {
 try { localStorage.clear() } catch {}
 setLang('en');
 store.getState().update({ phase: 'live', snapshot, paneStatus: copy(statuses), connected: true, appVersion: '2.7.0', screen: 'home', activePaneId: null, subscribedPaneId: null, lastPane: null, lastViewedAt: {}, homeCollapsed: [] });
 const host = document.getElementById('root'); const r = createRoot(host);
 flushSync(() => r.render(<LiveShell />));
 await frames();
 const layer = $('[data-terminal-layer]');

 // --- Waiting for you: the shared order and count (A6 rule, the desktop's) ---
 const items = attentionItems(snapshot.workspaces, statuses);
 const want = needsYouRows(items).map(x => x.id).join();
 const needsIds = () => $$('[data-needs-row]').map(e => e.dataset.needsRow).join();
 check(needsIds() === want && want === 'a5,a1,b1,a4,a2', 'Waiting for you lists the consoles in needsYouRows order across workspaces (got ' + needsIds() + ')');
 check(Number($('[data-needs-you]').dataset.needsYou) === needsYouCount(items) && needsYouCount(items) === 5 && $('[data-needs-count]').textContent === '5', 'its count is needsYouCount (5)');
 check($$('[data-ws-badge]').reduce((n, e) => n + Number(e.textContent), 0) === 5 && $('[data-workspace=w1] [data-ws-badge]').textContent === '4' && !$('[data-workspace=w3] [data-ws-badge]'), 'the workspace badges count the same consoles (4 + 1)');
 check($('[data-home-list]').firstElementChild === $('[data-needs-you]'), 'the section heads Home');
 check(!$('[data-needs-row=a6]') && !$('[data-needs-row=b3]') && !$('[data-needs-row=b2]') && !$('[data-needs-row=a3]'), 'muted, seen and working consoles stay out');
 const amber = 'rgb(245, 158, 11)', red = 'rgb(239, 68, 68)';
 check($('[data-needs-row=a5] [data-needs-line]').textContent === 'Needs you: Approve the deploy' && getComputedStyle($('[data-needs-row=a5] [data-needs-line]')).color === amber, 'a snaos needs row says what it asked for, in the request amber');
 check($('[data-needs-row=b1] [data-needs-line]').textContent === 'Needs you: Check the PR' && !$('[data-needs-row=b1] [role=img]') && $('[data-needs-row=b1] [data-needs-wsname]').textContent === 'Back', 'a bare request: its text and workspace, no agent glyph');
 check($('[data-needs-row=a1] [data-needs-line]').textContent === 'Waiting for permission' && $('[data-needs-row=a2] [data-needs-line]').textContent === 'Done 3m ago', 'the others say why with the row line');

 // --- the row signals ---
 const row = id => $('[data-pane=' + id + ']');
 check(row('a3').querySelector('[data-status-line]').textContent === 'Editing src/a.ts · 12m', 'doing now: "Editing src/a.ts · 12m" (got ' + row('a3').querySelector('[data-status-line]').textContent + ')');
 check(row('a3').querySelector('[data-row-silence=quiet]').textContent === 'No signal for 12 min', 'the silence with its minutes');
 const ctx = row('a3').querySelector('[data-row-context]');
 check(ctx.textContent === '42% est.' && ctx.getAttribute('aria-label') === 'Context 42% full (estimated)' && ctx.dataset.contextExact === 'false', 'an estimated context reads "42% est."');
 check(row('b4').querySelector('[data-row-context]').textContent === '90%' && row('b4').querySelector('[data-row-context]').getAttribute('aria-label') === 'Context 90% full', 'an exact one (Codex) has no "est."');
 const fail = row('a4').querySelector('[data-row-failure=limit]');
 check(fail && fail.textContent.startsWith('Usage limit until ') && getComputedStyle(fail).color === red, 'the failure, red, with "until <time>" while the reset is ahead (got ' + (fail && fail.textContent) + ')');
 const needs = row('a5').querySelector('[data-row-needs]');
 check(needs && needs.textContent === 'Needs you: Approve the deploy' && getComputedStyle(needs).color === amber, 'the needs text in amber under the state');
 check(row('a6').querySelector('[data-row-muted]')?.getAttribute('aria-label') === 'Muted until its state changes' && !row('a5').querySelector('[data-row-muted]'), 'a muted console carries the bell-off mark');
 const bare = row('b1');
 check(!bare.querySelector('[role=img]') && bare.querySelector('[data-status-line]').textContent === 'Needs you: Check the PR' && bare.querySelector('[data-status-line]').hasAttribute('data-row-needs') && !bare.querySelector('[data-row-failure],[data-row-silence],[data-row-context],[data-row-muted],[data-last-message]'), 'a bare status shows only its request: no glyph, no agent state');
 check($$('[data-workspace=w2] [data-pane]').map(e => e.dataset.pane).join() === 'b1,b4,b2,b3', 'a request ranks first in its workspace');
 check(noOverflow(), 'Home with every signal fits 360px' + wideNote());
 // The check can fail: a row whose context meter stops shrinking (420px) is
 // caught inside the list, though the document itself stays 360px wide.
 const meter = row('a3').querySelector('[data-row-context]');
 meter.style.minWidth = '420px';
 check(!noOverflow() && wide.some(w => w.includes('[data-home-list] scrollWidth')) && wide.some(w => w.startsWith('span[data-row-context]')) && wide.some(w => w.startsWith('div[data-pane]')), 'a row wider than 360px fails the check' + wideNote());
 meter.style.minWidth = '';
 check(noOverflow(), 'and it fits again once the meter shrinks' + wideNote());

 // --- the ctls ---
 const ack = $('[data-row-silence-ack=a3]');
 check(ack && ack.getAttribute('aria-label') === 'Ignore this turn' && ack.getBoundingClientRect().width >= 36, 'the silence line carries Ignore this turn');
 click(ack); await wait(60);
 check(JSON.stringify(ctls.at(-1)) === '{"kind":"silenceAck","paneId":"a3"}' && layer.dataset.open === 'false' && store.getState().screen === 'home', 'its tap sends silenceAck and never opens the console');
 const ids = () => $$('[data-pane-actions] [data-action]').map(b => b.dataset.action).join();
 const pick = async id => { click($('[data-pane-actions] [data-action=' + id + ']')); await wait(420) };
 await hold(row('a2')); await wait(300);
 check(ids() === 'markRead,mute,rename,restart,reveal,copyTitle,close', 'a done console: Mark as read and Mute first (got ' + ids() + ')');
 check($('[data-pane-actions] [data-action=markRead]').textContent === 'Mark as read' && $('[data-pane-actions] [data-action=mute]').textContent === 'Mute until it changes', 'with their labels');
 await pick('markRead');
 check(JSON.stringify(ctls.at(-1)) === '{"kind":"markRead","paneId":"a2"}', 'Mark as read sends markRead');
 await hold(row('a6')); await wait(300);
 check(ids() === 'unmute,rename,restart,reveal,copyTitle,close' && $('[data-pane-actions] [data-action=unmute]').textContent === 'Unmute', 'a muted action offers Unmute and no Mark as read');
 await pick('unmute');
 check(JSON.stringify(ctls.at(-1)) === '{"kind":"mutePane","paneId":"a6","muted":false}', 'Unmute sends mutePane muted:false');
 await hold(row('a3')); await wait(300);
 check(ids() === 'mute,silenceAck,rename,restart,reveal,copyTitle,close', 'a silent agent adds Ignore this turn');
 await pick('mute');
 check(JSON.stringify(ctls.at(-1)) === '{"kind":"mutePane","paneId":"a3","muted":true}', 'Mute sends mutePane muted:true');
 await hold(row('a3')); await wait(300);
 await pick('silenceAck');
 check(JSON.stringify(ctls.at(-1)) === '{"kind":"silenceAck","paneId":"a3"}', 'and its Ignore this turn sends silenceAck');
 await hold(row('b1')); await wait(300);
 check(ids() === 'rename,restart,reveal,copyTitle,close' && !$('[data-pane-actions] [role=img]'), 'a bare status gets no marks and no agent glyph');
 history.back(); await wait(420);
 failKind = 'markRead';
 await hold(row('a4')); await wait(300);
 await pick('markRead');
 check($$('[data-toast]').some(x => x.textContent === 'The PC could not do it'), 'a failed ack shows a toast');

 // Waiting for you rows open and long-press like a console row.
 tap($('[data-needs-row=b1]')); await wait(380);
 check(layer.dataset.open === 'true' && store.getState().activePaneId === 'b1' && !ctls.some(a => a.kind === 'switchWorkspace'), 'a tap on a Waiting for you row opens that console, phone only');
 history.back(); await wait(420);
 await hold($('[data-needs-row=a4]')); await wait(300);
 check($('[data-pane-actions]').dataset.paneActions === 'a4' && ids().startsWith('markRead,mute,') && $('[data-action-header]').textContent.includes('Front'), 'a long-press opens its actions on its own workspace');
 history.back(); await wait(420);

 // The workspace kebab: Mark all read.
 const wsIds = () => $$('[data-ws-actions] [data-action]').map(b => b.dataset.action).join();
 click($('[data-workspace=w1] [data-ws-menu]')); await wait(300);
 check(wsIds() === 'markAllRead,newHere,promptAll,quick,history,notes,showOnPc' && $('[data-ws-actions] [data-action=markAllRead]').textContent === 'Mark all read', 'the kebab starts with Mark all read');
 let from = ctls.length;
 click($('[data-ws-actions] [data-action=markAllRead]')); await wait(420);
 check(ctls.slice(from).map(a => a.kind + ':' + a.paneId).join() === 'markRead:a2,markRead:a4', 'Mark all read sends markRead for each unseen done or error console: ' + JSON.stringify(ctls.slice(from)));
 click($('[data-workspace=w2] [data-ws-menu]')); await wait(300);
 from = ctls.length;
 click($('[data-ws-actions] [data-action=markAllRead]')); await wait(420);
 check(ctls.slice(from).map(a => a.kind + ':' + a.paneId).join() === 'markRead:b3', 'a muted done counts (it may be unread under the mute); a seen one and a bare request do not');
 click($('[data-workspace=w3] [data-ws-menu]')); await wait(300);
 check(wsIds() === 'newHere,promptAll,quick,history,notes,showOnPc', 'nothing unread: no Mark all read');
 history.back(); await wait(420);

 // The PC answers: a2 seen, the list and the badge follow.
 flushSync(() => store.getState().update({ paneStatus: { ...copy(statuses), a2: { ...statuses.a2, attention: false } } }));
 await frames();
 check(needsIds() === 'a5,a1,b1,a4' && $('[data-needs-count]').textContent === '4' && $('[data-workspace=w1] [data-ws-badge]').textContent === '3', 'a console marked read leaves Waiting for you and its badge');

 // --- a 2.6.0 desktop: every new action hidden (the signals are data it never sends) ---
 flushSync(() => store.getState().update({ appVersion: '2.6.0', paneStatus: copy(statuses) }));
 await frames();
 check(!$('[data-row-silence-ack]') && row('a3').querySelector('[data-row-silence]'), 'no Ignore this turn on the row');
 await hold(row('a2')); await wait(300);
 check(ids() === 'rename,restart,reveal,copyTitle,close', 'the pane actions are the plain list (got ' + ids() + ')');
 history.back(); await wait(420);
 click($('[data-workspace=w1] [data-ws-menu]')); await wait(300);
 check(wsIds() === 'newHere,promptAll,quick,history,notes,showOnPc', 'and the kebab has no Mark all read');
 history.back(); await wait(420);

 // --- Spanish ---
 setLang('es');
 flushSync(() => store.getState().update({ appVersion: '2.7.0', snapshot: { ...copy(snapshot), language: 'es' }, paneStatus: copy(statuses) }));
 await frames();
 check($('[data-needs-you] h2').textContent.startsWith('Te esperan') && $('[data-needs-row=a5] [data-needs-line]').textContent === 'Te necesita: Approve the deploy', 'es: "Te esperan" and "Te necesita"');
 check(row('a3').querySelector('[data-status-line]').textContent === 'Editando src/a.ts · 12m' && row('a3').querySelector('[data-row-silence]').textContent === 'Sin señales hace 12 min' && row('a3').querySelector('[data-row-context]').textContent === '42% estimado', 'es: "Editando", "Sin señales hace 12 min", "42% estimado"');
 check(row('a4').querySelector('[data-row-failure]').textContent.startsWith('Límite de uso hasta ') && row('a6').querySelector('[data-row-muted]').getAttribute('aria-label') === 'Silenciada hasta que cambie su estado' && $('[data-row-silence-ack=a3]').getAttribute('aria-label') === 'Ignorar este turno', 'es: "Límite de uso hasta", the mute mark and Ignorar este turno');
 check(noOverflow(), 'es: Home fits 360px' + wideNote());
 await hold(row('a2')); await wait(300);
 check($('[data-pane-actions] [data-action=markRead]').textContent === 'Marcar leído' && $('[data-pane-actions] [data-action=mute]').textContent === 'Silenciar hasta que cambie', 'es: Marcar leído, Silenciar hasta que cambie');
 history.back(); await wait(420);
 await hold(row('a6')); await wait(300);
 check($('[data-pane-actions] [data-action=unmute]').textContent === 'Quitar silencio', 'es: Quitar silencio');
 history.back(); await wait(420);
 await hold(row('a3')); await wait(300);
 check($('[data-pane-actions] [data-action=silenceAck]').textContent === 'Ignorar este turno', 'es: Ignorar este turno in the actions');
 history.back(); await wait(420);
 click($('[data-workspace=w1] [data-ws-menu]')); await wait(300);
 check($('[data-ws-actions] [data-action=markAllRead]').textContent === 'Marcar todo leído' && noOverflow(), 'es: Marcar todo leído, and its sheet fits 360px' + wideNote());
 history.back(); await wait(420);
 setLang('en');
 r.unmount();

 // --- the Plan card's "View full plan" ---
 const card = { kind: 'plan', pending: { id: 'tp1', kind: 'plan', toolName: 'ExitPlanMode', summary: 'Add the parser, then wire it' } };
 const options = [{ n: 1, label: 'Yes, and use auto mode', cls: 'approve' }, { n: 2, label: 'Yes, and manually approve edits', cls: 'approve' }, { n: 3, label: 'No, keep planning', cls: 'reject' }];
 const planText = '# The plan\\n\\n1. Parse the input\\n2. Wire it to the CLI\\n\\n' + 'A long paragraph that keeps going so the sheet has to wrap it. '.repeat(12);
 const okPlan = (truncated = false) => ({ ok: true, value: { ok: true, plan: { requestId: 'tp1', text: planText, at: now, truncated } } });
 store.getState().update({ phase: 'live', connected: true, appVersion: '2.7.0', chatPaneId: null, activePaneId: 'a1' });
 const p = createRoot(host);
 const renderCard = () => flushSync(() => p.render(<BackStackHost><div style={{ position: 'fixed', left: 0, right: 0, bottom: 0 }}><PlanCard paneId="a1" card={card} options={options} onFold={() => {}} /></div></BackStackHost>));
 renderCard();
 await frames();
 const sheetState = () => $('[data-plan-sheet]')?.dataset.planState;
 const openPlan = async () => { click($('[data-plan-read=tp1]')); await wait(360) };
 const closePlan = async () => { history.back(); await wait(420) };
 check($('[data-plan-read=tp1]')?.textContent === 'View full plan' && !$('[data-prompt-card=plan]').textContent.includes('The full plan is in the terminal'), 'a 2.7.0 desktop: View full plan takes the place of the terminal pointer');
 planReply = okPlan();
 await openPlan();
 check(planCalls.join() === 'a1:tp1' && sheetState() === 'ok', 'it asks planReq for the card request and shows the plan');
 check($('[data-sheet][data-open=true] h2').textContent === 'Agent plan' && $('[data-plan-text] [data-md]').textContent.includes('Parse the input') && $('[data-plan-text] [data-md]').textContent.includes('Wire it to the CLI') && !$('[data-plan-truncated]'), 'the Markdown plan under "Agent plan", no cut note');
 check(noOverflow(), 'the plan sheet fits 360px' + wideNote());
 // And it can fail there too: a plan body that stops at 500px scrolls inside the panel.
 const planBody = $('[data-plan-text]');
 planBody.style.minWidth = '500px';
 check(!noOverflow() && wide.some(w => w.includes('[data-sheet-panel] scrollWidth')) && wide.some(w => w.startsWith('div[data-plan-text]')), 'a plan wider than 360px fails the check' + wideNote());
 planBody.style.minWidth = '';
 check(noOverflow(), 'and the plan fits again' + wideNote());
 await closePlan();
 check(!$('[data-plan-sheet]'), 'back closes the sheet');
 planReply = okPlan(true);
 await openPlan();
 check(planCalls.length === 2 && $('[data-plan-truncated]')?.textContent === 'This plan is long: only its start is shown here. The rest is in the terminal.' && $('[data-plan-text]'), 'a plan main cut says so above it, asked again on each open');
 await closePlan();
 planReply = { ok: true, value: { ok: false, error: 'not_found' } };
 await openPlan();
 check(sheetState() === 'gone' && $('[data-plan-unavailable]').textContent.includes('The full plan is no longer available.') && $('[data-plan-unavailable]').textContent.includes('Add the parser, then wire it'), 'a plan main no longer keeps: "no longer available" and the first line');
 await closePlan();
 planReply = { ok: true, value: { ok: false, error: 'rate' } };
 await openPlan();
 check(sheetState() === 'noReply' && $('[data-plan-sheet] [data-no-reply]'), 'the PC rate limit: The PC did not answer');
 planReply = okPlan();
 click($('[data-plan-sheet] [data-no-reply] button')); await wait(120);
 check(sheetState() === 'ok' && planCalls.length === 5, 'Retry asks again and shows the plan');
 await closePlan();
 planReply = { ok: false, error: 'timeout' };
 await openPlan();
 check(sheetState() === 'noReply', 'no answer in 10s: The PC did not answer');
 await closePlan();
 const asked = planCalls.length;
 flushSync(() => store.getState().update({ appVersion: '2.6.0' }));
 await frames();
 check(!$('[data-plan-read]') && $('[data-prompt-card=plan]').textContent.includes('The full plan is in the terminal') && planCalls.length === asked, 'a 2.6.0 desktop: no View full plan (planReq would strike), the terminal pointer stays');
 flushSync(() => store.getState().update({ appVersion: '2.7.0', connected: false }));
 await frames();
 check(!$('[data-plan-read]'), 'offline: no View full plan');
 setLang('es');
 flushSync(() => store.getState().update({ connected: true }));
 renderCard();
 await frames();
 check($('[data-plan-read=tp1]').textContent === 'Ver plan completo', 'es: Ver plan completo');
 planReply = okPlan(true);
 await openPlan();
 check($('[data-sheet][data-open=true] h2').textContent === 'Plan del agente' && $('[data-plan-truncated]').textContent === 'Este plan es largo: acá se ve solo el principio. El resto está en la terminal.' && noOverflow(), 'es: "Plan del agente" and the cut note, at 360px' + wideNote());
 await closePlan();
 planReply = { ok: true, value: { ok: false, error: 'not_found' } };
 await openPlan();
 check($('[data-plan-unavailable]').textContent.includes('El plan completo ya no está disponible.'), 'es: el plan ya no está disponible');
 await closePlan();
 setLang('en');
 p.unmount();
 return checks;
};
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { __APP_VERSION__: '"2.7.0"', 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': path.join(root, 'src/shared') }, loader: { '.css': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body style="margin:0"><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:360,height:640,useContentSize:true,webPreferences:{sandbox:true,backgroundThrottling:false,offscreen:true}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.runMain()');
 console.log('PASS: '+checks+' mobile attention UI checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 90000 })
process.stdout.write(result.stdout ?? '')
process.stderr.write((result.stderr ?? '') + (result.error ? result.error.message : ''))
fs.rmSync(dir, { recursive: true, force: true })
if (result.status !== 0 || !/^PASS:/m.test(result.stdout ?? '')) process.exit(1)
