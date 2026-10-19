import { CliSettings } from './CliSettings'

/**
 * Settings > Automation (E8-FR-22): the snaos CLI block (R30-11). The table of
 * recurring automations (E8-FR-31/32) joins this section from its own work
 * package.
 */
export function AutomationSection() {
  return (
    <div className="space-y-8">
      <CliSettings />
    </div>
  )
}
