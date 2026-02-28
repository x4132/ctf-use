# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

hacker-use is an AI agent built to automatically solve Web Exploitation CTF challenges. It consists of a monorepo with a backend API server and a React frontend.

## Architecture

- **Monorepo** managed with pnpm (v10.11.0) from the root `package.json`
- **Backend** (`backend/`): Hono HTTP server with tRPC router, run via Bun. Listens on port 3001 by default (configurable via `PORT` env var). Uses Vercel AI SDK (`ai` package) for agent capabilities.
- **Frontend** (`frontend/`): React 19 + Vite 7 + TypeScript. Uses Tailwind CSS v4 (via `@tailwindcss/vite` plugin), shadcn/ui components (base-vega style, Base UI primitives), and lucide-react icons. Path alias `@/` maps to `src/`.
- **Communication**: Frontend will consume backend via tRPC. The `AppRouter` type is exported from `backend/src/trpc/router.ts` for end-to-end type safety.

## Commands

```bash
# Install dependencies (from root)
pnpm install

# Backend
pnpm backend:dev          # dev server with hot reload (bun --watch)
pnpm backend:start        # production start
pnpm backend:typecheck    # type-check backend only

# Frontend (run from frontend/)
pnpm dev                  # vite dev server
pnpm build                # typecheck + vite build
pnpm lint                 # eslint
pnpm preview              # preview production build
```

## Key Files

- `backend/src/index.ts` — Hono server entry, mounts tRPC at `/trpc/*`
- `backend/src/trpc/router.ts` — tRPC router definition and `AppRouter` type export
- `frontend/src/App.tsx` — React app root
- `frontend/components.json` — shadcn/ui config

## Conventions

- Backend TypeScript targets ES2022 with NodeNext module resolution
- Frontend uses the `cn()` utility from `@/lib/utils` for merging Tailwind classes
- shadcn/ui components live in `src/components/ui/`; add new ones via `pnpm dlx shadcn@latest add <component>` from the frontend directory

## Context7

Always use Context7 MCP when I need library/API documentation, code generation, setup or configuration steps without me having to explicitly ask.

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
