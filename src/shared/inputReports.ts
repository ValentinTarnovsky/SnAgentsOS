/**
 * Input that is only terminal reports, never an answer (E2-FR-48): focus in /
 * out, SGR and X10 mouse, plus the replies a terminal sends on its own to the
 * app's queries (cursor position, device attributes, status, mode reports,
 * kitty keyboard flags, OSC color answers, DECRQSS), which a phone xterm emits
 * while it parses a replay. Shared by StatusManager (answer cards, attention)
 * and PtyManager (the unsent-input check of agentTune, v2.3). Pure: no Node,
 * no DOM.
 */
// eslint-disable-next-line no-control-regex
export const REPORTS_ONLY_RE = /^(?:\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[\??\d+;\d+(?:;\d+)?R|\x1b\[[?>=][\d;]*c|\x1b\[\??\d+n|\x1b\[\??[\d;]+\$y|\x1b\[\?\d+u|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[01]\$r[^\x1b]*\x1b\\)+$/
