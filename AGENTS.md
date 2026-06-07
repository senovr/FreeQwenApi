<!-- GSD:project-start source:PROJECT.md -->

## Project

**FreeQwenApi — Headless Multi-Platform**

FreeQwenApi is an OpenAI-compatible API proxy that turns Qwen Chat web sessions into a local REST API endpoint. Currently it requires a GUI browser for login (Puppeteer opens Chrome). The goal is to make it work on any platform — headless Linux servers (x86_64, ARM64/aarch64, RISC-V, ARM32), macOS (M-series), Windows — and allow authentication without physical access to a browser on that machine.

The proxy is used as a backend for AI tools: OpenCode, Hermes (via Telegram/Signal), Open WebUI, LiteLLM, and the OpenAI SDK.

**Core Value:** FreeQwenApi must work reliably on **any platform without a GUI**, allowing login from a phone or remote device, while preserving existing Windows/GUI workflows.

### Constraints

- **Browser dependency:** Puppeteer requires Chrome/Chromium binary. Must detect system browser or auto-install. On some architectures (RISC-V) Chromium may not be available — need fallback auth flow.
- **Qwen API stability:** Upstream Qwen Chat API is unofficial and may change. Proxy must handle breaking changes gracefully.
- **Token lifecycle:** Tokens expire. Need re-auth without physical access to the server.
- **Multi-arch binaries:** Puppeteer ships Chrome for x86_64 and some ARM. RISC-V and ARM32 have limited browser support.
- **Security:** Tokens and cookies stored in `session/` — must never be committed. Auth endpoints must be protected.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

## Languages

- JavaScript (ES Modules) — Main server implementation, all `src/` code, scripts, and examples
- Python 3 — Alternative implementation (`main.py`) using FastAPI + Playwright
- Shell/Batch — `start.bat`, `test_api.bat` launcher scripts
- PowerShell — `scripts/test_api.ps1` test helper

## Runtime

- Node.js 20 (Dockerfile base: `node:20-slim`)
- Python 3 (via `requirements.txt`, version not pinned)
- npm — Node.js dependency management
- Lockfile: `package-lock.json` present (listed in `.gitignore`)
- pip — Python dependencies (no lockfile)
- ES Modules (`"type": "module"` in `package.json`)

## Frameworks

- Express 4.18 — HTTP server framework (`src/api/routes.js`, `index.js`)
- FastAPI (Python) — Alternative server (`main.py`)
- Puppeteer 24 + `puppeteer-extra` + `puppeteer-extra-plugin-stealth` — Headless browser control for Qwen Chat interaction (`src/browser/browser.js`)
- Playwright (Python) — Alternative browser automation (`main.py`)
- No formal test framework configured (test script is a placeholder: `"test": "echo ... && exit 1"`)
- Manual test scripts in `scripts/` directory (`smoke_test.js`, `run_tests.js`, `test_streaming.js`, `test_direct_qwen.js`)
- Docker — Containerization (`Dockerfile`, `docker-compose.yml`)

## Key Dependencies

- `express` ^4.18.2 — HTTP server
- `puppeteer` ^24.31.0 — Headless Chromium automation
- `puppeteer-extra` ^3.3.6 — Stealth plugin support
- `puppeteer-extra-plugin-stealth` ^2.11.2 — Anti-detection for browser automation
- `axios` ^1.9.0 — HTTP client for DashScope API calls (`src/api/imageGeneration.js`)
- `openai` ^4.104.0 — OpenAI SDK (used in examples only)
- `winston` ^3.17.0 — Structured logging (`src/logger/index.js`)
- `body-parser` ^1.20.2 — Request body parsing (JSON/URL-encoded)
- `morgan` ^1.10.0 — HTTP request logging middleware
- `multer` ^2.0.0 — File upload handling (`src/api/routes.js`)
- `form-data` ^4.0.2 — Multipart form data construction
- `node-fetch` ^3.3.2 — Fetch API polyfill (Node.js native fetch preferred at runtime)
- `ali-oss` ^6.23.0 — Alibaba Cloud OSS SDK (listed but file uploads use browser-side OSS SDK via CDN)

## Python Dependencies (Alternative Server)

