# Feature Landscape

**Domain:** Headless multi-platform OpenAI-compatible API proxy / auth gateway
**Researched:** 2026-06-06
**Context:** Brownfield — existing Qwen Chat proxy adding headless Linux support, multi-arch deployment, and alternative auth flows while preserving Windows/GUI compatibility.

## Table Stakes

Features users expect. Missing = product feels broken or unusable on headless servers.

### Headless Authentication

| # | Feature | Why Expected | Complexity | Notes |
|---|---------|--------------|------------|-------|
| H1 | **HTTP auth endpoint** (`/api/auth/start` → link/QR → `/api/auth/callback` → token saved) | Users SSH into servers. They need to authenticate from a phone or remote browser without installing anything on the server. This is the primary headless workflow. | High | Device-flow inspired pattern (per GitHub OAuth RFC 8628). Server generates a short-lived auth session, user visits a URL on any device, server polls for completion. No OAuth provider needed — proxy generates its own auth URL. |
| H2 | **CLI auth flag** (`npm run auth -- --headless`) | Users in SSH sessions need to trigger auth from the command line and see a link/QR code in their terminal. The CLI prints a URL and a QR code; user scans/opens it elsewhere. | Medium | Use `qrcode-terminal` (1.3k stars, supports Linux/macOS/Windows) for terminal QR rendering. The CLI script already exists at `scripts/auth.js` — extend it with `--headless` flag. |
| H3 | **Token auto-refresh / re-auth** | Tokens expire on headless servers where no human is watching. The proxy must detect expired tokens (already partially done via `markInvalid`) and either auto-refresh from saved cookies or trigger a re-auth notification. | Medium | Current code detects 401 and marks tokens invalid. Missing: automatic cookie-based refresh attempt, and notification webhook when all tokens are dead. |
| H4 | **Token credential file** (`session/tokens.json`) | Persistent token storage so the proxy survives restarts without re-auth. Already exists but needs documentation and reliability improvements (atomic writes, corruption recovery). | Low | Already implemented in `src/api/tokenManager.js`. Needs: file-locking for concurrent access, backup on corruption, schema validation. |
| H5 | **Pre-seeded token import** (`--token` flag or env var `QWEN_TOKENS`) | Users who authenticated elsewhere (e.g., on their desktop) need to copy tokens to a headless server without running browser auth at all. | Low | Accept raw tokens via env var, CLI flag, or `tokens.json` volume mount in Docker. This is the simplest deployment path for Docker users. |

### Multi-Architecture Deployment

| # | Feature | Why Expected | Complexity | Notes |
|---|---------|--------------|------------|-------|
| A1 | **Docker multi-arch images** (amd64 + arm64) | ARM servers (Raspberry Pi, Oracle Cloud ARM, AWS Graviton) are common. Users expect `docker pull` to "just work" on their architecture. | Medium | Official Docker docs confirm: `docker buildx build --platform linux/amd64,linux/arm64` with QEMU emulation. GitHub Actions has first-class support via `docker/setup-qemu-action` + `docker/setup-buildx-action` + `docker/build-push-action`. (Context7: HIGH confidence) |
| A2 | **Chromium auto-detection** (system Chrome, Puppeteer cache, `CHROME_PATH`) | The proxy crashes on fresh install because Puppeteer can't find Chrome (`src/browser/browser.js` + `index.js`). Users expect it to detect and use whatever browser is available. | Medium | Current code has `CHROME_PATH` env var but no auto-detection. Need: check `$CHROME_PATH` → `which chromium` / `which google-chrome` → Puppeteer's bundled Chrome → graceful error with install instructions. |
| A3 | **Graceful degradation without browser** | On architectures where Chromium doesn't exist (RISC-V, some ARM32), the proxy must still function if tokens are pre-seeded. Browser is only needed for auth, not for API calls (which use Node `fetch()`). | Medium | Current `sendMessage()` in `chat.js` already uses Node `fetch()` preferentially. Browser `page.evaluate(fetch)` is fallback. Need: if no browser detected AND valid tokens exist → skip browser init entirely, use direct HTTP. |
| A4 | **Docker image with variant tags** (`:latest`, `:slim`, `:full`) | Users on constrained devices want smaller images; users who want browser auth in-container want the full image. | Low | `:slim` = Node.js only, no Chromium (requires pre-seeded tokens). `:full` = Node.js + Chromium. `:latest` = full. Multi-arch for both. |

### Testing Infrastructure

