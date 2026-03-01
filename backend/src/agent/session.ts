import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Event } from "@opencode-ai/sdk";
import { getConvexClient, api } from "../convex.js";
import type { Id } from "../../../convex/_generated/dataModel.js";

function errorToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

export interface OpenCodeSession {
  sessionId: string;
  sendMessage(text: string): Promise<void>;
  abort(): Promise<void>;
}

function buildSessionHandle(
  client: ReturnType<typeof createOpencodeClient>,
  sessionId: string,
  chatId: string,
): OpenCodeSession {
  return {
    sessionId,

    async sendMessage(text: string) {
      console.log(`[${chatId}] Sending prompt (${text.length} chars)`);

      // Subscribe to events BEFORE sending the prompt to avoid missing early events
      const eventSub = await client.event.subscribe();

      // Fire the prompt — events will stream in parallel via SSE
      const promptPromise = client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text" as const, text }],
        },
      });

      // Consume events until the prompt resolves
      await consumeEvents(
        eventSub.stream,
        sessionId,
        chatId as Id<"chats">,
        promptPromise,
      );

      // Check prompt result for errors
      const promptResult = await promptPromise as { error?: unknown; data?: unknown };
      if (promptResult?.error) {
        throw new Error(
          `OpenCode prompt failed: ${typeof promptResult.error === "string" ? promptResult.error : JSON.stringify(promptResult.error)}`,
        );
      }

      console.log(`[${chatId}] Prompt round complete`);
    },

    async abort() {
      try {
        await client.session.abort({ path: { id: sessionId } });
        console.log(`[${chatId}] Session aborted`);
      } catch {
        // best-effort
      }
    },
  };
}

export async function createOpenCodeSession(
  baseUrl: string,
  chatId: string,
): Promise<OpenCodeSession> {
  const client = createOpencodeClient({ baseUrl });

  const sessionResult = await client.session.create({
    body: { title: `hacker-use-${chatId}` },
    query: { directory: "/home/daytona" },
  });
  if (sessionResult.error) {
    console.error(`[${chatId}] opencode session.create error:`, sessionResult.error);
    throw new Error(
      `Failed to create opencode session: ${JSON.stringify(sessionResult.error)}`,
    );
  }
  const sessionId = sessionResult.data?.id;
  if (!sessionId) {
    throw new Error("Failed to create opencode session — no session ID returned");
  }
  console.log(`[${chatId}] opencode session created: ${sessionId}`);

  return buildSessionHandle(client, sessionId, chatId);
}

export async function resumeOrCreateOpenCodeSession(
  baseUrl: string,
  chatId: string,
): Promise<OpenCodeSession> {
  const client = createOpencodeClient({ baseUrl });
  const expectedTitle = `hacker-use-${chatId}`;

  try {
    const listResult = await client.session.list({
      query: { directory: "/home/daytona" },
    });

    if (listResult.data && listResult.data.length > 0) {
      const matching = listResult.data.filter(
        (s) => s.title === expectedTitle,
      );

      if (matching.length > 0) {
        const best = matching.sort(
          (a, b) => b.time.updated - a.time.updated,
        )[0];

        console.log(
          `[${chatId}] Resuming existing opencode session: ${best.id}`,
        );
        return buildSessionHandle(client, best.id, chatId);
      }
    }
  } catch (err) {
    console.warn(
      `[${chatId}] Failed to list opencode sessions, will create new:`,
      err,
    );
  }

  console.log(`[${chatId}] No existing session found, creating new`);
  return createOpenCodeSession(baseUrl, chatId);
}

