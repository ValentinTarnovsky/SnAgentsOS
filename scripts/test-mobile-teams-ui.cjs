// The phone's Teams screens (app 2.7.0, E10 B8) with the production CSS in an
// isolated offscreen browser at 360px: the real LiveShell over a fake PC
// (client.requestTeam and client.sendTeamCtl stubbed, no socket). A 2.6.0
// desktop hides the Home card and gets nothing sent; on 2.7.0 the card's
// count is teamNeedsCount of the team's needs view and "Ver todos" opens the
// list; the board's column tabs with their counts and "Cargar más"; a task
// with its needs first, the folded description cut on the PC, a comment main
// wrote rendered from its key (an unknown key in words, never the key),
// agent text with its hidden characters spelled out, the run log (notes and
// the log cut in words, never the record), older comments, a dictated
// comment that waits for Comentar, a dictated text past the cap refused on
// the phone (never sent), no reload while the composer holds text;
// "Te necesita" with the three ctls (teamDecide, teamAnswer, teamDispatch),
// hire, integrate and the resumeTeam card action read only with "En la PC"
// (never sent), the refusals in words (nothingToGrant, a stale hire, a gone
// card, a live key in the text); the Lead chat with leadSay; a new task; a
// #team=..&task=.. deep link opens the board, then the task, and back
// returns to the board; a read with the socket down keeps loading (no
// refusal) until the reconnect reads it; Labs off on the PC empties everything; Spanish at
// 360px with no horizontal overflow and 44px touch targets. Integration
// fixes: a board change on the PC reloads as many rows as Load more had
// loaded, a reload keeps the earlier comments and Lead messages Show earlier
// loaded, and a tapped push with the app open (the snaos-open message the
// worker posts, through the real registerServiceWorker listener) never fakes a
// back: a team push keeps Notes open under its board and task, a console push
// closes every pushed screen (Notes and the Teams ones) so its terminal shows,
// and the backs land on the first history entry (no dead back press). A
// notice shows once: inside the pushed screen on top (its live region in that
// dialog) while one slides in or stays open, never also on Home or the
// terminal under it, and not again on Home afterwards; a [Go] toast stays in
// the terminal. Tanda B close: teamDecide carries the rev of the approval
// shown; a permission the PC refuses as stale (a later run grew it) reads Te
// necesita again and says it changed (en and es); grantsFull in words; rows
// the PC could not send whole (pcOnly) read only with On the PC, no button,
// and "The rest is on the PC".
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagentsos-mobile-teams-ui-'))
const assets = path.join(root, 'out/mobile/assets')
const mobileCss = fs.existsSync(assets) && fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!mobileCss) throw new Error('Run npm run build:mobile first')
require('esbuild').buildSync({ stdin: { resolveDir: root, loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LiveShell } from './src/mobile/src/components/LiveShell';
import { store } from './src/mobile/src/lib/store';
import { client } from './src/mobile/src/lib/client';
import { setLang } from './src/mobile/src/lib/i18n';
import { parseDeepLink } from './src/mobile/src/lib/deepLink';
import { registerServiceWorker } from './src/mobile/src/lib/serviceWorker';
import { forgetTeams, loadTeamList, openTeamBoard, openTeamNeeds, openTeamTask, resyncTeams, teamChanged, useTeamsUi } from './src/mobile/src/lib/teamsStore';
import { openWsNotes, useWsNotes } from './src/mobile/src/lib/wsNotes';
import { teamNeedsCount } from './src/shared/teamNeeds';
import { COMMENT_TEXT_MAX, RUN_LOG_CUT_TEXT, runNoteText } from './src/shared/teams';
import { TEAM_PHONE_HIRE_LINES } from './src/shared/team-protocol';
import { answerFailText, decideFailText, refusalOfAck } from './src/mobile/src/components/teams/teamText';
const wait = ms => new Promise(r => setTimeout(r, ms));
const frames = () => wait(40);
let checks = 0; const check = (ok, label) => { if (!ok) throw new Error(label); checks++ };
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const until = async (fn, label, ms = 3000) => { for (let t = 0; t < ms; t += 40) { if (fn()) return; await frames() } throw new Error('timeout: ' + label) };
const click = el => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
const setValue = (el, value) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) };
const top = id => { const all = $$('[data-push-screen]'); return all.length > 0 && all[all.length - 1].dataset.pushScreen === id };
const screen = id => $('[data-push-screen="' + id + '"]');
const back = async () => { history.back(); await wait(420) };
// Pushed screens and sheets at rest (a slide moves them sideways for 300ms).
const shown = () => until(() => $$('[data-push-screen]').every(e => e.dataset.stage === 'shown') && $$('.sheet-up, .sheet-out').every(e => !e.getAnimations().length), 'slides end');
// Too wide content never widens the document here: Home scrolls inside
// [data-home-list], a pushed screen inside its body and a sheet inside its
// panel (overflow-y auto makes overflow-x auto too). So measure the content:
// each box fits its own width and nothing in it ends outside the viewport
// (an inner box that scrolls sideways on purpose, data-scrollable, holds its own).
const wideAt360 = () => {
 const bad = [];
 const tag = e => e.tagName.toLowerCase() + [...e.attributes].filter(a => a.name.startsWith('data-')).map(a => '[' + a.name + '=' + a.value + ']').join('');
 const fits = e => { if (e.scrollWidth > e.clientWidth + 1) bad.push(tag(e) + ' scrollWidth ' + e.scrollWidth + ' > ' + e.clientWidth) };
 for (const box of $$('[data-home-list], [data-push-screen] > [data-scrollable], [data-sheet][data-open=true] [data-sheet-panel]')) {
  fits(box);
  for (const e of box.querySelectorAll('*')) {
   if (e.parentElement.closest('[data-scrollable]') !== box || e.classList.contains('sr-only')) continue;
   const r = e.getBoundingClientRect();
   if ((r.width || r.height) && (r.left < -0.5 || r.right > innerWidth + 0.5)) bad.push(tag(e) + ' spans ' + Math.round(r.left) + '..' + Math.round(r.right));
  }
 }
 return bad;
};
let wide = [];
const noOverflow = () => { wide = wideAt360(); return document.documentElement.scrollWidth <= innerWidth && wide.length === 0 };
const tall = sel => $$(sel).every(e => e.getBoundingClientRect().height >= 43.5);
// Whether an element is what a tap at its center would hit (a toast box ignores touches, so it takes them for the probe).
const onTop = el => { const was = el.style.pointerEvents; el.style.pointerEvents = 'auto'; const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); el.style.pointerEvents = was; return r.width > 0 && !!hit && hit.closest('[data-toast]') === el };
const RLO = String.fromCodePoint(0x202E), TAG_A = String.fromCodePoint(0xE0041);

