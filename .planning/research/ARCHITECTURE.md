# Architecture Patterns

**Domain:** Multi-platform API proxy with pluggable auth strategies
**Researched:** 2026-06-06
**Confidence:** HIGH (based on deep codebase analysis + established patterns)

## Current Architecture Problems

The existing codebase has three structural issues that any refactoring must solve:

1. **Circular dependency**: `src/browser/browser.js` imports `clearPagePool`, `getAuthToken` from `src/api/chat.js`, while `chat.js` imports browser functions back. This makes it impossible to use auth without dragging in the full browser stack.

2. **Monolithic routes**: `src/api/routes.js` (2090 lines) bundles 25+ route handlers, session tracking, streaming logic, tool-call parsing, and media endpoints. Any change risks breaking unrelated functionality.

3. **Duplicated logic across runtimes**: `main.py` (800 lines) duplicates all core logic from the Node.js side — token management, model mapping, streaming, Qwen API interaction. They share only `session/tokens.json` and `src/AvailableModels.txt`.

## Recommended Architecture

### Target Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         External Clients                                │
│  (Open WebUI, OpenAI SDK, Hermes, LiteLLM, OpenCode, direct HTTP)      │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │  HTTP (OpenAI-compatible JSON/SSE)
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    HTTP Layer (Express / FastAPI)                       │
│                                                                         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────────┐  │
│  │ chatRoutes   │ │ mediaRoutes  │ │ authRoutes   │ │ statusRoutes  │  │
│  │ completions  │ │ image/video  │ │ /auth/*      │ │ /health       │  │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬────────┘  │
│         │                │                │                 │           │
│  ┌──────┴────────────────┴────────────────┴─────────────────┴────────┐  │
│  │                     Middleware Layer                               │  │
│  │  CORS · Auth (API key) · JSON parse · Logging · Rate limit       │  │
│  └───────────────────────────────┬───────────────────────────────────┘  │
└──────────────────────────────────┼──────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Service Layer                                    │
│                                                                         │
│  ┌─────────────────┐ ┌─────────────────┐ ┌───────────────────────────┐ │
│  │ ChatService     │ │ TokenService    │ │ SessionService            │ │
│  │ sendMessage()   │ │ rotate()        │ │ getScopedChatId()         │ │
│  │ buildPayload()  │ │ markInvalid()   │ │ saveChatMapping()         │ │
│  │ streamResponse()│ │ markRateLimited │ │ evictStale()              │ │
│  └────────┬────────┘ └────────┬────────┘ └───────────────────────────┘ │
│           │                     │                                       │
│  ┌────────┴────────┐ ┌────────┴────────┐ ┌──────────────────────────┐  │
│  │ ModelMapper     │ │ FileService     │ │ StreamingAdapter         │  │
│  │ resolve(name)   │ │ upload/STS      │ │ SSE formatter            │  │
│  └─────────────────┘ └─────────────────┘ │ handleSseResponse()      │  │
│                                           └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Auth Strategy Layer                                 │
│                                                                         │
│          ┌──────────────────────────────────────────┐                   │
│          │       AuthStrategy (interface)            │                   │
│          │  + authenticate(): Promise<AuthToken>     │                   │
│          │  + refreshToken(): Promise<AuthToken>     │                   │
│          │  + isAvailable(): boolean                 │                   │
│          └──────────┬───────────────────────────────┘                   │
│                     │                                                   │
│  ┌──────────┬───────┴────────┬──────────────┬────────────────┐         │
│  ▼          ▼                ▼              ▼                ▼         │
│ ┌────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐    │
│ │GUI     │ │Headless  │ │QR/Link   │ │Token     │ │Cookie        │    │
│ │Browser │ │Browser   │ │Flow      │ │File      │ │Import        │    │
│ │(existing)│(Puppeteer│ │(new)     │ │(existing)│ │(new)         │    │
│ │        │ │headless) │ │          │ │          │ │              │    │
│ └────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────┘    │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │              AuthStrategyResolver                                │   │
│  │  resolve(config): AuthStrategy                                  │   │
│  │  - Auto-detects platform capabilities (has display? browser?)   │   │
│  │  - Falls back: GUI → Headless → QR/Link → Token File           │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Browser Abstraction Layer                             │
│                                                                         │
│          ┌──────────────────────────────────────────┐                   │
│          │       BrowserProvider (interface)         │                   │
│          │  + launch(opts): BrowserContext           │                   │
│          │  + newPage(): Page                        │                   │
│          │  + close(): void                          │                   │
│          │  + isAvailable(): boolean                 │                   │
│          └──────────┬───────────────────────────────┘                   │
│                     │                                                   │
│         ┌───────────┼───────────┐                                      │
│         ▼           ▼           ▼                                      │
│  ┌────────────┐ ┌────────────┐ ┌──────────────┐                        │
│  │Puppeteer   │ │Playwright  │ │NoBrowser     │                        │
│  │Provider    │ │Provider    │ │Provider      │                        │
│  │(Node.js)   │ │(Python/    │ │(token-only,  │                        │
│  │            │ │ Node.js)   │ │ no browser)  │                        │
│  └────────────┘ └────────────┘ └──────────────┘                        │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Credential Store                                    │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  tokens.json (shared between Node.js and Python)                 │   │
│  │  [                                                                │   │
│  │    { id, token, cookies?, addedAt, resetAt, invalid,             │   │
│  │      authMethod: "gui|headless|qr|import" },                     │   │
│  │    ...                                                            │   │
│  │  ]                                                                │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  Read/Write: TokenService (Node.js) / TokenManager (Python)             │
│  Format: Shared JSON — single source of truth for both runtimes         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Component Boundaries

| Component | Responsibility | Depends On | Used By |
|-----------|---------------|------------|---------|
| **HTTP Layer** | Accept requests, route to services, format responses | Service Layer | External clients |
| **Middleware** | Auth check (API key), CORS, logging, rate limiting | Config, TokenService | HTTP Layer |
| **ChatService** | Build Qwen payloads, execute API calls, parse responses | TokenService, ModelMapper, BrowserProvider* | chatRoutes, completionsRoutes |
| **TokenService** | Load/save/rotate tokens, mark invalid/rate-limited | Credential Store (`tokens.json`) | ChatService, AuthStrategy |
| **SessionService** | Track chatId↔Qwen mapping, scoped sessions, LRU eviction | Nothing | chatRoutes, completionsRoutes |
| **StreamingAdapter** | Format SSE chunks, handle errors mid-stream, `[DONE]` | Nothing | chatRoutes, mediaRoutes |
| **ModelMapper** | Resolve model aliases to Qwen canonical IDs | AvailableModels.txt | ChatService |
| **AuthStrategy** (interface) | Authenticate and obtain/refresh tokens | BrowserProvider (optional) | TokenService, authRoutes |
| **AuthStrategyResolver** | Pick the right auth strategy for the environment | Platform detection | index.js / startup |
| **BrowserProvider** (interface) | Launch and manage browser, extract tokens | puppeteer or playwright | AuthStrategy implementations |
| **Credential Store** | Persist tokens and session data on disk | Filesystem | TokenService |
| **Config** | Single source of truth for all configurable values | Nothing | Everything |

\* ChatService depends on BrowserProvider **only for browser-fetch fallback**. When tokens are available in the credential store, ChatService uses Node-native `fetch` directly, bypassing the browser entirely.

### Data Flow

#### Auth Token Lifecycle

```
1. BOOT
   AuthStrategyResolver.resolve(config)
   ├── Has display? → GUI Browser Strategy → open visible Chrome
   ├── Has Chrome binary? → Headless Browser Strategy → headless Puppeteer
   ├── Has network? → QR/Link Strategy → start auth endpoint
   └── Has token file? → Token File Strategy → load from tokens.json

2. AUTHENTICATION
   Strategy.authenticate()
   ├── Browser-based: Launch → navigate to chat.qwen.ai → user logs in
   │                   → extract localStorage token → save to CredentialStore
   ├── QR/Link: Start HTTP endpoint → generate link → display QR
   │            → user opens link on phone → poll for cookie/token
   │            → extract token → save to CredentialStore
   └── Token File: Read tokens.json → validate tokens → done

3. REQUEST (ChatService.sendMessage)
   TokenService.getAvailableToken()
   ├── Returns token from CredentialStore (round-robin)
   └── If no valid token → triggers re-auth via AuthStrategy

   ChatService uses Node fetch with Bearer token
   ├── 200 → success, stream response
   ├── 401 → TokenService.markInvalid() → retry with next token
   ├── 429 → TokenService.markRateLimited() → retry with next token
   └── Verification → switch to visible browser (if available)

4. RE-AUTH (when token expires)
   TokenService detects no valid tokens
   └── AuthStrategy.refreshToken()
       └── Re-runs the current strategy's auth flow
```

#### Chat Request Flow (Refactored)

```
Client → POST /api/chat/completions
       → authMiddleware (check API key from Authorization.txt)
       → chatRoutes.completions handler
           → SessionService.resolveChatId(req) → effectiveChatId
           → ModelMapper.resolve(model) → mappedModel
           → ChatService.sendMessage({message, model, chatId, ...})
               → TokenService.getAvailableToken() → token
               → buildPayloadV2(message, model, chatId, ...)
               → Node fetch(CHAT_API_URL, {Bearer: token})
               → Parse SSE stream / JSON response
           → StreamingAdapter.formatSse(result) or JSON response
           → SessionService.saveChatMapping(effectiveChatId, qwenChatId)
       → Response to client
```

## Patterns to Follow

### Pattern 1: Strategy Pattern for Auth

**What:** Each auth method is a class implementing a common `AuthStrategy` interface. A resolver picks the right one at boot time based on environment capabilities.

**When:** Any code that needs to obtain or refresh auth tokens.

**Why:** Decouples auth mechanics from the rest of the system. Adding a new auth method (e.g., OAuth device flow) means creating a new class, not modifying existing code.

**Example:**

```javascript
// src/auth/strategies/AuthStrategy.js
export class AuthStrategy {
  async authenticate() { throw new Error('Not implemented'); }
  async refreshToken() { throw new Error('Not implemented'); }
  isAvailable() { throw new Error('Not implemented'); }
  get name() { throw new Error('Not implemented'); }
}

// src/auth/strategies/GuiBrowserStrategy.js
export class GuiBrowserStrategy extends AuthStrategy {
  constructor(browserProvider, credentialStore) {
    super();
    this.browser = browserProvider;
    this.store = credentialStore;
  }
  get name() { return 'gui-browser'; }
  isAvailable() {
    return this.browser.isAvailable() && !!process.env.DISPLAY;
  }
  async authenticate() {
    const ctx = await this.browser.launch({ headless: false });
    // User logs in manually...
    const token = await ctx.evaluate(() => localStorage.getItem('token'));
    await this.store.saveToken({ id: generateId(), token, authMethod: 'gui' });
    return token;
  }
}

// src/auth/strategies/QrLinkStrategy.js
export class QrLinkStrategy extends AuthStrategy {
  constructor(credentialStore, httpServer) {
    super();
    this.store = credentialStore;
    this.http = httpServer;
  }
  get name() { return 'qr-link'; }
  isAvailable() { return true; } // Always available, needs only HTTP
  async authenticate() {
    // Start a temporary HTTP endpoint, generate link/QR
    // Poll for completion
    // Extract token from callback
    await this.store.saveToken({ id: generateId(), token, authMethod: 'qr' });
    return token;
  }
}
```

### Pattern 2: Provider Pattern for Browser Abstraction

**What:** A `BrowserProvider` interface wraps Puppeteer and Playwright behind a unified API. A `NoBrowserProvider` exists for platforms without browser support.

**When:** Any code that needs to launch a browser, extract tokens, or perform browser-side operations.

**Why:** Puppeteer (Node.js) and Playwright (Python/Node.js) have different APIs. The provider pattern normalises them so auth strategies don't care which browser engine is running. It also allows a "no browser" mode for platforms where no browser exists (RISC-V, ARM32).

**Example:**

```javascript
// src/browser/providers/BrowserProvider.js
export class BrowserProvider {
  async launch(options) { throw new Error('Not implemented'); }
  async newPage() { throw new Error('Not implemented'); }
  async close() { throw new Error('Not implemented'); }
  isAvailable() { throw new Error('Not implemented'); }
}

// src/browser/providers/PuppeteerProvider.js
export class PuppeteerProvider extends BrowserProvider {
  isAvailable() {
    try {
      require.resolve('puppeteer');
      return true;
    } catch { return false; }
  }
  async launch({ headless = true } = {}) {
    const puppeteer = await import('puppeteer-extra');
    const stealth = (await import('puppeteer-extra-plugin-stealth')).default;
    puppeteer.default.use(stealth());
    return puppeteer.default.launch({
      headless,
      executablePath: process.env.CHROME_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...]
    });
  }
}

// src/browser/providers/NoBrowserProvider.js
export class NoBrowserProvider extends BrowserProvider {
  isAvailable() { return true; } // Always "available" — just does nothing
  async launch() {
    throw new Error('No browser available on this platform. Use token-file or QR auth.');
  }
}
```

### Pattern 3: Shared Credential Schema

**What:** Both Node.js and Python servers read/write the same `tokens.json` format with an extended schema.

**When:** Any code that reads or writes auth tokens.

**Why:** Currently both runtimes independently define their own token loading code with slightly different behavior. A shared schema eliminates drift.

**Example — extended token schema:**

```json
{
  "id": "acc_1717660800000",
  "token": "eyJhbGciOi...",
  "authMethod": "gui|headless|qr-link|token-import",
  "cookies": [
    { "name": "session_id", "value": "...", "domain": ".qwen.ai" }
  ],
  "addedAt": "2026-06-06T12:00:00Z",
  "resetAt": null,
  "invalid": false,
  "lastValidatedAt": "2026-06-06T12:30:00Z",
  "userEmail": "user@example.com"
}
```

The `authMethod` field enables the system to know how a token was obtained and choose the right re-auth strategy when it expires.

### Pattern 4: Route Decomposition

**What:** Split the monolithic `routes.js` into domain-specific route modules under `src/api/routes/`.

**When:** Any modification to HTTP endpoints.

**Why:** The current 2090-line file is the highest-risk file in the project. Domain decomposition means changes to chat endpoints don't affect media endpoints.

**Target structure:**

```
src/api/
├── routes/
│   ├── index.js              # Assembles all sub-routers
│   ├── chat.js               # POST /chat (legacy)
│   ├── completions.js        # POST /chat/completions (OpenAI)
│   ├── media.js              # /images/*, /videos/*
│   ├── files.js              # /files/*
│   ├── models.js             # GET /models
│   ├── status.js             # GET /status, /health
│   ├── chats.js              # /chats/*, /tasks/*
│   └── history.js            # /chats/:id/history
├── middleware/
│   ├── auth.js               # API key auth middleware
│   └── requestLogger.js      # HTTP request logging
├── services/
│   ├── chatService.js        # sendMessage, buildPayload, streamResponse
│   ├── tokenService.js       # Token rotation, validation, persistence
│   ├── sessionService.js     # chatId mapping, scoped sessions
│   └── streamingAdapter.js   # SSE formatting, error handling
├── chat.js                   # Existing — keep as thin wrapper during migration
├── modelMapping.js           # Existing — no change needed
├── chatHistory.js            # Existing — no change needed
├── fileUpload.js             # Existing — no change needed
└── imageGeneration.js        # Existing — no change needed
```

**Key extraction targets from current `routes.js`:**

| Lines | Current Location | Extract To |
|-------|-----------------|------------|
| 19–87 | `generateChatIdFromHistory`, `normalizeIdValue`, `pickFirstId`, `buildInternalChatIdFromHint` | `src/api/services/sessionService.js` |
| 89–148 | `extractConversationHint`, `extractParentHint`, `shouldForceNewChat` | `src/api/services/sessionService.js` |
| 150–270 | `chatIdMap`, `sessionToChatMap`, mapping functions, cleanup interval | `src/api/services/sessionService.js` |
| 294–310 | `authMiddleware` | `src/api/middleware/auth.js` |
| 320–371 | `parseOpenAIMessages`, `stringifyOpenAIContent`, `buildStatelessTranscript` | `src/api/services/messageParser.js` |
| 375–447 | `shouldFoldOpenAITranscript`, `prepareOpenAIMessageInput` | `src/api/services/messageParser.js` |
| 475–584 | `toolsToPrompt`, `parseToolCallJson` | `src/api/services/toolCallAdapter.js` |
| 652–705 | `handleStreamingResponse` | `src/api/services/streamingAdapter.js` |
| 1017–1315 | `/chat/completions` handler | `src/api/routes/completions.js` |
| 1341–1683 | `/v1/chat/completions` handler (deduplicate with above) | `src/api/routes/completions.js` |
| 726–906 | `/chat` handler | `src/api/routes/chat.js` |
| 908–1008 | `/status`, `/health`, `/models`, `/chats` | `src/api/routes/status.js`, `models.js`, `chats.js` |

### Pattern 5: Shared Config via JSON

**What:** Model mappings and API URLs stored in a shared JSON file consumed by both Node.js and Python.

**When:** Any configuration that both runtimes need.

**Why:** Currently model mappings are defined independently in `src/api/modelMapping.js` (Node.js) and inline in `main.py` (Python). This causes drift — adding a model requires updating two files.

**Example:**

```json
// config/shared.json
{
  "apiUrls": {
    "chatApi": "https://chat.qwen.ai/api/v2/chat/completions",
    "createChat": "https://chat.qwen.ai/api/v2/chats/new",
    "chatPage": "https://chat.qwen.ai/",
    "taskStatus": "https://chat.qwen.ai/api/v1/tasks/status"
  },
  "models": {
    "canonical": ["qwen3-max", "qwen3-plus", "qwen3-235b-a22b", ...],
    "aliases": {
      "qwen-max": "qwen3-max",
      "qwen3.5": "qwen3.5-plus",
      "qwq": "qwq-32b"
    },
    "default": "qwen-max-latest"
  }
}
```

Both `modelMapping.js` and `main.py` load this file. Single source of truth.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Auth Strategy Tightly Coupled to Browser

**What:** Requiring a browser to be running for the entire lifetime of the server, even after tokens are obtained.

**Why bad:** The browser is only needed during auth. Once a token is in `tokens.json`, all API calls should use Node-native `fetch` with Bearer tokens. Running Puppeteer continuously wastes 200-500MB RAM and makes the proxy fragile (browser crashes, verification prompts, page leaks).

**Instead:** Start browser only for auth flows. Shut it down after token extraction. The `executeApiRequestWithNodeStreaming()` path in `chat.js` already proves this works — make it the default.

### Anti-Pattern 2: Dual Implementation Without Shared Contract

**What:** Having Node.js and Python implementations independently implement the same proxy logic with no shared specification.

**Why bad:** Already diverged — Python lacks image/video generation, file upload, multi-account features, and tool call support. Bug fixes apply to one but not the other.

**Instead:** Define a shared protocol (JSON config for models/URLs, shared `tokens.json` schema, shared test suite). Each runtime implements against this contract. For auth flow logic, consider having Python call the Node.js auth endpoint (or vice versa) rather than reimplementing.

### Anti-Pattern 3: Circular Module Dependencies

**What:** `browser.js` imports from `chat.js`, and `chat.js` imports from `browser.js`.

**Why bad:** Makes module boundaries unclear. Can cause initialization order issues. Prevents using auth without the full chat stack.

**Instead:** Extract shared state (auth token, page pool) into a standalone `src/state.js` or `src/services/` module that both can import without circularity. The auth token should be managed by `TokenService`, not held as a module-level variable in `chat.js`.

### Anti-Pattern 4: Module-Level Singleton State

**What:** `authToken` in `chat.js` (line 24), `availableModels` in `chat.js` (line 25), `authKeys` in `chat.js` (line 26), `pointer` in `tokenManager.js` (line 13).

**Why bad:** Hidden global state makes testing impossible. Module-level singletons prevent running multiple instances. The round-robin pointer is especially dangerous under concurrent requests.

**Instead:** Encapsulate state in service objects. Use dependency injection or a simple service locator pattern. For the pointer, use atomic operations or a thread-safe counter.

### Anti-Pattern 5: Route Handler Does Everything

**What:** A single route handler function (200-300 lines) that parses messages, resolves sessions, maps models, builds payloads, executes API calls, handles errors, and formats responses.

**Why bad:** Violates single responsibility. Testing requires setting up the entire HTTP stack. Can't test message parsing without hitting the Qwen API.

**Instead:** Route handlers should be thin — parse the request, delegate to a service, format the response. All logic in between belongs in service functions.

## Component Build Order

Dependencies between components determine the build order. This is the order phases should follow:

```
Phase 1: Foundation (no dependencies)
├── src/config.js — already exists, needs extension for auth config
├── src/utils/delay.js — extract shared utility
├── config/shared.json — shared model mappings
└── Credential Store schema — extend tokens.json format

Phase 2: Core Services (depends on Phase 1)
├── src/api/services/tokenService.js — extract from tokenManager.js
├── src/api/services/sessionService.js — extract from routes.js maps
├── src/api/services/messageParser.js — extract from routes.js helpers
├── src/api/services/toolCallAdapter.js — extract from routes.js
└── src/api/services/streamingAdapter.js — extract from routes.js

Phase 3: Browser Abstraction (depends on Phase 1)
├── src/browser/providers/BrowserProvider.js — interface
├── src/browser/providers/PuppeteerProvider.js — wraps existing browser.js
├── src/browser/providers/NoBrowserProvider.js — fallback for no-browser
└── Break circular dependency: extract state to service layer

Phase 4: Auth Strategies (depends on Phase 2 + 3)
├── src/auth/AuthStrategy.js — interface
├── src/auth/strategies/GuiBrowserStrategy.js — wraps existing auth.js
├── src/auth/strategies/HeadlessBrowserStrategy.js — headless Puppeteer
├── src/auth/strategies/TokenFileStrategy.js — load from tokens.json
├── src/auth/strategies/QrLinkStrategy.js — NEW: QR/link auth endpoint
├── src/auth/AuthStrategyResolver.js — platform-aware strategy selection
└── src/api/routes/auth.js — auth HTTP endpoints

Phase 5: Route Decomposition (depends on Phase 2)
├── src/api/middleware/auth.js — extract authMiddleware
├── src/api/routes/completions.js — deduplicate /chat/completions + /v1/chat/completions
├── src/api/routes/chat.js — legacy /chat endpoint
├── src/api/routes/media.js — image/video endpoints
├── src/api/routes/files.js — file upload endpoints
├── src/api/routes/models.js — model listing
├── src/api/routes/status.js — health/status
└── src/api/routes/index.js — assemble sub-routers

Phase 6: ChatService Refactor (depends on Phase 2, 3, 4)
├── src/api/services/chatService.js — extract from chat.js
├── Make Node fetch the default transport (browser fetch as fallback)
├── Remove page pool dependency from core request path
└── Use TokenService for all token resolution

Phase 7: Python Server Update (depends on Phase 1, 2, 4)
├── Load config/shared.json for model mappings
├── Use shared tokens.json schema with authMethod field
├── Implement QrLinkStrategy in Python
└── Feature parity: tool calls, file upload, image/video generation

Phase 8: Integration & Testing (depends on all above)
├── Cross-platform testing (x86_64, ARM64, RISC-V)
├── Multi-arch Docker images
├── Client integration tests (OpenCode, Hermes, Open WebUI)
└── CI/CD pipeline
```

### Build Order Rationale

1. **Foundation first** — shared config and schema are prerequisites for everything else.
2. **Services before routes** — services encapsulate logic that routes delegate to. Building services first means routes can be thin wrappers.
3. **Browser abstraction before auth strategies** — auth strategies depend on browser providers. Breaking the circular dependency first is essential.
4. **Auth strategies before QR/link flow** — the QR flow is a new auth strategy that depends on the strategy interface existing.
5. **Route decomposition can happen in parallel with auth** — they share no dependencies beyond Phase 2 services.
6. **ChatService refactor last in the Node stack** — it's the riskiest change (touches the core request path) and depends on all service layers being stable.
7. **Python update after Node is stable** — Python can copy patterns from the refactored Node.js code.

## Scalability Considerations

| Concern | At 1 user (current) | At 100 users (VPS) | At 10K users (multi-instance) |
|---------|---------------------|---------------------|-------------------------------|
| Auth tokens | 1-3 tokens in JSON file | 10-50 tokens, JSON still fine | SQLite or Redis for token store |
| Session tracking | In-memory Map, ~10 entries | In-memory LRU Map, ~1000 entries | Redis for session state |
| Browser usage | Running full-time | Start only for auth, then shut down | Separate auth microservice |
| Concurrent requests | 3 (PAGE_POOL_SIZE) | 50+ (Node fetch, no browser) | Load balancer + multiple instances |
| Token rotation | Simple round-robin | Weighted round-robin (by rate-limit history) | Centralized token service |
| Config | .env file | .env + shared.json | Environment variables + shared config service |

## Platform-Specific Auth Matrix

| Platform | Display | Browser Available | Recommended Auth Strategy |
|----------|---------|-------------------|--------------------------|
| Windows desktop | Yes | Puppeteer (Chrome) | GUI Browser (existing) |
| macOS desktop | Yes | Puppeteer (Chrome) | GUI Browser (existing) |
| Linux desktop | Yes | Puppeteer (Chrome) | GUI Browser (existing) |
| Linux headless (x86_64) | No | Puppeteer headless | Headless Browser or QR/Link |
| Linux headless (ARM64) | No | Chromium available | Headless Browser or QR/Link |
| Linux headless (RISC-V) | No | No Chromium binary | QR/Link or Token Import |
| Linux headless (ARM32) | No | Limited browser support | QR/Link or Token Import |
| Docker container | No | Puppeteer (if installed) | QR/Link or Token Import |
| Docker (minimal) | No | No browser | QR/Link or Token Import |

## QR/Link Auth Flow Detail

This is the most critical new auth strategy for headless environments. Here's the detailed flow:

```
Server (headless)                        Phone/Remote Browser
    │                                           │
    │  POST /api/auth/start                     │
    │  ← { link: "https://proxy:3264/           │
    │       auth/callback?session=abc123",       │
    │       qr: "data:image/png;base64,..." }   │
    │                                           │
    │  (Admin displays QR in terminal, or        │
    │   sends link via Telegram/Signal)          │
    │                                           │
    │                          User opens link ──┤
    │                                           │
    │                GET /auth/callback?session=abc123
    │  → Serves login page with Qwen auth ──────┤
    │                                           │
    │                User logs into Qwen ────────┤
    │                                           │
    │  Browser JS extracts token from           │
    │  localStorage → POST /api/auth/complete   │
    │  { session: "abc123", token: "eyJ..." }   │
    │                                           │
    │  Server saves token to tokens.json         │
    │  ← { success: true, accountId: "acc_..." }│
    │                                           │
    │  Server is now authenticated               │
    │  (no browser needed on server)             │
```

**Implementation notes:**
- The `/auth/callback` page is a simple HTML page loaded by the phone browser that loads Qwen's login page in an iframe or redirects to it.
- After login, JavaScript on the callback page extracts the token from cookies or localStorage.
- The token is POSTed back to the server.
- Security: The session ID should be a short-lived random token. The auth endpoint should only be accessible from localhost or authenticated admin.

## Sources

- **Codebase analysis:** Deep read of all source files in `src/api/`, `src/browser/`, `src/utils/`, `index.js`, `main.py`
- **Architecture anti-patterns:** Identified from `.planning/codebase/CONCERNS.md` and `.planning/codebase/ARCHITECTURE.md`
- **Strategy pattern:** Standard GoF pattern, widely used in auth systems (Passport.js, NextAuth)
- **Provider pattern:** Used by Puppeteer/Playwright themselves for multi-browser support
- **QR auth flow:** Similar to WhatsApp Web auth flow, Proton Mail bridge auth, and GitHub device flow
- **Confidence:** HIGH — all recommendations are grounded in concrete codebase issues and established architectural patterns