async function consumeEvents(
  stream: AsyncGenerator<Event>,
  sessionId: string,
  chatId: Id<"chats">,
  promptPromise: Promise<unknown>,
): Promise<void> {
  const convex = getConvexClient();
  let done = false;
  let promptError: unknown = null;

  // Race: when the prompt resolves, mark done so we break
  promptPromise
    .then(() => { done = true; })
    .catch((err) => { promptError = err; done = true; });

  const writeError = (content: string) => {
    convex.mutation(api.messages.create, {
      chatId,
      role: "assistant" as const,
      content,
      kind: "status",
    }).catch((err) => {
      console.error(`[${chatId}] Failed to write error to Convex:`, err);
    });
  };

  // Incremental streaming: create message on first event, update on subsequent
  const partMessageIds = new Map<string, Id<"chatMessages">>();
  const partLatestContent = new Map<string, string>();
  const partCreating = new Map<string, Promise<Id<"chatMessages">>>();

  const partKinds = new Map<string, "message" | "tool" | "reasoning">();

  const handlePartUpdate = (partId: string, content: string, kind: "message" | "tool" | "reasoning") => {
    partKinds.set(partId, kind);
    partLatestContent.set(partId, content);

    const existingMsgId = partMessageIds.get(partId);
    if (existingMsgId) {
      convex.mutation(api.messages.updateContent, {
        messageId: existingMsgId,
        content,
      }).catch((err) => {
        console.error(`[${chatId}] Failed to update part in Convex:`, err);
      });
    } else if (!partCreating.has(partId)) {
      const createPromise = convex.mutation(api.messages.create, {
        chatId,
        role: "assistant" as const,
        content,
        kind,
      });
      partCreating.set(partId, createPromise);

      createPromise
        .then((msgId) => {
          partMessageIds.set(partId, msgId);
          partCreating.delete(partId);
          const latest = partLatestContent.get(partId);
          if (latest !== undefined && latest !== content) {
            handlePartUpdate(partId, latest, kind);
          }
        })
        .catch((err) => {
          console.error(`[${chatId}] Failed to create part message in Convex:`, err);
          partCreating.delete(partId);
        });
    }
  };

  // Track OpenCode message roles by messageID (from message.updated events)
  const messageRoles = new Map<string, "user" | "assistant">();

  try {
    for await (const event of stream) {
      if (done) break;

      const { type } = event;

      if (type === "session.idle") {
        const props = event.properties as { sessionID?: string };
        if (props.sessionID === sessionId) {
          break;
        }
        continue;
      }

      // Surface session-level errors to the client
      if (type === "session.error") {
        const props = event.properties as { sessionID?: string; error?: unknown };
        if (props.sessionID === sessionId) {
          const errMsg = props.error ? errorToString(props.error) : "Unknown session error";
          console.error(`[${chatId}] session.error:`, errMsg);
          writeError(`Session error: ${errMsg}`);
        }
        continue;
      }

      // Track message roles from message.updated events
      if (type === "message.updated") {
        const props = event.properties as {
          info?: { role?: string; id?: string; sessionID?: string };
        };
        const info = props.info;
        if (!info || info.sessionID !== sessionId) continue;

        if (info.id && (info.role === "user" || info.role === "assistant")) {
          messageRoles.set(info.id, info.role);
        }
        continue;
      }

      if (type === "message.part.updated") {
        const props = event.properties as {
          part?: {
            type?: string;
            text?: string;
            tool?: string;
            state?: { status?: string; input?: unknown; output?: unknown; error?: string };
            id?: string;
            messageID?: string;
          };
          delta?: string;
        };
        const part = props.part;
        if (!part) continue;

        // Skip parts belonging to user messages — only stream assistant output
        const role = part.messageID ? messageRoles.get(part.messageID) : undefined;
        if (role === "user") continue;

        if (part.type === "text") {
          const partId = part.id ?? "default";
          handlePartUpdate(partId, part.text ?? "", "message");
        } else if (part.type === "tool") {
          const partId = part.id ?? `tool-${part.tool ?? "unknown"}`;
          const toolName = part.tool ?? "unknown";
          const status = part.state?.status;

          // Map OpenCode status → AI SDK ToolPart state
          let aiState: string = "input-available";
          if (status === "completed") aiState = "output-available";
          else if (status === "error") aiState = "output-error";

          const toolData = JSON.stringify({
            toolName,
            state: aiState,
            input: part.state?.input ?? null,
            output: part.state?.output ?? null,
            errorText: part.state?.error ?? null,
          });

          handlePartUpdate(partId, toolData, "tool");

          // Extract live_url from browser-use tool outputs
          let output = part.state?.output;
          if (typeof output === "string") {
            try { output = JSON.parse(output); } catch { /* not JSON */ }
          }
          if (
            output &&
            typeof output === "object" &&
            "live_url" in (output as Record<string, unknown>)
          ) {
            const liveUrl = (output as Record<string, unknown>).live_url;
            if (typeof liveUrl === "string" && liveUrl.length > 0) {
              convex.mutation(api.chats.setLiveUrl, {
                chatId,
                liveUrl,
              }).catch((err) => {
                console.error(`[${chatId}] Failed to set liveUrl:`, err);
              });
            }
          }
        } else if (part.type === "reasoning") {
          const partId = part.id ?? "reasoning-default";
          handlePartUpdate(partId, part.text ?? "", "reasoning");
        }
      }
    }
  } finally {
    // Wait for any in-flight creates to finish
    await Promise.allSettled([...partCreating.values()]);

    // Final flush: ensure every part's latest content is persisted
    const finalWrites: Promise<unknown>[] = [];
    for (const [partId, latestContent] of partLatestContent) {
      if (!latestContent.trim()) continue;
      const msgId = partMessageIds.get(partId);
      if (msgId) {
        finalWrites.push(
          convex.mutation(api.messages.updateContent, {
            messageId: msgId,
            content: latestContent.trim(),
          }).catch((err) => {
            console.error(`[${chatId}] Failed final content update:`, err);
          }),
        );
      } else {
        // Create never completed — create the message now
        finalWrites.push(
          convex.mutation(api.messages.create, {
            chatId,
            role: "assistant" as const,
            content: latestContent.trim(),
            kind: partKinds.get(partId) ?? "message",
          }).catch((err) => {
            console.error(`[${chatId}] Failed final content create:`, err);
          }),
        );
      }
    }
    await Promise.allSettled(finalWrites);

    // Surface prompt errors to the client and re-throw
    if (promptError) {
      const errMsg = errorToString(promptError);
      console.error(`[${chatId}] Prompt error:`, errMsg);
      await convex.mutation(api.messages.create, {
        chatId,
        role: "assistant" as const,
        content: `Error: ${errMsg}`,
        kind: "status",
      }).catch((err) => {
        console.error(`[${chatId}] Failed to write prompt error to Convex:`, err);
      });
      throw promptError;
    }
  }
}
