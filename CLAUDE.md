# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

OpenMAIC (Open Multi-Agent Interactive Classroom) — a Next.js 16 / React 19 app that turns topics or documents into AI-delivered classrooms with slides, quizzes, HTML simulations, PBL activities, a real-time whiteboard, TTS, and multi-agent discussion. Requires Node >= 20.9 and pnpm >= 10. Package manager is pinned via `packageManager` in `package.json`; always use pnpm (there is a `pnpm-workspace.yaml`).

## Common commands

```bash
pnpm install              # also runs postinstall to build packages/mathml2omml + packages/pptxgenjs
pnpm dev                  # next dev (http://localhost:3000)
pnpm build && pnpm start  # production
pnpm lint                 # ESLint (next/core-web-vitals + typescript)
pnpm lint --fix
pnpm check                # prettier --check
pnpm format               # prettier --write
npx tsc --noEmit          # type check (CI runs this)
pnpm check:i18n-keys      # verify every locale has the same keys as en-US.json

pnpm test                 # vitest (tests/**/*.test.ts)
pnpm vitest run tests/path/to/file.test.ts        # single file
pnpm vitest -c vitest.eval.config.ts              # eval tests (tests/**/*.eval.test.ts)
pnpm eval:whiteboard      # tsx eval/whiteboard-layout/runner.ts

pnpm test:e2e             # Playwright (e2e/tests, runs against port 3002 via its own webServer)
pnpm test:e2e:ui
```

Notes:
- `postinstall` builds the two workspace packages. If you edit `packages/pptxgenjs` or `packages/mathml2omml`, re-run `pnpm install` (or `pnpm -C packages/pptxgenjs build`).
- The `tsconfig.json` excludes `packages/*/src` and `e2e`, so type-checking them is handled by their own configs / Playwright.
- Prefer running `pnpm lint --fix` and `pnpm format` before committing — CI runs both.

## High-level architecture

The app is a single Next.js App Router project. Business logic lives under `lib/`; UI under `components/`; server endpoints under `app/api/`. Path alias `@/*` maps to repo root.

### Core pipelines

- **Generation pipeline** (`lib/generation/`) — Two stages: outline generation (`outline-generator.ts`) → per-scene content generation (`scene-generator.ts`, `scene-builder.ts`, `generation-pipeline.ts`, `pipeline-runner.ts`). Prompts live in `lib/generation/prompts/` (with `loader.ts`, `snippets/`, `templates/`). JSON output is streamed and repaired (`json-repair.ts`, `partial-json`).
- **Multi-agent orchestration** (`lib/orchestration/`) — LangGraph `StateGraph` ("director graph"). Unified topology for single- and multi-agent: `START → director → (end | agent_generate → director)`. Single-agent takes code-only fast paths; multi-agent uses the LLM to pick the next speaker. Streaming via LangGraph custom stream mode + `config.writer()` SSE.
- **Playback engine** (`lib/playback/engine.ts`) — State machine `idle → playing ⇄ paused` with a branch into `live` (discussion). Executes `Scene.actions[]` via `ActionEngine` (`lib/action/engine.ts`), driving audio, whiteboard, slides, and effects. Do not add an intermediate compile step — actions are consumed directly.
- **Action engine** (`lib/action/engine.ts`) — Executes 28+ action types (speech, whiteboard draw/text/shape/chart, spotlight, laser pointer, etc.). Centralized type defs in `lib/types/action.ts`.

### AI provider abstraction

- `lib/ai/providers.ts` — unified facade over Vercel AI SDK for OpenAI, Anthropic, Google, plus OpenAI-compatible providers (DeepSeek, Kimi, GLM, SiliconFlow, Doubao, Qwen, Grok, MiniMax-Anthropic, Ollama). Client and server both import from here, so **do not import server-only modules (`node:async_hooks`, etc.) in this file**; the thinking context is read off `globalThis`.
- `lib/ai/thinking-context.ts` — server-only; uses AsyncLocalStorage.
- Provider keys are read from env (`{PROVIDER}_API_KEY`, `{PROVIDER}_BASE_URL`, `{PROVIDER}_MODELS`) and/or `server-providers.yml`. `DEFAULT_MODEL` sets the server default. See `.env.example` for the full list — TTS/ASR/Image/Video have their own `{CATEGORY}_{PROVIDER}_*` prefixes.

### State

Zustand stores in `lib/store/` (`canvas`, `settings`, `stage`, `user-profile`, `media-generation`, `whiteboard-history`, `snapshot`, `keyboard`). Persistence uses Dexie (IndexedDB) via `lib/storage/`.

### API routes (`app/api/`)

About 18 endpoints, including:
- `generate/*` — scene outlines (SSE stream), scene content/actions, images, video, TTS, agent profiles
- `generate-classroom/*` — async classroom job submission + polling (used by the OpenClaw skill)
- `chat/route.ts` — multi-agent discussion SSE stream (calls the director graph)
- `pbl/chat`, `quiz-grade`, `parse-pdf`, `transcription`, `web-search`, `verify-*`
- `access-code/*`, `health` — whitelisted by middleware

### Access control

`middleware.ts` implements optional `ACCESS_CODE` gating via an HMAC-SHA256 signed cookie (`openmaic_access`). When `ACCESS_CODE` is unset the middleware is a no-op. `/api/access-code/*` and `/api/health` are whitelisted; other `/api/*` calls return 401 when unauthenticated. Verification uses the Edge-compatible Web Crypto API — keep it that way.

### Workspace packages

- `packages/pptxgenjs` — customized PowerPoint exporter (used by `lib/export/`).
- `packages/mathml2omml` — MathML → Office Math conversion for formula export.

Both are vendored and built on `postinstall`. Their `src/` is excluded from the root tsconfig.

### Internationalization

- `lib/i18n/locales/{en-US,zh-CN,ja-JP,ru-RU,ar-SA}.json` — flat JSON, i18next double-brace interpolation (`{{var}}`).
- `lib/i18n/TRANSLATION_GUIDE.md` documents UX-sensitive keys (greetings, PBL system messages, truncation toasts, agent-bar copy). When adding keys, preserve interpolation variables and run `pnpm check:i18n-keys` — it fails if any locale drifts from `en-US.json`, if values are arrays, or if an object is empty.
- **All user-facing strings must be i18n'd** (called out in `CONTRIBUTING.md`).

## Conventions

- **Branches:** `feat/…`, `fix/…`, `docs/…`. Conventional Commits (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `perf`, `style`) with an optional scope, e.g. `feat(tts): add Azure TTS provider`.
- **PRs:** one concern each, must link an issue (`Closes #123`), include before/after screenshots for UI, and pass `pnpm format`, `pnpm lint --fix`, `npx tsc --noEmit`. Keep drafts in Draft until you've manually regression-tested the flow. Refactor-only PRs are not accepted unless a maintainer asks.
- **AI-assisted PRs** are welcome but must be marked as such and self-reviewed (e.g. with another AI code review) before requesting human review.
- Types live centrally in `lib/types/` (action, chat, stage, slides, provider, generation, roundtable, pdf, export, settings, web-search, edit). Prefer importing from there rather than redeclaring.
- `eslint.config.mjs` globally ignores `packages/**`, `e2e/**`, and Claude/worktree dirs. `@next/next/no-img-element` is off (AI-generated image URLs are dynamic). Unused vars/args prefixed with `_` are allowed.

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
