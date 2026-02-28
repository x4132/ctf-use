import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { TaskPool } from '../browser/pool.js'

const t = initTRPC.create()

const pool = new TaskPool()

const browserRouter = t.router({
  runTask: t.procedure
    .input(
      z.object({
        prompt: z.string().min(1),
        model: z.enum(['bu-mini', 'bu-max']).optional(),
        sessionId: z.string().optional(),
        keepAlive: z.boolean().optional(),
        maxCostUsd: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { prompt, ...options } = input
      const task = await pool.run(prompt, options)
      return {
        id: task.id,
        sessionId: task.sessionId,
        status: task.status,
        output: task.output,
        error: task.error,
        signals: task.signals,
        cost: task.cost,
        liveUrl: task.liveUrl,
      }
    }),

  poolStatus: t.procedure.query(() => {
    const tasks = pool.getAllTasks()
    return {
      activeCount: pool.activeCount,
      available: pool.available,
      totalTracked: tasks.length,
      signals: pool.getSignals(),
      tasks: tasks.map((t) => ({
        id: t.id,
        status: t.status,
        prompt: t.prompt.slice(0, 200),
        cost: t.cost,
        signalCount: t.signals.length,
      })),
    }
  }),

  stopSession: t.procedure
    .input(
      z.object({
        sessionId: z.string(),
        strategy: z.enum(['task', 'session']).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await pool.stopSession(input.sessionId, input.strategy ?? 'session')
      return { ok: true }
    }),
})

function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/)
  return match ? match[0] : null
}

const chatRouter = t.router({
  send: t.procedure
    .input(
      z.object({
        message: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const url = extractUrl(input.message)

      // TODO: Replace with actual LLM call
      const content = url
        ? `Received target URL: ${url}. I'll analyze this for web exploitation vulnerabilities. (Placeholder — LLM integration coming soon.)`
        : `Please provide a URL for me to analyze. (Placeholder response.)`

      return {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content,
      }
    }),
})

export const appRouter = t.router({
  health: t.procedure.query(() => ({
    status: 'ok',
    now: new Date().toISOString(),
  })),
  hello: t.procedure
    .input(
      z
        .object({
          name: z.string().min(1).optional(),
        })
        .optional(),
    )
    .query(({ input }) => ({
      message: `Hello ${input?.name ?? 'world'}!`,
    })),
  browser: browserRouter,
  chat: chatRouter,
})

export type AppRouter = typeof appRouter
