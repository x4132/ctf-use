# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

hacker-use is an AI agent built to automatically solve Web Exploitation CTF challenges. It consists of a monorepo with a backend API server, a React frontend, and a Convex real-time database.

## Architecture

- **Monorepo** managed with pnpm (v10.11.0) from the root `package.json`. Only `frontend/` is a workspace package; backend dependencies live at root.
- **Backend** (`backend/`): Hono HTTP server with tRPC router, run via **Bun** (not Node). Listens on port 3001 by default (configurable via `PORT` env var).
- **Frontend** (`frontend/`): React 19 + Vite 7 + TypeScript. Uses Tailwind CSS v4 (via `@tailwindcss/vite` plugin), shadcn/ui components (base-vega style, Base UI primitives), and lucide-react icons. Path alias `@/` maps to `src/`.
- **Convex** (`convex/`): Real-time backend-as-a-service for persisting chats and messages. Frontend subscribes reactively; backend writes via HTTP client.
- **Communication**: Frontend calls backend via tRPC (proxied through Vite at `/trpc` in dev). `AppRouter` type is exported from `backend/src/trpc/router.ts` for end-to-end type safety.

### Agent Pipeline

When a user sends a message, the backend orchestrates:

1. **Sandbox** (`backend/src/agent/sandbox.ts`): Provisions a Daytona cloud sandbox (Linux, 2 CPU / 4GB RAM) with OpenCode AI installed. Writes CTF rules (`system-prompt.ts`) into the sandbox. Persists sandbox ID to Convex for reconnection across restarts.
2. **Session** (`backend/src/agent/session.ts`): Creates an OpenCode session in the sandbox. Sends prompts and subscribes to SSE event stream for responses.
3. **Results**: Text parts and tool execution statuses are streamed incrementally to Convex as `chatMessages`. The frontend reactively displays them.

In-memory `Map<chatId, ChatSession>` tracks active sandbox+session pairs. Sessions auto-reconnect to persisted sandboxes on backend restart.

### OpenCode API

**Read [`OPENCODE_API.md`](./OPENCODE_API.md) before modifying any OpenCode integration code.** It contains the full OpenCode server API reference (events, sessions, messages, parts). Key points:

- `message.updated` events fire for **both** user and assistant messages — check `info.role`
- Every part (`message.part.updated`) has a `messageID` linking it to its parent message
- `TextPart.text` is the full accumulated text, not a delta
- The `/event` endpoint returns unwrapped `Event` objects; `/global/event` wraps them in `GlobalEvent`

## Commands

```bash
# Install dependencies (from root)
pnpm install

# Development (both backend + frontend concurrently)
pnpm dev

# Backend only
pnpm backend:dev          # dev server with hot reload (bun --watch)
pnpm backend:start        # production start
bunx tsc -p backend/tsconfig.json --noEmit  # type-check backend only

# Frontend (run from frontend/)
pnpm dev                  # vite dev server
pnpm build                # typecheck + vite build
pnpm lint                 # eslint
pnpm preview              # preview production build

# Type-check everything
pnpm typecheck            # checks both backend and frontend

# Frontend type-check (app sources only)
pnpm exec tsc -p tsconfig.app.json   # from frontend/

# Convex
npx convex dev            # start Convex dev server (syncs schema + functions)

# Add shadcn/ui components (from frontend/)
# Use "echo n |" to avoid overwriting existing files (e.g., button.tsx)
echo "n" | npx shadcn@latest add <component>
```

## Key Files

