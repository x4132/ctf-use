import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { createSandbox, reconnectToSandbox, createOpenCodeSession, resumeOrCreateOpenCodeSession, buildRules, deleteSandboxById, stopSandboxById } from "../agent/index.js";
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

async function getOrCreateChatSession(
  chatId: string,
  onStatus?: (status: string) => void,
): Promise<ChatSession> {
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
    let reconnected = false;
    if (chat?.sandboxId) {
      try {
        onStatus?.("Reconnecting to sandbox...");
        sandbox = await reconnectToSandbox(chat.sandboxId, chatId, onStatus);
        reconnected = true;
      } catch (err) {
        console.warn(`[${chatId}] Failed to reconnect to sandbox ${chat.sandboxId}, creating new:`, err);
      }
    }

    if (!sandbox) {
      console.log(`[${chatId}] Creating new sandbox`);
      sandbox = await createSandbox(chatId, undefined, onStatus);

      // Persist sandbox ID so it survives backend restarts
      await convex.mutation(api.chats.setSandboxId, {
        chatId: chatId as Id<"chats">,
        sandboxId: sandbox.sandbox.id,
      });
      console.log(`[${chatId}] Sandbox ID ${sandbox.sandbox.id} persisted`);
    }

    onStatus?.("Starting session...");
    const session = reconnected
      ? await resumeOrCreateOpenCodeSession(sandbox.baseUrl, chatId)
      : await createOpenCodeSession(sandbox.baseUrl, chatId);

    onStatus?.("Sandbox active");

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

      // Mark chat as running immediately
      convex.mutation(api.chats.setIsRunning, {
        chatId,
        isRunning: true,
      }).catch((err) => {
        console.error(`[${input.chatId}] Failed to set isRunning:`, err);
      });

      // Status updater — writes to the chat's status field in Convex
      const setStatus = (status: string) => {
        convex.mutation(api.chats.setStatus, {
          chatId,
          status,
        }).catch((err) => {
          console.error(`[${input.chatId}] Failed to set status:`, err);
        });
      };

      const clearRunning = () => {
        convex.mutation(api.chats.setIsRunning, {
          chatId,
          isRunning: false,
        }).catch((err) => {
          console.error(`[${input.chatId}] Failed to clear isRunning:`, err);
        });
      };

      // Get or bootstrap sandbox + session
      let chatSession: ChatSession;
      try {
        chatSession = await getOrCreateChatSession(input.chatId, setStatus);
      } catch (err) {
        console.error(`[${input.chatId}] Failed to initialize sandbox:`, err);
        const errMsg = err instanceof Error ? err.message : (typeof err === "string" ? err : JSON.stringify(err));
        setStatus(`Failed to start sandbox: ${errMsg}`);
        clearRunning();
        return { ok: false as const };
      }

      // Clear sandboxStopped flag if it was set (auto-started by sending a message)
      convex.mutation(api.chats.setSandboxStopped, {
        chatId,
        sandboxStopped: false,
      }).catch((err) => {
        console.error(`[${input.chatId}] Failed to clear sandboxStopped:`, err);
      });

      // Check if this is the first user message — if so, prepend system prompt
      const existingMessages = await convex.query(api.messages.listByChat, { chatId });
      const priorUserMessages = existingMessages.filter(
        (m) => m.role === "user" && m._id !== undefined,
      );
      // Only the message we just created above exists → this is the first prompt
      const isFirstMessage = priorUserMessages.length <= 1;
      const prompt = isFirstMessage
        ? `${buildRules()}\n\n---\n\n${input.message}`
        : input.message;

      // Send prompt in background — events stream to Convex inside session.sendMessage()
      chatSession.session.sendMessage(prompt)
        .then(() => {
          clearRunning();
        })
        .catch(async (err) => {
          console.error(`[${input.chatId}] sendMessage failed:`, err);
          const errMsg = err instanceof Error ? err.message : (typeof err === "string" ? err : JSON.stringify(err));
          setStatus(`Error: ${errMsg}`);
          clearRunning();
        });

      return { ok: true as const };
    }),

  stop: loggedProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const chatSession = chatSessions.get(input.chatId);
      if (chatSession) {
        await chatSession.session.abort();
      }

      const convex = getConvexClient();
      await convex.mutation(api.chats.setIsRunning, {
        chatId: input.chatId as Id<"chats">,
        isRunning: false,
      });

      return { ok: true };
    }),

  stopSandbox: loggedProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const convex = getConvexClient();
      const chatId = input.chatId as Id<"chats">;

      // Abort OpenCode session if running
      const chatSession = chatSessions.get(input.chatId);
      if (chatSession) {
        try { await chatSession.session.abort(); } catch { /* best-effort */ }
      }

      // Clear in-memory session (sandbox will be stopped, so the session is invalid)
      chatSessions.delete(input.chatId);

      // Look up sandbox ID from Convex and stop it
      const chat = await convex.query(api.chats.get, { chatId });
      if (chat?.sandboxId) {
        await stopSandboxById(chat.sandboxId);
      }

      // Update Convex state
      await Promise.all([
        convex.mutation(api.chats.setSandboxStopped, { chatId, sandboxStopped: true }),
        convex.mutation(api.chats.setIsRunning, { chatId, isRunning: false }),
        convex.mutation(api.chats.setStatus, { chatId, status: "Sandbox stopped" }),
      ]);

      return { ok: true };
    }),

  startSandbox: loggedProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const convex = getConvexClient();
      const chatId = input.chatId as Id<"chats">;

      const setStatus = (status: string) => {
        convex.mutation(api.chats.setStatus, { chatId, status }).catch((err) => {
          console.error(`[${input.chatId}] Failed to set status:`, err);
        });
      };

      setStatus("Starting sandbox...");

      try {
        await getOrCreateChatSession(input.chatId, setStatus);
      } catch (err) {
        console.error(`[${input.chatId}] Failed to start sandbox:`, err);
        const errMsg = err instanceof Error ? err.message : (typeof err === "string" ? err : JSON.stringify(err));
        await convex.mutation(api.chats.setStatus, {
          chatId,
          status: `Failed to start sandbox: ${errMsg}`,
        });
        throw err;
      }

      // Clear the stopped flag and update status
      await Promise.all([
        convex.mutation(api.chats.setSandboxStopped, { chatId, sandboxStopped: false }),
        convex.mutation(api.chats.setStatus, { chatId, status: "Sandbox active" }),
      ]);

      return { ok: true };
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