- `fastapi` — Web framework for Python alternative server
- `uvicorn` — ASGI server
- `playwright` — Browser automation
- `httpx` — Async HTTP client
- `openai` — OpenAI SDK
- `python-dotenv` — Environment variable loading
- `python-multipart` — File upload support

## Configuration

- Centralized config in `src/config.js` — all values read from env vars with defaults
- `.env` files supported (`.env`, `.env.local`, etc.) — noted in `.gitignore`
- Key config categories: API URLs, timeouts, limits, paths, browser settings, server settings, logging

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3264` | Server port |
| `HOST` | `0.0.0.0` | Server bind address |
| `QWEN_BASE_URL` | `https://chat.qwen.ai` | Qwen Chat base URL |
| `DEFAULT_MODEL` | `qwen-max-latest` | Default chat model |
| `NODE_ENV` | — | Node.js environment |
| `CHROME_PATH` | — | Custom Chromium binary path |
| `DASHSCOPE_API_KEY` | — | DashScope API key for image generation |
| `PAGE_POOL_SIZE` | `3` | Puppeteer page pool size |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `SKIP_ACCOUNT_MENU` | `false` | Skip interactive account menu |
| `STREAMING_CHUNK_DELAY` | `20` | Delay between SSE chunks (ms) |
| `ALLOW_UNSCOPED_SESSION_CHAT_RESTORE` | `false` | Enable unscoped session restore |
| `MAX_FILE_SIZE` | `10MB` | Upload file size limit |
| `QWEN_TOKENS` | — | Import tokens from environment for token-only mode |

- `Dockerfile` — Multi-stage Docker build
- `docker-compose.yml` — Container orchestration with volume mounts

## Platform Requirements

- Node.js >= 20
- Chromium/Chrome browser (for Puppeteer)
- Python 3 (optional, for alternative server)
- npm for package installation
- Docker (recommended) — `docker-compose up` deploys the service
- Port 3264 exposed
- Volume mounts: `session/`, `logs/`, `uploads/`
- Chromium installed in container (via `apt-get` in Dockerfile)
- No database required — state stored in filesystem (JSON files)

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Dual-Language Codebase

- **Node.js (primary):** `index.js` + `src/` — Express + Puppeteer proxy server
- **Python (secondary):** `main.py` — FastAPI + Playwright standalone proxy server

## Naming Patterns

- Use `camelCase` for module files: `chat.js`, `chatHistory.js`, `tokenManager.js`, `fileUpload.js`
- Use `camelCase` for utility files: `accountSetup.js`, `prompt.js`, `branding.js`
- Use `camelCase` for browser modules: `browser.js`, `auth.js`, `session.js`
- Use `snake_case` for script files: `smoke_test.js`, `sync_models.js`, `addAccount.js`
- Config: single `config.js`
- Single entry point: `main.py`
- All code in one file (800 lines)
- Use `camelCase` for all functions: `sendMessage()`, `createChatV2()`, `getMappedModel()`, `loadTokens()`, `saveHistory()`
- Private/helper functions use `camelCase` with no prefix: `buildPayloadV2()`, `extractTaskId()`, `validateAndPrepareMessage()`
- Use `_` prefix only for a few internal helpers in `main.py`: `_normalize_message_content()`, `_extract_messages()`
- Use `snake_case` for all functions: `load_tokens()`, `save_tokens()`, `get_available_token()`, `create_qwen_chat()`
- Async functions: `async def login_interactive()`, `async def handle_chat_completions()`
- `camelCase` in Node.js: `chatId`, `parentId`, `messageContent`, `mappedModel`, `authToken`
- `snake_case` in Python: `chat_id`, `parent_id`, `message_content`, `mapped_model`
- Constants use `UPPER_SNAKE_CASE`: `CHAT_API_URL`, `DEFAULT_MODEL`, `PAGE_TIMEOUT` — defined in `src/config.js`
- Module-level singletons use `camelCase`: `authToken`, `availableModels`, `browserInstance`
- No TypeScript — pure JavaScript throughout
- No JSDoc type annotations on most functions
- A few JSDoc blocks on public API functions in `src/api/modelMapping.js` and `src/api/imageGeneration.js`

## Code Style

