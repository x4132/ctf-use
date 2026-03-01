import Dedalus, { DedalusRunner } from "dedalus-labs";
import type { RunParams, RunResult } from "dedalus-labs/lib/runner/runner.js";
import type { Tool, ToolResult } from "dedalus-labs/lib/runner/index.js";
import { getBrowserTools, type BrowserToolProgressEvent } from "../browser/tools.js";
import { extractSignals, type Signal } from "../browser/signals.js";
import { buildInstructions } from "./system-prompt.js";

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
  output: string | null;
  signals: Signal[];
  toolsCalled: string[];
  stepsUsed: number;
  activity: string[];
  lastActivityAt: string | null;
  error: string | null;
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";
const DEFAULT_MAX_STEPS = 30;
const DEFAULT_MAX_TOKENS = 2048;

export class SecurityAgent {
  private readonly model: string;
  private result: InvestigationResult | null = null;
  private abortController: AbortController | null = null;
  private runPromise: Promise<void> | null = null;
  readonly id: string;

  constructor(config?: { model?: string }) {
    this.id = crypto.randomUUID();
    this.model = config?.model ?? DEFAULT_MODEL;
  }

  async investigate(config: InvestigationConfig): Promise<InvestigationResult> {
    const client = new Dedalus();
    const runner = new DedalusRunner(client);
    this.abortController = new AbortController();

    this.result = {
      agentId: this.id,
      status: "running",
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
          max_tokens: DEFAULT_MAX_TOKENS,
        };

        const runResult = await runWithStreamingFallback(
          runner,
          runParams,
          (message) => this.pushActivity(message),
        );

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
      } catch (err) {
        this.result!.status = "failed";
        this.result!.error =
          err instanceof Error ? err.message : String(err);
        this.pushActivity("Investigation failed.");
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
    this.result = null;
    this.runPromise = null;
    this.abortController = null;
  }

  private pushActivity(message: string): void {
    if (!this.result) return;
    const now = new Date().toISOString();
    const entry = `[${new Date(now).toLocaleTimeString("en-US", { hour12: false })}] ${message}`;
    this.result.activity = [...this.result.activity, entry].slice(-60);
    this.result.lastActivityAt = now;
  }

  private handleToolProgressEvent(event: BrowserToolProgressEvent): void {
    if (!this.result) return;

    if (
      event.phase === "start" &&
      !this.result.toolsCalled.includes(event.tool)
    ) {
      this.result.toolsCalled = [...this.result.toolsCalled, event.tool];
    }

    this.pushActivity(event.message);
  }
}

interface RunnerExecutionResult {
  finalOutput: string;
  toolResults: ToolResult[];
  toolsCalled: string[];
  stepsUsed: number;
}

async function runWithStreamingFallback(
  runner: DedalusRunner,
  runParams: RunParams,
  onActivity?: (message: string) => void,
): Promise<RunnerExecutionResult> {
  try {
    const result = (await runner.run(runParams)) as RunResult;
    return {
      finalOutput: result.finalOutput,
      toolResults: result.toolResults,
      toolsCalled: result.toolsCalled,
      stepsUsed: result.stepsUsed,
    };
  } catch (err) {
    if (!isStreamingRequiredError(err)) {
      throw err;
    }
    onActivity?.("Model requires streaming mode; retrying with streaming enabled.");

    const stream = (await runner.run({
      ...runParams,
      stream: true,
    })) as AsyncIterable<unknown>;

    return {
      finalOutput: await collectStreamOutput(stream),
      toolResults: [],
      toolsCalled: [],
      stepsUsed: 0,
    };
  }
}

function isStreamingRequiredError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("streaming_required") ||
    message.includes("requires streaming") ||
    message.includes('Set "stream": true')
  );
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

async function collectStreamOutput(stream: AsyncIterable<unknown>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of stream) {
    const content = extractChunkContent(chunk);
    if (content) {
      parts.push(content);
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
