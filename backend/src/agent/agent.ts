import { Daytona } from "@daytonaio/sdk";
import type { Sandbox } from "@daytonaio/sdk";
import { buildRules, buildPrompt } from "./system-prompt.js";
import { getConvexClient, api } from "../convex.js";
import type { Id } from "../../../convex/_generated/dataModel.js";
import { createAgentLogger, type Logger } from "../lib/logger.js";

export interface InvestigationConfig {
  targetUrl: string;
  goal: string;
  context?: string;
  model?: string;
  maxSteps?: number;
}

export interface InvestigationResult {
  agentId: string;
  status: "running" | "completed" | "failed" | "stopped";
  output: string | null;
  toolsCalled: string[];
  stepsUsed: number;
  activity: string[];
  lastActivityAt: string | null;
  error: string | null;
}

const DEFAULT_MODEL = "minimax-m2.5-free";
const FLUSH_DEBOUNCE_MS = 400;

export class SecurityAgent {
  private readonly model: string;
  private result: InvestigationResult | null = null;
  private runPromise: Promise<void> | null = null;
  private readonly chatId: Id<"chats">;
  private lastFlushedActivityIndex = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly log: Logger;
  private sandbox: Sandbox | null = null;
  private stopped = false;
  readonly id: string;

  constructor(config: { chatId: string; model?: string }) {
    this.id = crypto.randomUUID();
    this.model = config.model ?? DEFAULT_MODEL;
    this.chatId = config.chatId as Id<"chats">;
    this.log = createAgentLogger(this.id, config.chatId);
    this.log.info({ model: this.model }, "Agent created");
  }

