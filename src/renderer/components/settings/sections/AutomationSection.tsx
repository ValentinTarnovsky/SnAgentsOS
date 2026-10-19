import { AutomationsTable, ScheduleSettings } from './AutomationSchedules'

/**
 * Settings > Automation (E8-FR-22). Pane schedules (E8-FR-29..32): their
 * values and the table of every automation. The CLI rows (E8-FR-12..22) live
 * in their own block of this category.
 */
export function AutomationSection() {
  return (
    <div className="space-y-6">
      <AutomationsTable />
      <ScheduleSettings />
    </div>
  )
}
