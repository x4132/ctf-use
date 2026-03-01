import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { createSandbox, reconnectToSandbox, createOpenCodeSession, buildRules, deleteSandboxById } from "../agent/index.js";
import type { SandboxHandle, OpenCodeSession } from "../agent/index.js";
import { getConvexClient, api } from "../convex.js";
import type { Id } from "../../../convex/_generated/dataModel.js";

const t = initTRPC.create();

const loggedProcedure = t.procedure.use(async (opts) => {
  const start = performance.now();
  const result = await opts.next();
  const durationMs = Math.round(performance.now() - start);

  const meta = {
    path: opts.path,
    type: opts.type,
    durationMs,
    ok: result.ok,
  };

  if (result.ok) {
    console.log(`tRPC ${meta.type} ${meta.path} ${meta.durationMs}ms`);
  } else {
    console.error(`tRPC ${meta.type} ${meta.path} ${meta.durationMs}ms FAILED`, result.error);
  }

  return result;
});

// In-memory registry: one sandbox + opencode session per chat
interface ChatSession {
  sandbox: SandboxHandle;
  session: OpenCodeSession;
}

const chatSessions = new Map<string, ChatSession>();
const chatInitializing = new Map<string, Promise<ChatSession>>();

async function getOrCreateChatSession(chatId: string): Promise<ChatSession> {
  const existing = chatSessions.get(chatId);
  if (existing) return existing;

  // Deduplicate concurrent initializations
  const inFlight = chatInitializing.get(chatId);
  if (inFlight) return inFlight;

  const initPromise = (async (): Promise<ChatSession> => {
    const convex = getConvexClient();

    // Check Convex for an existing sandbox to reconnect to
    const chat = await convex.query(api.chats.get, {
      chatId: chatId as Id<"chats">,
    });

    let sandbox;
    if (chat?.sandboxId) {
      try {
        sandbox = await reconnectToSandbox(chat.sandboxId, chatId);
      } catch (err) {
        console.warn(`[${chatId}] Failed to reconnect to sandbox ${chat.sandboxId}, creating new:`, err);
      }
    }

    if (!sandbox) {
      console.log(`[${chatId}] Creating new sandbox`);
      const rules = buildRules();
      sandbox = await createSandbox(chatId, rules);

      // Persist sandbox ID so it survives backend restarts
      await convex.mutation(api.chats.setSandboxId, {
        chatId: chatId as Id<"chats">,
        sandboxId: sandbox.sandbox.id,
      });
      console.log(`[${chatId}] Sandbox ID ${sandbox.sandbox.id} persisted`);
    }

    const session = await createOpenCodeSession(sandbox.baseUrl, chatId);

    const chatSession: ChatSession = { sandbox, session };
    chatSessions.set(chatId, chatSession);
    chatInitializing.delete(chatId);
    return chatSession;
  })();

  chatInitializing.set(chatId, initPromise);

  try {
    return await initPromise;
  } catch (err) {
    chatInitializing.delete(chatId);
    throw err;
  }
}

const chatRouter = t.router({
  send: loggedProcedure
    .input(
      z.object({
        chatId: z.string().min(1),
        message: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const convex = getConvexClient();
      const chatId = input.chatId as Id<"chats">;

      // Persist user message to Convex (moved from frontend to backend for SDK-layer separation)
      await convex.mutation(api.messages.create, {
        chatId,
        role: "user" as const,
        content: input.message,
        kind: "message" as const,
      });

      // Post status if this is the first message (no session yet)
      const isNew = !chatSessions.has(input.chatId) && !chatInitializing.has(input.chatId);
      if (isNew) {
        await convex.mutation(api.messages.create, {
          chatId,
          role: "assistant" as const,
          content: "Starting sandbox...",
          kind: "status" as const,
        });
      }

      // Get or bootstrap sandbox + session
      let chatSession: ChatSession;
      try {
        chatSession = await getOrCreateChatSession(input.chatId);
      } catch (err) {
        console.error(`[${input.chatId}] Failed to initialize sandbox:`, err);
        await convex.mutation(api.messages.create, {
          chatId,
          role: "assistant" as const,
          content: `Failed to start sandbox: ${err instanceof Error ? err.message : String(err)}`,
          kind: "status" as const,
        });
        return { ok: false as const };
      }

      // Send prompt in background — events stream to Convex inside session.sendMessage()
      chatSession.session.sendMessage(input.message).catch(async (err) => {
        console.error(`[${input.chatId}] sendMessage failed:`, err);
        await convex.mutation(api.messages.create, {
          chatId,
          role: "assistant" as const,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          kind: "status" as const,
        });
      });

      return { ok: true as const };
    }),

  destroy: loggedProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      // Clear in-memory session if present
      chatSessions.delete(input.chatId);

      // Always look up sandbox ID from Convex (single source of truth)
      const convex = getConvexClient();
      const chat = await convex.query(api.chats.get, {
        chatId: input.chatId as Id<"chats">,
      });
      if (chat?.sandboxId) {
        try {
          await deleteSandboxById(chat.sandboxId);
          console.log(`[${input.chatId}] Sandbox ${chat.sandboxId} deleted`);
        } catch (err) {
          console.error(`[${input.chatId}] Failed to delete sandbox ${chat.sandboxId}:`, err);
        }
      }
      return { ok: true };
    }),
});

export const appRouter = t.router({
  health: loggedProcedure.query(() => ({
    status: "ok",
    now: new Date().toISOString(),
  })),
  chat: chatRouter,
});

export type AppRouter = typeof appRouter;
