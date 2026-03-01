import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Event } from "@opencode-ai/sdk";
import { getConvexClient, api } from "../convex.js";
import type { Id } from "../../../convex/_generated/dataModel.js";

export interface OpenCodeSession {
  sessionId: string;
  sendMessage(text: string): Promise<void>;
  abort(): Promise<void>;
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
      try {
        await consumeEvents(
          eventSub.stream,
          sessionId,
          chatId as Id<"chats">,
          promptPromise,
        );
      } finally {
        // Ensure prompt is resolved (it should already be done)
        await promptPromise.catch(() => {});
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

async function consumeEvents(
  stream: AsyncGenerator<Event>,
  sessionId: string,
  chatId: Id<"chats">,
  promptPromise: Promise<unknown>,
): Promise<void> {
  const convex = getConvexClient();
  let done = false;

  // Race: when the prompt resolves, mark done so we break
  promptPromise.then(() => { done = true; }).catch(() => { done = true; });

  const writeStatus = (content: string) => {
    const entry = `[${new Date().toLocaleTimeString("en-US", { hour12: false })}] ${content}`;
    convex.mutation(api.messages.create, {
      chatId,
      role: "assistant" as const,
      content: entry,
      kind: "status",
    }).catch((err) => {
      console.error(`[${chatId}] Failed to write status to Convex:`, err);
    });
  };

  // Incremental text streaming: create message on first text, update on subsequent
  const partMessageIds = new Map<string, Id<"chatMessages">>();
  const partLatestText = new Map<string, string>();
  const partCreating = new Map<string, Promise<Id<"chatMessages">>>();

  const handleTextUpdate = (partId: string, text: string) => {
    partLatestText.set(partId, text);

    const existingMsgId = partMessageIds.get(partId);
    if (existingMsgId) {
      // Update existing message content
      convex.mutation(api.messages.updateContent, {
        messageId: existingMsgId,
        content: text,
      }).catch((err) => {
        console.error(`[${chatId}] Failed to update text in Convex:`, err);
      });
    } else if (!partCreating.has(partId)) {
      // First time seeing this part — create the message
      const createPromise = convex.mutation(api.messages.create, {
        chatId,
        role: "assistant" as const,
        content: text,
        kind: "message",
      });
      partCreating.set(partId, createPromise);

      createPromise
        .then((msgId) => {
          partMessageIds.set(partId, msgId);
          partCreating.delete(partId);
          // If more text arrived while creating, push the latest
          const latest = partLatestText.get(partId);
          if (latest !== undefined && latest !== text) {
            handleTextUpdate(partId, latest);
          }
        })
        .catch((err) => {
          console.error(`[${chatId}] Failed to create text message in Convex:`, err);
          partCreating.delete(partId);
        });
    }
    // else: create is in flight — the .then() handler will pick up partLatestText
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
            state?: { status?: string };
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
          handleTextUpdate(partId, part.text ?? "");
        } else if (part.type === "tool") {
          const toolName = part.tool ?? "unknown";
          const status = part.state?.status;
          if (status === "running") {
            writeStatus(`Using tool: ${toolName}`);
          } else if (status === "completed") {
            writeStatus(`Tool completed: ${toolName}`);
          }
        }
      }
    }
  } finally {
    // Wait for any in-flight creates to finish
    await Promise.allSettled([...partCreating.values()]);

    // Final flush: ensure every part's latest text is persisted
    const finalWrites: Promise<unknown>[] = [];
    for (const [partId, latestText] of partLatestText) {
      if (!latestText.trim()) continue;
      const msgId = partMessageIds.get(partId);
      if (msgId) {
        finalWrites.push(
          convex.mutation(api.messages.updateContent, {
            messageId: msgId,
            content: latestText.trim(),
          }).catch((err) => {
            console.error(`[${chatId}] Failed final text update:`, err);
          }),
        );
      } else {
        // Create never completed — create the message now
        finalWrites.push(
          convex.mutation(api.messages.create, {
            chatId,
            role: "assistant" as const,
            content: latestText.trim(),
            kind: "message",
          }).catch((err) => {
            console.error(`[${chatId}] Failed final text create:`, err);
          }),
        );
      }
    }
    await Promise.allSettled(finalWrites);
  }
}