| # | Feature | Why Expected | Complexity | Notes |
|---|---------|--------------|------------|-------|
| T1 | **Unit test framework** (Vitest) | Zero tests currently. `"test": "echo ... && exit 1"`. Any serious project needs tests. Vitest is the standard for ES Module projects — zero-config, fast, Vite-native. | Low | Multiple pure functions are trivially testable: `getMappedModel()`, `parseToolCallJson()`, `normalizeIdValue()`, `validateAndPrepareMessage()`, `buildPayloadV2()`. (Context7: Vitest v3/v4, HIGH confidence) |
| T2 | **CI pipeline** (GitHub Actions) | No CI exists. PRs and pushes should run tests automatically. This is table stakes for any open-source project. | Low | GitHub Actions matrix: `os: [ubuntu-latest, windows-latest, macos-latest]`, `node: [20, 22]`. Use `actions/setup-node@v4`, `actions/checkout@v6`. (Context7: HIGH confidence) |
| T3 | **Smoke test per platform** | Users need to know the proxy works on their platform. A simple `npm run smoke` that hits `/health` and `/chat/completions` against a running server. | Low | `scripts/smoke_test.js` already exists. Needs: platform detection, skip auth-dependent tests when no tokens, GitHub Actions integration. |
| T4 | **Integration test with mocked Qwen** | Testing against live Qwen API is fragile and requires real tokens. Need a mock Qwen server for reliable CI. | Medium | Use `nock` or a simple Express mock server that returns Qwen-format SSE responses. Test the full request path: OpenAI-format request → proxy → mock Qwen → OpenAI-format response. |

### Client Integration

| # | Feature | Why Expected | Complexity | Notes |
|---|---------|--------------|------------|-------|
| C1 | **OpenAI SDK compatibility** (streaming + non-streaming) | Users plug this proxy into anything that speaks OpenAI. The `openai` npm/Python package with `base_url` pointed at the proxy must work out of the box. Already works. | Low (exists) | Already implemented and tested. Ensure it stays working as auth changes. |
| C2 | **Open WebUI connection** | Open WebUI expects: `URL` + `API Key` in Admin Settings → Connections → OpenAI. URL format: `http://host:port/v1` or `http://host:port/api`. Key: whatever the proxy accepts (or `none`). | Low (exists) | Already compatible. Open WebUI docs confirm: "Add Connection → URL + API Key → Model IDs filter". The proxy's `/api/models` returns OpenAI-format list. (Context7: HIGH confidence) |
| C3 | **LiteLLM routing** | LiteLLM expects `openai/<model>` with `api_base` pointing at proxy. Format: `litellm --model openai/qwen-max-latest --api_base http://host:port/v1`. | Low (exists) | Already compatible. LiteLLM docs confirm: "set `litellm.api_base` or `OPENAI_BASE_URL`". The proxy's OpenAI-compatible endpoints work. (Context7: HIGH confidence) |
| C4 | **`/v1/` path prefix support** | Many OpenAI clients default to `base_url/v1/chat/completions`. The proxy currently has `/api/chat/completions` and `/api/v1/chat/completions`. Need a clean `/v1/...` route alias for maximum compatibility. | Low | Add Express route alias: `/v1/chat/completions` → same handler. Already partially there via `/api/v1/`. |

### Monitoring & Health

| # | Feature | Why Expected | Complexity | Notes |
|---|---------|--------------|------------|-------|
| M1 | **Structured health endpoint** (`/health`) | Load balancers, Docker HEALTHCHECK, and monitoring systems need a standard health endpoint. Already exists but needs `/v1/` prefix and Kubernetes-compatible format. | Low (exists) | Current `/api/health` returns `ok`, `accounts`, `models`. Add: `/v1/health` alias, `uptime`, `version`, `platform` fields. |
| M2 | **Liveness + readiness separation** | Kubernetes expects `/live` (is the process alive?) and `/ready` (can it serve requests?). Live = process responds. Ready = has valid tokens. | Low | `/live` → 200 always. `/ready` → 200 if `availableAccounts > 0`, 503 otherwise. |
| M3 | **Prometheus metrics endpoint** (`/metrics`) | Headless services in production are invisible without metrics. Standard pattern: request count, latency histogram, error rate, token pool size. | Medium | Use `prom-client` npm package. Expose: `http_requests_total`, `http_request_duration_seconds`, `qwen_tokens_available`, `qwen_tokens_invalid`, `qwen_api_errors_total`. |
| M4 | **Docker HEALTHCHECK** directive | Docker users expect `docker ps` to show health status. Currently missing from Dockerfile. | Low | Add `HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -f http://localhost:3264/api/health || exit 1` to Dockerfile. |

---

## Differentiators

Features that set FreeQwenApi apart from other OpenAI-compatible proxies. Not expected, but valued.

### Headless Authentication

