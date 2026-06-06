# Project Research Summary

**Project:** FreeQwenApi — Headless Multi-Platform
**Domain:** OpenAI-compatible API proxy / auth gateway for Qwen Chat
**Researched:** 2026-06-06
**Confidence:** HIGH

## Executive Summary

FreeQwenApi is an OpenAI-compatible API proxy that extracts auth tokens from Qwen Chat web sessions and exposes them as a local REST API. It currently requires a GUI browser (Puppeteer + Chrome) for authentication, which blocks deployment on headless Linux servers, Docker containers, and non-x86_64 architectures. The research confirms this is a well-understood problem domain: multi-platform browser automation, headless auth flows, and multi-arch Docker builds all have mature, documented solutions.

The recommended approach is a **phased refactoring** that first establishes a browser-free operation mode (token-only with pre-seeded tokens), then adds remote authentication via QR/link endpoints, then introduces multi-arch Docker builds with a tiered image strategy. The key architectural decision is decoupling authentication from browser dependency through a Strategy Pattern — each auth method (GUI browser, headless browser, QR link, token import) becomes a pluggable class behind a resolver that picks the right strategy based on platform capabilities. Route decomposition (splitting the 2090-line `routes.js` monolith) and service extraction should happen alongside auth work to reduce risk.

The critical risks are: (1) Puppeteer's Chrome binaries only exist for x86_64 and macOS ARM64 — Linux ARM64, RISC-V, and ARM32 have no viable Chromium, making browser-free operation mandatory, not optional; (2) the headless auth endpoints open significant security surface (token leakage, CSRF, unauthorized token injection) that must be designed-in from the start; (3) the dual Node.js/Python implementations have already diverged and every new feature doubles maintenance cost unless a shared contract is established early.

## Key Findings

### Recommended Stack

The existing stack (Express 4.18, Puppeteer 25, Node 20, FastAPI, Playwright) is retained. New additions are minimal and purpose-driven: Vitest for testing (native ESM support, faster than Jest), `qrcode`/`qrcode-terminal` for headless auth flows, Docker Buildx + QEMU for multi-arch builds, and GitHub Actions with QEMU emulation for CI.

**Core technologies:**
- **Puppeteer (keep, v25.1):** Browser automation with stealth plugin — critical for anti-detection against Qwen Chat; no viable replacement exists for stealth capabilities
- **Browser Detection Cascade:** `CHROME_PATH` env → Puppeteer cache → system Chromium → no-browser fallback; this is the single most important infrastructure change for multi-platform support
- **Vitest (^4.1):** Test framework — zero tests exist currently; Vitest is native ESM, fast, Jest-compatible API
- **Docker Buildx + QEMU:** Multi-arch builds — `tonistiigi/binfmt` for ARM64, RISC-V, ARM32 emulation; tiered images (full with Chromium, slim without)
- **qrcode + qrcode-terminal:** QR code generation for headless auth — server generates auth URL, encodes as QR for terminal or API response

### Expected Features

**Must have (table stakes):**
- **Token import via env var / CLI flag (H5):** Simplest headless deployment path — copy token from desktop, paste into server config
- **Chrome auto-detection cascade (A2):** Fixes the crash-on-fresh-install bug; detects browser availability at startup
- **Browser-free operation mode (A3):** Proxy must function without a browser when tokens are pre-seeded; browser is only needed for auth, not API calls
- **HTTP auth endpoint (H1):** `/api/auth/start` → QR/link → `/api/auth/callback` → token saved; the primary headless workflow
- **CLI `--headless` auth flag (H2):** SSH users need terminal-rendered QR + clickable URL
- **Multi-arch Docker images (A1):** amd64 + arm64 at minimum; users expect `docker pull` to "just work"
- **Unit test framework (T1):** Zero tests currently; Vitest setup with coverage for pure functions
- **CI pipeline (T2):** GitHub Actions matrix for automated testing on push/PR
- **Docker HEALTHCHECK (M4):** Standard health monitoring for container deployments

**Should have (differentiators):**
- **QR code login in terminal (D1):** Scan-from-phone auth — intuitive, mirrors WhatsApp/WeChat pattern
- **RISC-V Docker image (D4):** First-mover advantage; QEMU emulation works, no Chromium needed
- **Webhook notification on token expiry (D3):** POST to Slack/Discord/Telegram when all tokens die
- **Platform diagnostics command (D6):** `npm run doctor` — one-command troubleshooting
- **Graceful shutdown with request draining (D12):** Finish in-flight requests on SIGTERM

