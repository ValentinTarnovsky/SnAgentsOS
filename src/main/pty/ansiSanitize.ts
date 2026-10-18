/**
 * Filters for raw terminal output that is written into a terminal again (a
 * replay into a reloaded pane or a phone). A terminal answers some sequences by
 * typing a reply into its input: replaying a recorded DA1 (`ESC [ c`) or a
 * cursor position query (`ESC [ 6 n`) would make the receiving xterm send
 * `ESC [ ? 1 ; 2 c` or `ESC [ 12 ; 1 R` to the live shell as if the user typed
 * it. The original program got its answer long ago, so replays drop them.
 */

/**
 * CSI query/report sequences: DA1/DA2/DA3 (`c`, `>c`, `=c`), DSR and its DEC
 * form (`n`, `?n`), window reports (`t`), DECRQM (`$p`, `?$p`), XTVERSION
 * (`>q`) and the kitty keyboard query (`?u`).
 */
const QUERY_RE = /\x1b\[(?:[?>=]?[\d;]*[cnt]|\??[\d;]*\$p|>[\d;]*q|\?u)/g

/** Only the CSI queries removed (used for every replay built from the raw ring). */
export function sanitizeQueries(raw: string): string {
  return raw.includes('\x1b[') ? raw.replace(QUERY_RE, '') : raw
}
