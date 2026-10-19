// Claude Code answer menus as the pty screen shows them (E2-FR-53, 54), for
// test-mobile-prompts.cjs (parsed in node) and test-mobile-prompts-ui.cjs
// (written into the phone's xterm). Each fixture is an array of screen rows.
// The layouts are the ones the phone validates; `changed*` are what a future
// Claude version could draw and must fall back to the strip / the hint.
const ptr = '\u276f'
const box = rows => ['\u256d' + '\u2500'.repeat(60) + '\u256e', ...rows.map(r => '\u2502 ' + r.padEnd(58) + ' \u2502'), '\u2570' + '\u2500'.repeat(60) + '\u256f']

module.exports = {
  // 2.x permission dialog for Bash, with the long scope wrapped by hand by Ink.
  bashPermission: [
    '> run the tests',
    '',
    '\u23fa Bash(npm test)',
    '',
    '\u2500'.repeat(60),
    ' Bash command',
    '',
    '   npm test',
    '   Run the test suite',
    '',
    ' Do you want to proceed?',
    ` ${ptr} 1. Yes`,
    "   2. Yes, and don't ask again for npm test commands in",
    '   C:\\Users\\dev\\repo',
    '   3. No, and tell Claude what to do differently (esc)',
    '',
  ],
  // Older boxed permission dialog for Edit.
  editPermission: box([
    'Edit file',
    'src/App.tsx',
    '',
    'Do you want to make this edit to App.tsx?',
    `${ptr} 1. Yes`,
    '  2. Yes, allow all edits during this session (shift+tab)',
    '  3. No, and tell Claude what to do differently (esc)',
  ]),
  // A permission without an "always" option: "2" would be No.
  twoOptionPermission: [
    ' Bash command',
    '   rm -rf build',
    ' Do you want to proceed?',
    ` ${ptr} 1. Yes`,
    '   2. No, and tell Claude what to do differently (esc)',
  ],
  // ExitPlanMode, 2.0 layout.
  plan: [
    '\u23fa User approved Claude\'s plan? Not yet:',
    ' Ready to code?',
    '',
    ' Here is Claude\'s plan:',
    ' 1. Add the parser',
    ' 2. Wire it',
    '',
    ' Would you like to proceed?',
    '',
    ` ${ptr} 1. Yes, and auto-accept edits`,
    '   2. Yes, and manually approve edits',
    '   3. No, keep planning',
    '',
    ' ctrl-g to edit plan in your editor',
  ],
  // ExitPlanMode, a later layout with the free text row.
  planWithFeedback: [
    ' Would you like to proceed?',
    ` ${ptr} 1. Yes, clear context and auto-accept edits (shift+tab)`,
    '   2. Yes, auto-accept edits',
    '   3. Yes, manually approve edits',
    '   4. Type here to tell Claude what to change',
  ],
  // A layout the phone does not know: no card buttons.
  changedPlan: [
    ' Would you like to proceed?',
    ` ${ptr} 1. Approve and start`,
    '   2. Keep planning',
  ],
  changedPermission: [
    ' Do you want to proceed?',
    ` ${ptr} 1. Yes`,
    '   2. Always for this project',
    '   3. No',
  ],
  // The menu was answered and Claude kept writing below it.
  staleMenu: [
    ` ${ptr} 1. Yes`,
    "   2. Yes, and don't ask again for npm test commands",
    '   3. No, and tell Claude what to do differently (esc)',
    '\u23fa Bash(npm test)',
    '  \u23bf  PASS src/a.test.ts',
    '     PASS src/b.test.ts',
    '     Tests: 12 passed',
    '\u23fa All tests pass.',
  ],
  brokenNumbers: [
    ` ${ptr} 1. Yes`,
    '   2. Yes, and do not ask again',
    '   4. No',
  ],
}