- `backend/src/index.ts` — Hono server entry, mounts tRPC at `/trpc/*`
- `backend/src/trpc/router.ts` — tRPC router (`AppRouter` type export), chat session lifecycle
- `backend/src/agent/sandbox.ts` — Daytona sandbox creation, reconnection, teardown
- `backend/src/agent/session.ts` — OpenCode session management, SSE event consumption
- `backend/src/agent/system-prompt.ts` — CTF exploitation rules injected into agent
- `backend/src/agent/loop.ts` — Loop mode orchestration (ralph loop pattern for continuous pentesting)
- `backend/src/agent/flag-detector.ts` — AI-powered flag detection via Dedalus Labs structured output
- `backend/src/convex.ts` — Convex HTTP client singleton
- `convex/schema.ts` — Database schema (`chats`, `chatMessages` tables)
- `convex/chats.ts` — Chat CRUD mutations/queries
- `convex/messages.ts` — Message CRUD, auto-titles chat from first user message
- `frontend/src/main.tsx` — Provider setup (Convex, tRPC, React Query)
- `frontend/src/components/chat-page.tsx` — Main chat UI (sidebar + message thread)
- `frontend/src/lib/trpc.ts` — tRPC React client creation
- `frontend/components.json` — shadcn/ui config

## Environment Variables

Required in `.env` (root):
- `DAYTONA_API_KEY` — Daytona sandbox SDK
- `DEDALUS_API_KEY` — Dedalus Labs API (used for AI-powered flag detection in loop mode)

Required in `.env.local` (root):
- `CONVEX_URL` — Convex deployment URL
- `CONVEX_DEPLOYMENT` — Convex deployment identifier

Optional:
- `PORT` — Backend port (default 3001)

## Conventions

- Backend runs on **Bun runtime** — use Bun APIs where applicable
- Backend TypeScript targets ES2022 with NodeNext module resolution
- Frontend uses the `cn()` utility from `@/lib/utils` for merging Tailwind classes
- Vite proxies `/trpc` to `http://localhost:3001` in dev; frontend reads env from parent dir (`envDir: ".."`)
- shadcn/ui components live in `src/components/ui/`; AI chat components in `src/components/ai-elements/` (from Vercel AI SDK registry)
- Convex functions use `v` validator from `convex/values` for schema definitions
- Frontend subscribes to Convex queries reactively (`useQuery`); backend writes via `ConvexHttpClient`

## Context7

**ALWAYS prefer Context7 MCP over web search** for library/API documentation, code generation, setup, or configuration steps. Context7 provides more accurate, structured results and should be the first tool reached for when needing docs or examples. Only fall back to web search if Context7 does not have the information needed. Use Context7 proactively without me having to explicitly ask.

## Bash Guidelines

### IMPORTANT: Avoid commands that cause output buffering issues

- DO NOT pipe output through `head`, `tail`, `less`, or `more` when monitoring or checking command output
- DO NOT use `| head -n X` or `| tail -n X` to truncate output - these cause buffering problems
- For log monitoring, prefer reading files directly rather than piping through filters

### When checking command output:

- Run commands directly without pipes when possible
- If you need to limit output, use command-specific flags (e.g., `git log -n 10` instead of `git log | head -10`)
- Avoid chained pipes that can cause output to buffer indefinitely

## Self-Improvement

When you make a mistake or learn something important during a session, update CLAUDE.md with the lesson so you don't repeat it in future sessions.

### Lessons Learned

- In `frontend/`, `pnpm exec tsc` can pass without checking app sources because `tsconfig.json` is solution-style with empty `files` and project references. Use `pnpm exec tsc -p tsconfig.app.json` to validate frontend source files directly.
- If `pnpm --filter hacker-use-frontend ...` reports no matching projects, ensure `pnpm-workspace.yaml` includes `packages: [frontend]`.
- Agent `activity` is a rolling window (max 60 lines), so persistence cursors cannot rely on array length. Use last-seen line matching (`lastActivityLine`) to append only new activity updates.
- Root type-check command is `pnpm typecheck`; there is no `pnpm backend:typecheck` script.
- Browser Use `cloud.browser-use.com` share URLs are not iframe-embeddable (`frame-ancestors 'none'`); for embedded live views, use session `liveUrl` instead.
