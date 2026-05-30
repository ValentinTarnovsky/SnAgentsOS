import type { GridPreset } from '@shared/types'

export interface WizardDraft {
  name: string
  cwd: string
  grid: GridPreset
  /** presetId per cell; length always equals the grid count. */
  assignments: string[]
}

export interface StepProps {
  draft: WizardDraft
  update: (patch: Partial<WizardDraft>) => void
}
