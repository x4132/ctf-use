import type { Tool } from "dedalus-labs/lib/runner/index.js";
import type { JSONSchema } from "dedalus-labs/lib/utils/schemas.js";
import type { SessionView, TaskResult, TaskStepView } from "browser-use-sdk";
import { getBrowserClient } from "./client.js";
import { extractSignals, type Signal } from "./signals.js";

type ToolMetadata = {
  description: string;
  parameters: JSONSchema;
};

type ToolWithMetadata<TArgs, TResult> = Tool & {
  (args: TArgs): Promise<TResult>;
  description: string;
  parameters: JSONSchema;
};

function defineTool<TArgs, TResult>(
  fn: (args: TArgs) => Promise<TResult>,
  metadata: ToolMetadata,
): ToolWithMetadata<TArgs, TResult> {
  const tool = fn as ToolWithMetadata<TArgs, TResult>;
  tool.description = metadata.description;
  tool.parameters = metadata.parameters;
  return tool;
}

interface BrowserRunTaskArgs {
  task: string;
  startUrl?: string;
  sessionId?: string;
  maxSteps?: number;
}

interface BrowserTaskStep {
  number: number;
  nextGoal: string;
  url: string;
  actions: string[];
}

type BrowserTaskSignal = Pick<
  Signal,
  "type" | "confidence" | "details" | "evidence" | "suggestedFollowUps"
>;

interface BrowserRunTaskResult {
  taskId: TaskResult["id"];
  sessionId: TaskResult["sessionId"];
  status: TaskResult["status"];
  output: string;
  steps: BrowserTaskStep[];
  stepsUsed: number;
  signals: BrowserTaskSignal[];
}

interface BrowserCreateSessionArgs {
  persistMemory?: boolean;
  keepAlive?: boolean;
  startUrl?: string;
}

interface BrowserSessionSummary {
  sessionId: SessionView["id"];
  status: SessionView["status"];
  liveUrl: string | null;
}

interface BrowserGetSessionArgs {
  sessionId: string;
}

interface BrowserGetSessionResult extends BrowserSessionSummary {
  startedAt: SessionView["startedAt"];
  finishedAt: string | null;
  persistMemory: SessionView["persistMemory"];
  keepAlive: SessionView["keepAlive"];
}

interface BrowserStopSessionArgs {
  sessionId: string;
}

interface BrowserStopSessionResult {
  sessionId: SessionView["id"];
  status: SessionView["status"];
}

type BrowserToolName =
  | "browser_run_task"
  | "browser_create_session"
  | "browser_get_session"
  | "browser_stop_session";

export interface BrowserToolProgressEvent {
  tool: BrowserToolName;
  phase: "start" | "step" | "end";
  message: string;
}

export interface BrowserToolHooks {
  onEvent?: (event: BrowserToolProgressEvent) => void;
}

function emitToolEvent(
  hooks: BrowserToolHooks | undefined,
  event: BrowserToolProgressEvent,
): void {
  hooks?.onEvent?.(event);
}

const DEFAULT_BROWSER_TASK_MAX_STEPS = 15;
const DEFAULT_BROWSER_TASK_TIMEOUT_MS = 45_000;

const browserRunTaskParameters = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description: "Natural language instruction for what the browser should do",
    },
    startUrl: {
      type: "string",
      description:
        "URL to start from. Include this in the task description too for best results",
    },
    sessionId: {
      type: "string",
      description:
        "Reuse an existing browser session for follow-up tasks. Enables multi-step investigations",
    },
    maxSteps: {
      type: "number",
      description: "Maximum number of browser agent steps. Default: 15",
    },
  },
  required: ["task"],
  additionalProperties: false,
} satisfies JSONSchema;

const browserCreateSessionParameters = {
  type: "object",
  properties: {
    persistMemory: {
      type: "boolean",
      description: "Share memory/history between tasks in this session. Default: true",
    },
    keepAlive: {
      type: "boolean",
      description: "Keep the browser alive after tasks complete. Default: true",
    },
    startUrl: {
      type: "string",
      description: "URL to navigate to when the session starts",
    },
  },
  required: [],
  additionalProperties: false,
} satisfies JSONSchema;

const browserGetSessionParameters = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      description: "The session ID to look up",
    },
  },
  required: ["sessionId"],
  additionalProperties: false,
} satisfies JSONSchema;

const browserStopSessionParameters = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      description: "The session ID to stop",
    },
  },
  required: ["sessionId"],
  additionalProperties: false,
} satisfies JSONSchema;

/**
 * Run a browser-use task with natural language instructions.
 * Main tool for web interaction: navigating pages, filling forms, clicking buttons, extracting content.
 * The browser agent executes autonomously in a cloud browser.
 * Returns the task output, steps taken, cost, and any security signals detected.
 */
