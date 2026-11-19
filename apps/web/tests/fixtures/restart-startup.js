/** Hold one Host service until the restart test releases application startup. */
export const name = 'web-restart-startup'

/** Keep the carrier services available while Session Controller startup is held. */
export const inject = ['typertGateway', 'connection', 'webServer', 'appExit']

/**
 * Provide the test-only dependency after startup has been released.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @returns {Promise<void>} Once the barrier is released or the plugin is disposed.
 */
export async function apply(ctx) {
  const exit = ctx.get('appExit')
  if (typeof process.send !== 'function' || exit === undefined) {
    throw new Error('web restart fixture requires an IPC channel and application exit')
  }
  const stop = (message) => {
    if (message === 'shutdown') exit(0)
  }
  ctx.effect(() => {
    process.on('message', stop)
    return () => { process.off('message', stop) }
  }, 'web-restart: graceful exit')
  if (process.env.DSH_WEB_RESTART_HOLD_STARTUP === '1') {
    const released = Promise.withResolvers()
    const resume = (message) => {
      if (message === 'resume-startup') released.resolve(true)
    }
    ctx.effect(() => {
      process.on('message', resume)
      return () => {
        process.off('message', resume)
        released.resolve(false)
      }
    }, 'web-restart: startup barrier')
    process.send('startup-blocked')
    if (!await released.promise) return
  }
  ctx.reflect.provide('webRestartReady', {})
}