**Defer (v2+):**
- Telegram bot auth flow (D2) — complex, HTTP auth endpoint is sufficient
- Binary releases via GitHub Releases (D5) — Docker covers most users
- Prometheus metrics endpoint (M3) — only when users run in production
- Cross-platform CI matrix with 5 OS × 2 Node versions (D7) — start with ubuntu-only

### Architecture Approach

The target architecture decomposes the monolithic codebase into distinct layers: HTTP routing, service logic, auth strategies, and browser abstraction. The Strategy Pattern for authentication is the central architectural decision — it decouples "how to get a token" from "how to use a token," enabling each platform to use its best-available auth method. The Provider Pattern wraps Puppeteer/Playwright behind a unified interface so the rest of the system doesn't know or care which browser engine is running (or if no browser exists at all).

**Major components:**
1. **Auth Strategy Layer** — `AuthStrategy` interface with `GuiBrowserStrategy`, `HeadlessBrowserStrategy`, `QrLinkStrategy`, `TokenFileStrategy`; `AuthStrategyResolver` picks the right one based on platform detection
2. **Browser Provider Layer** — `BrowserProvider` interface with `PuppeteerProvider`, `PlaywrightProvider`, `NoBrowserProvider`; enables graceful degradation on architectures without Chromium
3. **Service Layer** — Extracted from `routes.js`: `ChatService`, `TokenService`, `SessionService`, `StreamingAdapter`, `ModelMapper`, `MessageParser`, `ToolCallAdapter`
4. **Route Decomposition** — Split 2090-line `routes.js` into domain modules: `chat.js`, `completions.js`, `media.js`, `files.js`, `models.js`, `status.js`, `auth.js`
5. **Shared Credential Store** — Extended `tokens.json` schema with `authMethod` field, shared between Node.js and Python runtimes

### Critical Pitfalls

1. **Puppeteer x86_64-only Chrome on Linux ARM64** — Puppeteer downloads x86_64 Chrome binary even on ARM64 Linux; it silently fails with "Exec format error". Prevention: always set `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` in Docker, use system Chromium via `executablePath`, detect `process.arch` at runtime.

2. **No Chromium on RISC-V/ARM32 — browser-free mode is mandatory** — No maintained Chromium builds exist for these architectures. The proxy MUST work without a browser. Prevention: token-only mode using Node-native `fetch()`, remote auth via QR/link that never requires a browser on the server.

3. **Headless auth endpoints are a security nightmare** — Token leakage in logs, CSRF, open redirect, no binding between start/callback. Prevention: API key required on auth endpoints, state/nonce pattern, tokens in POST body only (never URLs), log redaction, rate limiting, auth state tokens with 5-minute TTL.

4. **Dual Node.js/Python implementations will diverge immediately** — Python version already lacks image/video, file upload, multi-account, tool calls. Every feature must be implemented twice. Prevention: designate Node.js as primary, establish shared contract (JSON config, shared `tokens.json` schema), shared test suite.

5. **Qwen's unofficial API will break without warning** — Undocumented v2 endpoints, no versioning, no announcement. Prevention: response schema validation, canary health checks, defensive parsing with fallback formats, decouple token extraction from browser (remote auth bypasses this).

## Implications for Roadmap

Based on combined research, the following phase structure is recommended:

### Phase 1: Foundation & Platform Compatibility
**Rationale:** The proxy currently crashes on non-x86_64 platforms and has no test coverage. Fixing platform detection and establishing a testing framework are prerequisites for everything else.
**Delivers:** Browser detection cascade, browser-free operation mode, token import via env var/CLI, Vitest setup with unit tests for pure functions, token file reliability improvements
**Addresses:** H5 (token import), A2 (Chrome detection), A3 (no-browser degradation), T1 (Vitest setup), H4 (token credential file reliability)
**Avoids:** Pitfall 1 (Puppeteer ARM64 crash), Pitfall 2 (no Chromium on RISC-V), Pitfall 5 (Qwen API breakage — via response validation layer)
**Key decisions:** `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` as default; Node-native `fetch()` as primary transport; browser only for auth

