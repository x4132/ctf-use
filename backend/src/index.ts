import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'
import { appRouter } from './trpc/router'

type HonoEnv = {
  Variables: {
    requestId: string
  }
}

const app = new Hono<HonoEnv>()

type BunRuntime = {
  serve(options: {
    fetch: typeof app.fetch
    port: number
  }): { port: number }
}

// HTTP request logging middleware
app.use('*', async (c, next) => {
  const start = performance.now()
  const requestId = crypto.randomUUID()
  c.set('requestId', requestId)

  await next()

  const durationMs = Math.round(performance.now() - start)
  console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${durationMs}ms`)
})

app.get('/', (c) =>
  c.json({
    service: 'backend',
    status: 'ok',
    trpc: '/trpc',
  }),
)

app.use(
  '/trpc/*',
  trpcServer({
    router: appRouter,
  }),
)

const bunRuntime = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun

if (!bunRuntime) {
  throw new Error('Bun runtime is required to run the backend.')
}

const requestedPort = Number(process.env.PORT ?? 3001)
const port = Number.isFinite(requestedPort) ? requestedPort : 3001

const server = bunRuntime.serve({
  fetch: app.fetch,
  port,
})

console.log(`Backend listening on port ${server.port}`)
