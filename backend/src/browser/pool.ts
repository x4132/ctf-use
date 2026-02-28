import type { BrowserUse, SessionResult, RunSessionOptions } from "browser-use-sdk/v3";
import { getBrowserClient } from "./client.js";
import { extractSignals, type Signal } from "./signals.js";

export interface RunTaskOptions {
  model?: "bu-mini" | "bu-max";
  sessionId?: string;
  keepAlive?: boolean;
  maxCostUsd?: number;
  profileId?: string;
  proxyCountryCode?: string;
  timeout?: number;
  interval?: number;
}

export interface PoolTask {
  id: string;
  sessionId: string | null;
  status: "pending" | "running" | "completed" | "failed";
  prompt: string;
  options: RunTaskOptions;
  output: string | null;
  error: string | null;
  signals: Signal[];
  cost: string | null;
  liveUrl: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

export type SignalHandler = (signal: Signal, task: PoolTask) => void;

interface CreateSessionOptions {
  proxyCountryCode?: string;
  profileId?: string;
  keepAlive?: boolean;
}

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get available(): number {
    return this.max - this.current;
  }

  get active(): number {
    return this.current;
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export class TaskPool {
  private readonly client: BrowserUse;
  private readonly semaphore: Semaphore;
  private readonly tasks = new Map<string, PoolTask>();
  private readonly signalHandlers: SignalHandler[] = [];

  constructor(options?: { maxConcurrency?: number }) {
    this.client = getBrowserClient();
    const max = options?.maxConcurrency
      ?? Number(process.env.BROWSER_POOL_MAX_CONCURRENCY ?? 5);
    this.semaphore = new Semaphore(max);
  }

  get activeCount(): number {
    return this.semaphore.active;
  }

  get available(): number {
    return this.semaphore.available;
  }

  onSignal(handler: SignalHandler): void {
    this.signalHandlers.push(handler);
  }

  async run(prompt: string, options: RunTaskOptions = {}): Promise<PoolTask> {
    const task = this.createPoolTask(prompt, options);
    await this.executeTask(task);
    return task;
  }

  async runAll(
    specs: Array<{ prompt: string; options?: RunTaskOptions }>,
  ): Promise<PoolTask[]> {
    const tasks = specs.map((s) => this.createPoolTask(s.prompt, s.options ?? {}));
    await Promise.allSettled(tasks.map((t) => this.executeTask(t)));
    return tasks;
  }

  submit(prompt: string, options: RunTaskOptions = {}): string {
    const task = this.createPoolTask(prompt, options);
    this.executeTask(task).catch(() => {
      // errors are captured on the task object
    });
    return task.id;
  }

  getTask(id: string): PoolTask | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): PoolTask[] {
    return Array.from(this.tasks.values());
  }

  getSignals(): Signal[] {
    return this.getAllTasks().flatMap((t) => t.signals);
  }

  async createSession(options: CreateSessionOptions = {}): Promise<string> {
    const session = await this.client.sessions.create({
      keepAlive: options.keepAlive ?? true,
      proxyCountryCode: options.proxyCountryCode as any,
      profileId: options.profileId,
    });
    return session.id;
  }

  async stopSession(
    sessionId: string,
    strategy: "task" | "session" = "session",
  ): Promise<void> {
    await this.client.sessions.stop(sessionId, { strategy });
  }

  async shutdown(): Promise<void> {
    const running = this.getAllTasks().filter((t) => t.status === "running");
    await Promise.allSettled(
      running
        .filter((t) => t.sessionId)
        .map((t) => this.client.sessions.stop(t.sessionId!, { strategy: "session" })),
    );
  }

  private createPoolTask(prompt: string, options: RunTaskOptions): PoolTask {
    const task: PoolTask = {
      id: crypto.randomUUID(),
      sessionId: null,
      status: "pending",
      prompt,
      options,
      output: null,
      error: null,
      signals: [],
      cost: null,
      liveUrl: null,
      startedAt: null,
      completedAt: null,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  private async executeTask(task: PoolTask): Promise<void> {
    await this.semaphore.acquire();
    try {
      task.status = "running";
      task.startedAt = Date.now();

      const sdkOptions: RunSessionOptions = {};
      if (task.options.model) sdkOptions.model = task.options.model;
      if (task.options.sessionId) sdkOptions.sessionId = task.options.sessionId;
      if (task.options.keepAlive != null) sdkOptions.keepAlive = task.options.keepAlive;
      if (task.options.maxCostUsd != null) sdkOptions.maxCostUsd = task.options.maxCostUsd;
      if (task.options.profileId) sdkOptions.profileId = task.options.profileId;
      if (task.options.proxyCountryCode) {
        sdkOptions.proxyCountryCode = task.options.proxyCountryCode as any;
      }
      if (task.options.timeout != null) sdkOptions.timeout = task.options.timeout;
      if (task.options.interval != null) sdkOptions.interval = task.options.interval;

      const sessionRun = this.client.run(task.prompt, sdkOptions);
      task.sessionId = sessionRun.sessionId;

      const result: SessionResult = await sessionRun;
      task.sessionId = result.id;
      task.output = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      task.cost = result.totalCostUsd;
      task.liveUrl = result.liveUrl ?? null;
      task.status = "completed";
      task.completedAt = Date.now();

      // Extract and emit signals
      if (task.output) {
        task.signals = extractSignals(task.id, task.prompt, task.output);
        for (const signal of task.signals) {
          for (const handler of this.signalHandlers) {
            try {
              handler(signal, task);
            } catch {
              // don't let a handler crash the pool
            }
          }
        }
      }
    } catch (err) {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = Date.now();
    } finally {
      this.semaphore.release();
    }
  }
}
