import { getConvexClient, api } from "../convex.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import type { OpenCodeSession } from "./session.js";
import { detectFlag, type FlagDetectionResult } from "./flag-detector.js";

const activeLoops = new Map<string, { aborted: boolean }>();

export function isLoopActive(chatId: string): boolean {
  const loop = activeLoops.get(chatId);
  return loop !== undefined && !loop.aborted;
}

export function abortLoop(chatId: string): void {
  const loop = activeLoops.get(chatId);
  if (loop) {
    loop.aborted = true;
  }
}

interface LoopOptions {
  chatId: string;
  session: OpenCodeSession;
  maxIterations: number;
  setStatus: (status: string) => void;
  clearRunning: () => void;
}

const MAX_CONSECUTIVE_ERRORS = 3;

async function checkForFlag(chatId: Id<"chats">): Promise<FlagDetectionResult> {
  const convex = getConvexClient();
  const messages = await convex.query(api.messages.listByChat, { chatId });
  const recentText = messages
    .filter((m) => m.role === "assistant" && m.kind === "message")
    .slice(-10)
    .map((m) => m.content)
    .join("\n");
  return detectFlag(recentText);
}

export async function runLoop(opts: LoopOptions): Promise<void> {
  const { chatId, session, maxIterations, setStatus, clearRunning } = opts;
  const convex = getConvexClient();
  const typedChatId = chatId as Id<"chats">;

  const loopState = { aborted: false };
  activeLoops.set(chatId, loopState);

  const isStopped = () => loopState.aborted;

  const markStopped = async () => {
    await convex.mutation(api.chats.updateLoopProgress, {
      chatId: typedChatId,
      loopStatus: "stopped",
    }).catch(() => {});
    setStatus("Loop stopped");
  };

  try {
    // Check iteration 1 (already completed before runLoop was called) for flag
    await convex.mutation(api.chats.updateLoopProgress, {
      chatId: typedChatId,
      loopIteration: 1,
      loopStatus: "running",
    });

    if (isStopped()) { await markStopped(); return; }

    const initialCheck = await checkForFlag(typedChatId);

    if (isStopped()) { await markStopped(); return; }

    if (initialCheck.found) {
      await convex.mutation(api.chats.updateLoopProgress, {
        chatId: typedChatId,
        loopStatus: "completed",
        loopFlagFound: initialCheck.flag ?? undefined,
      });
      setStatus(`Flag found: ${initialCheck.flag}`);
      return;
    }

    let consecutiveErrors = 0;

    for (let iteration = 2; iteration <= maxIterations; iteration++) {
      if (isStopped()) { await markStopped(); return; }

      setStatus(`Loop iteration ${iteration}/${maxIterations}`);
      await convex.mutation(api.chats.updateLoopProgress, {
        chatId: typedChatId,
        loopIteration: iteration,
      });

      const followUpPrompt = buildFollowUpPrompt(iteration, maxIterations);

      // Write iteration marker as a user message so it appears in the conversation
      await convex.mutation(api.messages.create, {
        chatId: typedChatId,
        role: "user" as const,
        content: followUpPrompt,
        kind: "message" as const,
      });

      if (isStopped()) { await markStopped(); return; }

      try {
        await session.sendMessage(followUpPrompt);
        consecutiveErrors = 0;
      } catch (err) {
        // If we were aborted, the error is from session.abort() — not a real error
        if (isStopped()) { await markStopped(); return; }

        consecutiveErrors++;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[${chatId}] Loop iteration ${iteration} error:`, errMsg);
        setStatus(`Iteration ${iteration} error: ${errMsg}`);

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          setStatus(`Loop stopped: ${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
          await convex.mutation(api.chats.updateLoopProgress, {
            chatId: typedChatId,
            loopStatus: "stopped",
          });
          return;
        }
        continue;
      }

      if (isStopped()) { await markStopped(); return; }

      const result = await checkForFlag(typedChatId);

      if (isStopped()) { await markStopped(); return; }

      if (result.found) {
        await convex.mutation(api.chats.updateLoopProgress, {
          chatId: typedChatId,
          loopStatus: "completed",
          loopFlagFound: result.flag ?? undefined,
        });
        setStatus(`Flag found: ${result.flag}`);
        return;
      }
    }

    // Reached max iterations without finding flag
    await convex.mutation(api.chats.updateLoopProgress, {
      chatId: typedChatId,
      loopStatus: "max_reached",
    });
    setStatus(`Loop completed: max iterations (${maxIterations}) reached without finding flag`);
  } finally {
    activeLoops.delete(chatId);
    clearRunning();
  }
}

function buildFollowUpPrompt(iteration: number, maxIterations: number): string {
  const urgency = iteration >= maxIterations - 2
    ? `\n\n**URGENCY**: You are running low on iterations (${iteration}/${maxIterations}). Focus on your most promising leads and try aggressive techniques.`
    : "";

  return `## Continue Investigation (Iteration ${iteration}/${maxIterations})

You have NOT found the flag yet. Continue your penetration testing.

**IMPORTANT INSTRUCTIONS:**
1. Review what you have already tried in this conversation. DO NOT repeat the same approaches that failed.
2. Try a DIFFERENT attack vector or technique than what you've used before.
3. If you were testing SQL injection, try XSS or path traversal instead (or vice versa).
4. If basic techniques failed, try more advanced variants:
   - Blind SQLi (time-based, boolean-based)
   - Second-order injection
   - Server-side template injection (SSTI)
   - Deserialization attacks
   - Race conditions
   - JWT manipulation
   - SSRF
   - Insecure Direct Object References (IDOR)
   - XML External Entity (XXE)
5. Re-examine the application for anything you might have missed -- hidden parameters, unusual cookies, commented-out HTML, JavaScript source maps, API endpoints.
6. If you found a partial vulnerability earlier, try to chain it with other techniques.

Remember: Your goal is to find the flag. Think creatively and try unconventional approaches.${urgency}`;
}