| # | Feature | Value Proposition | Complexity | Notes |
|---|---------|-------------------|------------|-------|
| D1 | **QR code login in terminal** | Users scan QR from phone to authenticate a headless server. This is how WeChat, WhatsApp Web, and Telegram Desktop work. Extremely intuitive for the "headless server" use case. | Medium | Generate QR encoding the auth URL. Print via `qrcode-terminal` in CLI mode, serve as SVG/PNG image via `/api/auth/qr` in HTTP mode. |
| D2 | **Telegram bot auth flow** | User sends `/login` to the proxy's Telegram bot → bot replies with login link → user clicks → token saved on server. Enables fully remote auth from mobile. | High | Requires Telegram Bot API integration. Separate from the existing Hermes integration. Bot receives auth callback, saves token. |
| D3 | **Webhook notification on token expiry** | When all tokens expire, the proxy calls a configured webhook URL (Slack, Discord, Telegram, custom). User gets notified and can re-auth remotely. | Low | `ON_TOKENS_EXHAUSTED_WEBHOOK` env var. POST with `{event: "tokens_exhausted", accounts: [...], timestamp: "..."}`. Simple but powerful for production use. |

### Multi-Architecture

| # | Feature | Value Proposition | Complexity | Notes |
|---|---------|-------------------|------------|-------|
| D4 | **RISC-V Docker image** (via QEMU) | First-mover advantage: very few Docker images support RISC-V. Demonstrates commitment to "any platform". | Medium | QEMU emulation in CI (`docker/setup-qemu-action`). RISC-V Chromium unlikely → `:slim` image only (no browser, pre-seeded tokens). |
| D5 | **Binary releases via GitHub Releases** | Users who don't want Docker can download a standalone binary. `pkg` or `nexe` bundles Node.js + app into single executable. | Medium | Use `vercel/pkg` or `nexe`. Platform matrix: `linux-x64`, `linux-arm64`, `darwin-arm64`, `win-x64`. Attach to GitHub Releases via CI. |
| D6 | **Platform detection & diagnostics command** (`npm run doctor`) | Users run one command to diagnose: "Can this machine run FreeQwenApi?" Checks: Node.js version, Chrome availability, architecture, Docker presence, network connectivity to Qwen. | Low | New `scripts/doctor.js`. Checks each dependency, prints green/red status. Saves hours of troubleshooting. |

### Testing & Quality

| # | Feature | Value Proposition | Complexity | Notes |
|---|---------|-------------------|------------|-------|
| D7 | **Cross-platform CI matrix** (5 OS × 2 Node versions) | GitHub-hosted runners cover: ubuntu-latest (x86_64), macos-latest (ARM64), windows-latest (x86_64). QEMU emulation for arm64 Docker builds. RISC-V via QEMU cross-build only. | Medium | `matrix: { os: [ubuntu-latest, macos-latest, windows-latest], node: [20, 22] }` + separate Docker build job with `platforms: linux/amd64,linux/arm64`. |
| D8 | **End-to-end test with real Qwen** (nightly, on schedule) | Unit tests with mocks don't catch "Qwen changed their API". A nightly E2E test with real tokens catches upstream breaks. | Medium | GitHub Actions `schedule: cron(0 3 * *)`. Use secrets for test tokens. Fail → open issue automatically. |

### Client Integration

| # | Feature | Value Proposition | Complexity | Notes |
|---|---------|-------------------|------------|-------|
| D9 | **OpenCode provider integration** | OpenCode is a CLI AI tool. Document how to configure it as an OpenAI-compatible backend: set `OPENAI_BASE_URL=http://localhost:3264/api` and `OPENAI_API_KEY=...`. No code changes needed — just docs. | Low | No code required. Add integration guide with `opencode.json` example. The existing OpenAI compatibility is sufficient. |
| D10 | **Hermes agent loop adapter** (already exists) | The tool call adapter (`src/api/routes.js:475-584`) emulates OpenAI function calling via prompt injection. This is a differentiator — most proxies don't bother with tool call compatibility. | Exists | Already implemented. Ensure it survives the refactoring (currently embedded in the 2090-line `routes.js` monolith). |

### Monitoring & Operations