- No linter configured (no `.eslintrc`, no `biome.json`, no `.prettierrc`)
- No formatter configured
- Indentation: 4 spaces in Node.js, 4 spaces in Python
- Quotes: single quotes for imports (`import express from 'express'`), double quotes for string content inside JSON
- Trailing commas: used in object literals and arrays
- Semicolons: not used consistently (mostly absent in Node.js files)
- ES modules throughout (`"type": "module"` in `package.json`)
- Use `import`/`export` syntax exclusively — no `require()`
- Named exports preferred: `export function sendMessage()`, `export const pagePool`
- Default exports used for logger: `export default { logHttpRequest, ... }`
- Dynamic imports used for conditional loading: `await import('./src/utils/accountSetup.js')`
- No local module imports — all code in `main.py`
- Standard library imports + third-party: `httpx`, `fastapi`, `playwright`, `pydantic`

## Import Organization

- No path aliases configured
- Use relative paths with `.js` extension: `'./src/api/chat.js'`, `'../config.js'`
- `__dirname` emulation via ESM: `path.dirname(fileURLToPath(import.meta.url))`

## Error Handling

- Route errors: `{ error: { message: "...", type: "server_error" } }`
- Service errors: `{ error: "message string", chatId }`
- Rate limit: HTTP 429 with error body

## Logging

- `logInfo(message)` — General info
- `logError(message, error?)` — Errors with optional stack trace
- `logWarn(message)` — Warnings
- `logDebug(message)` — Debug-level details
- `logRaw(message)` — Raw API responses (custom level)
- `logHttpRequest` — Morgan HTTP middleware
- Console: colorized with timestamps
- File: `logs/combined.log`, `logs/error.log`, `logs/http.log`, `logs/raw-responses.log`
- Rotation: 5 MB max, 5 files each
- Log every incoming request with truncated content
- Log model mapping changes
- Log chat creation and response success
- Log all errors with context
- Use `logDebug` for payload dumps and verbose details
- Use `logRaw` for full API response bodies

## Comments

- Section dividers using ASCII-art banners: `// ===== SECTION NAME =====`
- Inline comments explain "why" in Russian: `// Поддержка как message, так и messages для совместимости`
- JSDoc blocks on exported functions in some modules (`modelMapping.js`, `imageGeneration.js`)
- Most internal functions have no doc comments

## Function Design

- Positional parameters with defaults: `sendMessage(message, model = DEFAULT_MODEL, chatId = null, ...)`
- `sendMessage` has 13 positional parameters — a known pain point
- Destructuring for request body: `const { messages, model, stream } = req.body`
- Type hints used: `def get_mapped_model(model_name: str) -> str`
- Optional imports from typing: `Optional`, `Dict`, `Any`, `List`
- Service functions return plain objects (not classes)
- Success: `{ success: true, data: ..., chatId }` or `{ choices: [...], chatId }`
- Error: `{ error: "message" }` or `{ success: false, error: "message" }`
- Consistent `chatId` field in responses for conversation continuity
- FastAPI routes return dicts (auto-serialized to JSON) or `JSONResponse`/`StreamingResponse`
- Internal functions return dicts with `"success"` boolean key

## Module Design

- Named exports preferred
- One export per file for single-responsibility modules: `export const FORGETMEAI_WATERMARK`
- Multiple related exports from larger modules: `chat.js` exports `sendMessage`, `createChatV2`, `testToken`, etc.
- Re-exports used for aliases: `export { removeToken as removeInvalidToken }` in `src/api/tokenManager.js`
- `src/logger/index.js` acts as a barrel for logging utilities
- No other barrel/index files — imports reference specific module files directly

## Configuration

- Single config file: `src/config.js`
- All values from env vars with defaults: `process.env.PORT || 3264`
- Boolean conversion helper: `toBoolean()` checks for `'1'`, `'true'`, `'yes'`, `'on'`
- Numeric conversion: `Number(process.env.PAGE_TIMEOUT) || 120_000`
- Config consumed via named imports: `import { PORT, HOST } from '../config.js'`
- Inline constants at top of `main.py`
- `os.environ.get("PORT", 3264)`
- `.env` file loaded via `python-dotenv`

## State Management

