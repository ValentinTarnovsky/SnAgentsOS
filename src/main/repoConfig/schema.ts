import { z } from 'zod'
import { REPO_CONFIG_MAX_CONSOLES, REPO_CONFIG_MAX_QUICK, type RepoConfigFile } from '@shared/repo-config'

/**
 * zod of `.snagentsos.json` (E8-FR-23). Unknown keys are stripped (a newer
 * file still opens); the key order of the shapes is the export order (zod
 * rebuilds objects shape-first), so `version` always comes first.
 */

const label = z.string().max(60).refine((v) => v.trim().length > 0, 'label must not be blank')
/** A hex color or a CSS color name; anything else would never reach a style. */
const color = z.string().regex(/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,20})$/, 'expected #rgb, #rrggbb or a color name')

const consoleSchema = z.object({
  title: z.string().max(60).optional(),
  agent: z.string().min(1).max(60).optional(),
  command: z.string().max(4096).optional(),
  prompt: z.string().max(16384).optional(),
  cwd: z.string().min(1).max(1024).optional(),
  color: color.optional(),
  icon: z.string().regex(/^[a-zA-Z0-9-]{1,40}$/, 'expected an icon name').optional(),
})

const quickSchema = z.discriminatedUnion('action', [
  z.object({ label, action: z.literal('send'), text: z.string().min(1).max(16384), enter: z.boolean().optional() }),
  z.object({ label, action: z.literal('agent'), agent: z.string().min(1).max(60), prompt: z.string().min(1).max(16384) }),
])

const gridSchema = z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12)])

export const repoConfigSchema = z
  .object({
    $schema: z.string().max(500).optional(),
    version: z.literal(1),
    name: z.string().min(1).max(80).optional(),
    grid: gridSchema.optional(),
    connectionProfile: z.string().min(1).max(80).optional(),
    setup: z
      .object({
        command: z.string().min(1).max(4096),
        title: z.string().max(60).optional(),
        waitForSetup: z.boolean().optional(),
      })
      .optional(),
    consoles: z.array(consoleSchema).min(1).max(REPO_CONFIG_MAX_CONSOLES),
    quickCommands: z.array(quickSchema).max(REPO_CONFIG_MAX_QUICK).optional(),
  })
  .superRefine((cfg, ctx) => {
    // The setup console counts against the 12-console grid.
    if (cfg.setup && cfg.consoles.length >= REPO_CONFIG_MAX_CONSOLES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['consoles'], message: `at most ${REPO_CONFIG_MAX_CONSOLES - 1} consoles with a setup` })
    }
  })

export type RepoConfigParse = { ok: true; config: RepoConfigFile } | { ok: false; at: string; detail: string }

/** `consoles[2].cwd` from a zod path. */
export function jsonPath(path: ReadonlyArray<string | number>): string {
  let out = ''
  for (const seg of path) out += typeof seg === 'number' ? `[${seg}]` : out ? `.${seg}` : seg
  return out || '(root)'
}

/** Parse an already JSON-decoded value; reports the first issue only. */
export function parseRepoConfig(raw: unknown): RepoConfigParse {
  const r = repoConfigSchema.safeParse(raw)
  if (r.success) return { ok: true, config: r.data as RepoConfigFile }
  const issue = r.error.issues[0]
  return { ok: false, at: jsonPath(issue?.path ?? []), detail: issue?.message ?? 'invalid' }
}