// ---- the fake PC ----
const TEAM = 'tm-aaaaaaaaaaaa', T2 = 'tm-bbbbbbbbbbbb', T3 = 'tm-cccccccccccc', T4 = 'tm-dddddddddddd';
const now = Date.now(), MIN = 60000;
const sum = (id, title, column, extra = {}) => ({
 id, rev: 1, title, state: column, phase: column === 'doing' ? 'executing' : column === 'review' ? 'qa' : 'none', column, priority: 'normal',
 repoId: 'main', isolation: 'worktree', needsPlan: true, blockedBy: [], createdBy: 'user', createdAt: now, updatedAt: now, stateSince: now,
 userOwned: [], needs: 0, comments: 0, queued: 0, ...extra,
});
const cols = {
 todo: Array.from({ length: 160 }, (_, i) => sum('t-' + (10 + i), 'Todo task ' + (10 + i), 'todo')),
 doing: [sum('t-1', 'Login form', 'doing', { phase: 'planApproval', assignee: 'dev', needs: 3, priority: 'urgent', comments: 3, run: { id: 'r-aaaaaaaaaaaa', agentId: 'dev', mode: 'plan', state: 'running' } }), sum('t-5', 'Api ' + RLO + 'route', 'doing', { assignee: 'dev-2' })],
 review: [sum('t-2', 'Signup', 'review', { phase: 'userOk', assignee: 'qa', review: { round: 2, max: 3 } }), sum('t-3', 'Reset password', 'review', { phase: 'userOk', assignee: 'qa' })],
 done: Array.from({ length: 5 }, (_, i) => sum('t-' + (200 + i), 'Done ' + i, 'done')),
 blocked: [sum('t-4', 'Payments', 'blocked', { state: 'blocked', blocked: { kind: 'deps', waitingOn: ['t-1'] } })],
};
const counts = () => Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.length]));
const hireLines = Array.from({ length: 260 }, (_, i) => '+line ' + i);
const freshNeeds = () => ({
 teamId: TEAM, rev: 5, trust: 'trusted', paused: null,
 approvals: [
  { id: 'a-1', taskId: 't-1', state: 'pending', decider: 'user', requestedBy: 'dev', at: now - 9 * MIN, rev: 1, payload: { kind: 'plan', planRev: 2, small: false, text: '# Plan\\n- one ' + RLO + 'x\\n- two' } },
  { id: 'a-2', state: 'pending', decider: 'user', requestedBy: 'lead', at: now - 8 * MIN, rev: 1, payload: { kind: 'hire', roleId: 'docs', diff: { rel: 'roles/docs.md', status: 'added', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 260, lines: hireLines }], add: 260, del: 0 }, risks: [] } },
  { id: 'a-3', taskId: 't-2', state: 'pending', decider: 'user', requestedBy: 'qa', at: now - 7 * MIN, rev: 1, payload: { kind: 'integrate', branch: 'sn/t-aaaaaa-2', base: 'main', ahead: 3 } },
  // rev 2: a later run of the task already merged a denial into this permission once (Tanda B close).
  { id: 'a-4', taskId: 't-1', state: 'pending', decider: 'user', requestedBy: 'dev', at: now - 6 * MIN, rev: 2, payload: { kind: 'permission', roleId: 'dev', tools: ['Bash(npm test:*)'], denied: ['npm test --watch'] } },
  { id: 'a-5', taskId: 't-3', state: 'pending', decider: 'user', requestedBy: 'qa', at: now - 5 * MIN, rev: 1, payload: { kind: 'final', summary: 'All done', stat: { files: 2, insertions: 10, deletions: 3, top: [{ path: 'src/a.ts', add: 8, del: 1 }] } } },
  { id: 'a-6', taskId: 't-5', state: 'pending', decider: 'lead', requestedBy: 'dev', at: now - 5 * MIN, rev: 1, payload: { kind: 'plan', planRev: 1, small: true, text: 'small' } },
 ],
 cards: [
  { id: 'k-1', taskId: 't-1', agentId: 'dev', kind: 'choice', state: 'open', at: now - 4 * MIN, question: 'Which db?', options: ['sqlite', 'postgres'], multi: false },
  { id: 'k-2', agentId: 'dev', kind: 'choice', state: 'open', at: now - 4 * MIN, question: 'Pick some', options: ['a', 'b', 'c'], multi: true },
  { id: 'k-3', agentId: 'research', kind: 'text', state: 'open', at: now - 3 * MIN, question: 'Name it' },
  { id: 'k-4', agentId: 'dev', kind: 'confirm', state: 'open', at: now - 3 * MIN, question: 'Key added?' },
  { id: 'k-5', taskId: 't-2', kind: 'confirm', state: 'open', at: now - 2 * MIN, system: { why: 'failure', actions: ['retry', 'resumeTeam', 'dismiss'] } },
 ],
 queue: [
  { id: 'q-1', agentId: 'dev', taskId: 't-1', reason: 'assigned', mode: 'exec', priority: 'high', at: now - MIN, approved: false, defer: { reason: 'teamCap' } },
  { id: 'q-2', agentId: 'qa', reason: 'review', mode: 'qa', priority: 'normal', at: now - MIN, approved: false },
 ],
 tasks: { 't-1': { title: 'Login form', state: 'doing', phase: 'planApproval' }, 't-2': { title: 'Signup', state: 'review', phase: 'userOk' }, 't-3': { title: 'Reset password', state: 'review', phase: 'userOk' }, 't-5': { title: 'Api', state: 'doing', phase: 'executing' } },
});
let needs = freshNeeds();
const NEEDS_COUNT = teamNeedsCount(needs);
const list = () => [
 { id: TEAM, name: 'Front team', repoName: 'front', trust: 'trusted', paused: null, autoDispatch: false, agents: 4, running: 1, needsCount: teamNeedsCount(needs), rev: 5 },
 { id: T2, name: 'Back ' + RLO + 'team', repoName: 'back', trust: 'changed', paused: null, autoDispatch: true, agents: 2, running: 0, needsCount: 1, rev: 1 },
 { id: T3, name: 'Docs', repoName: 'docs', trust: 'trusted', paused: { reason: 'user', at: now }, autoDispatch: true, agents: 1, running: 0, needsCount: 0, rev: 1 },
 { id: T4, name: 'Ops', repoName: 'ops', trust: 'trusted', paused: null, autoDispatch: true, agents: 1, running: 2, needsCount: 0, rev: 1 },
];
// What the phone posted, kept by the PC: the next read has it.
const posted = { lead: [], tasks: {} };
const comment = (id, author, text, extra = {}) => ({ id, author, authorName: author === 'user' ? 'You' : author === 'system' ? 'System' : author.toUpperCase(), kind: author === 'system' ? 'system' : 'comment', text, at: now - MIN, queued: false, ...extra });
const taskDetail = (id) => {
 const s = Object.values(cols).flat().find(x => x.id === id) || sum(id, 'Task ' + id, 'todo');
 return {
  ...s,
  body: Array.from({ length: 20 }, (_, i) => 'Line ' + (i + 1)).join('\\n'),
  plan: { rev: 2, text: '# Plan\\n- one', status: 'pending', small: false, at: now },
  reviewInfo: { round: 0, max: 3 },
  comments: [
   comment('m-3', 'system', '', { sys: { key: 'noQaRole' } }),
   comment('m-4', 'dev', 'Done ' + RLO + 'evil' + TAG_A),
   comment('m-5', 'user', 'Thanks', { queued: true, recipient: 'dev', recipientName: 'Dev' }),
   comment('m-6', 'system', '', { sys: { key: 'futureKey', vars: {} } }),
   ...(posted.tasks[id] || []),
  ],
  commentsCursor: 'm-3', commentsArchived: 0,
  runs: [{ id: 'r-aaaaaaaaaaaa', agentId: 'dev', roleId: 'dev', taskId: id, mode: 'plan', trigger: 'assigned', state: 'running', provider: 'claude', resumed: false, queuedAt: now - 5 * MIN, startedAt: now - 5 * MIN }],
  approvals: [], cards: [],
  truncated: { body: true },
 };
};
const runItem = (id, role, text) => ({ id, role, ts: now, blocks: [{ t: 'text', text }] });
const leadView = (older) => older
 ? { messages: [comment('m-1', 'user', 'Older hello')], cursor: null, agent: null }
 : { messages: [comment('m-2', 'user', 'Build a login'), comment('m-7', 'lead', 'On it: **plan** ' + RLO + 'x'), comment('m-8', 'system', '', { sys: { key: 'hireRejected', vars: { roleId: 'docs' } } }), comment('m-9', 'user', 'And tests', { queued: true }), ...posted.lead],
  cursor: 'm-2', agent: { id: 'lead', roleId: 'lead', roleName: 'Lead', kind: 'lead', index: 1, provider: 'claude', permission: 'readonly', status: 'running', paused: false, retired: false, run: { id: 'r-bbbbbbbbbbbb', agentId: 'lead', roleId: 'lead', taskId: null, mode: 'lead', trigger: 'userMessage', state: 'running', provider: 'claude', resumed: true, queuedAt: now } } };
