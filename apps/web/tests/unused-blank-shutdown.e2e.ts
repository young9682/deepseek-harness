/** Graceful shutdown reclaims untouched Sessions after the browser checks its drafts. */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { chromium, type WebSocketRoute } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

it('reuses a draft across Workspace switches and removes only the empty Session at shutdown', async () => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  for (const name of ['Draft workspace', 'Empty workspace']) {
    const cwd = join(scaffold.workspaceCwd, name)
    await mkdir(cwd)
    await scaffold.ctx.workspaceRegistry.create(cwd, name)
  }

  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const connections: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  await page.routeWebSocket('**/api/remote.mux', (client) => {
    connections.push({ client, server: client.connectToServer() })
  })
  await page.goto(scaffold.authenticatedUrl)
  const input = page.locator('[data-composer-input]')
  const openBlank = async (name: string): Promise<SessionId> => {
    const row = page.locator('[data-row-key^="workspace:"]').filter({ hasText: name })
    await row.hover()
    const response = page.waitForResponse('**/api/session/create')
    await row.getByRole('button', { name: `New session in ${name}`, exact: true }).click()
    const { result } = await (await response).json() as { result: { ok: boolean; value: { sessionId: SessionId } } }
    expect(result.ok).toBe(true)
    await page.locator(`[data-conversation-session="${result.value.sessionId}"]`).waitFor()
    await input.waitFor()
    return result.value.sessionId
  }

  const draft = await openBlank('Draft workspace')
  await input.fill('Keep this draft.')
  const unused = await openBlank('Empty workspace')
  expect(await openBlank('Draft workspace')).toBe(draft)
  await expect.poll(() => input.textContent()).toBe('Keep this draft.')
  expect(await openBlank('Empty workspace')).toBe(unused)
  expect(await scaffold.ctx.sessionPersistence.stat(unused)).toBeDefined()

  await scaffold.ctx.parallel('app/before-shutdown', AbortSignal.timeout(5_000))
  expect(await scaffold.ctx.sessionPersistence.stat(unused)).toBeUndefined()
  expect(await scaffold.ctx.sessionPersistence.stat(draft)).toBeDefined()
  expect(await page.evaluate(id => localStorage.getItem(`dsh.conversation.${id}`), draft)).toContain('Keep this draft.')

  expect(await page.evaluate(() => document.documentElement.inert)).toBe(true)
  const connection = connections.at(-1)
  if (connection === undefined) throw new Error('Missing the browser Remote connection')
  await Promise.all([
    connection.client.close({ code: 1012, reason: 'test Host reconnect' }),
    connection.server.close({ code: 1012, reason: 'test Host reconnect' }),
  ])
  await expect.poll(() => page.evaluate(() => document.documentElement.inert), { timeout: 20_000 }).toBe(false)
  expect(await openBlank('Draft workspace')).toBe(draft)
  await expect.poll(() => input.textContent()).toBe('Keep this draft.')
})
