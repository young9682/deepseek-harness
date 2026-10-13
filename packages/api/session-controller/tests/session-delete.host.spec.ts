/**
 * `session.delete` orchestration: the refusal ladder, and the order that keeps
 * a removed Session's files from coming back.
 *
 * The live-Agent teardown is injected here rather than composed: what matters
 * at this layer is that the command asks for it, that it happens before the
 * stored log is removed, and that a failure to obtain it is reported instead
 * of leaving a half-deleted Session.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, vi } from 'vitest'
import { ApiSessionAgentController } from '../src/agent.ts'
import { SessionCommandController } from '../src/commands.ts'
import { installSessionReadTestServices } from './test-remote.ts'

const sid = (id: string): SessionId => id as SessionId

/** One recorded effect of a delete, in the order the command performed it. */
interface DeleteHarness {
  readonly ctx: Context
  readonly controller: SessionCommandController
  readonly order: string[]
  readonly persistenceDelete: ReturnType<typeof vi.fn>
  readonly checkpointDelete: ReturnType<typeof vi.fn>
  readonly forgetSession: ReturnType<typeof vi.fn>
  readonly disposeLive: ReturnType<typeof vi.fn>
  readonly removed: SessionId[]
  readonly stops: SessionId[]
  /** Overrides applied to the injected doubles before the command runs. */
  readonly doubles: {
    archived: Set<SessionId>
    activity: readonly SessionActivity[]
    live: Map<SessionId, Agent>
    disposeLive: (sessionId: SessionId) => Promise<boolean>
  }
}

async function harness(): Promise<DeleteHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  // The Agent controller registers its Typert lookups on construction; this
  // layer is not what those lookups serve.
  ctx.provide('typert', {
    lookups: { configure: () => {} },
    contexts: { configureHost: () => {} },
  } as never)

  const order: string[] = []
  const removed: SessionId[] = []
  const stops: SessionId[] = []
  const doubles: DeleteHarness['doubles'] = {
    archived: new Set(),
    activity: [],
    live: new Map(),
    disposeLive: async () => true,
  }

  const persistenceDelete = vi.fn(async (id: SessionId) => { order.push(`persistence.delete:${id}`) })
  ctx.provide('sessionPersistence', {
    list: async () => [],
    open: () => { throw new Error('event bodies must not be opened') },
    stat: async () => undefined,
    delete: persistenceDelete,
  } as never)
  const checkpointDelete = vi.fn(async () => { order.push('checkpoint.delete') })
  ctx.provide('sessionProjectionCache', { delete: checkpointDelete } as never)

  const forgetSession = vi.fn(async (id: SessionId) => { order.push(`forgetSession:${id}`) })
  ctx.provide('workspaceRegistry', {
    isArchived: (id: SessionId) => doubles.archived.has(id),
    sessionActivity: async () => doubles.activity,
    forgetSession,
  } as never)

  ctx.on('workspace/session-stop', ({ sessionId }: { sessionId: SessionId }) => { stops.push(sessionId) })
  // A removed Session's own row is announced as its teardown falls out; the
  // command announce is what covers a Session that was never live.
  ctx.on('api-session/removed', (id: SessionId) => { removed.push(id) })

  const agents = new ApiSessionAgentController(ctx)
  const disposeLive = vi.fn(async (id: SessionId) => {
    order.push(`disposeLive:${id}`)
    return await doubles.disposeLive(id)
  })
  Object.assign(agents, { disposeLive })

  const controller = new SessionCommandController(ctx, agents, '/default-workspace')
  return {
    ctx,
    controller,
    order,
    persistenceDelete,
    checkpointDelete,
    forgetSession,
    disposeLive,
    removed,
    stops,
    doubles,
  }
}

/** A live Session, as the API host would have it after opening its history. */
function liveSession(b: DeleteHarness, id: string): Session {
  const session = b.ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  const agent = {} as Agent
  Object.assign(agent, { id: session.id, session, status: 'idle', ctx: b.ctx })
  b.doubles.live.set(sid(id), agent)
  return session
}