| # | Feature | Value Proposition | Complexity | Notes |
|---|---------|-------------------|------------|-------|
| D11 | **`/api/auth/status` endpoint** | Shows which auth methods are available on this platform: browser-based, HTTP endpoint, CLI, token import. Lets client tools and scripts adapt their auth flow to the platform. | Low | Return: `{ methods: ["http", "cli", "browser", "import"], browserAvailable: true/false, hasTokens: true/false }`. |
| D12 | **Graceful shutdown with request draining** | When Docker stops the container (`SIGTERM`), the proxy should finish in-flight requests before exiting. Prevents dropped responses. | Low | `process.on('SIGTERM', ...)` → stop accepting new requests → wait for in-flight to complete (with timeout) → exit. |
| D13 | **Token pool status dashboard** (JSON endpoint, not UI) | `GET /api/status` already returns per-account token status. Extend with: last used timestamp, requests served count, next rotation position. Enables external dashboards (Grafana, etc.) via Prometheus metrics. | Low | Extend existing `/api/status` response. No new endpoint needed. |

---

## Anti-Features

Features to explicitly NOT build. Building these wastes time, adds complexity, or conflicts with the project's identity.

| # | Anti-Feature | Why Avoid | What to Do Instead |
|---|-------------|-----------|-------------------|
| X1 | **Web UI dashboard** | PROJECT.md explicitly scopes this out. It's a proxy, not a management platform. Open WebUI already provides a frontend. Users who want a dashboard can use Grafana + Prometheus with the `/metrics` endpoint. | Provide JSON endpoints + Prometheus metrics. Let existing dashboard tools consume them. |
| X2 | **Official Qwen API integration** | PROJECT.md explicitly scopes this out. The project's identity is browser-based auth to free Qwen Chat. Using the official API would require API keys and defeat the purpose. | Stay with browser token extraction. Document this as a design decision. |
| X3 | **Local model inference** | This is a proxy, not a model runner. Ollama, llama.cpp, and vLLM exist for local inference. Trying to add inference would dilute the project's focus. | Be the best proxy. Let inference tools be inference tools. |
| X4 | **Database persistence** | Current file-based storage (`session/tokens.json`, `session/history/`) is simple and works. Adding SQLite/Redis/Postgres creates operational complexity for no clear benefit at this scale. | Keep file-based storage. Add atomic writes and corruption recovery if needed. |
| X5 | **Multi-user tenant system** | This is a single-user/local proxy, not a SaaS platform. Adding user management, RBAC, and tenant isolation is scope creep. | Optional API key auth (`Authorization.txt`) already exists. That's sufficient for personal/team use. |
| X6 | **Custom model fine-tuning or training** | Completely different domain. The proxy's job is to relay requests, not train models. | Not applicable. Just don't. |
| X7 | **Built-in OAuth server for client apps** | Making the proxy an OAuth provider for downstream apps adds massive complexity. Clients should use their own auth; the proxy's optional API key is sufficient. | API key via `Authorization.txt` (already exists). Or expose behind a reverse proxy (nginx, Caddy) that handles auth. |
| X8 | **Automatic CAPTCHA solving** | Qwen occasionally shows verification pages. Building CAPTCHA solvers is ethically questionable and technically fragile. When verification appears, notify the user. | Detect verification page (already done in `checkVerification`), notify via webhook/log, prompt for manual intervention (or restart browser in visible mode on GUI platforms). |

---

## Feature Dependencies

```
┌─ Authentication ──────────────────────────────────────────────────────┐
│                                                                        │
│  H5 (Token Import) ─────► H4 (Credential File) ──► H3 (Auto-Refresh) │
│       │                                                    │           │
│       ▼                                                    ▼           │
│  A3 (No-Browser Mode) ──► H1 (HTTP Auth Endpoint) ──► D1 (QR Code)  │
│                                │                                      │
│                                ▼                                      │
│                           H2 (CLI Auth) ──► D1 (QR Code Terminal)    │
│                                                                        │
│                           D2 (Telegram Auth) ◄── H1 (HTTP Auth)      │
│                           D3 (Webhook Notify) ◄── H3 (Auto-Refresh)  │
└────────────────────────────────────────────────────────────────────────┘

┌─ Multi-Arch ─────────────────────────────────────────────────────────┐
│                                                                        │
│  A2 (Chrome Detection) ──► A3 (No-Browser Degradation) ──► A4 (Tags) │
│                               │                                        │
│                               ▼                                        │
│                          A1 (Multi-Arch Docker) ◄── T1 (Tests)       │
│                               │                                        │
│                               ▼                                        │
│                          D4 (RISC-V) ◄── D5 (Binary Releases)       │
│                                                                        │
│  D6 (Doctor) ◄── A2 (Chrome Detection)                               │
└────────────────────────────────────────────────────────────────────────┘

┌─ Testing ─────────────────────────────────────────────────────────────┐
│                                                                        │
│  T1 (Vitest Framework) ──► T3 (Smoke Tests) ──► T2 (CI Pipeline)    │
│       │                              │                                  │
│       ▼                              ▼                                  │
│  T4 (Mock Qwen) ◄── D7 (Cross-Platform Matrix) ──► D8 (Nightly E2E)│
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘

┌─ Monitoring ──────────────────────────────────────────────────────────┐
│                                                                        │
│  M1 (Health Endpoint) ──► M2 (Live/Ready) ──► M4 (Docker HEALTHCHECK)│
│       │                                                                │
│       ▼                                                                │
│  M3 (Prometheus Metrics) ──► D13 (Token Pool Dashboard Data)         │
│                                                                        │
│  D12 (Graceful Shutdown) ◄── M1 (Health Endpoint)                    │
│  D11 (Auth Status) ◄── H1 (HTTP Auth Endpoint)                       │
└────────────────────────────────────────────────────────────────────────┘
```

