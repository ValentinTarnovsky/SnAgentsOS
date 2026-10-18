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

/**
 * The other queries xterm.js 5.5 answers: OSC 4/10/11/12 color reports
 * (`ESC ] 11 ; ? BEL`, which Codex sends to detect the theme) and DECRQSS
 * (`ESC P $ q Pt ST`). Only the pure query forms, so a color set is kept.
 */
const OSC_DCS_QUERY_RE = /\x1b\](?:4(?:;\d+;\?)+|1[0-2](?:;\?)+)(?:\x07|\x1b\\)|\x1bP\$q[^\x1b\x07]*\x1b\\/g

/** Only the queries removed (used for every replay built from the raw ring). */
export function sanitizeQueries(raw: string): string {
  if (!raw.includes('\x1b')) return raw
  const csi = raw.includes('\x1b[') ? raw.replace(QUERY_RE, '') : raw
  return csi.includes('\x1b]') || csi.includes('\x1bP') ? csi.replace(OSC_DCS_QUERY_RE, '') : csi
}

/**
 * Strings that end at ST (`ESC \`) or, for OSC, also at BEL: OSC, DCS, SOS, PM
 * and APC. Any other ESC ends them too (xterm.js dispatches an OSC or DCS cut
 * by `ESC [`), so the body goes up to it and the ESC stays for what follows.
 * An unterminated one at the end runs to the end of the text.
 */
const STRING_SEQ_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|(?=\x1b)|$)|\x1b[P_^X][^\x1b]*(?:\x1b\\|(?=\x1b)|$)/g
/** Passes before a text that keeps producing new sequences loses every ESC. */
const SEED_PASSES = 8
/**
 * C1 controls and ENQ. A saved seed comes from addon-serialize, which never
 * emits them; an 8-bit CSI/OSC/DCS (0x9b/0x9d/0x90) in an edited file would
 * open a sequence the 7-bit filters above do not see.
 */
const C1_ENQ_RE = /[\x05\x80-\x9f]/g

/**
 * A saved scrollback about to be written into a terminal again (E6-FR-37):
 * every OSC (titles, hyperlinks, clipboard, color queries), DCS, SOS, PM and
 * APC string and every CSI query/report goes, so a hand-edited file can
 * neither answer into the shell, set the title (and through it Claude's state)
 * nor reach the clipboard. SGR, cursor moves and erases are kept.
 */
export function sanitizeSeed(ansi: string): string {
  if (!ansi) return ''
  const noC1 = ansi.replace(C1_ENQ_RE, '')
  if (!noC1.includes('\x1b')) return noC1
  // A removal can join the halves around it into a new sequence
  // (`ESC ESC[c ]0;t BEL` becomes an OSC title), so it repeats until stable.
  let text = noC1
  for (let pass = 0; pass < SEED_PASSES; pass++) {
    const next = text.replace(STRING_SEQ_RE, '').replace(QUERY_RE, '')
    if (next === text) return text
    text = next
  }
  return text.replace(/\x1b/g, '')
}