### Phase 2: Service Extraction & Route Decomposition
**Rationale:** The 2090-line `routes.js` monolith and circular `browser.js`↔`chat.js` dependency make any auth or feature work high-risk. Extracting services first means auth strategies and new routes can be built cleanly.
**Delivers:** Service layer (`TokenService`, `SessionService`, `ChatService`, `StreamingAdapter`, `MessageParser`, `ToolCallAdapter`), route decomposition into domain modules, middleware extraction, break circular dependency
**Addresses:** Architecture Patterns 1-5 (strategy, provider, shared schema, route decomposition, shared config)
**Avoids:** Anti-patterns 1-5 (auth coupled to browser, no shared contract, circular deps, module-level singletons, route handler does everything)
**Key decisions:** Thin route handlers that delegate to services; shared `config/shared.json` for model mappings; `authMethod` field in token schema

### Phase 3: Headless Authentication
**Rationale:** With platform compatibility and clean service architecture in place, adding headless auth becomes straightforward — implement `AuthStrategy` interface for each method.
**Delivers:** `QrLinkStrategy`, `HeadlessBrowserStrategy`, `TokenFileStrategy`, `AuthStrategyResolver`, `/api/auth/*` HTTP endpoints, CLI `--headless` flag, QR code generation (terminal + API), auth status endpoint
**Addresses:** H1 (HTTP auth endpoint), H2 (CLI auth flag), D1 (QR code terminal), H3 (token auto-refresh), D3 (webhook notification), D11 (auth status endpoint)
**Avoids:** Pitfall 3 (headless auth security — designed in from start), Pitfall 6 (token lifecycle management — remote re-auth as first-class operation)
**Key decisions:** State/nonce pattern for auth flow; API key required on auth endpoints; POST-only token submission; 5-minute auth session TTL

### Phase 4: Multi-Arch Docker & Distribution
**Rationale:** With browser-free mode and remote auth working, the proxy can run on any architecture. Multi-arch Docker images are now safe to build.
**Delivers:** Tiered Docker images (`:latest`/`:full` with Chromium, `:slim` without), Docker HEALTHCHECK, multi-arch build via Buildx + QEMU (amd64, arm64, riscv64, arm/v7), `npm run doctor` diagnostics command, graceful shutdown with request draining
**Addresses:** A1 (multi-arch Docker), A4 (image tags), M4 (Docker HEALTHCHECK), D4 (RISC-V image), D6 (doctor command), D12 (graceful shutdown), M1 (health endpoint improvements)
**Avoids:** Pitfall 7 (multi-arch Docker failures — tiered strategy, conditional Chromium install)
**Key decisions:** `:slim` image for all architectures (no Chromium); `:full` only for amd64/arm64; RISC-V = slim only; conditional Chromium install via `TARGETARCH` build arg

### Phase 5: CI/CD & Production Readiness
**Rationale:** With all features built, establish automated testing and deployment. CI validates multi-arch builds and runs the test suite.
**Delivers:** GitHub Actions CI pipeline, test matrix (ubuntu + macos, Node 20 + 22), multi-arch Docker build workflow, mock Qwen server for integration tests, smoke tests, liveness/readiness probes
**Addresses:** T2 (CI pipeline), T3 (smoke tests), T4 (mock Qwen integration), M2 (liveness/readiness), D7 (cross-platform CI matrix)
**Avoids:** Pitfall 4 (dual runtime divergence — shared test suite), Pitfall 5 (Qwen API instability — nightly E2E with real tokens)
**Key decisions:** QEMU emulation for ARM64/RISC-V Docker builds (not tests); tests on x86_64 only; smoke tests per architecture; build on merge to main only (not every PR)

### Phase Ordering Rationale

