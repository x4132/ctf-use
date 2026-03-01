import { initTRPC } from '@trpc/server'
import { z } from 'zod'
import { SecurityAgent } from '../agent/agent.js'
import type { InvestigationResult } from '../agent/agent.js'

const t = initTRPC.create()

// In-memory agent registry
const agents = new Map<string, SecurityAgent>()

const agentRouter = t.router({
  investigate: t.procedure
    .input(
      z.object({
        targetUrl: z.string().url(),
        goal: z.string().min(1),
        context: z.string().optional(),
        model: z.string().optional(),
        maxSteps: z.number().int().positive().optional(),
        mcpServers: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const agent = new SecurityAgent({ model: input.model })
      agents.set(agent.id, agent)

      // Start investigation in the background
      const promise = agent.investigate({
        targetUrl: input.targetUrl,
        goal: input.goal,
        context: input.context,
        model: input.model,
        maxSteps: input.maxSteps,
        mcpServers: input.mcpServers,
      })

      // Don't await — let it run. Client polls via getStatus.
      promise.then(() => {
        // Investigation complete — result is on the agent
      }).catch(() => {
        // Errors captured on the agent result
      })

      return {
        agentId: agent.id,
        status: 'running' as const,
      }
    }),

  getStatus: t.procedure
    .input(z.object({ agentId: z.string() }))
    .query(({ input }): InvestigationResult => {
      const agent = agents.get(input.agentId)
      if (!agent) {
        return {
          agentId: input.agentId,
          status: 'failed',
          output: null,
          signals: [],
          toolsCalled: [],
          stepsUsed: 0,
          activity: [],
          lastActivityAt: null,
          error: 'Agent not found',
        }
      }
      return agent.getResult() ?? {
        agentId: input.agentId,
        status: 'running',
        output: null,
        signals: [],
        toolsCalled: [],
        stepsUsed: 0,
        activity: [],
        lastActivityAt: null,
        error: null,
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
      status: InvestigationResult['status']
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