- `authToken` in `src/api/chat.js` — cached bearer token
- `availableModels` in `src/api/chat.js` — lazy-loaded model list
- `browserInstance`, `browserContext` in `src/browser/browser.js` — singleton browser
- `pointer` in `src/api/tokenManager.js` — round-robin token pointer
- `chatIdMap`, `sessionToChatMap` in `src/api/routes.js` — in-memory session tracking
- `http_client` — global `httpx.AsyncClient`
- `_pointer` — round-robin token pointer (with `global` keyword)
- `app` — FastAPI instance

## Anti-Patterns to Avoid

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## System Overview

```text

```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Server entry | Bootstraps Express app, middleware, interactive account menu | `index.js` |
| API routes | All HTTP endpoints (chat, models, files, images, videos, status) | `src/api/routes.js` |
| Chat core | Sends messages to Qwen API, manages page pool, token resolution | `src/api/chat.js` |
| Model mapping | Alias-to-canonical model name resolution | `src/api/modelMapping.js` |
| Token manager | Load/save/rotate auth tokens from `session/tokens.json` | `src/api/tokenManager.js` |
| File upload | STS token acquisition and OSS upload via browser | `src/api/fileUpload.js` |
| Image generation | DashScope image API integration (separate from Qwen Chat) | `src/api/imageGeneration.js` |
| Chat history | Local JSON-file-based chat history persistence | `src/api/chatHistory.js` |
| Browser management | Puppeteer lifecycle (launch, shutdown, stealth config) | `src/browser/browser.js` |
| Auth | Manual/interactive browser authentication flows | `src/browser/auth.js` |
| Session | Save/load cookies and auth tokens to disk | `src/browser/session.js` |
| Config | Centralised env-driven configuration | `src/config.js` |
| Logger | Winston + Morgan logging to console and rotating files | `src/logger/index.js` |
| Branding | Watermark constant (`t.me/forgetmeai`) | `src/utils/branding.js` |
| Prompt | Readline-based interactive CLI prompt | `src/utils/prompt.js` |
| Account setup | Interactive add/relogin/remove account flows | `src/utils/accountSetup.js` |
| Python server | Alternative FastAPI-based server (Playwright, no browser API calls) | `main.py` |

## Pattern Overview

- OpenAI-compatible REST API surface (SSE streaming + non-streaming)
- Browser automation for auth token extraction (Puppeteer stealth)
- Direct Node `fetch()` for API calls with browser `fetch()` fallback
- Round-robin multi-account token rotation with rate-limit handling
- Tool-call JSON adapter (Qwen has no native tool support; emulated via system prompt)
- Dual implementation: Node.js (primary) and Python (secondary)

## Layers

- Purpose: Accept OpenAI-format requests, handle CORS, auth middleware, JSON parsing
- Location: `index.js`, `src/api/routes.js`
- Contains: Route handlers, middleware, SSE streaming output
- Depends on: All `src/api/` modules, `src/browser/`, `src/logger/`
- Used by: External HTTP clients
- Purpose: Business logic — chat completion, model mapping, file upload, token rotation
- Location: `src/api/`
- Contains: `chat.js` (core), `modelMapping.js`, `tokenManager.js`, `fileUpload.js`, `imageGeneration.js`, `chatHistory.js`
- Depends on: Browser layer, config, logger
- Used by: HTTP layer (routes)
- Purpose: Manage headless browser instance, extract auth tokens, handle CAPTCHA/verification
- Location: `src/browser/`
- Contains: `browser.js`, `auth.js`, `session.js`
- Depends on: `puppeteer`, `puppeteer-extra-plugin-stealth`
- Used by: Service layer (chat.js calls browser for pages/tokens)
- Purpose: Single source of truth for all configurable values
- Location: `src/config.js`
- Contains: Environment variable parsing with defaults
- Depends on: Nothing
- Used by: All layers

## Data Flow

### Primary Request Path (Chat Completion)

### Authentication Flow

### Video Generation Flow

- Auth tokens: `session/tokens.json` (file-based, round-robin rotation)
- Chat history: `session/history/{chatId}.json` (per-chat JSON files)
- In-memory chatId mapping: `Map<string, string>` in `routes.js` (generated → real Qwen chatId)
- In-memory session tracking: `Map<string, object>` in `routes.js` (IP+UA → chatId+parentId)
- Browser auth token: module-level variable in `chat.js` (`authToken`)

