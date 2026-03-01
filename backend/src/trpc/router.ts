import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { SecurityAgent } from '../agent/agent.js'
import { getConvexClient, api } from '../convex.js'
import type { Id } from '../../../convex/_generated/dataModel.js'

const t = initTRPC.create()

// In-memory agent registry
const agents = new Map<string, SecurityAgent>()

const agentRouter = t.router({
  investigate: t.procedure
    .input(
      z.object({
        chatId: z.string(),
        targetUrl: z.string().url(),
        goal: z.string().min(1),
        context: z.string().optional(),
        model: z.string().optional(),
        maxSteps: z.number().int().positive().optional(),
        mcpServers: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const agent = new SecurityAgent({
        chatId: input.chatId,
        model: input.model,
      })
      agents.set(agent.id, agent)

      // Create investigation document in Convex
      const convex = getConvexClient()
      await convex.mutation(api.investigations.create, {
        chatId: input.chatId as Id<"chats">,
        agentId: agent.id,
      })

      // Start investigation in the background
      const promise = agent.investigate({
        targetUrl: input.targetUrl,
        goal: input.goal,
        context: input.context,
        model: input.model,
        maxSteps: input.maxSteps,
        mcpServers: input.mcpServers,
      })

      // Self-clean on completion — agent writes terminal state to Convex
      promise.then(() => {
        agents.delete(agent.id)
      }).catch(() => {
        agents.delete(agent.id)
      })

      return {
        agentId: agent.id,
        status: 'running' as const,
      }
    }),

  stop: t.procedure
    .input(z.object({ agentId: z.string() }))
    .mutation(({ input }) => {
      const agent = agents.get(input.agentId)
      if (!agent) return { ok: false, error: 'Agent not found' }
      agent.stop()
      return { ok: true, error: null }
    }),

  destroy: t.procedure
    .input(z.object({ agentId: z.string() }))
    .mutation(({ input }) => {
      const agent = agents.get(input.agentId)
      if (!agent) return { ok: false, error: 'Agent not found' }
      agent.destroy()
      agents.delete(input.agentId)
      return { ok: true, error: null }
    }),

  list: t.procedure.query(() => {
    const entries: Array<{
      agentId: string
      status: string
      stepsUsed: number
      signalCount: number
    }> = []
    for (const [id, agent] of agents) {
      const result = agent.getResult()
      entries.push({
        agentId: id,
        status: result?.status ?? 'running',
        stepsUsed: result?.stepsUsed ?? 0,
        signalCount: result?.signals.length ?? 0,
      })
    }
    return { agents: entries }
  }),
})

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

function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]+/)
  return match ? match[0] : null
}

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
  agent: agentRouter,
  chat: chatRouter,
})

export type AppRouter = typeof appRouter
