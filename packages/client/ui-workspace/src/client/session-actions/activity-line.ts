/**
 * The one rendering of a reported `SessionActivity` family: the archive
 * confirmation and the delete confirmation both list running work, and the
 * two must read the same. The strings live under the archive keys because the
 * archive dialog introduced them and both surfaces name the same families.
 */
import type { SessionActivity } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionArchiveConfirmProps } from '../contract/slots.ts'

/** The locale seat a family line translates through. */
export type ActivityTranslate = SessionArchiveConfirmProps['t']

/**
 * One family's line: its count and the items' labels (ids when a family
 * carries no label). A family this dictionary does not know — a provider
 * merged into the kind map — falls through to the generic line.
 * @param entry - one activity family the Host reported.
 * @param t - the workspace locale seat.
 * @returns the localized line.
 */
export function activityLine(entry: SessionActivity, t: ActivityTranslate): string {
  const items = entry.items ?? []
  const n = items.length
  const names = items.map(item => item.label ?? item.id).join(t('archive.confirm.listSeparator'))
  const plural = n === 1 ? 'one' : 'other'
  switch (entry.kind) {
    case 'turn': return t('archive.confirm.turn')
    case 'subagent': return t(`archive.confirm.subagents.${plural}`, { n, names })
    case 'job': return t(`archive.confirm.jobs.${plural}`, { n, names })
    case 'schedule': return t(`archive.confirm.schedules.${plural}`, { n, names })
    default: return t(`archive.confirm.other.${plural}`, { kind: entry.kind, n })
  }
}