### Critical Path

The **minimum viable headless proxy** requires these features in order:

1. **H5** (Token Import) → Enables immediate headless use without any new auth
2. **A2** (Chrome Detection) → Fixes the crash-on-fresh-install bug
3. **A3** (No-Browser Degradation) → Enables operation without browser
4. **H1** (HTTP Auth Endpoint) → Enables remote authentication
5. **A1** (Multi-Arch Docker) → Enables ARM64 deployment
6. **T1** (Vitest) → Enables testing everything else

### Phase Dependencies

| Phase Prerequisite | Enables |
|---|---|
| H5 + A3 | Docker `:slim` image (no browser, pre-seeded tokens) |
| H1 + D1 | Full headless auth via HTTP + QR code |
| A2 + A3 | Running on any platform with or without browser |
| T1 + T4 | Reliable CI that doesn't depend on live Qwen |
| T2 + A1 | Automated multi-arch Docker builds in CI |
| M2 + M4 | Kubernetes-ready deployment |

---

## MVP Recommendation

### Priority 1 — Unblock Headless Users (Table Stakes)
1. **H5** — Token import via env var/CLI flag (immediate workaround for headless)
2. **A2** — Chrome auto-detection and fallback (fixes crash bug)
3. **A3** — Graceful degradation without browser (enables `:slim` Docker)
4. **T1** — Vitest setup with unit tests for pure functions

### Priority 2 — Headless Auth Experience (Table Stakes)
5. **H1** — HTTP auth endpoint (core headless auth flow)
6. **H2** — CLI `--headless` auth flag (SSH workflow)
7. **D1** — QR code in terminal (intuitive remote auth)

### Priority 3 — Multi-Platform Distribution (Differentiator)
8. **A1** — Multi-arch Docker images (amd64 + arm64)
9. **A4** — Docker image tags (`:latest`, `:slim`)
10. **M4** — Docker HEALTHCHECK

### Priority 4 — Production Readiness (Table Stakes)
11. **T2** — GitHub Actions CI pipeline
12. **T3** — Platform smoke tests
13. **M2** — Liveness/readiness probes
14. **D12** — Graceful shutdown

### Defer to Later Phases
- **D4** (RISC-V): Niche; QEMU emulation works but Chromium unavailable
- **D5** (Binary releases): Docker covers most users
- **D2** (Telegram bot auth): Complex; HTTP auth endpoint is sufficient for now
- **D7** (Cross-platform CI matrix): Can start with ubuntu-only
- **D8** (Nightly E2E): Only after unit/integration tests exist
- **M3** (Prometheus metrics): Only when users are running in production

---

## Sources

- **Docker multi-arch:** Docker official docs — `docker buildx build --platform`, GitHub Actions `docker/setup-qemu-action`, `docker/setup-buildx-action`, `docker/build-push-action` (Context7: HIGH confidence)
- **GitHub device flow:** GitHub OAuth docs — RFC 8628 Device Authorization Grant pattern (Official docs: HIGH confidence)
- **Vitest:** Context7 docs — Vitest v3/v4, ES Module support, coverage configuration (Context7: HIGH confidence)
- **Open WebUI integration:** Open WebUI docs — "Connections → OpenAI → URL + API Key + Model IDs" (Context7: HIGH confidence)
- **LiteLLM integration:** LiteLLM docs — `openai/<model>` with `api_base`, `OPENAI_BASE_URL` env var (Context7: HIGH confidence)
- **QR code terminal:** `qrcode-terminal` npm package (1.3k GitHub stars, supports Linux/macOS/Windows)
- **GitHub Actions matrix:** GitHub Actions docs — `strategy.matrix` for OS × version combinations (Context7: HIGH confidence)
- **Existing codebase analysis:** `.planning/codebase/` — ARCHITECTURE.md, STACK.md, INTEGRATIONS.md, TESTING.md

---

*Feature landscape: 2026-06-06*
