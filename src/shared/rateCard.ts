/**
 * App 2.7.0 (A4): the prices and context windows behind the console ledger
 * (`src/main/usage/ConsoleLedger.ts`). Pure: no Node, no DOM.
 *
 * Every figure the ledger derives from here is an estimate, shown as
 * "estimado" on every surface. A price or a window goes in only when a
 * source in this repo or the spike captures (docs/snagentsos/epics/E10.md,
 * SPIKE) shows it; a model without one has no cost, never a guess. Bump
 * RATE_CARD_VERSION and RATE_CARD_DATE whenever a row changes.
 */

export const RATE_CARD_VERSION = 1
/** The day the card was last checked against its sources. */
export const RATE_CARD_DATE = '2026-10-23'

/** USD per 1M tokens of one Codex model. */
export interface CodexRate {
  /** Input that was not read from the cache. */
  input: number
  cachedInput: number
  output: number
}

/**
 * Codex prices by model slug (lowercase), USD per 1M tokens. Empty on
 * purpose: codex-cli 0.163.0 reports no price (neither `exec --json` nor
 * `thread/tokenUsage/updated` carries one, S4 and S8) and nothing in this
 * repo states one for the current gpt-6.x models, so every Codex console has
 * `unknownCost` until a verified row lands here.
 */
export const CODEX_RATES: Readonly<Record<string, CodexRate>> = Object.freeze({})

/** The counts a Codex cost needs; `inputTokens` includes `cachedInputTokens` (E10 SPIKE S4, S8). */
export interface CodexCostBreakdown {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * USD of `breakdown` at the model's rate, or undefined when the model has no
 * row (unknown cost). The cached part of the input is priced apart; reasoning
 * is not added, since the usage already counts it inside `outputTokens`.
 * `rates` is for tests.
 */
export function codexCost(model: string | undefined, breakdown: CodexCostBreakdown, rates: Readonly<Record<string, CodexRate>> = CODEX_RATES): number | undefined {
  const slug = typeof model === 'string' ? model.trim().toLowerCase() : ''
  if (!slug || !Object.prototype.hasOwnProperty.call(rates, slug)) return undefined
  const rate = rates[slug]
  const cached = Math.min(count(breakdown.cachedInputTokens), count(breakdown.inputTokens))
  const fresh = count(breakdown.inputTokens) - cached
  const usd = (fresh * rate.input + cached * rate.cachedInput + count(breakdown.outputTokens) * rate.output) / 1_000_000
  return Number.isFinite(usd) ? usd : undefined
}

/** Claude's standard context window, in tokens. */
export const CLAUDE_CONTEXT_WINDOW = 200_000
/** The long one: a `[1m]` model, and the models whose window is 1M as they come. */
export const CLAUDE_LONG_CONTEXT_WINDOW = 1_000_000

/**
 * Claude models whose window is 1M without the `[1m]` suffix, verified:
 * claude-haiku-5-5 reports `contextWindow: 1000000` in `result.modelUsage`
 * (E10 SPIKE S1). A date or version suffix still matches; another digit does not.
 */
const CLAUDE_LONG_MODELS: readonly RegExp[] = [/\bclaude-haiku-5-5(?![\d.])/i]

/**
 * The window Claude's context is measured against, for a model id or alias:
 * 1M for an id ending in `[1m]` (`claude-sonnet-4-5[1m]`, `opus[1m]`) and for
 * the models listed above, else 200k. An unknown or missing id is 200k.
 */
export function claudeContextWindow(modelId: string | undefined): number {
  const id = typeof modelId === 'string' ? modelId.trim() : ''
  if (!id) return CLAUDE_CONTEXT_WINDOW
  if (/\[1m\]$/i.test(id) || CLAUDE_LONG_MODELS.some((re) => re.test(id))) return CLAUDE_LONG_CONTEXT_WINDOW
  return CLAUDE_CONTEXT_WINDOW
}

/**
 * A context cannot be larger than its window: when the tokens used exceed
 * the assumed window, the window was the long one (a 1M model reached through
 * an alias or a setting the ledger cannot see), so it is 1M.
 */
export function fitContextWindow(used: number, window: number): number {
  return count(used) > window ? Math.max(window, CLAUDE_LONG_CONTEXT_WINDOW) : window
}