describe('session.delete refusals', () => {
  it('refuses an archived Session and changes nothing', async () => {
    const b = await harness()
    liveSession(b, 'archived')
    b.doubles.archived.add(sid('archived'))

    await expect(b.controller.delete({ sessionId: sid('archived') })).rejects.toMatchObject({
      code: 'session/archived',
    })
    expect(b.order).toEqual([])
    expect(b.persistenceDelete).not.toHaveBeenCalled()
    await b.ctx.fiber.dispose()
  })

  it('refuses a running Session as session/active with the reported work, unless stopActivity is set', async () => {
    const b = await harness()
    const session = liveSession(b, 'busy')
    b.doubles.activity = [{ kind: 'job', items: [{ id: 'job-1', label: 'build' }] }]

    await expect(b.controller.delete({ sessionId: sid('busy') })).rejects.toMatchObject({
      code: 'session/active',
      details: { sessionId: 'busy', activity: [{ kind: 'job', items: [{ id: 'job-1', label: 'build' }] }] },
    })
    // Nothing was stopped and nothing was removed on the refusal.
    expect(b.stops).toEqual([])
    expect(b.order).toEqual([])
    expect(b.ctx.sessions.get(session.id)).toBe(session)

    await b.controller.delete({ sessionId: sid('busy'), stopActivity: true })
    expect(b.stops).toEqual(['busy'])
    expect(b.persistenceDelete).toHaveBeenCalledWith(sid('busy'))
    await b.ctx.fiber.dispose()
  })

  it('refuses a live Session whose Agent another owner holds, without touching the log', async () => {
    const b = await harness()
    liveSession(b, 'elsewhere')
    b.doubles.disposeLive = async () => false

    await expect(b.controller.delete({ sessionId: sid('elsewhere') })).rejects.toMatchObject({
      code: 'session/delete-unavailable',
    })
    expect(b.persistenceDelete).not.toHaveBeenCalled()
    // The row is still announced as gone: the client must not keep it.
    expect(b.removed).toEqual([])
    await b.ctx.fiber.dispose()
  })
})

describe('session.delete ordering', () => {
  it('tears the Agent down before removing the log, then clears metadata and announces', async () => {
    const b = await harness()
    liveSession(b, 'doomed')

    await expect(b.controller.delete({ sessionId: sid('doomed') })).resolves.toEqual({ deleted: true })

    // Teardown precedes removal: an open write handle behind the log would
    // recreate the files this command is about to remove.
    expect(b.order).toEqual([
      'disposeLive:doomed',
      'persistence.delete:doomed',
      'checkpoint.delete',
      'forgetSession:doomed',
    ])
    expect(b.doubles.live.size).toBe(1)
    // Teardown owns the announcement: the command must not announce a removal
    // the disposal already reported through `session/disposed`.
    expect(b.removed).toEqual([])
    await b.ctx.fiber.dispose()
  })

  it('announces a Session that was never live, which emits no session/disposed', async () => {
    const b = await harness()
    b.doubles.disposeLive = async () => false

    await expect(b.controller.delete({ sessionId: sid('cold') })).resolves.toEqual({ deleted: true })

    expect(b.persistenceDelete).toHaveBeenCalledWith(sid('cold'))
    expect(b.removed).toEqual(['cold'])
    await b.ctx.fiber.dispose()
  })

  it('tolerates a composition without a projection cache', async () => {
    // The cache is optional: a deployment without one still deletes cleanly.
    const without = new Context()
    await without.plugin(SessionStore)
    await without.plugin(AgentRegistry)
    installSessionReadTestServices(without)
    without.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      saveSelection: () => Promise.resolve(),
    } as never)
    without.provide('typert', {
      lookups: { configure: () => {} },
      contexts: { configureHost: () => {} },
    } as never)
    const persistenceDelete = vi.fn()
    without.provide('sessionPersistence', { list: async () => [], delete: persistenceDelete } as never)
    without.provide('workspaceRegistry', {
      isArchived: () => false,
      sessionActivity: async () => [],
      forgetSession: async () => {},
    } as never)
    const agents = new ApiSessionAgentController(without)
    Object.assign(agents, { disposeLive: async () => false })
    const controller = new SessionCommandController(without, agents, '/default-workspace')

    await expect(controller.delete({ sessionId: sid('no-cache') })).resolves.toEqual({ deleted: true })
    expect(persistenceDelete).toHaveBeenCalledWith(sid('no-cache'))
    await without.fiber.dispose()
  })
})

describe('session.delete failure reporting', () => {
  it('reports a persistence corruption instead of claiming success', async () => {
    const b = await harness()
    liveSession(b, 'corrupt')
    b.persistenceDelete.mockRejectedValueOnce(new Error('directory is not removable'))

    await expect(b.controller.delete({ sessionId: sid('corrupt') })).rejects.toMatchObject({
      code: 'gateway/internal',
    })
    // The later steps did not run against a Session whose files survived.
    expect(b.checkpointDelete).not.toHaveBeenCalled()
    await b.ctx.fiber.dispose()
  })
})
