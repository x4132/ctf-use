import { Daytona } from "@daytonaio/sdk";
import type { Sandbox } from "@daytonaio/sdk";

const OPENCODE_PORT = 4096;
const OPENCODE_VERSION = "1.1.1";
const DEFAULT_MODEL = "minimax-m2.5-free";
const READY_MARKER = "opencode server listening";
const SERVER_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1000;

export interface SandboxHandle {
  baseUrl: string;
  sandbox: Sandbox;
  destroy(): Promise<void>;
}

export async function createSandbox(
  chatId: string,
  rules: string,
  model?: string,
): Promise<SandboxHandle> {
  console.log(`[${chatId}] Creating Daytona sandbox`);
  const daytona = new Daytona();

  const sandbox = await daytona.create({
    public: true,
    resources: { cpu: 2, memory: 4, disk: 8 },
    autoStopInterval: 30,
  });
  console.log(`[${chatId}] Sandbox created: ${sandbox.id}`);

  // Install opencode
  await sandbox.process.executeCommand(
    `npm i -g opencode-ai@${OPENCODE_VERSION}`,
  );
  console.log(`[${chatId}] opencode installed`);

  // Write CTF rules to the rules directory
  const safeRules = rules.replace(/RULES_EOF/g, "RULES__EOF");
  await sandbox.process.executeCommand(
    `mkdir -p /home/daytona/.opencode/rules && cat > /home/daytona/.opencode/rules/ctf.md << 'RULES_EOF'\n${safeRules}\nRULES_EOF`,
  );
  console.log(`[${chatId}] CTF rules written`);

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

  // Start opencode server in background
  const sessionId = `opencode-${sandbox.id}`;
  await sandbox.process.createSession(sessionId);

  const command = await sandbox.process.executeSessionCommand(sessionId, {
    command: `cd /home/daytona && BROWSER_USE_API_KEY=${process.env.BROWSER_USE_API_KEY ?? ""} OPENCODE_CONFIG=/home/daytona/opencode.json OPENCODE_DISABLE_MODELS_FETCH=true OPENCODE_DISABLE_AUTOUPDATE=true opencode serve --port ${OPENCODE_PORT} --hostname 0.0.0.0 2>&1`,
    runAsync: true,
  });

  if (!command.cmdId) {
    throw new Error("Failed to start opencode server in sandbox");
  }
  console.log(`[${chatId}] opencode server started (async), cmdId=${command.cmdId}`);

  // Wait for server readiness by tailing logs
  await waitForServer(sandbox, sessionId, command.cmdId, chatId);

  // Get public preview URL
  const preview = await sandbox.getPreviewLink(OPENCODE_PORT);
  const baseUrl = preview.url.replace(/\/$/, "");
  console.log(`[${chatId}] opencode server ready at ${baseUrl}`);

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
): Promise<SandboxHandle> {
  console.log(`[${chatId}] Reconnecting to sandbox ${sandboxId}`);
  const daytona = new Daytona();
  const sandbox = await daytona.get(sandboxId);

  // Start the sandbox if it was auto-stopped
  await sandbox.start();
  console.log(`[${chatId}] Sandbox ${sandboxId} is running`);

  const preview = await sandbox.getPreviewLink(OPENCODE_PORT);
  const baseUrl = preview.url.replace(/\/$/, "");
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

export async function deleteSandboxById(sandboxId: string): Promise<void> {
  const daytona = new Daytona();
  const sandbox = await daytona.get(sandboxId);
  await sandbox.delete();
  console.log(`Sandbox ${sandboxId} deleted by ID`);
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
  throw new Error(`[${chatId}] Timed out waiting for opencode server to become ready`);
}
