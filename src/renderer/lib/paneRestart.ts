import { restartFresh, restartFromButton, restartResume } from './agentLaunch'
import { wakePane } from './hibernation'

/**
 * Restart of a console asked from elsewhere: the phone's `restartPane` and
 * `snaos restart` (app 2.3.0) run this same code (E5-FR-11). `true` resumes
 * (falls back to a new chat with the chip when the record is gone), `false`
 * forgets the session, `undefined` = the header button. A sleeping console
 * wakes through the overlay's path (E5-FR-26), so a scheduled prompt waits for
 * the resumed agent. The resume goes through the launch intent: nothing is
 * ever typed and no Enter is sent.
 */
export function restartPaneWith(paneId: string, resume: boolean | undefined): void {
  if (resume === true) {
    if (!wakePane(paneId)) restartResume(paneId)
  } else if (resume === false) restartFresh(paneId)
  else restartFromButton(paneId)
}