const reqs = [], ctls = [];
// offline: the PC never answers (timeout); dropped: the socket is down, the frame never leaves the phone.
let offline = false, dropped = false;
// hold: a comment or leadSay reply waits on it (a slow PC), so the test can type while the request is out.
let hold = null;
const ok = v => ({ ok: true, value: { ok: true, ...v } });
const fail = (error, extra = {}) => ({ ok: true, value: { ok: false, error, ...extra } });
// The socket: client.request carries every teamReq frame (requestTeam's version gate and slots are the real ones).
const fakeTeam = async (req) => {
 reqs.push(req);
 await frames();
 if (offline) return { ok: false, error: 'timeout' };
 switch (req.op) {
  case 'list': return ok({ teams: list() });
  case 'board': {
   const col = req.column || 'todo', all = cols[col], start = req.cursor ? Number(req.cursor) : 0, limit = req.limit || 150;
   const next = start + limit < all.length ? String(start + limit) : null;
   return ok({ page: { teamId: req.teamId, rev: 5, tasks: all.slice(start, start + limit), cursor: next, done: next === null, counts: counts(), cancelled: 0 } });
  }
  case 'task': {
   if (req.taskId === 't-404') return fail('not_found');
   const d = taskDetail(req.taskId);
   if (req.commentsBefore) return ok({ task: { ...d, comments: [comment('m-1', 'dev', 'First'), comment('m-2', 'user', 'Second')], commentsCursor: null } });
   return ok({ task: d });
  }
  case 'needs': return ok({ needs: JSON.parse(JSON.stringify(needs)) });
  case 'runPage':
   if (req.before) return ok({ run: taskDetail('t-1').runs[0], items: [runItem('10', 'user', 'Start the plan')], cursor: null, done: true, live: true });
   return ok({ run: taskDetail('t-1').runs[0], items: [
    runItem('100', 'assistant', 'Reading ' + TAG_A + 'files'),
    runItem('200', 'system', runNoteText({ key: 'blockStopped', vars: { applied: 1, total: 3, at: 2, method: 'team.comment', error: 'bad_request', detail: 'secret' } })),
    runItem('300', 'system', runNoteText({ key: 'blockStopped', vars: { applied: 0, total: 2, at: 1, method: 'team.task.update', error: 'conflict' } })),
    runItem('400', 'system', RUN_LOG_CUT_TEXT),
   ], cursor: '100', done: false, live: true });
  case 'comment': {
   if (hold) await hold;
   if (req.text.includes('SECRET')) return fail('bad_request', { detail: 'secret' });
   const c = comment('m-50', 'user', req.text, { queued: true, at: Date.now() });
   (posted.tasks[req.taskId] ||= []).push(c);
   return ok({ comment: c });
  }
  case 'lead': return ok({ lead: leadView(!!req.before) });
  case 'leadSay': {
   if (hold) await hold;
   const c = comment('m-60', 'user', req.text, { queued: true, at: Date.now() });
   posted.lead.push(c);
   return ok({ comment: c });
  }
  case 'createTask': {
   if (req.task.title === 'too many') return fail('cap');
   const t = sum('t-300', req.task.title, 'todo'); cols.todo = [t, ...cols.todo]; return ok({ task: t });
  }
 }
 return fail('bad_request');
};
let frameId = 0;
client.request = async (make) => {
 const msg = make('f' + ++frameId);
 if (msg.type !== 'teamReq' || dropped) return { ok: false, error: 'offline' };
 return fakeTeam(msg.req);
};
const drop = (a) => {
 if (a.kind === 'teamDecide') needs.approvals = needs.approvals.filter(x => x.id !== a.approvalId);
 if (a.kind === 'teamAnswer') needs.cards = needs.cards.filter(x => x.id !== a.cardId);
 if (a.kind === 'teamDispatch') needs.queue = a.queueId === 'all' ? [] : needs.queue.filter(x => x.id !== a.queueId);
};
// The ctl path: sendTeamCtl's version gate is the real one; the team kinds reach this ack.
let ackFor = () => null;
// The PC's rule for a permission (Tanda B close): a decide at a rev other than the one it holds now is stale.
const staleUnlessRev = (a) => {
 const cur = a.kind === 'teamDecide' && needs.approvals.find(x => x.id === a.approvalId);
 return cur && cur.payload.kind === 'permission' && a.rev !== cur.rev ? { ok: false, error: 'conflict:stale' } : null;
};
client.sendCtl = async (action) => {
 if (!String(action.kind).startsWith('team')) return { ok: true };
 ctls.push(action);
 await frames();
 const forced = ackFor(action);
 if (forced) return forced;
 drop(action);
 return { ok: true };
};
class FakeRec { constructor() { window.__rec = this } start() {} stop() {} }
window.webkitSpeechRecognition = FakeRec;
try { Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true }) } catch {}
// A tapped notification with the app open: sw.js posts { type: 'snaos-open', hash } to the page. The container is
// fake (file:// has no worker); the listener is the real registerServiceWorker one and the hashchange handler the
// client's (client.start() adds it).
const swContainer = new EventTarget();
swContainer.register = () => Promise.resolve({});
Object.defineProperty(navigator, 'serviceWorker', { value: swContainer, configurable: true });
const tap = hash => swContainer.dispatchEvent(new MessageEvent('message', { data: { type: 'snaos-open', hash } }));
// A toast a person sees: displayed, not in the parked terminal (hidden, aria-hidden and inert).
const seen = text => $$('[data-toast]').filter(el => el.textContent === text && el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible' && !el.closest('[aria-hidden="true"], [inert]'));
const dictate = async (owner, words) => {
 click($('[data-mic-button="' + owner + '"]')); await frames();
 window.__rec.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: words } }] }); await frames();
};

const snapshot = { language: 'en', themeTokens: {}, fontFamily: 'mono', fontSize: 13, activeWorkspaceId: 'w1', hostName: 'PC', keyButtons: [], mountedWorkspaceIds: ['w1'], workspaces: [{ id: 'w1', name: 'Front', layoutOrder: [], panes: [] }] };