  async investigate(config: InvestigationConfig): Promise<InvestigationResult> {
    this.result = {
      agentId: this.id,
      status: "running",
      output: null,
      toolsCalled: [],
      stepsUsed: 0,
      activity: [],
      lastActivityAt: null,
      error: null,
    };
    this.pushActivity(`Investigation started for ${config.targetUrl}.`);
    this.log.info(
      { targetUrl: config.targetUrl, goal: config.goal },
      "Investigation started",
    );

    this.runPromise = (async () => {
      try {
        // 1. Create Daytona sandbox
        this.pushActivity("Creating sandbox...");
        const daytona = new Daytona();
        this.sandbox = await daytona.create({
          resources: { cpu: 2, memory: 4, disk: 8 },
          autoStopInterval: 30,
        });
        this.pushActivity("Sandbox created.");
        this.log.info(
          { sandboxId: this.sandbox.id },
          "Daytona sandbox created",
        );

        if (this.stopped) {
          await this.cleanup();
          await this.flushTerminal();
          return;
        }

        // 2. Install OpenCode
        this.pushActivity("Installing hacker-use agent on Daytona...");
        const installResult = await this.sandbox.process.executeCommand(
          "curl -fsSL https://opencode.ai/install | bash",
        );
        this.log.info(
          {
            exitCode: installResult.exitCode,
            output: installResult.result?.slice(0, 500),
          },
          "Agent install result",
        );
        this.pushActivity("Agent installed.");

        if (this.stopped) {
          await this.cleanup();
          await this.flushTerminal();
          return;
        }

        // 3. Write opencode.json config
        const opencodeConfig = JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            yolo: true,
            model: config.model ?? this.model,
            permission: "allow",
            autoupdate: false,
          },
          null,
          2,
        );
        await this.sandbox.process.executeCommand(
          `cat > /home/daytona/opencode.json << 'OPENCODE_CONFIG_EOF'\n${opencodeConfig}\nOPENCODE_CONFIG_EOF`,
        );

        // 4. Write CTF rules
        const rules = buildRules({
          targetUrl: config.targetUrl,
          goal: config.goal,
          context: config.context,
        });
        // Escape any EOF markers in the rules content
        const safeRules = rules.replace(/RULES_EOF/g, "RULES__EOF");
        await this.sandbox.process.executeCommand(
          `mkdir -p /home/daytona/.opencode/rules && cat > /home/daytona/.opencode/rules/ctf.md << 'RULES_EOF'\n${safeRules}\nRULES_EOF`,
        );

        // Verify config was written
        const configCheck = await this.sandbox.process.executeCommand(
          "cat /home/daytona/opencode.json && echo '---' && cat /home/daytona/.opencode/rules/ctf.md | wc -l",
        );
        this.log.info(
          { output: configCheck.result?.slice(0, 300) },
          "Config files written",
        );

        // 5. Create a session and run OpenCode
        const sessionId = `opencode-${this.id}`;
        await this.sandbox.process.createSession(sessionId);

        const prompt = buildPrompt({
          targetUrl: config.targetUrl,
          goal: config.goal,
          context: config.context,
        });

        // Escape single quotes in prompt for shell safety
        const escapedPrompt = prompt.replace(/'/g, "'\\''");
        // Disable model refresh and auto-update to prevent hanging on network requests
        // Redirect stderr to stdout so we capture everything
        const cmd = `cd /home/daytona && OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_AUTOUPDATE=true opencode run --format json '${escapedPrompt}' 2>&1`;

        this.pushActivity("Starting Agent...");
        this.log.info({ cmd }, "Running Agent command");

        const command = await this.sandbox.process.executeSessionCommand(
          sessionId,
          { command: cmd, runAsync: true },
        );

        if (!command.cmdId) {
          throw new Error("Failed to start Agent command in sandbox");
        }

        this.log.info({ cmdId: command.cmdId }, "Agent command started");

        // 6. Stream logs and parse JSON events
        const outputParts: string[] = [];
        const rawLogParts: string[] = [];
        const toolsSeenSet = new Set<string>();
        let lineBuffer = "";

        await this.sandbox.process.getSessionCommandLogs(
          sessionId,
          command.cmdId,
          (chunk: string) => {
            rawLogParts.push(chunk);
            lineBuffer += chunk;

            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              try {
                const event = JSON.parse(trimmed);
                this.handleOpenCodeEvent(event, outputParts, toolsSeenSet);
              } catch {
                // Not JSON — log as raw output and add to activity
                this.log.info({ raw: trimmed }, "Agent raw output");
                this.pushActivity(trimmed.slice(0, 120));
              }
            }
          },
        );

        // Process any remaining buffer
        if (lineBuffer.trim()) {
          try {
            const event = JSON.parse(lineBuffer.trim());
            this.handleOpenCodeEvent(event, outputParts, toolsSeenSet);
          } catch {
            this.log.info(
              { raw: lineBuffer.trim() },
              "OpenCode trailing raw output",
            );
          }
        }

        // Check the command's exit code
        const cmdInfo = await this.sandbox.process.getSessionCommand(
          sessionId,
          command.cmdId,
        );
        this.log.info(
          {
            exitCode: cmdInfo.exitCode,
            rawLogLength: rawLogParts.join("").length,
            parsedOutputLength: outputParts.join("").length,
          },
          "OpenCode command finished",
        );

        if (this.result?.status === "stopped") {
          await this.cleanup();
          await this.flushTerminal();
          return;
        }

        const finalOutput =
          outputParts.join("") || "Investigation completed with no output.";

        this.result!.output = finalOutput;
        this.result!.toolsCalled = [...toolsSeenSet];
        this.result!.status = "completed";
        this.pushActivity("Investigation completed.");

        this.log.info(
          {
            toolsCalled: [...toolsSeenSet],
            outputLength: finalOutput.length,
          },
          "Investigation completed",
        );

        await this.cleanup();
        await this.flushTerminal();
      } catch (err) {
        if (this.result?.status === "stopped") {
          await this.cleanup();
          await this.flushTerminal();
          return;
        }

        this.result!.status = "failed";
        this.result!.error = err instanceof Error ? err.message : String(err);
        this.pushActivity("Investigation failed.");
        this.log.error(
          { err: err instanceof Error ? err : new Error(String(err)) },
          "Investigation failed",
        );

        await this.cleanup();
        await this.flushTerminal();
      }
    })();

    await this.runPromise;
    return this.result!;
  }

  private handleOpenCodeEvent(
    event: unknown,
    outputParts: string[],
    toolsSeenSet: Set<string>,
  ): void {
    if (typeof event !== "object" || event === null) return;

    const e = event as Record<string, unknown>;
    const type = e.type as string | undefined;

    if (type === "message.part.updated") {
      const part = e.part as Record<string, unknown> | undefined;
      if (!part) return;

      const partType = part.type as string | undefined;

      if (partType === "text") {
        const text = part.text as string | undefined;
        if (text) {
          outputParts.push(text);
          if (this.result) {
            this.result.output = outputParts.join("");
            this.scheduleFlush();
          }
        }
      } else if (partType === "tool") {
        const toolName = part.name as string | undefined;
        const state = part.state as string | undefined;
        if (toolName) {
          toolsSeenSet.add(toolName);
          if (this.result) {
            this.result.toolsCalled = [...toolsSeenSet];
          }
          if (state === "running") {
            this.pushActivity(`Using tool: ${toolName}`);
          }
        }
      }
    } else if (type === "session.idle") {
      this.log.info("OpenCode session idle — run complete");
    }
  }

  getResult(): InvestigationResult | null {
    return this.result;
  }

  stop(): void {
    if (this.result && this.result.status === "running") {
      this.result.status = "stopped";
      this.stopped = true;
      this.pushActivity("Investigation stopped by request.");
      this.log.info("Agent stop requested");

      // Immediately kill the sandbox so the streaming log call aborts
      this.cleanup().catch((err) => {
        this.log.error({ err }, "Failed to cleanup sandbox on stop");
      });
    }
  }

  destroy(): void {
    this.stop();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.log.info("Agent destroyed");
  }

  private async cleanup(): Promise<void> {
    if (this.sandbox) {
      try {
        await this.sandbox.delete();
        this.log.info("Sandbox deleted");
      } catch {
        // Best effort
      }
      this.sandbox = null;
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

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushToConvex().catch((err) => {
        this.log.error(
          { err },
          "Failed to flush investigation state to Convex",
        );
      });
    }, FLUSH_DEBOUNCE_MS);
  }

  private async flushToConvex(): Promise<void> {
    if (!this.result) return;
    const start = performance.now();
    const convex = getConvexClient();

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

    const durationMs = Math.round(performance.now() - start);
    this.log.debug(
      { durationMs, newLines: newLines.length, status: this.result.status },
      "Convex flush completed",
    );
  }

  private async flushTerminal(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.result) return;
    const start = performance.now();
    const convex = getConvexClient();

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

    const terminal = buildTerminalMessage(this.result);
    await convex.mutation(api.messages.create, {
      chatId: this.chatId,
      role: "assistant" as const,
      content: terminal.content,
      kind: terminal.kind,
    });

    const durationMs = Math.round(performance.now() - start);
    this.log.info(
      { durationMs, status: this.result.status },
      "Terminal Convex flush completed",
    );
  }
}

function buildTerminalMessage(result: InvestigationResult): {
  content: string;
  kind: "message" | "status";
} {
  if (result.status === "completed") {
    const output =
      result.output?.trim() || "Investigation completed with no output.";
    return { content: output, kind: "message" };
  }

  if (result.status === "failed") {
    return {
      content: `Investigation failed: ${result.error ?? "Unknown error."}`,
      kind: "status",
    };
  }

  return { content: "Investigation stopped.", kind: "status" };
}