- **Platform compatibility before auth** — Auth strategies need browser-free mode to exist; you can't test QR auth if the proxy crashes without Chrome
- **Service extraction before new features** — Adding auth strategies and routes to the current monolith compounds technical debt; clean architecture first
- **Headless auth before Docker** — Remote auth must work before building Docker images that can't open a browser
- **Docker before CI** — Multi-arch images need to exist before CI can build and push them
- **CI last** — Tests are written alongside each phase; CI just automates running them
- **Architecture Patterns 3, 4, 5 (shared config, route decomposition, shared schema) are cross-cutting** — They're implemented incrementally across phases, not as standalone work

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (Headless Auth):** Complex integration — Qwen's auth flow is undocumented; the QR/link callback mechanism (how to extract tokens from a phone browser session) needs empirical validation. Security patterns (state/nonce, CORS restrictions) need careful design.
- **Phase 4 (Multi-Arch Docker):** QEMU emulation performance for RISC-V is unknown; Chromium version compatibility between Puppeteer protocol and Debian's `chromium` package on ARM64 needs testing.
- **Phase 5 (CI/CD):** GitHub Actions ARM64 runner availability and QEMU build times need empirical measurement; mock Qwen server design needs investigation.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Foundation):** Well-documented — Puppeteer configuration, Vitest setup, Node.js `process.arch` detection all have extensive documentation.
- **Phase 2 (Service Extraction):** Standard refactoring — Strategy Pattern, route decomposition, dependency injection are textbook patterns with clear implementation guides.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All technologies verified against official docs (Puppeteer 25.1, Vitest 4.1, Docker Buildx, GitHub Actions). Version compatibility confirmed. |
| Features | HIGH | Feature landscape derived from deep codebase analysis + established patterns (QR auth, device flow, multi-arch Docker). Dependencies mapped. |
| Architecture | HIGH | Component boundaries grounded in existing code structure. Anti-patterns identified from concrete codebase issues (2090-line routes.js, circular deps). Patterns are GoF standard. |
| Pitfalls | HIGH | Pitfalls verified against official Puppeteer docs (ARM64 Chrome issue), Chromium build matrix, and codebase analysis. Security pitfalls derived from OWASP patterns. |

**Overall confidence:** HIGH

### Gaps to Address

- **Qwen auth token TTL:** Research couldn't determine how long Qwen tokens last before expiring. This affects token health check intervals and re-auth urgency. **Handle during Phase 1 planning:** implement empirical TTL tracking (record `addedAt`, observe when tokens get 401s).
- **Qwen Chat login flow for remote auth:** The exact mechanism for extracting tokens from a phone browser after Qwen login is unclear — `localStorage` access from the callback page may be blocked by same-origin policy. **Handle during Phase 3 planning:** spike the QR/link flow to validate token extraction before building the full auth strategy.
- **Python runtime scope:** The project has both Node.js and Python servers. Research recommends Node.js as primary but doesn't resolve whether Python should be a thin client or continue as parallel implementation. **Handle during Phase 2 planning:** make explicit decision; if thin client, define the HTTP contract between Python and Node.js.
- **Puppeteer stealth compatibility with system Chromium:** The `puppeteer-extra-plugin-stealth` plugin may behave differently with system Chromium vs. bundled Chrome for Testing. **Handle during Phase 1 execution:** test stealth plugin with `apt-get install chromium` on ARM64.
- **Docker image size with Chromium:** Including Chromium in the Docker image significantly increases size (~500MB+). Research recommends tiered images but doesn't quantify the size difference. **Handle during Phase 4 planning:** measure both image sizes and document.

## Sources

### Primary (HIGH confidence)
- Puppeteer 25.1.0 official docs — ARM64 Linux Chrome unavailability, Docker setup, configuration options
- Docker official docs — Multi-platform builds with Buildx, QEMU setup, `tonistiigi/binfmt`
- Vitest 4.1.7 docs — ES Module support, coverage configuration, Jest compatibility
- Playwright docs — Browser management, ARM64 Docker support, system browser connection
- GitHub Actions marketplace — `docker/setup-qemu-action` v4.1, `docker/setup-buildx-action` v4, `docker/build-push-action` v6
- npm registry — `qrcode` (3M+ weekly downloads), `qrcode-terminal`, `supertest`

### Secondary (MEDIUM confidence)
- Puppeteer issue #14258 — `--platform linux_arm` installs x86_64 binary (confirmed bug)
- Codebase analysis — `.planning/codebase/` files (ARCHITECTURE.md, CONCERNS.md, STACK.md, TESTING.md)
- Open WebUI docs — OpenAI connection configuration
- LiteLLM docs — `openai/<model>` provider routing
- `qrcode-terminal` npm package — cross-platform terminal QR rendering

### Tertiary (LOW confidence)
- Qwen Chat API behavior — undocumented v2 endpoints; patterns inferred from codebase analysis, not official docs
- Token TTL estimation — no official documentation; must be measured empirically
- RISC-V Chromium availability — community builds exist but are experimental and unreliable

---
*Research completed: 2026-06-06*
*Ready for roadmap: yes*
