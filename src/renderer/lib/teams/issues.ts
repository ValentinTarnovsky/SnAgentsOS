/**
 * Definition problems on screen (app 2.7.0, E10 B1): main sends errors and
 * warnings in the same lists (`defIssues`, a probe's `existing.issues`, a
 * trust diff's `issues`), each with its severity. Only an error blocks a
 * trust, an adopt or a write; a warning is shown and never blocks. Repo text
 * inside an issue (a file name, a key, a detail) is shown with its hiding
 * characters spelled out, like the repo config trust dialog (E8-FR-24).
 */
import type { DefError } from '@shared/teams'
import { visibleText } from '@/lib/repoConfig'

/** A warning is only shown; an issue without a severity (an older main) counts as an error. */
export function isDefWarning(issue: DefError): boolean {
  return issue.severity === 'warning'
}

export function defErrorsOf(issues: readonly DefError[]): DefError[] {
  return issues.filter((issue) => !isDefWarning(issue))
}

export function defWarningsOf(issues: readonly DefError[]): DefError[] {
  return issues.filter(isDefWarning)
}

/** True when something in the list blocks (a warning alone never does). */
export function hasDefErrors(issues: readonly DefError[] | undefined): boolean {
  return !!issues && issues.some((issue) => !isDefWarning(issue))
}

function codePoint(ch: string): string {
  return `<U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`
}

/**
 * What visibleText leaves: the line and paragraph separators, and the tag
 * characters (U+E0000-U+E007F), invisible on screen yet read by a model as
 * ASCII text.
 */
const LINE_HIDDEN_RE = /[\u2028\u2029\u{E0000}-\u{E007F}]/gu

/**
 * One line of a definition file as it really is, for the trust and adopt
 * diff: control, bidi and zero-width characters as `<U+XXXX>` (visibleText)
 * and the separators and tag characters too, so hidden text in role
 * instructions or team.md cannot pass the review unseen. Tab stays (it is
 * indentation); plain text is unchanged.
 */
export function visibleLine(text: string): string {
  return visibleText(text).replace(LINE_HIDDEN_RE, codePoint)
}

/**
 * One line of repo text as it really is: what visibleLine spells out, and
 * tab and newline too, so a file name can neither hide part of itself nor
 * break the line it sits in.
 */
export function visibleName(text: string): string {
  return visibleLine(text).replace(/[\t\n]/g, codePoint)
}
