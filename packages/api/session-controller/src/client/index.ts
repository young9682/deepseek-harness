/** Client Session object layer, Agent scopes, and Remote lifecycle wiring. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-file-upload/client'
import { typertOwnedValue } from '@deepseek-ai/dsh-typert-protocol'
import { createSessionControlStream } from './transport.ts'
import { ClientSessions } from './sessions/service.ts'
import type { SessionRemotes } from './sessions/remotes.ts'
import type {} from '../remote-events.ts'

export {
  createSessionControlStream,
  SessionEventStream,
  SESSION_SEARCH_RESULT_LIMIT,
  SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from './transport.ts'
export type {
  ClientSessionPageRequest,
  SessionControlStream,
  SessionControlStreamOptions,
  SessionEventStreamOptions,
  SessionJournalChange,
  SessionRemote,
} from './transport.ts'
export { createScope, scopeOf } from './scope.ts'
export type { AgentContext, AgentScopeHandle } from './scope.ts'
export { SessionCreateError, SessionDeleteError, SessionForkError } from './sessions/service.ts'
export type { SessionBinding, SessionListState, SessionSummary } from './sessions/service.ts'
export type {
  SessionListPhase,
  SessionListSnapshot,
  SessionSearchResultItem,
  SessionProjectionSnapshot,
} from './sessions/manager.ts'
export type { Session } from './sessions/session.ts'
export type {
  ProjectionsBaseline,
  ProjectionValueStore,
  SessionProjectionMap,
  UseProjection,
} from './sessions/projection-store.ts'
export type {
  BeginSubmissionInput,
  ISession,
  PendingSubmissionRetirement,
  ProjectionsFace,
  SessionFace,
  SubmissionHandle,
} from './contract/session.ts'
export type {
  ISessions, SessionReference, SessionRetainInfo, SessionRetainOptions, SessionTarget,
} from './contract/sessions.ts'
export { MutableSessionEventSource } from './contract/events.ts'
export type {
  AssistantLiveChunkEvent,
  SessionAssistantSettlementEntry,
  SessionEventChange,
  SessionEventLike,
  SessionEventLikeEntry,
  SessionEventSource,
  SessionEventWindow,
  SessionLiveEventEntry,
  SessionTransientEventEntry,
} from './contract/events.ts'
export type {
  OpenState,
  PendingSubmission,
  PendingSubmissionAttachment,
  PendingSubmissionFileAttachment,
  PendingSubmissionImage,
  PendingSubmissionImageAttachment,
  PendingSubmissionPlacement,
  PromptError,
  SessionSnapshot,
} from './contract/snapshot.ts'

/** Consumer-owned reference labels; extend this map through the package's canonical /client entry. */
export interface SessionReferenceSourceMap {
  /** Temporary Client Controller work, including fork-title preparation. */
  controllerOperation: unknown
  /** A Client Gateway invocation's synchronous Context ownership. */
  gateway: unknown
}

/** Declaration-merge-extensible labels carried by independent Client references. */
export type SessionReferenceSource = Extract<keyof SessionReferenceSourceMap, string>

/**
 * Owner-declared parts of a retained Session beyond its history stream, each counted independently.
 * Owners extend it by augmenting this package's canonical `/client` module specifier; the Controller assigns no meaning to a key.
 */
export interface SessionRetainFacetMap {}

/** Declaration-merge-extensible facet names a reference may retain. */
export type SessionRetainFacet = Extract<keyof SessionRetainFacetMap, string>

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Confirm nominated Sessions have no draft, then stop their input during Host exit.
     * @mode bail
     * @param sessionIds - Sessions whose local draft state the Host is checking.
     * @returns candidate identities confirmed empty by the input owner.
     */
    'client-session/check-unused-blanks'(sessionIds: readonly SessionId[]): {
      readonly sessionIds: readonly SessionId[]
      readonly resume: () => void
    } | undefined
  }

  interface Context {
    /** Client Session object layer and Agent scope owner. */
    sessions: import('./contract/sessions.ts').ISessions
  }
}

/** Required Remote and Context projection services. */
export const inject = [
  'connection',
  'fileUpload',
  'typert',
  'remote',
  'remote.commands',
  'remote.session',
  'remote.subagents',
]

/**
 * Install Client Session state and its reconnecting control stream.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: Context): void {
  const remotes = ctx.remote as unknown as SessionRemotes
  const connection = ctx.get('connection') as ConnectionHandle
  const sessions = new ClientSessions(ctx, remotes)
  ctx.remote.$on('api-session/added', (summary) => { sessions.handleSessionAdded(summary) })
  ctx.remote.$on('api-session/removed', (sessionId) => { sessions.handleSessionRemoved(sessionId) })
  ctx.remote.$on('api-session/status', (sessionId, running) => {
    sessions.handleSessionStatus(sessionId, running)
  })
  ctx.remote.$on('api-session/activity', (sessionId, updatedAt) => {
    sessions.handleSessionActivity(sessionId, updatedAt)
  })
  ctx.remote.$on('api-session/error', (sessionId, message) => {
    sessions.handleSessionError(sessionId, message)
  })

  let controlReady = false
  let resumeDraftInput: (() => void) | undefined
  const control = createSessionControlStream(remotes, {
    accept: (frame) => {
      sessions.handleControlFrame(frame)
      if (frame.type === 'baseline') {
        controlReady = true
        resumeDraftInput?.()
        resumeDraftInput = undefined
      }
    },
    failed: (error) => { console.error('[session-controller] control stream failed:', error) },
  })
  let draftCheck: { controller: AbortController; settled: Promise<void> } | undefined
  const answerDraftCheck = async (signal: AbortSignal): Promise<void> => {
    try {
      const probe = remotes.session.observeUnusedBlanks(signal)
      for await (const ids of probe) {
        signal.throwIfAborted()
        const report = controlReady ? ctx.bail('client-session/check-unused-blanks', ids) : undefined
        resumeDraftInput = report?.resume
        probe.send(report?.sessionIds ?? [])
        probe.end()
      }
    } catch (error: unknown) {
      // Missing or failed probes leave the draft unconfirmed.
      console.debug('[session-controller] shutdown draft check unavailable:', error)
    }
  }
  const connected = (): void => {
    if (connection.generation.getSnapshot() === undefined) return
    // A ready control baseline may arrive before Cordis delivers connection/reset.
    controlReady = false
    sessions.handleConnected()
    control.restart()
    control.start()
    draftCheck?.controller.abort()
    const controller = new AbortController()
    draftCheck = { controller, settled: answerDraftCheck(controller.signal) }
  }
  ctx.effect(() => connection.generation.subscribe(connected), 'session-controller.client.generation')
  connected()
  ctx.typert.contexts.registerClient('agent', {
    identity: candidate => sessions.sessionOf(candidate)?.sessionId,
    resolve: (sessionId) => {
      const reference = sessions.retainAgentScope(sessionId)
      return typertOwnedValue(reference.binding.ctx, () => { reference.release() })
    },
  })
  ctx.effect(() => async () => {
    draftCheck?.controller.abort()
    await Promise.all([control.dispose(), draftCheck?.settled])
    resumeDraftInput?.()
  }, 'session-controller.client.control')
}
