/**
 * The delete action: a `sidebar.workspaces.session.menu.item` row over one
 * injected behavior, plus the `shell.overlay` dialog that confirms permanent
 * removal. There is deliberately no hover button — deletion is irreversible,
 * so it must not sit one stray click away on every row.
 *
 * An archived row never reaches the dialog: deletion cannot be undone, so the
 * recoverable archived state has to be left first, and the notice says so.
 * The notice a successful deletion raises and the diagnostics for Host
 * rejections live in the injected callbacks, not here.
 */
import { useEffect, useRef, useState } from 'react'
import type { SessionActivity } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the family keys each provider merges; a key this program did not compile takes the generic line.
import type {} from '@deepseek-ai/dsh-agent/types'
import type {} from '@deepseek-ai/dsh-jobs/view'
import type {} from '@deepseek-ai/dsh-schedule/client'
import type {} from '@deepseek-ai/dsh-subagent/client'
import {
  Button, IconTrashOutlineRegular, MenuItemButton, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DeleteSessionInjected, SessionDeleteConfirmInjected, SessionDeleteConfirmProps, SessionDeleteConfirmRequest,
  SessionMenuItemProps,
} from '../contract/slots.ts'
import { activityLine } from './activity-line.ts'
import browserCss from '../rows/WorkspaceBrowser.module.css'

/**
 * Menu row (order 500, after archive and drawing a separator): delete the
 * Session and its stored log. The injected behavior owns the archived guard,
 * so the row just asks.
 * @param props - owner share, the delete share, and the menu open state.
 * @returns the row.
 */
export function DeleteSessionMenuItem({
  sessionId, displayTitle, useMenuOpenState, requestDeleteSession, t,
}: SessionMenuItemProps<DeleteSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      danger
      separatorBefore
      icon={<IconTrashOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        requestDeleteSession(sessionId, displayTitle)
      }}
    >
      {t('menu.deleteSession')}
    </MenuItemButton>
  )
}

/**
 * The `shell.overlay` entry: nothing while no confirmation is pending,
 * otherwise one dialog per request (keyed by the Session).
 * @param props - the request hook, its settlement, the activity read, the
 *   delete hop, and the locale seat.
 * @returns the open dialog, or null.
 */
export function SessionDeleteConfirmDialog({
  useDeleteRequest, settleSessionDelete, loadSessionActivity, confirmSessionDelete, t,
}: SessionDeleteConfirmProps) {
  const request = useDeleteRequest(pending => pending)
  if (request === null) return null
  return (
    <DeleteConfirmForm
      key={request.sessionId}
      request={request}
      loadSessionActivity={loadSessionActivity}
      confirmSessionDelete={confirmSessionDelete}
      onSettle={settleSessionDelete}
      t={t}
    />
  )
}

/** One request's dialog: in-flight and error state die with it. */
function DeleteConfirmForm({ request, loadSessionActivity, confirmSessionDelete, onSettle, t }: {
  request: SessionDeleteConfirmRequest
  loadSessionActivity: SessionDeleteConfirmInjected['loadSessionActivity']
  confirmSessionDelete: SessionDeleteConfirmInjected['confirmSessionDelete']
  onSettle: () => void
  t: SessionDeleteConfirmProps['t']
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Absent while the read is in flight: the dialog states irreversibility
  // either way, and only the confirmed action differs by what is running.
  const [activity, setActivity] = useState<readonly SessionActivity[] | null>(null)
  // The injected loader is rebuilt with its face, so keying the read on its
  // identity would refetch on every render. The request is what changed.
  const loader = useRef(loadSessionActivity)
  loader.current = loadSessionActivity
  useEffect(() => {
    let live = true
    loader.current(request.sessionId).then(
      (reported) => { if (live) setActivity(reported) },
      // A failed activity read is not a failed deletion: fall back to the
      // plain confirmation, which still stops whatever runs before removing.
      () => { if (live) setActivity([]) },
    )
    return () => { live = false }
  }, [request.sessionId])

  const running = activity !== null && activity.length > 0
  const close = () => {
    if (deleting) return
    onSettle()
  }
  const confirm = () => {
    setDeleting(true)
    setError(null)
    confirmSessionDelete(request.sessionId, { stopActivity: running }).then(() => {
      setDeleting(false)
      onSettle()
    }).catch((reason: unknown) => {
      setDeleting(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('delete.confirm.title')}
      description={t('delete.confirm.desc', { title: request.displayTitle })}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={close}>{t('cancel')}</Button>
          <Button
            variant="outline"
            className={browserCss.deleteAction}
            disabled={deleting || activity === null}
            onClick={confirm}
          >
            {t(running ? 'delete.confirm.stopAction' : 'delete.confirm.action')}
          </Button>
        </>
      )}
    >
      {running && (
        <>
          <div className={browserCss.deleteWarning}>{t('delete.confirm.running')}</div>
          <ul className={browserCss.archiveActivity} aria-label={t('delete.confirm.activity')}>
            {activity.map((entry, index) => (
              <li key={`${entry.kind}-${String(index)}`}>{activityLine(entry, t)}</li>
            ))}
          </ul>
        </>
      )}
      {deleting && <div className={browserCss.deleteStatus} role="status">{t('delete.confirm.pending')}</div>}
      {error !== null && <div className={browserCss.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
