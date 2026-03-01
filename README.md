# hacker-use

`hacker-use` is an AI agent for solving web exploitation CTF challenges.

It provides:

- A React chat UI for running investigations
- A Bun backend that orchestrates agent sessions through OpenCode
- A Daytona cloud sandbox per chat
- Convex persistence and real-time streaming of messages/tool output
- Optional loop mode that keeps iterating until a flag is found or a max iteration limit is reached

## Architecture

- `backend/` (Bun + Hono + tRPC)
- `frontend/` (React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui)
- `convex/` (chat/message data model + mutations/queries)

High-level flow:

1. User sends a prompt from the frontend.
2. Backend creates/reconnects a Daytona sandbox for that chat.
3. Backend creates/resumes an OpenCode session in the sandbox.
4. OpenCode streams SSE events (text, tool calls, reasoning).
5. Backend writes streamed updates to Convex.
6. Frontend reactively renders updates from Convex.

## Repository Layout

- `backend/src/index.ts`: Hono server entry (`/trpc/*` + health route)
- `backend/src/trpc/router.ts`: chat lifecycle and orchestration endpoints
- `backend/src/agent/sandbox.ts`: Daytona sandbox + OpenCode server bootstrap
- `backend/src/agent/session.ts`: OpenCode session and SSE event handling
- `backend/src/agent/loop.ts`: loop mode orchestration
- `backend/src/agent/flag-detector.ts`: AI-based flag detection (Dedalus)
- `convex/schema.ts`: Convex schema (`chats`, `chatMessages`)
- `frontend/src/components/chat-page.tsx`: primary chat UI
- `OPENCODE_API.md`: OpenCode API notes used by this integration

## Prerequisites

- Node.js (for pnpm tooling and frontend)
- Bun (backend runtime)
- pnpm `10.11.0` (or compatible)
- A Convex project/deployment
- Daytona API access
- Model API keys used by OpenCode in sandbox

## Environment Variables

Create the following files in the repo root.

### `.env`

Required:

- `DAYTONA_API_KEY`: Daytona SDK auth for sandbox creation
- `AMAZON_BEDROCK_API_KEY`: OpenCode model auth (set via `/auth/amazon-bedrock`)
- `BROWSER_USE_API_KEY`: passed into sandbox OpenCode server for browser-use MCP
- `CONVEX_URL`: Convex deployment URL (used by backend)

Optional:

- `DEDALUS_API_KEY`: required for AI flag detection used in loop mode
- `PORT`: backend port (default `3001`)

### `.env.local`

Required for Convex/local frontend wiring:

- `CONVEX_URL`
- `CONVEX_DEPLOYMENT`

Frontend also accepts `VITE_CONVEX_URL` (fallbacks to `CONVEX_URL`).

## Quick Start

1. Install dependencies:

```bash
pnpm install
```

2. Start Convex dev (in a separate terminal):

```bash
npx convex dev
```

3. Start backend + frontend:

```bash
pnpm dev
```

4. Open:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

## Commands

From repo root:

- `pnpm dev`: run backend (Bun watch) + frontend (Vite dev)
- `pnpm start`: run backend + frontend preview
- `pnpm typecheck`: backend and frontend type-check

Backend only:

- `bun --watch backend/src/index.ts`
- `bun backend/src/index.ts`
- `bunx tsc -p backend/tsconfig.json --noEmit`

From `frontend/`:

- `pnpm dev`
- `pnpm build`
- `pnpm lint`
- `pnpm preview`
- `pnpm exec tsc -p tsconfig.app.json --noEmit`

## tRPC API Surface

Defined in `backend/src/trpc/router.ts`:

- `health`
- `chat.send`
- `chat.stop`
- `chat.stopSandbox`
- `chat.startSandbox`
- `chat.destroy`

Frontend uses `AppRouter` types directly for end-to-end type safety.

## Notes

- Backend must run on Bun. `backend/src/index.ts` explicitly throws if Bun is unavailable.
- Sandboxes are persisted per chat (`sandboxId` in Convex) and reconnected after backend restart.
- `chatMessages` include `kind` values: `message`, `status`, `tool`, `reasoning`.
- Current root `test` script is a placeholder; automated tests are not yet set up.

## Security

This project is intended for authorized CTF and legal security testing scenarios only.
