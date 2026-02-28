import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'
import { appRouter } from './trpc/router'

const app = new Hono()

type BunRuntime = {
  serve(options: {
    fetch: typeof app.fetch
    port: number
  }): { port: number }
}

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

console.log(`Backend listening on http://localhost:${server.port}`)
