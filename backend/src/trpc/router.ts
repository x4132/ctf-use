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
})

export type AppRouter = typeof appRouter
