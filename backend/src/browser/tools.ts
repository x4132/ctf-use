import { tool } from "ai";
import { z } from "zod";
import type { TaskPool } from "./pool.js";
import * as presets from "./presets.js";

export function createBrowserTools(pool: TaskPool) {
  return {
    browser_navigate: tool({
      description:
        "Navigate a cloud browser to a URL and perform a task. The browser agent executes autonomously. " +
        "Use for any web interaction: reading pages, filling forms, clicking buttons, extracting content.",
      inputSchema: z.object({
        task: z.string().describe("Natural language instruction for what the browser should do"),
        startUrl: z.string().optional().describe("URL to start from (include in the task description too)"),
        model: z.enum(["bu-mini", "bu-max"]).optional().describe("bu-mini (fast/cheap) or bu-max (more capable). Default: bu-mini"),
        maxCostUsd: z.number().optional().describe("Cost cap in USD. Agent stops if exceeded"),
        sessionId: z.string().optional().describe("Reuse an existing session for follow-up tasks"),
        keepAlive: z.boolean().optional().describe("Keep session alive after task for follow-ups"),
      }),
      execute: async ({ task, startUrl, model, maxCostUsd, sessionId, keepAlive }) => {
        const prompt = startUrl ? `Navigate to ${startUrl}. ${task}` : task;
        const result = await pool.run(prompt, { model, maxCostUsd, sessionId, keepAlive });
        return {
          output: result.output,
          status: result.status,
          cost: result.cost,
          liveUrl: result.liveUrl,
          sessionId: result.sessionId,
          signals: result.signals,
        };
      },
    }),

    browser_recon: tool({
      description:
        "Perform web reconnaissance on a target URL. Discovers forms, cookies, headers, " +
        "tech stack, links, and JavaScript files. Use as a first step when investigating a target.",
      inputSchema: z.object({
        targetUrl: z.string().describe("The URL to perform reconnaissance on"),
      }),
      execute: async ({ targetUrl }) => {
        const task = presets.recon(targetUrl);
        const result = await pool.run(task.prompt, task.options);
        return {
          output: result.output,
          status: result.status,
          cost: result.cost,
          signals: result.signals,
        };
      },
    }),

    browser_xss_probe: tool({
      description:
        "Test a URL parameter for Cross-Site Scripting (XSS) vulnerabilities by injecting " +
        "common test payloads and checking if they are reflected unescaped.",
      inputSchema: z.object({
        targetUrl: z.string().describe("The URL to test for XSS"),
        paramName: z.string().describe("The parameter name to inject payloads into"),
      }),
      execute: async ({ targetUrl, paramName }) => {
        const task = presets.xssProbe(targetUrl, paramName);
        const result = await pool.run(task.prompt, task.options);
        return {
          output: result.output,
          status: result.status,
          cost: result.cost,
          signals: result.signals,
        };
      },
    }),

    browser_sqli_probe: tool({
      description:
        "Test a URL parameter for SQL Injection vulnerabilities using diagnostic payloads " +
        "including error-based, boolean-based, UNION-based, and time-based techniques.",
      inputSchema: z.object({
        targetUrl: z.string().describe("The URL to test for SQL injection"),
        paramName: z.string().describe("The parameter name to inject payloads into"),
      }),
      execute: async ({ targetUrl, paramName }) => {
        const task = presets.sqliProbe(targetUrl, paramName);
        const result = await pool.run(task.prompt, task.options);
        return {
          output: result.output,
          status: result.status,
          cost: result.cost,
          signals: result.signals,
        };
      },
    }),

    browser_source_analysis: tool({
      description:
        "Analyze a web page's source code for sensitive information: HTML comments, " +
        "hidden fields, hardcoded secrets, debug artifacts, robots.txt, and flag patterns.",
      inputSchema: z.object({
        targetUrl: z.string().describe("The URL to analyze"),
      }),
      execute: async ({ targetUrl }) => {
        const task = presets.sourceAnalysis(targetUrl);
        const result = await pool.run(task.prompt, task.options);
        return {
          output: result.output,
          status: result.status,
          cost: result.cost,
          signals: result.signals,
        };
      },
    }),

    browser_form_submit: tool({
      description:
        "Submit a web form with specified field values. Useful for testing login forms, " +
        "search inputs, or any form-based interaction with crafted payloads.",
      inputSchema: z.object({
        targetUrl: z.string().describe("URL where the form is located"),
        formSelector: z.string().describe("CSS selector or description to identify the form"),
        fields: z.record(z.string(), z.string()).describe("Field name-value pairs to fill in"),
      }),
      execute: async ({ targetUrl, formSelector, fields }) => {
        const task = presets.formSubmit(targetUrl, formSelector, fields);
        const result = await pool.run(task.prompt, task.options);
        return {
          output: result.output,
          status: result.status,
          cost: result.cost,
          signals: result.signals,
        };
      },
    }),

    browser_cookie_analysis: tool({
      description:
        "Analyze cookies and session tokens at a URL. Inspects cookie flags, " +
        "decodes base64/JWT values, and checks for session security issues.",
      inputSchema: z.object({
        targetUrl: z.string().describe("The URL to analyze cookies for"),
      }),
      execute: async ({ targetUrl }) => {
        const task = presets.cookieAnalysis(targetUrl);
        const result = await pool.run(task.prompt, task.options);
        return {
          output: result.output,
          status: result.status,
          cost: result.cost,
          signals: result.signals,
        };
      },
    }),

    browser_path_discovery: tool({
      description:
        "Check common sensitive paths at a target URL (robots.txt, .git, .env, admin, flag, etc). " +
        "Reports which paths are accessible with HTTP status codes and content summaries.",
      inputSchema: z.object({
        targetUrl: z.string().describe("The base URL to check paths against"),
      }),
      execute: async ({ targetUrl }) => {
        const task = presets.pathDiscovery(targetUrl);
        const result = await pool.run(task.prompt, task.options);
        return {
          output: result.output,
          status: result.status,
          cost: result.cost,
          signals: result.signals,
        };
      },
    }),

    browser_parallel: tool({
      description:
        "Run multiple browser tasks in parallel. Use when you need to probe multiple " +
        "URLs or test multiple payloads simultaneously for efficiency. Each task gets its own browser.",
      inputSchema: z.object({
        tasks: z.array(z.object({
          task: z.string().describe("Natural language instruction for the browser"),
          startUrl: z.string().optional().describe("URL to start from"),
          model: z.enum(["bu-mini", "bu-max"]).optional().describe("Model to use for this task"),
        })).min(1).max(10).describe("Array of tasks to run in parallel"),
      }),
      execute: async ({ tasks }) => {
        const results = await pool.runAll(
          tasks.map((t) => ({
            prompt: t.startUrl ? `Navigate to ${t.startUrl}. ${t.task}` : t.task,
            options: t.model ? { model: t.model as "bu-mini" | "bu-max" } : undefined,
          })),
        );
        return results.map((r) => ({
          prompt: r.prompt,
          output: r.output,
          status: r.status,
          cost: r.cost,
          signals: r.signals,
        }));
      },
    }),

    browser_check_signals: tool({
      description:
        "Return all signals/findings collected from browser tasks so far. " +
        "Use to review what vulnerabilities or interesting findings have been detected across all tasks.",
      inputSchema: z.object({}),
      execute: async () => {
        const signals = pool.getSignals();
        return {
          count: signals.length,
          signals: signals.map((s) => ({
            type: s.type,
            confidence: s.confidence,
            details: s.details,
            evidence: s.evidence,
            suggestedFollowUps: s.suggestedFollowUps,
          })),
        };
      },
    }),
  };
}
