import { Daytona } from "@daytonaio/sdk";
import type { Sandbox } from "@daytonaio/sdk";

const OPENCODE_PORT = 4096;
const OPENCODE_VERSION = "1.1.1";
const DEFAULT_MODEL = "amazon-bedrock/anthropic.claude-opus-4-5";
const READY_MARKER = "opencode server listening";
const SERVER_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1000;

export interface SandboxHandle {
  baseUrl: string;
  sandbox: Sandbox;
  destroy(): Promise<void>;
}

/**
 * Start (or restart) the OpenCode server inside an already-running sandbox.
 * Creates the process session if needed, launches `opencode serve`, and waits
 * for the readiness marker. Returns the public base URL.
 */
async function startOpenCodeServer(
  sandbox: Sandbox,
  chatId: string,
): Promise<string> {
  const sessionId = `opencode-${sandbox.id}`;
  try {
    await sandbox.process.createSession(sessionId);
  } catch {
    // Session may already exist from a prior run
  }

  const command = await sandbox.process.executeSessionCommand(sessionId, {
    command: `cd /home/daytona && BROWSER_USE_API_KEY='${process.env.BROWSER_USE_API_KEY ?? ""}' OPENCODE_CONFIG=/home/daytona/opencode.json OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_AUTOUPDATE=true opencode serve --port ${OPENCODE_PORT} --hostname 0.0.0.0 2>&1`,
    runAsync: true,
  });

  if (!command.cmdId) {
    throw new Error("Failed to start Agent server in sandbox");
  }
  console.log(`[${chatId}] Agent server started (async), cmdId=${command.cmdId}`);

  await waitForServer(sandbox, sessionId, command.cmdId, chatId);

  const preview = await sandbox.getPreviewLink(OPENCODE_PORT);
  const baseUrl = preview.url.replace(/\/$/, "");
  console.log(`[${chatId}] Agent server ready at ${baseUrl}`);
  return baseUrl;
}

export async function createSandbox(
  chatId: string,
  model?: string,
  onStatus?: (status: string) => void,
): Promise<SandboxHandle> {
  onStatus?.("Creating sandbox...");
  console.log(`[${chatId}] Creating Daytona sandbox`);
  const daytona = new Daytona();

  const sandbox = await daytona.create({
    public: true,
    resources: { cpu: 2, memory: 4, disk: 8 },
    autoStopInterval: 30,
  });
  console.log(`[${chatId}] Sandbox created: ${sandbox.id}`);

  // Install opencode
  onStatus?.("Installing Agent...");
  await sandbox.process.executeCommand(
    `npm i -g opencode-ai@${OPENCODE_VERSION}`,
  );
  console.log(`[${chatId}] agent installed`);

  // Write opencode config file
  const config = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    permission: { "*": "allow" },
    autoupdate: false,
    share: "disabled",
    mcp: {
      "browser-use": {
        type: "remote",
        url: "https://api.browser-use.com/mcp",
        enabled: true,
        headers: {
          "X-Browser-Use-API-Key": "{env:BROWSER_USE_API_KEY}",
        },
      },
      context7: {
        type: "remote",
        url: "https://mcp.context7.com/mcp",
        enabled: true,
      },
    },
  });
  const safeConfig = config.replace(/CONFIG_EOF/g, "CONFIG__EOF");
  await sandbox.process.executeCommand(
    `cat > /home/daytona/opencode.json << 'CONFIG_EOF'\n${safeConfig}\nCONFIG_EOF`,
  );
  console.log(`[${chatId}] opencode config written`);

  onStatus?.("Starting Agent server...");
  const baseUrl = await startOpenCodeServer(sandbox, chatId);

  // Authenticate with Amazon Bedrock (equivalent to /connect)
  onStatus?.("Authenticating with Amazon Bedrock...");
  await fetch(`${baseUrl}/auth/amazon-bedrock`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "api", key: process.env.AMAZON_BEDROCK_API_KEY ?? "" }),
  });
  console.log(`[${chatId}] Bedrock auth set`);

  // Set model via API
  onStatus?.("Setting model...");
  await fetch(`${baseUrl}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: model ?? DEFAULT_MODEL }),
  });
  console.log(`[${chatId}] Model set to ${model ?? DEFAULT_MODEL}`);

  onStatus?.("Sandbox ready");

  return {
    baseUrl,
    sandbox,
    destroy: async () => {
      try {
        await sandbox.delete();
        console.log(`[${chatId}] Sandbox deleted`);
      } catch {
        // best-effort
      }
    },
  };
}

export async function reconnectToSandbox(
  sandboxId: string,
  chatId: string,
  onStatus?: (status: string) => void,
): Promise<SandboxHandle> {
  console.log(`[${chatId}] Reconnecting to sandbox ${sandboxId}`);
  const daytona = new Daytona();
  const sandbox = await daytona.get(sandboxId);

  // Start the sandbox if it was stopped (no-op if already running)
  await sandbox.start();
  console.log(`[${chatId}] Sandbox ${sandboxId} is running`);

  // Check if OpenCode server is already alive (e.g. sandbox never stopped, just backend restarted)
  const preview = await sandbox.getPreviewLink(OPENCODE_PORT);
  let baseUrl = preview.url.replace(/\/$/, "");

  const alive = await isOpenCodeAlive(baseUrl);
  if (alive) {
    console.log(`[${chatId}] Agent server already running at ${baseUrl}`);
  } else {
    console.log(`[${chatId}] Agent server not responding, restarting...`);
    onStatus?.("Restarting Agent server...");
    baseUrl = await startOpenCodeServer(sandbox, chatId);
  }
  console.log(`[${chatId}] Reconnected to sandbox at ${baseUrl}`);

  return {
    baseUrl,
    sandbox,
    destroy: async () => {
      try {
        await sandbox.delete();
        console.log(`[${chatId}] Sandbox deleted`);
      } catch {
        // best-effort
      }
    },
  };
}

export async function stopSandboxById(sandboxId: string): Promise<void> {
  const daytona = new Daytona();
  const sandbox = await daytona.get(sandboxId);
  await sandbox.stop();
  console.log(`Sandbox ${sandboxId} stopped`);
}

export async function deleteSandboxById(sandboxId: string): Promise<void> {
  const daytona = new Daytona();
  const sandbox = await daytona.get(sandboxId);
  await sandbox.delete();
  console.log(`Sandbox ${sandboxId} deleted by ID`);
}

async function isOpenCodeAlive(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/session`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(
  sandbox: Sandbox,
  sessionId: string,
  cmdId: string,
  chatId: string,
): Promise<void> {
  const deadline = Date.now() + SERVER_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const logs = await sandbox.process.getSessionCommandLogs(
        sessionId,
        cmdId,
      );
      if (logs.includes(READY_MARKER)) {
        return;
      }
    } catch {
      // logs may not be available yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`[${chatId}] Timed out waiting for agent server to become ready`);
}
