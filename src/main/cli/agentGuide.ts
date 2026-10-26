/**
 * `snaos help --agent` (E8-FR-21): the guide an agent loads before driving
 * other consoles. English on purpose (a stable contract for agents) and
 * versioned with the app, so the skill stub stays a two-line pointer. Only the
 * idea of a handoff guide comes from stablyai/orca's CLI guide; no text is
 * copied. Node core only: cli.js bundles it (teamTools.ts is pure and zod-free).
 */
import { teamChannelText, teamToolsGuide } from '@shared/teamTools'

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

- \`snaos ls [--workspace <ws>]\`: workspaces and consoles with agent state. A console row also
  shows why its last turn failed (\`failed: limit until 15:30\`), a working agent silent for a while
  (\`quiet 12m\`, \`stalled 25m\`) and an open request for the user (\`needs: <text>\`).
- \`snaos spawn <claude|codex|shell|preset> [--prompt <text> | --prompt-file <path> | --prompt -] [--workspace <ws>] [--title <t>] [--focus] [--no-profile]\`:
  opens a console and returns its index and id right away, without waiting for the agent.
- \`snaos send <console> <text|-> [--file <path>] [--enter]\`: types text into the console's input;
  \`--enter\` submits it. Without \`--enter\` the text waits there, unsent, until a person presses Enter.
- \`snaos read <console> [--lines N]\`: last N lines (default 100, max 2000) without colors.
- \`snaos wait <console> --idle [--timeout <s>] [--quiet-ms <ms>]\`: blocks until the agent is
  idle, done, asking or failed (shells: no output for --quiet-ms).
- \`snaos status ["<text>" | --clear]\`: shows or sets your console's status line (max 120).
- \`snaos needs "<action>" | --clear\`: flags your console because the user has to do or decide
  something (see "Asking the user for something").
- \`snaos notify "<text>" [--title <t>] [--local]\`: desktop notification (and Discord/ntfy unless --local).
- \`snaos note "<text>" [--task-state todo|doing|review|done] | --clear\`: the one-line workspace
  note of the sidebar (not the Markdown notes below).
- \`snaos peek <console> [--lines N]\`: one look at a console: agent state, whether it needs the
  user, pending requests, activity, the tools of its current or last turn, last reply, model and
  effort when known, and its last N screen lines (default 30).
- \`snaos chat <console> [--turns N] [--before <cursor>] [--tools] [--thinking]\`: the conversation
  of a Claude or Codex console from its transcript (default the last 3 turns, max 20).
- \`snaos notes [ls]\`, \`notes get|new|set|append|rm|open\`: the workspace's Markdown notes (below).
- \`snaos open <ws> [--console <c>]\` or \`snaos open --path <dir>\`: shows it on the desktop.
  \`snaos focus <console>\` is the same as \`open --console\`.
- \`snaos rename <console> <title>\`, \`snaos restart <console> [--resume | --fresh]\`,
  \`snaos kill <console> [--close]\`: console control (see the rules below).
- \`snaos ws new [<name>] [--path <dir>] [--focus] [--composer]\`, \`ws rename <ws> <name>\`,
  \`ws fav <ws> [--off]\`, \`ws close <ws> --yes\`: workspaces. \`ws new\` takes the current folder
  without \`--path\` and keeps the desktop on its workspace without \`--focus\`.
- \`snaos usage [--provider claude|codex]\`: the Claude and Codex usage bars (percent and reset).
- \`snaos account [status]\`, \`account ls\`, \`account use <n|id|label>\`: the saved
  Claude accounts (see below).
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
- \`send\` (with or without \`--enter\`) to a console waiting on its user (a permission, question or
  plan menu) types nothing and exits 9 (\`awaiting_user\`). If the menu opens after the text was
  typed, \`--enter\` drops the Enter (the text stays unsent) and also exits 9. Never try to answer
  another agent's menu: tell the user, or \`wait\` and send later.
- Never \`kill\`, \`restart\` or \`ws close\` a console or workspace unless the user asked for it.
  None of them works on your own console or workspace, consoles with a Connection Profile
  answer \`ssh_protected\`, and \`ws close\` always needs \`--yes\` (it ends every console there).
- \`restart --resume\` keeps the agent's chat, \`--fresh\` starts a new one; without either it
  does what the console's restart button does. \`kill\` leaves the console stopped until someone
  restarts it; \`kill --close\` also removes it from the grid (the user can reopen it).
- Never \`account use\` unless the user asked to change the Claude account.

## Observing other consoles

- \`snaos peek <console>\` first: it is cheap, shows whether the agent is working, done or waiting
  on the user, what it asks, and its screen. Looking never clears the user's marks.
- \`snaos chat <console>\` to know what the agent did or answered: prompts, replies and tool calls
  (\`-> Bash: <command>\`); add \`--tools\` for tool output and \`--thinking\` for reasoning. Older
  turns: run the \`older: snaos chat <c> --before <cursor>\` line it prints. "no messages yet" means
  the transcript does not exist yet; a not found error says whether to use \`read\` or \`peek\`.
- \`snaos read <console>\` for the raw screen of any console (shells too).
- To follow another agent's work: \`snaos wait <console> --idle --timeout 110\`, then \`snaos peek\`
  or \`snaos chat <console> --turns 1\` to read the result.
- \`quiet <time>\` or \`stalled <time>\` in \`ls\` and \`peek\` means a working agent gave no sign of life
  for that long (a long command, or a stuck tool). Look with \`peek\` or \`read\`; never \`kill\` or
  \`restart\` it for that unless the user asks. \`failed: limit until <time>\` means its usage limit
  ran out until then: tell the user instead of sending it more work.

## Notes

- Workspace notes are real \`.md\` files the user sees in the Notes drawer. A note is its id
  (\`n-...\`) or its exact title (case-insensitive); there are no indexes.
- \`snaos notes\` lists them, \`notes get <note>\` prints one (\`--json\` adds \`rev\` and the file
  \`path\`), \`notes new "<text>" [--title <t>] [--open]\`, \`notes set <note> <text>\` overwrites,
  \`notes append <note> <text>\` adds at the end, \`notes rm <note>\` moves it to the trash (30
  days), \`notes open <note>\` shows it on the desktop.
- Always edit through \`snaos notes set\` or \`snaos notes append\`, never the file: the open
  editor and the phones only update through the CLI. Long text goes through \`-\` (stdin) or \`--file <path>\`.
- For a safe edit read \`rev\` from \`notes get --json\` and pass \`notes set <note> - --rev <rev>\`;
  exit 8 (\`conflict\`) means someone else changed it: read it again and retry.

## Usage and Claude accounts

- \`snaos usage\` shows what the usage bars show (5 h and weekly windows, \`resets in ...\`). It reads
  the app's cache: no need to call it in a loop. It answers \`disabled\` when the bars are off.
- \`snaos account\` shows the live Claude account, the last switch and whether the automatic
  switch is on; \`account ls\` lists the saved ones in priority order (\`#1\` first, \`*\` marks the
  live one).
- Run \`snaos account use <n|id|label>\` only when the user asks for it (\`n\` is the number
  \`account ls\` shows; \`primary\` and \`secondary\` still name #1 and #2). It
  changes the login of every Claude console at once (running ones too, no restart) and allows 3
  switches a minute. Accounts are saved and removed by the user in Settings, never by the CLI.

## Talking to another agent

- The first message to a new agent goes in \`spawn --prompt\` (or \`--prompt-file\`, \`--prompt -\`): it is
  submitted for you once the agent is ready. Do not spawn and then \`send\` the same task.
- Every follow-up or reply to an agent is \`snaos send <console> - --enter\` (text on stdin) or
  \`snaos send <console> --file <path> --enter\`. Leave out \`--enter\` only when the user wants to
  review the text before it goes.
- To get an answer back, put in your message the exact command the other agent must run, with your
  own console id and \`--enter\`, for example: reply with \`snaos send <your id> - --enter\`. Your id is
  in \`$SNAOS_CONSOLE_ID\` (PowerShell: \`$env:SNAOS_CONSOLE_ID\`, cmd: \`%SNAOS_CONSOLE_ID%\`); \`snaos ls\`
  also marks your console as \`self\`. Write the real id, not the variable: the other agent runs in
  another console.
- \`spawn\` prints \`prompt: argv\`, \`gate\` or \`none\`. If it printed \`prompt: gate\` and \`snaos read\` shows
  the text sitting unsent in the new console, submit it with an empty \`snaos send <console> --enter\`.
  Never type the text again.

## Asking the user for something

- \`snaos needs "<action>"\` (one line, max 200 characters) when the user has to do or decide
  something you cannot do yourself: approve a deploy, log in, pick between two designs, check
  something by hand. Your console turns amber and goes first in the attention lists (desktop and
  phone), but its input stays free and nothing blocks you: keep working, or end your turn.
- It is a flag, not a question menu: write the action itself ("approve the staging migration"),
  and put the details in your reply or in \`snaos status\`. Running it again replaces the text.
- Run \`snaos needs --clear\` once it is resolved. The next prompt your console gets, and your
  session starting or ending, also clear it.
- It only flags your own console: a console that names another one with \`--console\` gets
  \`forbidden\` (from an external terminal \`--console\` is required). It shares the budget of 30 a
  minute with \`kill\`, \`restart\`, \`rename\` and \`ws rename|close|fav\`.

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

## Teams (snaos team)

\`snaos team\` works only inside a team run (the app sets \`SNAOS_TEAM_RUN\` for it); outside one it
answers \`forbidden\`. Inside a team run every other command answers \`forbidden\` too, except \`ping\`
and \`usage\`. Each run's instructions list the tools of its role; those of a dev, for example:

${teamToolsGuide('dev')}

${teamChannelText(false, { win32: false, provider: 'claude' })}

- Claude Code runs \`snaos team\` with its Bash tool (Git Bash on Windows), never with the PowerShell
  tool nor through \`$env:SNAOS_CLI\`: on Windows those reach \`snaos.cmd\`, whose arguments cmd.exe
  reads again, so a team run's permissions allow \`Bash(snaos team:*)\` only. A Codex run calls it from
  its own shell.
- Read code changes with \`snaos team diff\` and history with \`snaos team log\`, never with \`git log\`,
  \`git diff\` or \`git show\`: a read-only run does not allow them (their options can write or read any
  file), so the app runs git for you with safe options. \`team diff\` reads a task's worktree against its
  base (its commits and its uncommitted changes) or, for a task without one or a run without a task,
  the repo root against HEAD (files git does not track yet are not in it: \`git status\` lists them);
  \`--stat\` lists the files only. \`team log [-n <1..50>]\` lists the commits
  of the task branch since its base, or of the repo root (20 by default). Your own task by default,
  \`--task <t-N>\` for another task of your team; paths only after \`--\`, relative to the repo
  (\`snaos team diff -- src/a.ts\`). The text stops at 256 KB (diff) or 64 KB (log) with a
  \`[... cut ...]\` line: narrow it with \`--stat\`, \`-n\` or a path.
- A tool that ends your run concludes it: the team then refuses your writes (\`conflict\`, exit 8)
  and you keep only the reads. Budgets per run: 120 reads and 60 writes a minute.
- \`team task update\` never changes a field the user set: it answers \`user_owned\` (exit 8) with
  those fields; send the call again without them.
- \`team hire --file <file>|-\` (the Lead, in its lead runs) proposes a whole role file, frontmatter
  and instructions like \`roles/<id>.md\`. An optional \`id: <role-id>\` line in its frontmatter names
  the role (it is not written); without it the id is the slug of \`name\` (\`QA Movil\` -> \`qa-movil\`).
  A refused file answers \`bad_request\` and prints one line per problem (\`data.issues\` with \`--json\`).

## Exit codes

0 ok, 1 internal error, 2 bad usage, 3 not found or not running, 4 ambiguous, 5 app not
available, 6 unauthorized (restart the console; in a team run: the run is over), 7 forbidden or
disabled, 8 conflict (the note or the team task changed since --rev, or this team run already
concluded) or user owned (team task fields the user set), 9 awaiting the user (a permission,
question or plan menu), 124 timeout.
`
}
