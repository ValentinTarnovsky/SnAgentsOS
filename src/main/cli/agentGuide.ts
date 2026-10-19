/**
 * `snaos help --agent` (E8-FR-21): the guide an agent loads before driving
 * other consoles. English on purpose (a stable contract for agents) and
 * versioned with the app, so the skill stub stays a two-line pointer. Only the
 * idea of a handoff guide comes from stablyai/orca's CLI guide; no text is
 * copied. Node core only: cli.js bundles it.
 */
export function agentGuide(appVersion: string): string {
  return `# SnAgentsOS CLI guide (snaos ${appVersion})

\`snaos\` drives the consoles of the SnAgentsOS window you are running in. Inside a
SnAgentsOS console it already knows which console you are (\`self\`). Use
\`$SNAOS_CLI\` (PowerShell: \`$env:SNAOS_CLI\`, cmd: \`%SNAOS_CLI%\`) when \`snaos\` is not on PATH.

## Addresses

- Console: \`self\`, its 1-based index in the workspace grid (\`2\`), \`<workspace>:<index>\`
  (\`api:2\`), its id, or its exact title (case-insensitive).
- Workspace: its id, exact name (case-insensitive) or 1-based sidebar index.
- Without \`--workspace\`, an index means your own workspace.

## Commands

- \`snaos ls [--workspace <ws>]\`: workspaces and consoles with agent state.
- \`snaos spawn <claude|codex|shell|preset> [--prompt <text> | --prompt-file <path> | --prompt -] [--workspace <ws>] [--title <t>] [--focus] [--no-profile]\`:
  opens a console and returns its index and id right away, without waiting for the agent.
- \`snaos send <console> <text|-> [--file <path>] [--enter]\`: types text; Enter only with \`--enter\`.
- \`snaos read <console> [--lines N]\`: last N lines (default 100, max 2000) without colors.
- \`snaos wait <console> --idle [--timeout <s>] [--quiet-ms <ms>]\`: blocks until the agent is
  idle, done, asking or failed (shells: no output for --quiet-ms).
- \`snaos status ["<text>" | --clear]\`: shows or sets your console's status line (max 120).
- \`snaos notify "<text>" [--title <t>] [--local]\`: desktop notification (and Discord/ntfy unless --local).
- \`snaos note "<text>" [--task-state todo|doing|review|done] | --clear\`: workspace note.
- \`snaos open <ws> [--console <c>]\` or \`snaos open --path <dir>\`: shows it on the desktop.
- Add \`--json\` to any command for one line of JSON: \`{"ok":true,"data":...}\` or
  \`{"ok":false,"error":{"code","message"}}\`.

## Rules

- A full handoff is: \`spawn\` with the whole task as the prompt, then report the console
  index to the user. Do not wait for it unless the user asked you to.
- Text with quotes, line breaks or more than a short sentence always goes through a file
  or stdin: \`--prompt-file\`, \`--file\` or \`-\`. Quoting through PowerShell 5.1 and cmd mangles
  inline text.
- Set \`snaos status "<what you are doing>"\` at checkpoints so the user sees your progress.
- \`wait\` can block for minutes, and the shell tool of an agent (Claude Code, Codex) cuts a
  command short after its own timeout (Claude Code's Bash tool: 120 s by default). Keep each
  call short: use \`snaos wait <c> --idle --timeout 110\` and repeat, or raise your shell tool's
  timeout, or run the wait in the background if your tool can.
- \`send --enter\` followed by \`wait --idle\` returns only after the new turn started and ended;
  \`noTurnObserved: true\` means nothing happened in 10 s (check the console with \`read\`).

## Waiting on other consoles, drivers and background work

SnAgentsOS shows your console as done when your turn ends. If you are not done yet:

- Never end your turn just saying you will wait. Wait for real: run \`snaos wait <console> --idle\`
  in the foreground (in short calls, see above) or as a background task of your shell tool. While a
  background \`snaos wait\`, a background subagent or a driver runs, your console shows "Waiting"
  instead of done, and no "turn finished" notice goes out.
- Set \`snaos status "waiting for <what>"\` so the user sees what you wait on.
- A \`claude -p\` you start (a driver script, a sub-task) is tracked as a sub-session of your
  console: it keeps your console "Waiting" and never replaces you. A \`codex exec\` is not tracked
  at all. Either way, say so with \`snaos status\` when you start one.
- A background dev server or watcher does not hold your console: it still shows done.
- Consoles with a Connection Profile (SSH) are protected by default: \`ssh_protected\`. Do not
  retry; tell the user.
- If a command says SnAgentsOS is not running or unreachable, or your sandbox blocks the
  pipe, report it and ask the user. Do not retry in a loop.

## Exit codes

0 ok, 1 internal error, 2 bad usage, 3 not found or not running, 4 ambiguous, 5 app not
available, 6 unauthorized (restart the console), 7 forbidden or disabled, 124 timeout.
`
}
