/** Live Session projection state with reconnect baselines. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type {
  Session, SessionId,
} from '@deepseek-ai/dsh-session'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SessionControlBaseline,
  SessionControlFrame,
  SessionProjectionBaseline,
  SessionProjectionUpdate,
  SessionProjectionValues,
} from './types.ts'

/** Owns the Host-wide Session control stream. */
export class SessionControlController {
  private readonly streams = new Set<ControlQueue>()
  private readonly newBlanks = new Set<SessionId>()
  // A second owner stream, even after disconnect, may have left drafts in a
  // different storage partition. Only the first uninterrupted owner can attest.
  private observedBrowser = false
  private owner: { peer: PeerScope; signal: AbortSignal } | undefined
  private probe: {
    peer: PeerScope
    signal: AbortSignal
    request: PromiseWithResolvers<readonly SessionId[]>
  } | undefined
  private shuttingDown = false
  private answerUnused: ((ids: readonly SessionId[]) => void) | undefined

  /** @param ctx - Host context carrying live Agent and projection services. */
  constructor(private readonly ctx: Context) {
    ctx.sessionProjections.onEventChanged((session, changes, seq) => {
      this.broadcast({
        type: 'projection',
        sessionId: session.id,
        seq,
        // Every projection definition validates its value before change publication.
        changes: changes as SessionProjectionUpdate['changes'],
      })
    })
    ctx.effect(() => () => {
      for (const stream of this.streams) stream.end()
      this.streams.clear()
    }, 'session-controller.control')
  }

  /**
   * Open one generation of Host-wide live control state.
   * @param signal - Remote stream cancellation.
   * @param peer - an owner browser, null for other browser callers, or absent for in-process consumers.
   * @returns one complete baseline followed by live replacement frames.
   */
  async *control(signal: AbortSignal, peer?: PeerScope | null): AsyncIterable<SessionControlFrame> {
    signal.throwIfAborted()
    const queue = new ControlQueue()
    this.streams.add(queue)
    if (peer !== undefined) {
      this.owner = this.observedBrowser || peer === null ? undefined : { peer, signal }
      this.observedBrowser = true
      if (this.owner === undefined) this.newBlanks.clear()
    }
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* queue.iterate(signal)
    } finally {
      this.streams.delete(queue)
      queue.end()
      if (this.owner?.signal === signal) this.owner = undefined
    }
  }

  /**
   * Record a freshly minted Session when its sole browser is known.
   * @param sessionId - newly minted identity.
   * @param peer - authenticated creator.
   */
  rememberBlank(sessionId: SessionId, peer: PeerScope): void {
    if (!this.shuttingDown && this.owner?.peer === peer && !this.owner.signal.aborted) this.newBlanks.add(sessionId)
  }

  /** @param sessionId - identity that acquired durable activity or was removed. */
  forgetBlank(sessionId: SessionId): void {
    this.newBlanks.delete(sessionId)
  }

  /**
   * Disqualify a blank opened outside the browser that can attest to it.
   * @param sessionId - opened identity.
   * @param peer - caller, absent for an in-process consumer.
   */
  observeBlankUse(sessionId: SessionId, peer?: PeerScope): void {
    if (peer !== this.owner?.peer || this.shuttingDown) this.forgetBlank(sessionId)
  }

  /**
   * @param sessionId - candidate to validate before destructive work.
   * @returns whether the original browser and candidate still qualify.
   */
  canClean(sessionId: SessionId): boolean {
    return this.owner !== undefined && !this.owner.signal.aborted && this.newBlanks.has(sessionId)
  }

  /**
   * Wait for one draft check from the launcher without altering the control stream's wire format.
   * @param peer - authenticated responder.
   * @param signal - responder stream lifetime.
   * @returns candidates to check, or undefined when the stream is cancelled.
   */
  async awaitBlankCheck(peer: PeerScope, signal: AbortSignal): Promise<readonly SessionId[] | undefined> {
    if (this.shuttingDown || signal.aborted) return undefined
    if (this.probe !== undefined) {
      this.owner = undefined
      this.newBlanks.clear()
      return undefined
    }
    const request = Promise.withResolvers<readonly SessionId[]>()
    this.probe = { peer, signal, request }
    const cancelled = Promise.withResolvers<undefined>()
    const cancel = (): void => {
      if (this.probe?.signal === signal) this.probe = undefined
      cancelled.resolve(undefined)
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await Promise.race([request.promise, cancelled.promise])
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  /**
   * Request positive draft-absence evidence from the same still-connected browser.
   * @param signal - shutdown inspection deadline.
   * @returns only nominated identities the browser confirmed.
   */
  async checkUnusedBlanks(signal: AbortSignal): Promise<readonly SessionId[]> {
    if (this.shuttingDown) return []
    this.shuttingDown = true
    const owner = this.owner
    const probe = this.probe
    if (owner === undefined || probe?.peer !== owner.peer || this.newBlanks.size === 0) return []
    const lifetime = AbortSignal.any([signal, owner.signal, probe.signal])
    if (lifetime.aborted) return []
    const answer = Promise.withResolvers<readonly SessionId[]>()
    const cancel = (): void => { answer.resolve([]) }
    this.answerUnused = answer.resolve
    lifetime.addEventListener('abort', cancel, { once: true })
    try {
      const sessionIds = [...this.newBlanks]
      const nominated = new Set(sessionIds)
      probe.request.resolve(sessionIds)
      return [...new Set(await answer.promise)].filter(id => nominated.has(id) && this.canClean(id))
    } finally {
      lifetime.removeEventListener('abort', cancel)
      this.answerUnused = undefined
    }
  }

  /**
   * Accept a draft check delivered on the challenged control stream.
   * @param sessionIds - nominated identities with known-empty browser state.
   * @param signal - the replying stream's cancellation identity.
   */
  reportUnusedBlanks(sessionIds: readonly SessionId[], signal: AbortSignal): void {
    if (this.probe?.signal === signal && !signal.aborted) this.answerUnused?.(sessionIds)
  }

  private baseline(): SessionControlBaseline {
    const sessions = this.ctx.sessions.list()
    return {
      projections: this.projectionBaseline(sessions),
    }
  }

  private projectionBaseline(
    sessions: readonly Session[],
  ): Readonly<Record<SessionId, SessionProjectionBaseline>> {
    const blocks = Object.create(null) as Record<SessionId, SessionProjectionBaseline>
    for (const session of sessions) {
      const snapshot = this.ctx.sessionProjections.snapshot(session)
      blocks[session.id] = {
        asOfSeq: snapshot.asOfSeq,
        // Every projection definition validates its value before snapshot publication.
        values: snapshot.values as SessionProjectionValues,
      }
    }
    return blocks
  }

  private broadcast(frame: SessionControlFrame): void {
    for (const stream of this.streams) stream.push(frame)
  }
}

class ControlQueue {
  private readonly buffer = new Deque<SessionControlFrame>()
  private wake: (() => void) | undefined
  private done = false

  push(frame: SessionControlFrame): void {
    if (this.done) return
    this.buffer.pushBack(frame)
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  end(): void {
    if (this.done) return
    this.done = true
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }

  async *iterate(signal: AbortSignal): AsyncIterable<SessionControlFrame> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!this.done && !signal.aborted) {
        const frame = this.buffer.popFront()
        if (frame !== undefined) {
          yield frame
          continue
        }
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
      while (this.buffer.size > 0 && !signal.aborted) yield this.buffer.popFront() as SessionControlFrame
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.end()
    }
  }
}