window.runMain = async () => {
 try { localStorage.clear() } catch {}
 setLang('en');
 store.getState().update({ phase: 'live', snapshot, paneStatus: {}, connected: true, appVersion: '2.6.0', screen: 'home', activePaneId: null, subscribedPaneId: null, lastPane: null, lastViewedAt: {}, homeCollapsed: [] });
 const host = document.getElementById('root'); const reactRoot = createRoot(host);
 flushSync(() => reactRoot.render(<LiveShell />));
 await frames();
 registerServiceWorker();
 window.addEventListener('hashchange', client.onHashChange);
 check(navigator.serviceWorker === swContainer, 'the fake worker container is the one the app listens to');

 // ---- 2.6.0: nothing shows and nothing is sent ----
 await loadTeamList();
 client.setPendingTeamLink(parseDeepLink('#team=' + TEAM + '&task=t-1'));
 const out = await client.requestTeam({ op: 'list' });
 await frames();
 check(!$('[data-home-teams]'), '2.6.0 desktop: no Teams card');
 check(out.ok && !out.value.ok && out.value.error === 'unsupported', '2.6.0 desktop: the client answers unsupported itself');
 const ack = await client.sendTeamCtl({ kind: 'teamDispatch', teamId: TEAM, queueId: 'all', go: true });
 check(!ack.ok && reqs.length === 0 && ctls.length === 0, '2.6.0 desktop: no team request nor ctl leaves the phone');
 check(useTeamsUi.getState().boardFor === null && !screen('team-board'), '2.6.0 desktop: a team link opens nothing');
 // The words of refusals no screen below reaches (a hire is decided on the PC only).
 check(decideFailText(refusalOfAck('conflict:stale'), 'hire') === 'The definition changed since the Lead proposed this hire: ask the Lead to propose it again.', 'a stale hire in words');
 check(decideFailText(refusalOfAck('forbidden'), 'hire') === 'That is decided on the PC.', 'a hire from the phone: forbidden in words');
 check(decideFailText(refusalOfAck('nothingToGrant'), 'permission', 'reject') === 'There is nothing to grant: the app no longer allows any rule of this request. Reject it.', 'a bare nothingToGrant detail');
 check(answerFailText(refusalOfAck('secret')) === 'The text holds a key of the app, so it was not sent. Remove it and try again.', 'a live key in an answer');
 check(answerFailText(refusalOfAck('rate')) === 'Too many requests in a row: try again in a moment.' && answerFailText(refusalOfAck('timeout')) === 'The PC did not answer', 'rate and no answer');
 check(answerFailText(refusalOfAck('weird_code')) === 'Could not send the answer.', 'an unknown code never shows as a code');

 // ---- 2.7.0: the Home card ----
 flushSync(() => store.getState().update({ appVersion: '2.7.0' }));
 await loadTeamList();
 await until(() => !!$('[data-home-teams]'), 'the Teams card shows');
 check($$('[data-team-card]').length === 3, 'the card lists three teams');
 check($$('[data-team-card]').map(e => e.dataset.teamCard).join() === TEAM + ',' + T2 + ',' + T4, 'those needing the user first, then the working ones');
 check($('[data-team-card="' + TEAM + '"] [data-team-card-needs]').dataset.teamCardNeeds === String(NEEDS_COUNT) && NEEDS_COUNT === 12, 'the count is teamNeedsCount of the needs view (12)');
 check($('[data-team-card="' + TEAM + '"] [data-team-card-needs]').textContent === '12', 'the pill shows the count');
 check($('[data-team-card="' + T2 + '"] [data-team-line]').textContent === 'Review the changes on the PC', 'a changed definition says to review it on the PC');
 check($('[data-team-card="' + TEAM + '"] [data-team-line]').textContent === '1 agent working', 'a working team says how many agents');
 check($('[data-team-card="' + T4 + '"] [data-team-line]').textContent === '2 agents working', 'plural');
 check($('[data-team-card="' + T2 + '"]').textContent.includes('<U+202E>'), 'a hidden character in a team name is spelled out');
 check($('[data-home-teams-all]').textContent.includes('See all (4)'), 'See all (4)');
 click($('[data-home-teams-all]'));
 await until(() => top('teams') && $$('[data-team-row]').length === 4, 'See all opens every team');
 check($('[data-team-row="' + T3 + '"] [data-team-line]').textContent === 'Paused', 'a paused team says so');
 await shown(); check(noOverflow(),'no horizontal overflow (teams list): ' + wide.join('; '));
 await back();
 check(!screen('teams'), 'back closes the list');

 // ---- the board ----
 click($('[data-team-card="' + TEAM + '"]'));
 await until(() => top('team-board') && $$('[data-team-task-row]').length === 150, 'the board opens on To do with its first page');
 check(reqs.filter(r => r.op === 'board').at(-1).column === 'todo', 'the first page asks for To do');
 check($$('[data-board-tab]').map(e => e.dataset.boardTab).join() === 'todo,doing,review,done,blocked', 'five column tabs');
 check($('[data-board-tab="todo"]').dataset.tabCount === '160' && $('[data-board-tab="doing"]').dataset.tabCount === '2' && $('[data-board-tab="blocked"]').dataset.tabCount === '1', 'each tab carries its count');
 check($('[data-board-tab="todo"]').getAttribute('aria-selected') === 'true', 'To do is selected');
 check(!!$('[data-board-chip="manual"]') && !$('[data-board-chip="paused"]') && !$('[data-board-chip="review"]'), 'the read-only chip of manual dispatch');
 check($('[data-board-needs]').dataset.boardNeeds === '12', 'the header needs button carries the count');
 check(tall('[data-board-tab]') && tall('[data-board-needs]') && tall('[data-board-lead]') && tall('[data-board-more]'), '44px touch targets on the board');
 click($('[data-board-more]'));
 await until(() => $$('[data-team-task-row]').length === 160, 'Load more appends the next page');
 check(reqs.filter(r => r.op === 'board').at(-1).cursor === '150', 'Load more sends the cursor');
 check(!$('[data-board-more]'), 'no Load more past the last page');
 // A change of the board on the PC keeps what Load more loaded: the reload asks for the rows shown, from the start.
 const pagedBefore = reqs.filter(r => r.op === 'board').length;
 teamChanged({ teamId: TEAM, rev: 6, scopes: ['board'] });
 await until(() => reqs.filter(r => r.op === 'board').length === pagedBefore + 1, 'a board change reloads the paged column');
 const reload = reqs.filter(r => r.op === 'board').at(-1);
 check(reload.column === 'todo' && reload.limit === 160 && reload.cursor === undefined, 'the reload asks for the 160 rows shown: ' + JSON.stringify(reload));
 await wait(200);
 check($$('[data-team-task-row]').length === 160 && !$('[data-board-more]'), 'and the 160 rows stay on screen');
 click($('[data-board-tab="doing"]'));
 await until(() => $$('[data-team-task-row]').length === 2 && !!$('[data-team-task-row="t-1"]'), 'the In progress tab shows its tasks');
 check(reqs.filter(r => r.op === 'board').at(-1).column === 'doing', 'a tab asks for its column');
 const t1 = $('[data-team-task-row="t-1"]');
 check(t1.textContent.includes('Plan to approve') && t1.textContent.includes('Urgent') && !!t1.querySelector('[data-task-needs]') && !!t1.querySelector('[data-task-running]'), 'a row: phase, priority, needs and run');
 check($('[data-team-task-row="t-5"]').textContent.includes('<U+202E>'), 'a task title with a hidden character spells it out');
 click($('[data-board-tab="blocked"]'));
 await until(() => !!$('[data-team-task-row="t-4"]'), 'the Blocked tab');
 check($('[data-team-task-row="t-4"]').textContent.includes('Waiting on t-1'), 'a blocked row says why');
 await shown(); check(noOverflow(),'no horizontal overflow (board): ' + wide.join('; '));
 // A change of the board on the PC reloads the column shown.
 const boards = reqs.filter(r => r.op === 'board').length;
 teamChanged({ teamId: TEAM, rev: 6, scopes: ['board'] });
 await until(() => reqs.filter(r => r.op === 'board').length === boards + 1, 'a board change reloads the column');
 click($('[data-board-tab="doing"]'));
 await until(() => !!$('[data-team-task-row="t-1"]'), 'back on In progress');

 // ---- a new task ----
 click($('[data-board-fab]'));
 await until(() => !!$('[data-new-task]') && $('[data-sheet][data-open=true]'), 'the + opens the new task sheet');
 check([...$('[data-new-task-assignee]').options].map(o => o.value).join() === ',dev,dev-2', 'assignee: the Lead decides, or an agent the board names');
 click($('[data-new-task-create]')); await frames();
 check($('[data-new-task-error]')?.textContent === 'Write a title.' && !reqs.some(r => r.op === 'createTask'), 'a title is required and nothing is sent');
 setValue($('[data-new-task-title]'), 'too many'); await frames();
 click($('[data-new-task-create]'));
 await until(() => $('[data-new-task-error]')?.textContent === 'The team has as many tasks or comments as it can hold.', 'a refusal in words');
 setValue($('[data-new-task-title]'), 'Write docs'); await frames();
 await dictate('teamNewTask', 'para el readme');
 check($('[data-new-task-body]').value === 'para el readme' && reqs.filter(r => r.op === 'createTask').length === 1, 'dictation lands in the description, nothing sent');
 click($('[data-new-task-prio="high"]'));
 $('[data-new-task-assignee]').value = 'dev'; $('[data-new-task-assignee]').dispatchEvent(new Event('change', { bubbles: true })); await frames();
 await shown(); check(noOverflow(),'no horizontal overflow (new task): ' + wide.join('; '));
 click($('[data-new-task-create]'));
 await until(() => !$('[data-sheet][data-open=true]'), 'Create closes the sheet');
 const created = reqs.filter(r => r.op === 'createTask').at(-1);
 check(created.teamId === TEAM && created.task.title === 'Write docs' && created.task.body === 'para el readme' && created.task.priority === 'high' && created.task.assignee === 'dev', 'createTask carries the draft');
 check(store.getState().toast === 'Task t-300 created', 'the toast names the new task');

 // ---- a task ----
 click($('[data-team-task-row="t-1"]'));
 await until(() => top('team-task') && !!$('[data-task-screen="t-1"]'), 'a row opens its task');
 await until(() => $$('[data-task-screen] [data-team-need]').length === 4, 'the task shows its needs first');
 check($$('[data-task-screen] [data-team-need]').map(e => e.dataset.teamNeed).join() === 'a-1,a-4,k-1,q-1', 'only this task\\'s rows, in the shared order');
 check(screen('team-task').querySelector('h2').textContent.startsWith('t-1'), 'the title names the task');
 const body = $('[data-task-body]');
 check(body.dataset.folded === 'true' && body.textContent.includes('Line 12') && !body.textContent.includes('Line 13'), 'the description folds after 12 lines');
 click(body.querySelector('[data-fold-toggle]')); await frames();
 check(body.textContent.includes('Line 20') && !!body.querySelector('[data-more-on-pc]') && body.textContent.includes('The rest is on the PC'), 'Show more, and "The rest is on the PC" for a cut text');
 const sys = $('[data-comment-sys="noQaRole"]');
 check(sys && sys.textContent.includes('This team has no QA role: the task goes straight to the user for the final OK.'), 'a comment main wrote renders from its key');
 check($('[data-comment-sys="futureKey"]').textContent.includes('A message of the app.') && !$('[data-task-screen]').textContent.includes('futureKey'), 'an unknown key reads in words, never the key');
 check($('[data-task-comment="m-4"]').textContent.includes('<U+202E>') && $('[data-task-comment="m-4"]').textContent.includes('<U+E0041>'), 'agent text spells out bidi and tag characters');
 check($('[data-task-comment="m-5"] [data-comment-queued]').textContent === 'Queued for Dev', 'a queued comment names its recipient');
 click($('[data-comments-older]'));
 await until(() => !!$('[data-task-comment="m-1"]'), 'Show earlier loads the older comments');
 check(reqs.filter(r => r.op === 'task').at(-1).commentsBefore === 'm-3' && !$('[data-comments-older]'), 'with the cursor; no more after the last page');
 // The run log.
 click($('[data-task-run="r-aaaaaaaaaaaa"]'));
 await until(() => !!$('[data-run-sheet]') && $('[data-run-sheet]').textContent.includes('Reading'), 'a run opens its log');
 const log = $('[data-run-sheet]');
 check(log.textContent.includes('held a key of the app, so it was not applied') && log.textContent.includes('action 1 (team.task.update) was refused.'), 'main\\'s notes in words');
 check(!log.textContent.includes('snaos.note') && !log.textContent.includes('bad_request') && !log.textContent.includes('conflict'), 'never the record nor the refusal\\'s code');
 check(log.textContent.includes('The run log got too big') && !log.textContent.includes(RUN_LOG_CUT_TEXT), 'the log cut in words');
 check(log.textContent.includes('<U+E0041>'), 'agent text in the log spells out tag characters');
 click($('[data-run-older]'));
 await until(() => $('[data-run-sheet]').textContent.includes('Start the plan'), 'Load earlier');
 check(reqs.filter(r => r.op === 'runPage').at(-1).before === '100', 'with the cursor');
 const pages = reqs.filter(r => r.op === 'runPage').length;
 click($('[data-run-refresh]'));
 await until(() => reqs.filter(r => r.op === 'runPage').length === pages + 1, 'Refresh while the run is live');
 await shown(); check(noOverflow(),'no horizontal overflow (run log): ' + wide.join('; '));
 await back();
 await until(() => !$('[data-sheet][data-open=true]'), 'back closes the run log');
 // A dictated comment waits for Comentar; Enter is a newline.
 const sentBefore = reqs.filter(r => r.op === 'comment').length;
 await dictate('teamComment', 'hola equipo');
 const field = $('[data-task-comment-text]');
 check(field.value === 'hola equipo', 'dictation lands in the composer');
 field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await frames();
 check(reqs.filter(r => r.op === 'comment').length === sentBefore && ctls.length === 0, 'nothing is sent until Comentar (not even on Enter)');
 // No reload while the composer holds text.
 const tasks = reqs.filter(r => r.op === 'task').length;
 teamChanged({ teamId: TEAM, rev: 7, scopes: ['task'], taskId: 't-1' });
 await wait(700);
 check(reqs.filter(r => r.op === 'task').length === tasks, 'a change of the task waits while the composer holds text');
 setValue(field, 'SECRET token'); await frames();
 click($('[data-task-comment-send]'));
 await until(() => $('[data-composer-error]')?.textContent === 'The text holds a key of the app, so it was not sent. Remove it and try again.', 'a live key in the text: refused in words');
 check($('[data-task-comment-text]').value === 'SECRET token', 'the refused text stays');
 // Dictated words land past the field's maxLength: the phone refuses the text itself (main's schema would strike the frame).
 const sentLong = reqs.filter(r => r.op === 'comment').length;
 setValue(field, 'x'.repeat(COMMENT_TEXT_MAX - 2)); await frames();
 await dictate('teamComment', 'and more');
 check($('[data-task-comment-text]').value.length > COMMENT_TEXT_MAX, 'dictation lands past the maxLength');
 click($('[data-task-comment-send]'));
 await until(() => $('[data-composer-error]')?.textContent === 'The text is too long: shorten it to send it.', 'a text past the cap: refused in words');
 check(reqs.filter(r => r.op === 'comment').length === sentLong, 'nothing past the cap leaves the phone');
 setValue(field, 'hola equipo'); await frames();
 check(tall('[data-task-comment-send]'), '44px Comentar');
 click($('[data-task-comment-send]'));
 await until(() => $('[data-task-comment-text]').value === '' && !!$('[data-task-comment="m-50"]'), 'Comentar sends and shows it');
 check(reqs.filter(r => r.op === 'comment').at(-1).text === 'hola equipo' && reqs.filter(r => r.op === 'comment').at(-1).taskId === 't-1', 'the comment goes as typed');
 await until(() => reqs.filter(r => r.op === 'task').length > tasks, 'the owed reload once the composer is empty');
 await wait(250);
 check(!!$('[data-task-comment="m-1"]') && !!$('[data-task-comment="m-50"]') && !$('[data-comments-older]'), 'the reload keeps the earlier comments Show earlier loaded');
 // Text typed while a comment is out stays: only what was sent leaves the field (B8 review).
 {
  let release; hold = new Promise(r => { release = r; });
  const sentHeld = reqs.filter(r => r.op === 'comment').length;
  setValue($('[data-task-comment-text]'), 'primera'); await frames();
  click($('[data-task-comment-send]'));
  await until(() => reqs.filter(r => r.op === 'comment').length === sentHeld + 1, 'the held comment went out');
  setValue($('[data-task-comment-text]'), 'primera y segunda'); await frames();
  hold = null; release();
  await until(() => $('[data-task-comment-text]').value === 'y segunda', 'text typed while the comment was out stays in the field');
  check($('[data-task-comment-text]').value === 'y segunda', 'text typed while the comment was out stays; only what was sent leaves the field');
  setValue($('[data-task-comment-text]'), ''); await frames();
 }
 await shown(); check(noOverflow(),'no horizontal overflow (task): ' + wide.join('; '));
 await back();
 await until(() => top('team-board') && !screen('team-task'), 'back returns to the board');

 // ---- Te necesita ----
 click($('[data-board-needs]'));
 await until(() => top('team-needs') && $$('[data-team-need]').length === NEEDS_COUNT, 'Te necesita lists teamNeedsRows');
 check($('[data-team-needs]').dataset.needsCount === String(NEEDS_COUNT) && !$('[data-team-need="a-6"]'), 'the same count as the card; a Lead-decided plan does not count');
 check($$('[data-need-group]').map(e => e.dataset.needGroup).join() === '2,3', 'grouped by rank');
 // Read only: hire, integrate, the resumeTeam action.
 const hire = $('[data-team-need="a-2"]');
 check(hire.dataset.readOnly === 'true' && !!hire.querySelector('[data-on-pc]') && hire.textContent.includes('On the PC') && !hire.querySelector('button[data-need-approve], button[data-need-reject]'), 'a hire is read only with On the PC');
 check(hire.querySelectorAll('[data-diff-line]').length === TEAM_PHONE_HIRE_LINES && hire.textContent.includes('Only the first 200 lines are shown here.'), 'its diff cut to TEAM_PHONE_HIRE_LINES');
 const integ = $('[data-team-need="a-3"]');
 check(integ.dataset.readOnly === 'true' && !!integ.querySelector('[data-on-pc]') && !integ.querySelector('[data-need-approve], [data-need-reject], [data-need-changes]') && integ.textContent.includes('Integrating lands the branch in its base: it is done on the PC.'), 'an integrate is read only with On the PC');
 const sysCard = $('[data-team-need="k-5"]');
 check(!!sysCard.querySelector('[data-card-action="resumeTeam"][data-card-action-pc] [data-on-pc]') && !sysCard.querySelector('button[data-card-action="resumeTeam"]'), 'the resumeTeam action is read only with On the PC');
 check(sysCard.textContent.includes('Resume the team · On the PC'), 'it names the action');
 check($('[data-team-need="a-1"]').textContent.includes('<U+202E>'), 'plan text spells out bidi characters');
 await shown(); check(noOverflow(),'no horizontal overflow (needs): ' + wide.join('; '));
 check(tall('[data-need-approve]') && tall('[data-dispatch-go]') && tall('[data-card-option]') && tall('[data-need-task]') && tall('[data-fold-toggle]'), '44px touch targets in Te necesita');
 // teamDecide: approve a plan.
 click($('[data-need-approve="a-1"]'));
 await until(() => !$('[data-team-need="a-1"]'), 'an approved plan hides');
 check(JSON.stringify(ctls.at(-1)) === JSON.stringify({ kind: 'teamDecide', teamId: TEAM, approvalId: 'a-1', decision: 'approve', rev: 1 }), 'teamDecide approve, with the rev of the approval shown');
 // Ask for changes: the note is required, dictated, sent only on Send.
 click($('[data-need-changes="a-5"]'));
 await until(() => !!$('[data-need-note]') && !!$('[data-sheet][data-open=true]'), 'Ask for changes opens the note');
 click($('[data-need-note-send]')); await frames();
 check($('[data-need-note-error]')?.textContent === 'Write what has to change.' && ctls.length === 1, 'the note is required');
 await dictate('teamNote', 'falta el test');
 check($('[data-need-note-text]').value === 'falta el test' && ctls.length === 1, 'a dictated note waits for Send');
 click($('[data-need-note-send]'));
 await until(() => !$('[data-team-need="a-5"]'), 'the changes ask hides the row');
 check(JSON.stringify(ctls.at(-1)) === JSON.stringify({ kind: 'teamDecide', teamId: TEAM, approvalId: 'a-5', decision: 'reject', note: 'falta el test', rev: 1 }), 'teamDecide reject with the note and the rev');
 // A permission: confirm first; the PC refuses with nothing left to grant.
 ackFor = a => (a.kind === 'teamDecide' && a.approvalId === 'a-4' && a.decision === 'approve' ? { ok: false, error: 'bad_request' } : null);
 click($('[data-need-approve="a-4"]'));
 await until(() => !!$('[data-confirm-ok]') && !!$('[data-sheet][data-open=true]'), 'a permission asks first');
 check($('[data-confirm-message]').textContent.includes('Grant this rule to the agents of dev on this task?') && ctls.length === 2, 'the confirmation names the role; nothing sent yet');
 click($('[data-confirm-ok]'));
 await until(() => $('[data-team-need="a-4"] [data-need-error]')?.textContent === 'There is nothing to grant: the app no longer allows any rule of this request. Reject it.', 'nothingToGrant in words');
 check(!!$('[data-team-need="a-4"]'), 'a refused row stays');
 check(ctls.at(-1).approvalId === 'a-4' && ctls.at(-1).rev === 2, 'teamDecide carries the rev of the permission shown (2), never a default: ' + JSON.stringify(ctls.at(-1)));
 // Tanda B close: a later run grew the permission on the PC after the phone read it (one more rule, rev 3).
 const grownA4 = needs.approvals.find(x => x.id === 'a-4');
 grownA4.rev = 3; grownA4.payload.tools = [...grownA4.payload.tools, 'Bash(make release)'];
 ackFor = staleUnlessRev;
 const needsReads = reqs.filter(r => r.op === 'needs').length;
 await wait(320);
 click($('[data-need-approve="a-4"]'));
 await until(() => !!$('[data-confirm-ok]') && !!$('[data-sheet][data-open=true]'), 'approve asks first again');
 click($('[data-confirm-ok]'));
 const changedWords = 'This request changed on the PC since you saw it: review it again before you decide.';
 await until(() => $('[data-team-need="a-4"] [data-need-error]')?.textContent === changedWords, 'a stale permission: it changed, review it again');
 check(ctls.at(-1).approvalId === 'a-4' && ctls.at(-1).rev === 2, 'that decide carried the rev the phone showed (2), so the PC refused it');
 await until(() => reqs.filter(r => r.op === 'needs').length > needsReads && $$('[data-team-need="a-4"] [data-permission-rule]').some(e => e.textContent === 'Bash(make release)'), 'the stale refusal reads Te necesita again: the row shows the rule the run added');
 check($('[data-team-need="a-4"] [data-need-error]')?.textContent === changedWords && !!$('[data-team-need="a-4"]'), 'the row stays with the words under it');
 // Decided again at the rev it shows now: the PC answers that the task's grants are full.
 ackFor = a => staleUnlessRev(a) || (a.kind === 'teamDecide' && a.approvalId === 'a-4' && a.decision === 'approve' ? { ok: false, error: 'bad_request:grantsFull' } : null);
 await wait(320);
 click($('[data-need-approve="a-4"]'));
 await until(() => !!$('[data-confirm-ok]') && !!$('[data-sheet][data-open=true]'), 'approve asks first once more');
 click($('[data-confirm-ok]'));
 await until(() => $('[data-team-need="a-4"] [data-need-error]')?.textContent === 'This task already holds as many rules as it can, so nothing more can be granted. Reject this request.', 'grantsFull in words');
 check(ctls.at(-1).rev === 3, 'the next decide carries the rev shown now (3)');
 ackFor = () => null;
 // teamAnswer: one option sends at once.
 click($('[data-team-need="k-1"] [data-card-option="1"]'));
 await until(() => !$('[data-team-need="k-1"]'), 'a single choice sends at once');
 check(JSON.stringify(ctls.at(-1)) === JSON.stringify({ kind: 'teamAnswer', teamId: TEAM, cardId: 'k-1', answer: { choices: [1] } }), 'teamAnswer with the choice');
 // Several options wait for Answer.
 const n0 = ctls.length;
 click($('[data-team-need="k-2"] [data-card-option="2"]')); await frames();
 click($('[data-team-need="k-2"] [data-card-option="0"]')); await frames();
 check(ctls.length === n0, 'a multiple choice waits');
 click($('[data-card-send="k-2"]'));
 await until(() => !$('[data-team-need="k-2"]'), 'Answer sends the options');
 check(JSON.stringify(ctls.at(-1).answer) === JSON.stringify({ choices: [0, 2] }), 'in order');
 // A text answer: dictated, sent on Answer.
 await dictate('teamCard:k-3', 'se llama Nube');
 check($('[data-card-text="k-3"]').value === 'se llama Nube' && ctls.length === n0 + 1, 'a dictated answer waits');
 click($('[data-card-send="k-3"]'));
 await until(() => !$('[data-team-need="k-3"]'), 'Answer sends the text');
 check(ctls.at(-1).answer.text === 'se llama Nube', 'teamAnswer with the text');
 // A confirm card the PC already closed: words, then I can't.
 ackFor = a => (a.kind === 'teamAnswer' && a.cardId === 'k-4' ? { ok: false, error: 'conflict' } : null);
 click($('[data-team-need="k-4"] [data-card-confirm="no"]'));
 await until(() => $('[data-team-need="k-4"] [data-need-error]')?.textContent === 'That no longer waits for you.', 'a gone card in words');
 ackFor = () => null;
 click($('[data-team-need="k-4"] [data-card-confirm="no"]'));
 await until(() => !$('[data-team-need="k-4"]'), 'I can\\'t sends');
 check(ctls.at(-1).answer.confirm === false, 'teamAnswer confirm false');
 // A system card's action.
 click($('[data-team-need="k-5"] button[data-card-action="retry"]'));
 await until(() => !$('[data-team-need="k-5"]'), 'a system card action sends');
 check(ctls.at(-1).kind === 'teamAnswer' && ctls.at(-1).answer.action === 'retry', 'teamAnswer with the action');
 // teamDispatch: all, with the count of the rows shown.
 check(!!$('[data-dispatch-all]') && $('[data-team-need="q-1"]').textContent.includes('If you dispatch it, it waits: the team already has its most runs at once.'), 'a queued run says why it would wait');
 click($('[data-dispatch-all]'));
 await until(() => !!$('[data-confirm-ok]') && !!$('[data-sheet][data-open=true]'), 'Dispatch all asks first');
 check($('[data-confirm-message]').textContent.includes('Dispatch the 2 runs?'), 'with the count of the rows shown');
 click($('[data-confirm-ok]'));
 await until(() => !$('[data-team-need="q-1"]') && !$('[data-team-need="q-2"]'), 'Dispatch all hides the queue');
 check(JSON.stringify(ctls.at(-1)) === JSON.stringify({ kind: 'teamDispatch', teamId: TEAM, queueId: 'all', go: true }) && store.getState().toast === 'Runs dispatched: 2.', 'teamDispatch all, the toast counts the rows shown');
 check(new Set(ctls.map(c => c.kind)).size === 3, 'the three ctls went out');
 check(!ctls.some(c => c.approvalId === 'a-2' || c.approvalId === 'a-3' || (c.answer && c.answer.action === 'resumeTeam')), 'hire, integrate and resumeTeam were never sent');
 // Rows the PC could not send whole (phoneFit pcOnly, Tanda B close): read only with On the PC, never a button, and
 // what came of them says the rest is on the PC.
 needs = {
  ...freshNeeds(),
  approvals: [
   { id: 'a-7', taskId: 't-1', state: 'pending', decider: 'user', requestedBy: 'dev', at: now - MIN, rev: 1, pcOnly: true, payload: { kind: 'permission', roleId: 'dev', tools: ['Bash(npm run build:web-build:web-build:web-'], denied: ['npm run build:web-build:web-'], truncated: true } },
   { id: 'a-8', taskId: 't-3', state: 'pending', decider: 'user', requestedBy: 'qa', at: now - MIN, rev: 1, pcOnly: true, payload: { kind: 'final', summary: 'All done, and then the', truncated: true } },
  ],
  cards: [{ id: 'k-6', taskId: 't-1', agentId: 'dev', kind: 'choice', state: 'open', at: now - MIN, question: 'Which of these do we', options: ['sqlite', 'postgres'], multi: false, pcOnly: true, truncated: true }],
  queue: [],
 };
 const pcCtls = ctls.length;
 teamChanged({ teamId: TEAM, rev: 9, scopes: ['needs'] });
 await until(() => !!$('[data-team-need="a-7"]') && !!$('[data-team-need="a-8"]') && !!$('[data-team-need="k-6"]'), 'a needs change brings the rows the PC could not send whole');
 for (const id of ['a-7', 'a-8', 'k-6']) {
  const row = $('[data-team-need="' + id + '"]');
  check(row.dataset.readOnly === 'true' && !!row.querySelector('[data-on-pc]') && row.querySelector('[data-need-fit-pc]')?.textContent === 'It is too long to show whole on the phone: decide it on the PC.', id + ' is read only with On the PC, and says why');
  check(!row.querySelector('button[data-need-approve], button[data-need-reject], button[data-need-changes], button[data-card-option], button[data-card-send], textarea'), id + ' offers no Approve, Reject, Ask for changes nor answer');
  check(!!row.querySelector('[data-more-on-pc]') && row.textContent.includes('The rest is on the PC'), id + ' says the rest is on the PC');
 }
 check($('[data-team-need="a-7"] [data-permission-rule]').textContent.startsWith('Bash(npm run') && $$('[data-team-need="k-6"] [data-card-option-pc]').map(e => e.textContent).join() === 'sqlite,postgres', 'what came of them shows, read only');
 check(ctls.length === pcCtls, 'nothing was sent for them');
 await shown(); check(noOverflow(), 'no horizontal overflow (rows decided on the PC): ' + wide.join('; '));
 await back();
 await until(() => top('team-board') && !screen('team-needs'), 'back returns to the board');

 // ---- the Lead chat ----
 click($('[data-board-lead]'));
 await until(() => top('team-lead') && $$('[data-lead-msg]').length === 4, 'the Lead chat opens');
 check($('[data-lead-msg="m-2"]').dataset.leadAuthor === 'user' && $('[data-lead-msg="m-7"]').dataset.leadAuthor === 'lead', 'user and Lead bubbles');
 check(!!$('[data-lead-msg="m-7"] strong') && $('[data-lead-msg="m-7"]').textContent.includes('<U+202E>'), 'the Lead in Markdown, hidden characters spelled out');
 check($('[data-lead-msg="m-8"]').textContent.includes('The user rejected hiring the role docs.'), 'a message main wrote from its key');
 check($('[data-lead-msg="m-9"]').textContent.includes('It reads it in its next run') && !!$('[data-lead-working]'), 'queued message and the Lead is working');
 click($('[data-lead-older]'));
 await until(() => !!$('[data-lead-msg="m-1"]'), 'Show earlier in the Lead chat');
 await dictate('teamLead', 'sumá tests');
 check($('[data-lead-text]').value === 'sumá tests' && !reqs.some(r => r.op === 'leadSay'), 'a dictated message waits for Send');
 click($('[data-lead-send]'));
 await until(() => !!$('[data-lead-msg="m-60"]'), 'Send goes to the Lead');
 check(reqs.filter(r => r.op === 'leadSay').at(-1).text === 'sumá tests' && $('[data-lead-text]').value === '', 'leadSay with the text');
 // Text typed while a Lead message is out stays (B8 review).
 {
  let release; hold = new Promise(r => { release = r; });
  const saidHeld = reqs.filter(r => r.op === 'leadSay').length;
  setValue($('[data-lead-text]'), 'uno'); await frames();
  click($('[data-lead-send]'));
  await until(() => reqs.filter(r => r.op === 'leadSay').length === saidHeld + 1, 'the held Lead message went out');
  setValue($('[data-lead-text]'), 'uno dos'); await frames();
  hold = null; release();
  await until(() => $('[data-lead-text]').value === 'dos', 'text typed while the Lead message was out stays in the field');
  check($('[data-lead-text]').value === 'dos', 'text typed while the Lead message was out stays; only what was sent leaves the field');
  setValue($('[data-lead-text]'), ''); await frames();
 }
 // The reload after Send and one a change of the thread asks for keep the earlier messages Show earlier loaded.
 await wait(250);
 check(!!$('[data-lead-msg="m-1"]') && !$('[data-lead-older]'), 'the reload after Send keeps the earlier messages');
 const leads = reqs.filter(r => r.op === 'lead').length;
 teamChanged({ teamId: TEAM, rev: 8, scopes: ['lead'] });
 await until(() => reqs.filter(r => r.op === 'lead').length === leads + 1, 'a change of the Lead thread reloads it');
 await wait(200);
 check(!!$('[data-lead-msg="m-1"]') && !!$('[data-lead-msg="m-60"]') && !$('[data-lead-older]'), 'and so does the reload a change asks for');
 await shown(); check(noOverflow(),'no horizontal overflow (Lead): ' + wide.join('; '));
 await back();
 await back();
 await until(() => !screen('team-board') && !screen('team-lead'), 'back to Home');

 // ---- a team push: board, then the task over it; back returns to the board ----
 client.setPendingTeamLink(parseDeepLink('#team=' + TEAM + '&task=t-2'));
 await until(() => top('team-task') && !!$('[data-task-screen="t-2"]'), 'the link opens the task');
 check(!!screen('team-board') && useTeamsUi.getState().boardFor === TEAM, 'over its board');
 await back();
 await until(() => top('team-board') && !screen('team-task') && useTeamsUi.getState().task === null, 'back returns to the board');
 await back();
 await until(() => !screen('team-board'), 'and then Home');
 // A task gone from the PC.
 flushSync(() => openTeamTask(TEAM, 't-404'));
 await until(() => screen('team-task')?.textContent.includes('This task is no longer on the board.'), 'a gone task says so');
 await back();
 await until(() => !$('[data-push-screen]'), 'back to Home after the gone task');

 // ---- a tapped push with the app open (the worker posts snaos-open): never a fake back nor an extra entry ----
 const atRoot = () => history.state?.snagentsos === 'root';
 check(atRoot(), 'at Home the back stack sits on its first entry');
 const viewed = [], viewPane = client.viewPane;
 client.viewPane = id => { viewed.push(id); store.getState().update({ activePaneId: id }) };
 flushSync(() => store.getState().update({ snapshot: { ...snapshot, workspaces: [{ ...snapshot.workspaces[0], layoutOrder: ['p1'], panes: [{ id: 'p1', title: 'Shell', type: 'shell', running: true }] }] } }));
 flushSync(() => openWsNotes('w1'));
 await until(() => top('ws-notes'), 'Notes open');
 await shown();
 // A team push keeps the other pushed screens as they are: its board and task open over Notes.
 tap('#team=' + TEAM + '&task=t-2');
 await until(() => top('team-task') && !!$('[data-task-screen="t-2"]'), 'a tapped team push opens its task');
 await shown();
 check(!!screen('team-board') && !!screen('ws-notes') && useWsNotes.getState().workspaceId === 'w1', 'over its board, with Notes still open under them (no fake back closed them)');
 check(location.hash === '', 'the client took the hash');
 await back();
 await until(() => top('team-board') && !screen('team-task'), 'back returns to the board');
 await back();
 await until(() => top('ws-notes') && !screen('team-board'), 'then to Notes');
 await back();
 await until(() => !$('[data-push-screen]'), 'then to Home');
 check(atRoot(), 'three backs for three screens reach the first entry: the tap added no history entry');
 // A console push over the pushed screens: they close, its terminal shows, and one back reaches Home.
 flushSync(() => openWsNotes('w1'));
 await until(() => top('ws-notes'), 'Notes open again');
 flushSync(() => openTeamBoard(TEAM));
 await until(() => top('team-board'), 'a board over Notes');
 flushSync(() => openTeamTask(TEAM, 't-2'));
 await until(() => top('team-task') && !!$('[data-task-screen="t-2"]'), 'a task over the board');
 await shown();
 tap('#ws=w1&pane=p1');
 await until(() => !$('[data-push-screen]') && $('[data-terminal-layer]').dataset.open === 'true', 'a tapped console push closes the pushed screens and its terminal shows');
 check(viewed.at(-1) === 'p1' && store.getState().screen === 'terminal' && useTeamsUi.getState().boardFor === null && useWsNotes.getState().workspaceId === null, 'the console the push names, nothing over it');
 await back();
 await until(() => store.getState().screen === 'home' && $('[data-terminal-layer]').dataset.open === 'false', 'one back from that terminal returns to Home');
 check(atRoot(), 'and lands on the first entry: no dead back press is left after it');

 // ---- a notice shows once: inside the pushed screen on top while one is open (its live region in that dialog) ----
 store.getState().setToast('Saved on Home');
 await until(() => seen('Saved on Home').length === 1, 'a notice on Home');
 check(!!seen('Saved on Home')[0].closest('[data-home]'), 'Home shows it');
 flushSync(() => openWsNotes('w1'));
 await frames();
 check(screen('ws-notes').dataset.stage === 'in', 'Notes still sliding in');
 const sliding = seen('Saved on Home');
 check(sliding.length === 1 && sliding[0].closest('[role="dialog"][aria-modal="true"]') === screen('ws-notes'), 'while Notes slides in over Home the notice shows once, inside the Notes dialog: ' + sliding.length);
 check(sliding[0].closest('[role="status"][aria-live="polite"]').closest('[data-push-screen]') === screen('ws-notes') && !$('[data-home] [data-toast-stack]').querySelector('[data-toast]:not(.hidden)'), 'its live region is in the open dialog; Home hides its copy');
 await shown();
 store.getState().update({ toasts: [], toast: null });
 click($('[data-ws-notes-new]'));
 await until(() => seen('The note could not be saved').length === 1, 'a failed new note toasts once');
 check(onTop(seen('The note could not be saved')[0]) && seen('The note could not be saved')[0].closest('[data-push-screen]') === screen('ws-notes'), 'on top of the Notes screen that raised it');
 // A board over Notes takes the notice into its own dialog.
 flushSync(() => openTeamBoard(TEAM));
 await frames();
 check(seen('The note could not be saved').length === 1 && seen('The note could not be saved')[0].closest('[data-push-screen]') === screen('team-board'), 'the screen on top holds it, still once');
 await back();
 await until(() => top('ws-notes') && !screen('team-board'), 'back to Notes');
 await back();
 await until(() => !$('[data-push-screen]'), 'back to Home from Notes');
 check(store.getState().toasts.some(x => x.text === 'The note could not be saved') && seen('The note could not be saved').length === 0, 'a notice a pushed screen showed does not show (nor announce) again on Home');
 store.getState().update({ toasts: [], toast: null });
 // Over the terminal too: its notice moves into the pushed screen, a console toast with [Go] stays in the terminal.
 tap('#ws=w1&pane=p1');
 await until(() => $('[data-terminal-layer]').dataset.open === 'true' && store.getState().screen === 'terminal', 'the terminal again');
 // (Home lies under the terminal, so count each layer's displayed copies.)
 const shownIn = (sel, text) => $$(sel + ' [data-toast]').filter(el => el.firstChild.textContent === text && el.getClientRects().length > 0);
 store.getState().setToast('In the terminal');
 store.getState().pushToast({ text: 'Shell needs you', kind: 'action', paneId: 'p9' });
 await until(() => shownIn('[data-terminal-layer]', 'In the terminal').length === 1, 'the terminal shows its notice');
 flushSync(() => openWsNotes('w1'));
 await frames();
 check(shownIn('[data-push-screen="ws-notes"]', 'In the terminal').length === 1 && shownIn('[data-terminal-layer]', 'In the terminal').length === 0 && shownIn('[data-home]', 'In the terminal').length === 0, 'a pushed screen over the terminal shows the notice once, inside it');
 check(shownIn('[data-terminal-layer]', 'Shell needs you').length === 1 && !screen('ws-notes').querySelector('[data-toast-go]'), 'the [Go] toast stays in the terminal under it');
 await shown();
 await back();
 await until(() => !$('[data-push-screen]'), 'back to the terminal');
 await back();
 await until(() => store.getState().screen === 'home' && atRoot(), 'and to Home on the first entry');
 store.getState().update({ toasts: [], toast: null });
 client.viewPane = viewPane;
 flushSync(() => store.getState().update({ snapshot, activePaneId: null, subscribedPaneId: null }));

 // ---- no answer ----
 offline = true;
 flushSync(() => openTeamNeeds(TEAM));
 await until(() => !!$('[data-push-screen="team-needs"] [data-no-reply]'), 'no answer: The PC did not answer');
 offline = false;
 click($('[data-push-screen="team-needs"] [data-no-reply] button'));
 await until(() => !!$('[data-team-needs]'), 'Retry loads it');
 await back();
 // The socket down: no refusal on screen, the read waits and the reconnect's resync reads it again.
 dropped = true;
 flushSync(() => openTeamNeeds(TEAM));
 await until(() => top('team-needs'), 'Te necesita opens with the socket down');
 await wait(200);
 check(!$('[data-push-screen="team-needs"] [data-load-failed]') && !$('[data-push-screen="team-needs"] [data-no-reply]') && !$('[data-team-needs]'), 'a socket down is not a refusal: it keeps loading');
 dropped = false;
 resyncTeams();
 await until(() => !!$('[data-team-needs]'), 'the reconnect reads it again');
 await back();

 // ---- Spanish at 360px ----
 needs = freshNeeds();
 setLang('es');
 flushSync(() => store.getState().update({ snapshot: { ...snapshot, language: 'es' } }));
 flushSync(() => reactRoot.render(<LiveShell key="es" />));
 await loadTeamList();
 await until(() => !!$('[data-home-teams]') && $('[data-home-teams]').textContent.includes('Equipos'), 'the card in Spanish');
 check($('[data-team-card="' + T2 + '"] [data-team-line]').textContent === 'Revisá los cambios en la PC' && $('[data-home-teams-all]').textContent.includes('Ver todos (4)'), 'Spanish card lines');
 await shown(); check(noOverflow(),'no horizontal overflow (Home, es): ' + wide.join('; '));
 flushSync(() => openTeamBoard(TEAM, 'todo'));
 await until(() => top('team-board') && $$('[data-team-task-row]').length > 0, 'the board in Spanish');
 check($('[data-board-tab="todo"]').textContent.startsWith('Por hacer') && $('[data-board-tab="review"]').textContent.startsWith('Revisión') && $('[data-board-more]').textContent.includes('Cargar más') && $('[data-board-chip="manual"]').textContent === 'Despacho manual', 'Spanish board');
 await shown(); check(noOverflow(),'no horizontal overflow (board, es): ' + wide.join('; '));
 click($('[data-board-needs]'));
 await until(() => top('team-needs') && $$('[data-team-need]').length === NEEDS_COUNT, 'Te necesita in Spanish');
 check($('[data-team-need="a-2"]').textContent.includes('En la PC') && $('[data-team-need="k-5"]').textContent.includes('Reanudar el equipo · En la PC'), 'En la PC');
 check($('[data-need-approve="a-1"]').textContent.includes('Aprobar') && $('[data-need-changes="a-1"]').textContent.includes('Pedir cambios') && $('[data-dispatch-all]').textContent.includes('Despachar todo'), 'Spanish actions');
 await shown(); check(noOverflow(),'no horizontal overflow (needs, es): ' + wide.join('; '));
 ackFor = a => (a.kind === 'teamDecide' ? { ok: false, error: 'bad_request:nothingToGrant' } : null);
 click($('[data-need-approve="a-4"]'));
 await until(() => !!$('[data-confirm-ok]') && !!$('[data-sheet][data-open=true]'), 'confirm in Spanish');
 check($('[data-confirm-message]').textContent.includes('¿Concedés esta regla a los agentes de dev en esta tarea?'), 'Spanish confirmation');
 click($('[data-confirm-ok]'));
 await until(() => $('[data-team-need="a-4"] [data-need-error]')?.textContent === 'No hay nada para conceder: la app ya no permite ninguna regla de este pedido. Rechazalo.', 'nothingToGrant in Spanish');
 // A later run grew it on the PC (Tanda B close): stale, in Spanish, and Te necesita reads it again.
 needs.approvals.find(x => x.id === 'a-4').rev = 3;
 ackFor = staleUnlessRev;
 const needsReadsEs = reqs.filter(r => r.op === 'needs').length;
 await wait(320);
 click($('[data-need-approve="a-4"]'));
 await until(() => !!$('[data-confirm-ok]') && !!$('[data-sheet][data-open=true]'), 'confirm in Spanish again');
 click($('[data-confirm-ok]'));
 await until(() => $('[data-team-need="a-4"] [data-need-error]')?.textContent === 'Este pedido cambió en la PC desde que lo viste: revisalo de nuevo antes de decidir.', 'a stale permission in Spanish');
 await until(() => reqs.filter(r => r.op === 'needs').length > needsReadsEs, 'and Te necesita reads it again');
 check(decideFailText(refusalOfAck('bad_request:grantsFull'), 'permission', 'approve') === 'Esta tarea ya tiene todas las reglas que puede tener, así que no se puede conceder nada más. Rechazá este pedido.', 'grantsFull in Spanish, in the same words as the desktop');
 ackFor = () => null;
 click($('[data-team-need="k-1"] [data-need-task]'));
 await until(() => top('team-task') && !!$('[data-task-screen="t-1"]'), 'a need row opens its task over Te necesita');
 check($('[data-comment-sys="noQaRole"]').textContent.includes('Este equipo no tiene rol de QA: la tarea va directo a tu OK final.') && $('[data-task-comment-send]').textContent.includes('Comentar'), 'Spanish task');
 await shown(); check(noOverflow(),'no horizontal overflow (task, es): ' + wide.join('; '));
 await back();
 await until(() => top('team-needs'), 'back returns to Te necesita');
 await back(); await back();
 await until(() => !screen('team-board') && !screen('team-needs'), 'back to Home in Spanish');
 // The new task sheet, the Lead chat and a run log in Spanish at 360px too.
 flushSync(() => openTeamBoard(TEAM, 'doing'));
 await until(() => top('team-board') && !!$('[data-team-task-row="t-1"]'), 'the board again in Spanish');
 click($('[data-board-fab]'));
 await until(() => !!$('[data-new-task]') && !!$('[data-sheet][data-open=true]'), 'the new task sheet in Spanish');
 check($('[data-new-task-prio="urgent"]').textContent === 'Urgente' && $('[data-new-task-create]').textContent.includes('Crear'), 'Spanish new task');
 await shown(); check(noOverflow(), 'no horizontal overflow (new task, es): ' + wide.join('; '));
 await back();
 await until(() => !$('[data-sheet][data-open=true]'), 'back closes the new task sheet');
 click($('[data-board-lead]'));
 await until(() => top('team-lead') && $$('[data-lead-msg]').length > 0, 'the Lead chat in Spanish');
 check($('[data-lead-send]').textContent.includes('Enviar') && $('[data-lead-working]')?.textContent.includes('El Líder está trabajando'), 'Spanish Lead chat');
 await shown(); check(noOverflow(), 'no horizontal overflow (Lead, es): ' + wide.join('; '));
 await back();
 await until(() => top('team-board') && !screen('team-lead'), 'back to the board');
 click($('[data-team-task-row="t-1"]'));
 await until(() => top('team-task') && !!$('[data-task-run="r-aaaaaaaaaaaa"]'), 'the task again in Spanish');
 click($('[data-task-run="r-aaaaaaaaaaaa"]'));
 await until(() => !!$('[data-run-sheet]') && $('[data-run-sheet]').textContent.includes('Cargar anteriores'), 'the run log in Spanish');
 check($('[data-run-sheet]').textContent.includes('tenía una clave de la app') && $('[data-run-refresh]').textContent.includes('Actualizar'), 'Spanish run notes');
 await shown(); check(noOverflow(), 'no horizontal overflow (run log, es): ' + wide.join('; '));
 await back();
 await until(() => !$('[data-sheet][data-open=true]'), 'back closes the run log in Spanish');
 await back(); await back();
 await until(() => !screen('team-board') && !screen('team-task'), 'back to Home in Spanish again');

 // ---- Labs off on the PC: everything goes ----
 flushSync(() => openTeamBoard(TEAM));
 await until(() => top('team-board'), 'a board open');
 teamChanged({ teamId: '', rev: 0, scopes: ['disabled'] });
 await until(() => !$('[data-home-teams]') && !screen('team-board') && useTeamsUi.getState().listState === 'disabled', 'Labs off empties the card and closes the screens');
 forgetTeams();
 reactRoot.unmount();
 return checks;
};
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: '"2.7.0"' }, alias: { '@shared': path.join(root, 'src/shared') }, loader: { '.css': 'empty' }, outfile: path.join(dir, 'renderer.js') })
fs.writeFileSync(path.join(dir, 'index.html'), `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, mobileCss))}"></head><body style="margin:0"><div id="root"></div><script src="renderer.js"></script></body></html>`)
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');const path=require('path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:360,height:740,useContentSize:true,webPreferences:{sandbox:true,backgroundThrottling:false,offscreen:true}});
 await w.loadFile(path.join(__dirname,'index.html'));
 const checks=await w.webContents.executeJavaScript('window.runMain()');
 console.log('PASS: '+checks+' mobile Teams screen checks');w.destroy();app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const flags = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : []
const result = spawnSync(require('electron'), [...flags, path.join(dir, 'main.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 180000 })
process.stdout.write(result.stdout ?? '')
if (result.status !== 0) process.stderr.write((result.stderr || '') + (result.error ? result.error.message : '') + (result.signal ? ' signal ' + result.signal : ''))
fs.rmSync(dir, { recursive: true, force: true })
process.exitCode = result.status ?? 1
