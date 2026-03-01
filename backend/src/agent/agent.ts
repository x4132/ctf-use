import Dedalus, { DedalusRunner } from "dedalus-labs";
import type { RunParams } from "dedalus-labs/lib/runner/runner.js";
import type { Tool, ToolResult } from "dedalus-labs/lib/runner/index.js";
import { getBrowserTools, type BrowserToolProgressEvent } from "../browser/tools.js";
import { extractSignals, type Signal } from "../browser/signals.js";
import { buildInstructions } from "./system-prompt.js";
import { getConvexClient, api } from "../convex.js";
import type { Id } from "../../../convex/_generated/dataModel.js";

export interface InvestigationConfig {
  targetUrl: string;
  goal: string;
  context?: string;
  model?: string;
  maxSteps?: number;
  mcpServers?: string[];
}

export interface InvestigationResult {
  agentId: string;
  status: "running" | "completed" | "failed" | "stopped";
  liveBrowserUrl: string | null;
  output: string | null;
  signals: Signal[];
  toolsCalled: string[];
  stepsUsed: number;
  activity: string[];
  lastActivityAt: string | null;
  error: string | null;
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";
const DEFAULT_MAX_STEPS = 30;
const FLUSH_DEBOUNCE_MS = 400;

export class SecurityAgent {
  private readonly model: string;
  private result: InvestigationResult | null = null;
  private abortController: AbortController | null = null;
  private runPromise: Promise<void> | null = null;
  private readonly chatId: Id<"chats">;
  private lastFlushedActivityIndex = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  readonly id: string;

  constructor(config: { chatId: string; model?: string }) {
    this.id = crypto.randomUUID();
    this.model = config.model ?? DEFAULT_MODEL;
    this.chatId = config.chatId as Id<"chats">;
  }

  async investigate(config: InvestigationConfig): Promise<InvestigationResult> {
    const client = new Dedalus();
    const runner = new DedalusRunner(client);
    this.abortController = new AbortController();

    this.result = {
      agentId: this.id,
      status: "running",
      liveBrowserUrl: null,
      output: null,
      signals: [],
      toolsCalled: [],
      stepsUsed: 0,
      activity: [],
      lastActivityAt: null,
      error: null,
    };
    this.pushActivity(`Investigation started for ${config.targetUrl}.`);

    const instructions = buildInstructions({
      targetUrl: config.targetUrl,
      goal: config.goal,
      context: config.context,
    });

    const tools: Tool[] = getBrowserTools({
      onEvent: (event) => this.handleToolProgressEvent(event),
      abortSignal: this.abortController.signal,
    });
    const mcpServers = config.mcpServers ?? [];

    const input = `Investigate ${config.targetUrl}\n\nGoal: ${config.goal}`;

    this.runPromise = (async () => {
      try {
        const runParams: RunParams = {
          input,
          instructions,
          model: config.model ?? this.model,
          tools,
          mcpServers,
          maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
        };

        const runResult = await runWithStreaming(
          runner,
          runParams,
          this.abortController?.signal,
        );

        if (this.result?.status === "stopped") {
          return;
        }

        this.result!.output = runResult.finalOutput;
        this.result!.toolsCalled =
          runResult.toolsCalled.length > 0
            ? runResult.toolsCalled
            : this.result!.toolsCalled;
        this.result!.stepsUsed = runResult.stepsUsed;
        this.result!.status = "completed";
        this.pushActivity("Investigation completed.");

        // Extract signals from the final output
        if (runResult.finalOutput) {
          this.result!.signals.push(
            ...extractSignals(this.id, input, runResult.finalOutput),
          );
        }

        // Also extract signals from tool results (browser task outputs)
        for (const toolResult of runResult.toolResults) {
          const output = extractToolOutput(toolResult);
          if (output) {
            this.result!.signals.push(
              ...extractSignals(this.id, input, output),
            );
          }
        }

        // Deduplicate signals
        this.result!.signals = deduplicateSignals(this.result!.signals);

        await this.flushTerminal();
      } catch (err) {
        if (isAbortError(err) || this.result?.status === "stopped") {
          if (this.result && this.result.status !== "stopped") {
            this.result.status = "stopped";
            this.pushActivity("Investigation stopped by request.");
          }
          if (this.result) {
            this.result.error = null;
          }
          await this.flushTerminal();
          return;
        }

        this.result!.status = "failed";
        this.result!.error =
          err instanceof Error ? err.message : String(err);
        this.pushActivity("Investigation failed.");

        await this.flushTerminal();
      }
    })();

    await this.runPromise;
    return this.result!;
  }