## Key Abstractions

- Purpose: Reuse Puppeteer pages to avoid cold-start cost; pages are the execution context for browser-side API calls
- Examples: `src/api/chat.js:63-136`
- Pattern: Object with `getPage()` / `releasePage()` methods, bounded to `PAGE_POOL_SIZE` (default 3)
- Purpose: Cycle through multiple Qwen accounts to avoid rate limits
- Examples: `src/api/tokenManager.js:40-48`
- Pattern: Round-robin pointer over valid (non-expired, non-invalid) tokens
- Purpose: Translate OpenAI-style or user-friendly model names to Qwen canonical IDs
- Examples: `src/api/modelMapping.js:209-254`
- Pattern: Frozen lookup object built from `CANONICAL_MODELS` + `ALIAS_GROUPS`
- Purpose: Emulate OpenAI function/tool calling by injecting JSON schema into system prompt and parsing Qwen's text response for structured JSON tool calls
- Examples: `src/api/routes.js:475-584`
- Pattern: Prompt injection + regex/JSON parsing of model output

## Entry Points

- Location: `index.js`
- Triggers: `npm start` or `node index.js`
- Responsibilities: Start Express server, present interactive account menu, initialize headless browser, register routes and shutdown handlers
- Location: `main.py`
- Triggers: `python main.py`
- Responsibilities: FastAPI server with same endpoints, uses Playwright + httpx instead of Puppeteer, no browser-side API calls (direct HTTP)
- Location: `scripts/auth.js`
- Triggers: `npm run auth`
- Responsibilities: Standalone account authentication

## Architectural Constraints

- **Threading:** Single-threaded Node.js event loop. Puppeteer operations are async but sequential within the event loop. The page pool enables limited concurrency (up to `PAGE_POOL_SIZE` concurrent API calls).
- **Global state:** `authToken` in `src/api/chat.js` (module-level singleton), `sessionToChatMap` and `chatIdMap` in `src/api/routes.js` (in-memory Maps), `availableModels` and `authKeys` in `src/api/chat.js`.
- **Circular imports:** `src/browser/browser.js` imports from `src/api/chat.js` (for `clearPagePool`, `getAuthToken`) and `src/api/chat.js` imports from `src/browser/browser.js` (for `getBrowserContext`). This works because ES module circular imports resolve to live bindings, but it creates tight coupling.
- **Dual implementation:** `main.py` is a parallel Python implementation that duplicates much of the Node.js logic. They share `session/tokens.json` and `src/AvailableModels.txt` but are otherwise independent.

## Anti-Patterns

### Monolithic Route File

`src/api/routes.js` contains all HTTP endpoints in a single 800+ line file. As new features are added (images, video, file uploads), the file becomes harder to navigate. Mitigation: split routes by domain (chat routes, file routes, image routes) into separate modules and compose them in the main routes file.

### Duplicated Streaming Logic

Streaming response handling appears in multiple route handlers with similar SSE formatting code. This creates maintenance overhead when streaming behavior needs to change. Mitigation: centralize stream handling into a shared utility function that accepts an async generator and handles SSE formatting, error handling, and cleanup.

### Circular Dependency Between Browser and Chat

`src/browser/browser.js` imports from `src/api/chat.js` (`clearPagePool`, `getAuthToken`) and `src/api/chat.js` imports from `src/browser/browser.js` (`getBrowserContext`). While ES modules support this via live bindings, it creates tight coupling. Mitigation: introduce an intermediary event emitter or dependency injection pattern to break the direct circular import.

## Error Handling

- Express error middleware catches unhandled route errors (`index.js:78-81`)
- `sendMessage()` returns error objects with `{ error: string, chatId }` instead of throwing (`src/api/chat.js:767-916`)
- Rate-limited tokens are marked with a cooldown timestamp and skipped in rotation (`src/api/tokenManager.js:56-63`)
- Invalid tokens (401 responses) are marked invalid and retried with next token (`src/api/chat.js:722-735`)
- Browser verification/CAPTCHA triggers restart in visible mode (`src/api/chat.js:712-719`)
- Python implementation returns structured error JSON via FastAPI's `JSONResponse` (`main.py:660-667`)

## Cross-Cutting Concerns

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