function createBrowserRunTaskTool(
  hooks?: BrowserToolHooks,
): ToolWithMetadata<BrowserRunTaskArgs, BrowserRunTaskResult> {
  return defineTool(
    async function browser_run_task(
      args: BrowserRunTaskArgs,
    ): Promise<BrowserRunTaskResult> {
      emitToolEvent(hooks, {
        tool: "browser_run_task",
        phase: "start",
        message: `Starting browser task: ${args.task.slice(0, 180)}`,
      });

      try {
        const client = getBrowserClient();

        const taskRun = client.run(args.task, {
          startUrl: args.startUrl,
          sessionId: args.sessionId,
          maxSteps: args.maxSteps ?? DEFAULT_BROWSER_TASK_MAX_STEPS,
          timeout: DEFAULT_BROWSER_TASK_TIMEOUT_MS,
        });

        // Collect steps via async iteration
        const steps: BrowserTaskStep[] = [];

        for await (const step of taskRun as AsyncIterable<TaskStepView>) {
          steps.push({
            number: step.number,
            nextGoal: step.nextGoal,
            url: step.url,
            actions: step.actions,
          });

          emitToolEvent(hooks, {
            tool: "browser_run_task",
            phase: "step",
            message: `Browser step ${step.number}: ${step.nextGoal || "continuing"} (${step.url})`,
          });
        }

        const result: TaskResult | null = taskRun.result;
        if (!result) {
          throw new Error("browser_run_task completed without a task result");
        }

        const output =
          typeof result.output === "string"
            ? result.output
            : result.output == null
              ? ""
              : JSON.stringify(result.output);

        const signals = output ? extractSignals(result.id, args.task, output) : [];

        emitToolEvent(hooks, {
          tool: "browser_run_task",
          phase: "end",
          message: `Browser task finished with status ${result.status} after ${result.steps.length} steps.`,
        });

        return {
          taskId: result.id,
          sessionId: result.sessionId,
          status: result.status,
          output,
          steps,
          stepsUsed: result.steps.length,
          signals: signals.map((s) => ({
            type: s.type,
            confidence: s.confidence,
            details: s.details,
            evidence: s.evidence,
            suggestedFollowUps: s.suggestedFollowUps,
          })),
        };
      } catch (err) {
        emitToolEvent(hooks, {
          tool: "browser_run_task",
          phase: "end",
          message: `Browser task failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        throw err;
      }
    },
    {
      description:
        "Run a browser-use task with natural language instructions. " +
        "The browser agent navigates pages, fills forms, clicks buttons, and extracts content autonomously. " +
        "Returns the task output, execution steps, and any security signals detected.",
      parameters: browserRunTaskParameters,
    },
  );
}

/**
 * Create a persistent browser session for multi-step investigations.
 * Returns a sessionId that can be passed to browser_run_task for follow-up tasks.
 */
function createBrowserCreateSessionTool(
  hooks?: BrowserToolHooks,
): ToolWithMetadata<BrowserCreateSessionArgs, BrowserSessionSummary> {
  return defineTool(
    async function browser_create_session(
      args: BrowserCreateSessionArgs,
    ): Promise<BrowserSessionSummary> {
      emitToolEvent(hooks, {
        tool: "browser_create_session",
        phase: "start",
        message: "Creating browser session.",
      });

      const client = getBrowserClient();

      const session = await client.sessions.create({
        persistMemory: args.persistMemory ?? true,
        keepAlive: args.keepAlive ?? true,
        startUrl: args.startUrl,
      });

      emitToolEvent(hooks, {
        tool: "browser_create_session",
        phase: "end",
        message: `Created session ${session.id}.`,
      });

      return {
        sessionId: session.id,
        status: session.status,
        liveUrl: session.liveUrl ?? null,
      };
    },
    {
      description:
        "Create a persistent browser session for multi-step investigations. " +
        "Returns a sessionId to pass to browser_run_task for follow-up tasks that share browser state.",
      parameters: browserCreateSessionParameters,
    },
  );
}

/**
 * Get the status and details of a browser session.
 */
function createBrowserGetSessionTool(
  hooks?: BrowserToolHooks,
): ToolWithMetadata<BrowserGetSessionArgs, BrowserGetSessionResult> {
  return defineTool(
    async function browser_get_session(
      args: BrowserGetSessionArgs,
    ): Promise<BrowserGetSessionResult> {
      emitToolEvent(hooks, {
        tool: "browser_get_session",
        phase: "start",
        message: `Checking session ${args.sessionId}.`,
      });

      const client = getBrowserClient();
      const session = await client.sessions.get(args.sessionId);

      emitToolEvent(hooks, {
        tool: "browser_get_session",
        phase: "end",
        message: `Session ${session.id} is ${session.status}.`,
      });

      return {
        sessionId: session.id,
        status: session.status,
        liveUrl: session.liveUrl ?? null,
        startedAt: session.startedAt,
        finishedAt: session.finishedAt ?? null,
        persistMemory: session.persistMemory,
        keepAlive: session.keepAlive,
      };
    },
    {
      description: "Get the current status, live URL, and details of a browser session.",
      parameters: browserGetSessionParameters,
    },
  );
}

/**
 * Stop a browser session or its running task.
 */
function createBrowserStopSessionTool(
  hooks?: BrowserToolHooks,
): ToolWithMetadata<BrowserStopSessionArgs, BrowserStopSessionResult> {
  return defineTool(
    async function browser_stop_session(
      args: BrowserStopSessionArgs,
    ): Promise<BrowserStopSessionResult> {
      emitToolEvent(hooks, {
        tool: "browser_stop_session",
        phase: "start",
        message: `Stopping session ${args.sessionId}.`,
      });

      const client = getBrowserClient();
      const session = await client.sessions.stop(args.sessionId);

      emitToolEvent(hooks, {
        tool: "browser_stop_session",
        phase: "end",
        message: `Stopped session ${session.id}.`,
      });

      return {
        sessionId: session.id,
        status: session.status,
      };
    },
    {
      description:
        "Stop a browser session and all its running tasks. Use when done investigating or to free resources.",
      parameters: browserStopSessionParameters,
    },
  );
}

/**
 * Returns all browser-use tools as an array compatible with DedalusRunner.
 */
export function getBrowserTools(hooks?: BrowserToolHooks): Tool[] {
  return [
    createBrowserRunTaskTool(hooks),
    createBrowserCreateSessionTool(hooks),
    createBrowserGetSessionTool(hooks),
    createBrowserStopSessionTool(hooks),
  ];
}
