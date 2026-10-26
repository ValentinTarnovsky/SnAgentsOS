import type { ConfigFile } from '@shared/types'

/**
 * The config written by "Export": a deep copy with every secret blanked and the
 * channels that depend on one switched off, so a shared export never carries a
 * hook token, a Discord webhook or the ntfy topic/token (E2-FR-40), the values
 * of a preset env or the text of a secret Connection step, and an import never
 * starts posting to someone else's channel.
 */
export function sanitizeExport(config: ConfigFile): ConfigFile {
  const exported = structuredClone(config)
  const n = exported.settings.notifications
  n.hookToken = ''
  n.hooksEnabled = false
  n.discord.webhookUrl = ''
  n.discord.enabled = false
  if (n.ntfy) {
    n.ntfy.topic = ''
    n.ntfy.token = ''
    n.ntfy.enabled = false
  }
  // A preset env keeps its keys (what the preset needs) but never its values
  // (API keys, tokens): a blank value is "not set" at spawn (applyPresetEnv), so
  // an import never overrides the inherited env. A secret Connection step keeps
  // its place, not its text.
  for (const preset of exported.presets ?? []) {
    if (preset.env) preset.env = Object.fromEntries(Object.keys(preset.env).map((key) => [key, '']))
  }
  for (const profile of exported.connections ?? []) {
    for (const step of profile.steps ?? []) if (step.secret) step.send = ''
  }
  // Never write the pre-v12 key, even if a caller still had it.
  delete exported.snippets
  return exported
}