  getResult(): InvestigationResult | null {
    return this.result;
  }

  getSignals(): Signal[] {
    return this.result?.signals ?? [];
  }

  stop(): void {
    if (this.result && this.result.status === "running") {
      this.result.status = "stopped";
      this.pushActivity("Investigation stopped by request.");
      this.abortController?.abort();
    }
  }

  destroy(): void {
    this.stop();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private pushActivity(message: string): void {
    if (!this.result) return;
    const now = new Date().toISOString();
    const entry = `[${new Date(now).toLocaleTimeString("en-US", { hour12: false })}] ${message}`;
    this.result.activity = [...this.result.activity, entry].slice(-60);
    this.result.lastActivityAt = now;
    this.scheduleFlush();
  }

  private handleToolProgressEvent(event: BrowserToolProgressEvent): void {
    if (!this.result) return;

    if (event.liveUrl) {
      this.result.liveBrowserUrl = event.liveUrl;
    }

    if (
      event.phase === "start" &&
      !this.result.toolsCalled.includes(event.tool)
    ) {
      this.result.toolsCalled = [...this.result.toolsCalled, event.tool];
    }

    // Keep live URL updates out of rolling activity logs; UI renders a pinned live URL section.
    if (event.liveUrl || event.message.startsWith("Live browser view:")) {
      // Still flush for liveBrowserUrl changes
      this.scheduleFlush();
      return;
    }

    this.pushActivity(event.message);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushToConvex().catch((err) => {
        console.error("Failed to flush investigation state to Convex:", err);
      });
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flushToConvex(): Promise<void> {
    if (!this.result) return;
    const convex = getConvexClient();

    // Persist new activity lines as chatMessages
    const newLines = this.result.activity.slice(this.lastFlushedActivityIndex);
    this.lastFlushedActivityIndex = this.result.activity.length;

    for (let i = 0; i < newLines.length; i++) {
      await convex.mutation(api.messages.create, {
        chatId: this.chatId,
        role: "assistant" as const,
        content: newLines[i],
        kind: "status" as const,
      });
    }

    // Patch investigation state
    await convex.mutation(api.investigations.updateState, {
      agentId: this.id,
      status: this.result.status,
      ...(this.result.liveBrowserUrl
        ? { liveBrowserUrl: this.result.liveBrowserUrl }
        : {}),
      ...(this.result.toolsCalled.length > 0
        ? { toolsCalled: this.result.toolsCalled }
        : {}),
      ...(this.result.stepsUsed > 0
        ? { stepsUsed: this.result.stepsUsed }
        : {}),
    });
  }

  private async flushTerminal(): Promise<void> {
    // Cancel any pending debounced flush
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.result) return;
    const convex = getConvexClient();

    // Flush any remaining activity lines
    const newLines = this.result.activity.slice(this.lastFlushedActivityIndex);
    this.lastFlushedActivityIndex = this.result.activity.length;

    for (let i = 0; i < newLines.length; i++) {
      await convex.mutation(api.messages.create, {
        chatId: this.chatId,
        role: "assistant" as const,
        content: newLines[i],
        kind: "status" as const,
      });
    }

    // Build and persist the terminal message
    const terminal = buildTerminalMessage(this.result);
    await convex.mutation(api.messages.create, {
      chatId: this.chatId,
      role: "assistant" as const,
      content: terminal.content,
      kind: terminal.kind,
    });

    // Final state patch with output, signals, error
    await convex.mutation(api.investigations.updateState, {
      agentId: this.id,
      status: this.result.status,
      ...(this.result.output ? { output: this.result.output } : {}),
      ...(this.result.error ? { error: this.result.error } : {}),
      ...(this.result.signals.length > 0
        ? {
            signals: this.result.signals.map((s) => ({
              type: s.type,
              confidence: s.confidence,
              details: s.details,
              evidence: s.evidence,
              suggestedFollowUps: s.suggestedFollowUps,
            })),
          }
        : {}),
      stepsUsed: this.result.stepsUsed,
      toolsCalled: this.result.toolsCalled,
    });
  }
}

function buildTerminalMessage(result: InvestigationResult): {
  content: string;
  kind: "message" | "status";
} {
  if (result.status === "completed") {
    const output =
      result.output?.trim() || "Investigation completed with no output.";
    const signals =
      result.signals.length > 0
        ? `\n\nSignals detected (${result.signals.length}):\n${result.signals
            .map(
              (signal, index) =>
                `${index + 1}. ${signal.type} (${signal.confidence})`,
            )
            .join("\n")}`
        : "";
    return {
      content: `${output}${signals}`,
      kind: "message",
    };
  }

  if (result.status === "failed") {
    return {
      content: `Investigation failed: ${result.error ?? "Unknown error."}`,
      kind: "status",
    };
  }

  return {
    content: "Investigation stopped.",
    kind: "status",
  };
}

interface RunnerExecutionResult {
  finalOutput: string;
  toolResults: ToolResult[];
  toolsCalled: string[];
  stepsUsed: number;
}

async function runWithStreaming(
  runner: DedalusRunner,
  runParams: RunParams,
  abortSignal?: AbortSignal,
): Promise<RunnerExecutionResult> {
  const stream = (await runner.run({
    ...runParams,
    stream: true,
  })) as AsyncIterable<unknown>;

  return {
    finalOutput: await collectStreamOutput(stream, abortSignal),
    toolResults: [],
    toolsCalled: [],
    stepsUsed: 0,
  };
}

function extractChunkContent(chunk: unknown): string | null {
  if (typeof chunk !== "object" || chunk === null) {
    return null;
  }
  if (!("choices" in chunk)) {
    return null;
  }

  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }

  const firstChoice = choices[0] as { delta?: { content?: unknown } };
  const content = firstChoice?.delta?.content;
  return typeof content === "string" ? content : null;
}

async function collectStreamOutput(
  stream: AsyncIterable<unknown>,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (abortSignal?.aborted) {
    throw createAbortError();
  }

  const parts: string[] = [];
  const iterator = stream[Symbol.asyncIterator]();

  let onAbort: (() => void) | null = null;
  const abortPromise: Promise<never> | null = abortSignal
    ? new Promise((_, reject) => {
      onAbort = () => reject(createAbortError());
      abortSignal.addEventListener("abort", onAbort, { once: true });
    })
    : null;

  try {
    while (true) {
      const next = abortPromise
        ? (await Promise.race([iterator.next(), abortPromise])) as IteratorResult<unknown>
        : await iterator.next();

      if (next.done) {
        break;
      }

      const content = extractChunkContent(next.value);
      if (content) {
        parts.push(content);
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      try {
        await iterator.return?.();
      } catch {
        // Best effort stream cleanup.
      }
    }
    throw err;
  } finally {
    if (abortSignal && onAbort) {
      abortSignal.removeEventListener("abort", onAbort);
    }
  }

  return parts.join("");
}

function extractToolOutput(result: ToolResult): string | null {
  if (typeof result === "string") return result;
  if (typeof result.output === "string") return result.output;
  if (result.output != null) return JSON.stringify(result.output);
  return JSON.stringify(result);
}

function deduplicateSignals(signals: Signal[]): Signal[] {
  const seen = new Set<string>();
  return signals.filter((s) => {
    const key = `${s.type}:${s.evidence.slice(0, 100)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createAbortError(): Error {
  const error = new Error("Investigation aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  return error.message.toLowerCase().includes("abort");
}
