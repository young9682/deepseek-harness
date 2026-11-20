/** Graceful shutdown reclaims untouched Sessions after the browser checks its drafts. */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { chromium, type WebSocketRoute } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

it('only cleans a confirmed empty Session and preserves drafts and unknown browser state', async () => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  const createWorkspace = async (name: string): Promise<WorkspaceId> => {
    const cwd = join(scaffold.workspaceCwd, name)
    await mkdir(cwd)
    return (await scaffold.ctx.workspaceRegistry.create(cwd, name)).id
  }
  await createWorkspace('Draft workspace')

  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  onTestFailed(() => saveFailureShot(page, 'unused-blank-shutdown'))
  const connections: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  await page.routeWebSocket('**/api/remote.mux', (client) => {
    connections.push({ client, server: client.connectToServer() })
  })
  await page.goto(scaffold.authenticatedUrl)
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  const selected = (): Promise<SessionId | undefined> => page.evaluate(() => {
    const raw = localStorage.getItem('dsh.sessions.current')
    if (raw === null) return undefined
    return (JSON.parse(raw) as { sessionId?: SessionId }).sessionId
  })
  await expect.poll(selected, { timeout: 20_000 }).toMatch(/^session-/u)
  await input.waitFor()
  const storedDraft = (id: SessionId): Promise<string | null> =>
    page.evaluate(sessionId => localStorage.getItem(`dsh.conversation.${sessionId}`), id)
  // This browser owns all three Sessions. Acquire the two background blanks
  // through the authenticated browser RPC without moving the active editor.
  const createBlank = (workspaceId: WorkspaceId): Promise<SessionId> => page.evaluate(async ({ id, rpcId }) => {
    const response = await fetch('/api/session/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId, method: 'session/create',
        payload: { args: { request: { workspaceId: id } } },
      }),
    })
    const { result } = await response.json() as {
      result: { ok: true; value: { sessionId: SessionId } } | { ok: false; error: { message: string } }
    }
    if (!result.ok) throw new Error(result.error.message)
    return result.value.sessionId
  }, { id: workspaceId, rpcId: randomUUID() })

  const draft = await selected()
  if (draft === undefined) throw new Error('The active blank Session is missing')
  await input.fill('Keep this draft.')
  await expect.poll(() => storedDraft(draft), { timeout: 10_000 }).toContain('Keep this draft.')
  const unknown = await createBlank(await createWorkspace('Unknown workspace'))
  const unused = await createBlank(await createWorkspace('Empty workspace'))
  expect(await scaffold.ctx.sessionPersistence.stat(unused)).toBeDefined()
  const damaged = 'unreadable-draft-record'
  await page.evaluate(({ id, value }) => { localStorage.setItem(`dsh.conversation.${id}`, value) }, { id: unknown, value: damaged })

  await scaffold.ctx.parallel('app/before-shutdown', AbortSignal.timeout(5_000))
  expect(await scaffold.ctx.sessionPersistence.stat(unused)).toBeUndefined()
  expect(await scaffold.ctx.sessionPersistence.stat(draft)).toBeDefined()
  expect(await scaffold.ctx.sessionPersistence.stat(unknown)).toBeDefined()
  expect(await storedDraft(draft)).toContain('Keep this draft.')
  expect(await storedDraft(unknown)).toBe(damaged)

  expect(await page.evaluate(() => document.documentElement.inert)).toBe(true)
  const connection = connections.at(-1)
  if (connection === undefined) throw new Error('Missing the browser Remote connection')
  await Promise.all([
    connection.client.close({ code: 1012, reason: 'test Host reconnect' }),
    connection.server.close({ code: 1012, reason: 'test Host reconnect' }),
  ])
  await expect.poll(() => page.evaluate(() => document.documentElement.inert), { timeout: 20_000 }).toBe(false)
  expect(await selected()).toBe(draft)
  await expect.poll(() => input.textContent()).toBe('Keep this draft.')
})
