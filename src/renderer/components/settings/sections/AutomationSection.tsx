import { AutomationsTable, ScheduleSettings } from './AutomationSchedules'
import { CliSettings } from './CliSettings'

/**
 * Settings > Automation (E8-FR-22). Pane schedules (E8-FR-29..32): their
 * values and the table of every automation (R30-13). Then the snaos CLI block
 * (E8-FR-12..22, R30-11).
 */
export function AutomationSection() {
  return (
    <div className="space-y-8">
      <div className="space-y-6">
        <AutomationsTable />
        <ScheduleSettings />
      </div>
      <CliSettings />
    </div>
  )
}
