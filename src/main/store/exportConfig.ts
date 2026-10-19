import type { ConfigFile } from '@shared/types'

/**
 * The config written by "Export": a deep copy with every secret blanked and the
 * channels that depend on one switched off, so a shared export never carries a
 * hook token, a Discord webhook or the ntfy topic/token (E2-FR-40), and an
 * import never starts posting to someone else's channel.
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
  // Never write the pre-v12 key, even if a caller still had it.
  delete exported.snippets
  return exported
}
