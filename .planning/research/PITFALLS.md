# Pitfalls Research

**Domain:** Headless multi-platform API proxy (Qwen Chat → OpenAI-compatible)
**Researched:** 2026-06-06
**Confidence:** HIGH (verified against Puppeteer official docs, Playwright docs, codebase analysis, existing CONCERNS.md)

## Critical Pitfalls

### Pitfall 1: Puppeteer Downloads x86_64 Chrome Only — Linux ARM64 Silently Broken

**What goes wrong:**
Puppeteer's `npm install` downloads Chrome for Testing binaries. On Linux ARM64, the downloaded binary is x86_64 — it **will not execute**. The Puppeteer troubleshooting docs explicitly state: *"Chrome currently does not provide arm64 binaries for Linux. There are only arm64 binaries for Mac ARM. That means that Linux binaries downloaded by default will not work on Linux arm64."* The current Dockerfile (`FROM node:20-slim` + `apt-get install chromium`) works on x86_64 because Debian's `chromium` package is available for amd64. On ARM64, Debian's `chromium` package exists but may be a different version than what Puppeteer expects, causing protocol mismatches.

**Why it happens:**
Google only publishes Chrome for Testing binaries for linux-amd64 and mac-arm64. Puppeteer's `browsers install chrome` has no ARM64 Linux target. Developers test on x86_64 machines and don't discover the failure until deploying to ARM64 servers or building multi-arch Docker images.

**How to avoid:**
1. Always set `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` in Dockerfile (already done) — rely on system Chromium
2. For ARM64 Linux: use `apt-get install chromium` (Debian provides ARM64 Chromium packages in bookworm+)
3. Detect architecture at runtime: check `process.arch` and use `executablePath` to point to system Chromium
4. For architectures with NO Chromium (RISC-V, ARM32): the proxy must work without a browser entirely (token-only mode)
5. Add a startup health check that verifies the browser actually launches before accepting requests

**Warning signs:**
- `npm install` succeeds on ARM64 but Chrome binary errors with "cannot execute binary file: Exec format error"
- Docker multi-arch build succeeds for x86_64 but ARM64 container crashes on first Puppeteer call
- `ldd $(which chromium) | grep "not a dynamic executable"` — wrong architecture binary

**Phase to address:** Phase 1 (Chrome auto-detection) — this is the foundational platform-compatibility work

**Sources:**
- Puppeteer troubleshooting docs: "Chrome currently does not provide arm64 binaries for Linux" (HIGH confidence — official docs)
- Puppeteer issue #14258: "Installing Chrome with `--platform linux_arm` installs x86-64 binary" (confirmed bug)
- Playwright v1.16+ ships Docker images for ARM64 with Chromium — Playwright is the better choice for ARM64 Linux

---

### Pitfall 2: RISC-V and ARM32 Have No Viable Chromium — Architecture Graceful Degradation Required

**What goes wrong:**
There is no maintained Chromium build for RISC-V (rv64gc) or ARM32 (armhf). Period. The Chromium project does not officially target these architectures. Community builds exist for RISC-V but are experimental, severely outdated, and unsuitable for Puppeteer's protocol expectations. ARM32 Chromium builds are last-generation and incompatible with modern Puppeteer versions.

If the proxy requires Puppeteer/Chromium to function, it **will not work** on RISC-V or ARM32. Period. There is no workaround.

**Why it happens:**
Chromium's build system (GN/Ninja) doesn't officially support these targets. The JIT compilation engine (V8) needs architecture-specific code generation. RISC-V support in V8 is incomplete. ARM32 is considered a legacy architecture by Google.

**How to avoid:**
The proxy MUST have a browser-free operation mode:
1. **Token-only mode**: After initial auth (done elsewhere), the proxy uses Node-native `fetch()` with Bearer tokens — no browser needed for API calls
2. **Remote auth**: `/api/auth/start` endpoint generates a link/QR code that opens on the user's phone/desktop browser; the callback saves the token on the server. Server never needs a browser.
3. **Architecture detection at startup**: `if (process.arch === 'arm' || isRiscV()) { disableBrowser(); enableTokenOnlyMode(); }`
4. The existing `executeApiRequestWithNodeStreaming()` in `chat.js` already bypasses Puppeteer for streaming — extend this to ALL API operations, making the browser optional

**Warning signs:**
- Docker build for RISC-V completes but container exits immediately with "chrome: not found"
- Startup hangs forever trying to launch browser on ARM32
- Users reporting "I installed it on my Raspberry Pi / RISC-V board and it doesn't start"

**Phase to address:** Phase 1 (Chrome auto-detection + fallback) — must be designed from the start, not bolted on later

**Confidence:** HIGH — Chromium's official build matrix confirms no RISC-V/ARM32 targets

---

### Pitfall 3: Headless Auth Endpoints Are a Security Nightmare if Done Wrong

**What goes wrong:**
Adding `/api/auth/start` → `/api/auth/callback` endpoints for remote auth opens several attack vectors:

1. **Token leakage in logs**: The auth callback receives tokens via URL parameters or request body. If logged (Morgan logs all requests by default), tokens end up in `http.log` in plaintext
2. **Open redirect on callback**: If the callback accepts a `redirect_url` parameter without validation, attackers can redirect users to phishing pages after token capture
3. **CSRF on callback endpoint**: An attacker tricks an authenticated admin into visiting a page that POSTs to `/api/auth/callback` with a stolen/intercepted token, adding the attacker's Qwen account to the proxy
4. **No binding between start and callback**: If `/api/auth/start` doesn't create a one-time challenge, any request to `/api/auth/callback` with a valid Qwen token can add accounts
5. **Tokens visible in URL**: If using GET-based callback with token in query string, the token appears in browser history, referrer headers, and proxy logs

**Why it happens:**
Auth endpoints are deceptively simple to implement ("just save the token"). The complexity lies in preventing abuse. The current codebase already has `Access-Control-Allow-Origin: *` and auth middleware that's disabled when no API keys are configured (CONCERNS.md lines 111-122). Adding auth endpoints on top of this open default is dangerous.

**How to avoid:**
1. **Auth endpoints MUST require API key auth** — no anonymous auth flows allowed, even in "local mode"
2. **Use state/nonce pattern**: `/api/auth/start` generates a random `state` token, stored server-side with 5-minute TTL. Callback must present the same `state` value
3. **Tokens in POST body, never in URLs**: The callback endpoint must accept tokens via POST body only
4. **Add startup warning**: If server binds `0.0.0.0` with no API keys configured, print a loud warning
5. **Log redaction**: Morgan/http logger must redact `authorization`, `token`, and `cookie` headers
6. **Rate-limit auth endpoints**: Prevent brute-force token injection attempts
7. **Disable auth endpoints via env var**: `ENABLE_REMOTE_AUTH=false` should be the default on production deployments

**Warning signs:**
- Tokens appearing in `logs/http.log`
- `CORS: *` combined with unauthenticated auth endpoints
- Auth callback accepting tokens without state verification
- No rate limiting on `/api/auth/*` endpoints

**Phase to address:** Phase 2 (Headless auth implementation) — security must be designed in, not audited later

---

### Pitfall 4: Dual Node.js + Python Implementations Will Diverge Immediately

**What goes wrong:**
The project requires maintaining both a Node.js server (Express + Puppeteer) and a Python server (FastAPI + Playwright). The codebase analysis already shows this is happening — `main.py` (800 lines) duplicates all core logic from `src/api/` with different patterns: `_pointer` global vs. `tokenManager.js`, different cookie handling, different streaming implementation. The Python version is missing image/video generation, file upload, and multi-account features.

Every new feature or bug fix must be applied twice. Every Qwen API change must be tested against both implementations. The model mapping, token format, SSE streaming format, and error handling will diverge within the first sprint.

**Why it happens:**
Two independent implementations in different languages cannot share code. Even with shared config files (`AvailableModels.txt`, `tokens.json`), the logic that consumes them is duplicated. There is no testing framework for either implementation, so divergence goes undetected.

**How to avoid:**
1. **Designate a primary runtime** — Node.js is already the primary with more features. Python should be a thin client that calls the Node.js server's API, not a parallel implementation
2. **If parallel is required**: Extract shared contract into a JSON specification — model mapping schema, API endpoint contracts, token format spec, SSE chunk format spec
3. **Shared test suite**: Use the same OpenAI-compatible test client against both servers to verify parity
4. **Feature parity tracking**: Maintain a matrix of features per runtime, enforced by CI
5. **Never implement features in only one runtime**: If a feature can't be justified for both, reconsider whether it belongs in the core proxy

**Warning signs:**
- Python server returns different error codes than Node.js for the same request
- Model aliases work in Node.js but not Python
- Token rotation works differently between runtimes
- "Works with Node.js server but not Python" bug reports

**Phase to address:** Phase 0 (before adding features) — decide whether Python is a thin client or full reimplementation. This decision affects every subsequent phase.

---

### Pitfall 5: Qwen's Unofficial API Will Break Without Warning

**What goes wrong:**
The proxy depends on Qwen Chat's undocumented v2 API (`/api/v2/chat/completions`, `/api/v2/chats/new`). These endpoints are not publicly documented and can change at any time. The codebase already handles a 3-way response format split (SSE stream, JSON completion, structured error) with multiple fallback paths. A single upstream change can break:
- Token extraction from `localStorage` (field name changes)
- Chat API request/response format (field renames, new required fields)
- SSE chunk format (delimiter changes)
- Rate limiting behavior (different headers, different thresholds)
- Authentication flow (new CAPTCHA types, different cookie structure)

**Why it happens:**
Qwen (Alibaba/Qwen team) does not maintain these endpoints as a public API. They are internal endpoints used by the web chat UI. Changes are deployed without announcement or versioning.

**How to avoid:**
1. **Pinpoint failure detection**: The `/api/health` endpoint should include a "canary" check — make a lightweight API call to verify the Qwen contract is still valid
2. **Schema validation on responses**: Don't assume field names. Validate response structure before parsing. Log unexpected fields.
3. **Response format flexibility**: The existing 3-way handling (SSE/JSON/error) is good — extend this to be data-driven with a response parser registry
4. **Monitoring**: Log the Qwen API response schema version (if any) and alert on changes
5. **Fallback strategies**: Have a plan for each type of breakage (token extraction fails → try cookie-based; chat format changes → attempt legacy format)
6. **Decouple from Puppeteer for token extraction**: If `localStorage` structure changes, browser automation breaks. Remote auth (link/QR) bypasses this entirely.

**Warning signs:**
- Sudden spike in 401/403 errors from Qwen API
- Token extraction returns `null` from `localStorage.getItem('token')`
- SSE chunks have unexpected format (missing `data:` prefix, new JSON structure)
- New unknown fields in API responses that the proxy ignores

**Phase to address:** Every phase that touches Qwen API interaction. Mitigation architecture in Phase 1 (response validation layer).

---

### Pitfall 6: Token Lifecycle Management on Headless Servers — Tokens Expire and You're Locked Out

**What goes wrong:**
Qwen auth tokens expire. On a headless server with no browser, re-authentication requires:
1. Knowing that a token expired (no proactive notification from Qwen)
2. Having a way to re-authenticate without physical access to the server
3. Handling the gap between token expiry and re-auth (API returns 401, users see errors)

The current code marks tokens as invalid on 401 responses but has no mechanism to re-authenticate on a headless server. The Python version has the same issue. If ALL tokens expire simultaneously (e.g., Qwen invalidates all sessions), the proxy becomes completely non-functional and requires manual intervention.

**Why it happens:**
Token refresh is straightforward when a browser is available (re-open page, re-extract token). On a headless server, there's no browser to automate. The token expiry time is unknown — Qwen doesn't expose TTL information. The proxy discovers expiry only when a request fails.

**How to avoid:**
1. **Proactive token health checks**: Periodically (every 30 min) make a lightweight API call with each token to verify it's still valid. Mark tokens as "expiring soon" before they fail in production
2. **Multi-account redundancy**: Never run with a single token. The round-robin system should have at least 2-3 tokens so one expiry doesn't cause total outage
3. **Token expiry estimation**: Track when tokens were created and the typical TTL (empirically measured). Send alerts when tokens approach estimated expiry
4. **Remote re-auth as first-class operation**: The headless auth endpoints (link/QR) must work reliably enough that re-auth from a phone is a 30-second operation
5. **Graceful degradation**: When all tokens are invalid, return `503 Service Unavailable` with a JSON body explaining "all tokens expired, use /api/auth/start to re-authenticate" — don't return generic 500 errors
6. **Token refresh webhook**: If Qwen ever supports token refresh, implement it immediately. Don't wait for tokens to expire.

**Warning signs:**
- Increasing 401 error rate from Qwen API
- Token marked invalid but no way to re-authenticate remotely
- Only one token configured (single point of failure)
- No monitoring on token health
- Users reporting "it was working yesterday, now it returns errors"

**Phase to address:** Phase 2 (Headless auth) for the re-auth flow. Phase 1 (Token health monitoring) for proactive detection.

---

### Pitfall 7: Multi-Arch Docker Build Failures — libc Mismatches and Native Dependencies

**What goes wrong:**
The current Dockerfile uses `node:20-slim` (Debian-based) with `apt-get install chromium`. Building this for multiple architectures fails in multiple ways:

1. **Debian chromium package availability**: Available for amd64 and arm64, but NOT for riscv64 or armhf in standard Debian repos
2. **Puppeteer's native dependencies**: The `puppeteer` npm package may have native addons that need compilation per architecture
3. **QEMU emulation for RISC-V**: GitHub Actions can use QEMU to emulate RISC-V, but it's 10-100x slower than native. A 5-minute x86_64 build becomes a 50-minute RISC-V build
4. **Font dependencies**: `fonts-liberation` and other rendering packages may not be available for all architectures
5. **glibc vs musl**: If using Alpine-based images for smaller size, Chromium requires glibc — musl (Alpine's libc) is incompatible. Alpine 3.20 has known Chromium timeout issues with Puppeteer

**Why it happens:**
Docker multi-arch builds via `docker buildx` build each architecture independently. Dependencies must be available for each target architecture. Chromium's dependency chain is deep (30+ shared libraries) and not all are available on all architectures.

**How to avoid:**
1. **Tiered Docker images**:
   - **Full image** (x86_64, ARM64): Includes Chromium, supports browser auth
   - **Slim image** (all architectures): No Chromium, token-only mode, remote auth only
   - Use build args or separate Dockerfiles per tier
2. **`docker buildx` with matrix**: Build x86_64 and ARM64 natively (or via QEMU). Skip RISC-V Chromium — token-only image only
3. **Base image selection**: Use `node:20-bookworm` (not slim) for architectures that need Chromium — bookworm has the full Debian package repo
4. **Conditional Chromium install in Dockerfile**:
   ```dockerfile
   ARG TARGETARCH
   RUN if [ "$TARGETARCH" = "amd64" ] || [ "$TARGETARCH" = "arm64" ]; then \
         apt-get update && apt-get install -y chromium && \
         rm -rf /var/lib/apt/lists/* ; \
       fi
   ```
5. **Build-time architecture detection**: Pass `TARGETARCH` as a build arg, conditionally set `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` and `CHROME_PATH`
6. **Test each architecture's image**: Don't assume ARM64 works because x86_64 does. CI must test per-arch

**Warning signs:**
- `docker buildx` fails on ARM64 with "E: Unable to locate package chromium"
- RISC-V build succeeds but container crashes on startup
- Alpine-based builds timeout during Puppeteer operations
- CI builds timing out on emulated architectures

**Phase to address:** Phase 1 (Docker multi-arch) — must be part of the initial platform support phase

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Single Dockerfile for all architectures | Simpler CI | ARM64/RISC-V silently broken | **Never** — will cause user-facing failures |
| Skipping browser-free operation mode | Faster initial development | RISC-V/ARM32 users completely blocked | **Never** — project requirement |
| Implementing auth in only Node.js | Less work | Python users can't authenticate | MVP only — must add Python auth before v1 |
| Hardcoded Qwen API field names | Faster implementation | Breaks silently when Qwen changes | **Never** — use a response validation layer |
| Shared `tokens.json` between Node.js and Python | No extra infrastructure | Concurrent write corruption | Acceptable for single-server; must add file locking for multi-instance |
| No token health monitoring | Less code | Tokens expire silently, users see random 401s | MVP only — add monitoring in Phase 1 |
| `session/tokens.json` as plaintext | Simple implementation | Token exposure if directory is accidentally served | Acceptable with `.gitignore` + file permissions; must fix before public deployment |
| Single Dockerfile with `if` statements | One file to maintain | Complex conditional logic, hard to debug per-arch | Acceptable for 2-3 architectures; use separate Dockerfiles if matrix grows |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Puppeteer + system Chromium | Assume Puppeteer's protocol version matches system Chromium version | Pin Chromium version or use Puppeteer's bundled Chrome for x86_64; for ARM64, verify Chromium version compatibility with Puppeteer's protocol expectations |
| Qwen Chat API | Assume stable response format | Parse responses defensively: check for SSE stream, JSON completion, or error-within-200-OK. Log unrecognised formats for analysis |
| Docker multi-arch + QEMU | Expect QEMU-emulated RISC-V to run at native speed | Limit RISC-V CI to smoke tests only. Full test suite on x86_64/ARM64. RISC-V build should be a "does it compile and start?" check |
| OpenAI SDK compatibility | Return exact OpenAI response format | Match OpenAI's response schema exactly — field names, types, nullability. Test with actual OpenAI SDK, not just HTTP calls |
| LiteLLM integration | Assume LiteLLM handles all OpenAI-compatible providers | Test specifically with LiteLLM's Qwen provider — it may set custom headers or modify the request format |
| Playwright (Python) | Assume Playwright and Puppeteer behave identically | Playwright has different API patterns (auto-wait, different selector syntax). The Python server must be tested independently |
| `ali-oss` SDK | Import `ali-oss` but upload via browser `page.evaluate()` | Either use `ali-oss` server-side (recommended) or remove the dead dependency. The current browser-based upload leaks STS credentials into page context |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| In-memory `chatIdMap` with no eviction | Memory usage grows linearly over days/weeks | Add LRU eviction (cap at 10K entries, evict after 1 hour) | After ~100K unique conversations (days of continuous use) |
| Puppeteer page pool contention | Requests queue, latency spikes under load | Prefer Node-native `fetch()` for all token-based requests; reserve Puppeteer for auth only | When concurrent requests exceed `PAGE_POOL_SIZE` (default 3) |
| Synchronous `fs.readFileSync` for `tokens.json` on every request | Event loop blocks during file reads | Cache `tokens.json` in memory with file watcher for updates | Immediately — affects every single request |
| Full chat history write on every response | Disk I/O blocks per response, grows with conversation length | Append-only writes or debounced persistence | When conversations exceed 50+ messages |
| Browser restart during active requests | "Page is closed" errors for all concurrent requests | Implement request draining queue before browser restart | When browser verification is triggered during traffic |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Auth endpoints without API key requirement | Anyone on the network can add/remove Qwen accounts | Auth endpoints MUST require API key — reject unauthenticated requests to `/api/auth/*` |
| Tokens in GET request parameters | Tokens leak via browser history, referrer headers, server logs | Tokens only in POST body, never in URLs |
| `CORS: *` with auth endpoints enabled | Any website can trigger auth flows in user's browser | Restrict CORS to configured origins when auth endpoints are active |
| No CSRF protection on auth callback | Attacker can inject tokens via cross-site POST | Use state/nonce pattern for auth flows — start generates nonce, callback validates it |
| `session/` directory world-readable | Docker default umask may allow other containers to read tokens | Set file permissions to `0600` for token files, use non-root user (already in Dockerfile) |
| Morgan logging request bodies | Tokens in POST bodies appear in `http.log` | Configure Morgan to exclude auth endpoints from body logging, or redact sensitive fields |
| No rate limiting on auth endpoints | Brute-force token injection or account enumeration | Add `express-rate-limit` specifically for `/api/auth/*` — 5 attempts per minute per IP |
| Auth state tokens without TTL | One-time auth URLs remain valid forever | Expire auth state tokens after 5 minutes, delete after use |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Error messages that say "Qwen API error" | Users don't know if it's a token issue, rate limit, or upstream change | Return structured errors: `{"error": "token_expired", "message": "Qwen session expired. Re-authenticate via /api/auth/start"}` |
| Headless setup requires reading source code | Users on RISC-V/ARM32 can't figure out why Puppeteer fails | Startup message: `"No browser detected (architecture: riscv64). Running in token-only mode. Use /api/auth/start to add tokens."` |
| Auth flow has no timeout or progress feedback | User clicks auth link, nothing seems to happen, server is waiting silently | Show clear status: "Waiting for authentication... (link expires in 4:32)" in CLI; polling endpoint for headless |
| All tokens expired with no recovery path | Proxy returns 500, users don't know what to do | Return 503 with clear instructions: `"All Qwen tokens expired. Open http://server:3264/api/auth/start in a browser to re-authenticate."` |
| Docker image works on x86_64 but not ARM | ARM users pull image, container crashes immediately | Multi-arch manifest with per-architecture README. Startup health check that validates browser availability. |

## "Looks Done But Isn't" Checklist

- [ ] **Multi-arch Docker**: Image builds for ARM64, but Chromium actually launches? — verify with `docker run --rm <arm64-image> node -e "require('puppeteer').launch().then(b => b.close())"` 
- [ ] **Token-only mode**: Proxy starts without browser, but ALL endpoints work without Puppeteer? — verify chat, models, status, image gen, file upload all work with tokens only
- [ ] **Headless auth**: Auth endpoint returns a link, but token is actually saved and usable for API calls? — verify end-to-end: start → login on phone → callback → make a chat request
- [ ] **Token refresh**: Tokens are marked invalid on 401, but is there a way to re-authenticate on a headless server? — verify the full re-auth cycle without a browser on the server
- [ ] **Python feature parity**: Python server starts, but does it support all the same endpoints? — verify image gen, video gen, file upload, multi-account, tool calls in Python
- [ ] **Graceful degradation**: Browser missing on RISC-V, but does the proxy still serve requests with existing tokens? — verify with `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` and pre-existing `tokens.json`
- [ ] **CI multi-arch**: Build succeeds for ARM64, but does the test suite actually run on ARM64? — verify CI runs tests (not just build) on ARM64 runner
- [ ] **Security**: Auth endpoints work, but are they protected against CSRF, token leakage, and unauthorized access? — verify with curl from unauthenticated client

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Puppeteer x86_64 binary on ARM64 | LOW | Set `PUPPETEER_EXECUTABLE_PATH` to system Chromium. Rebuild image with `apt-get install chromium`. |
| All Qwen tokens expired | MEDIUM | SSH into server, run `npm run auth -- --headless` or call `/api/auth/start` remotely. Re-authenticate via phone/desktop browser. |
| Qwen API format changed | HIGH | Check `logs/raw-responses.log` for new format. Update response parser. Add new fallback format. Deploy fix. |
| Python/Node feature drift | HIGH | Audit both implementations against shared spec. Implement missing features in lagging runtime. Add shared test suite. |
| Docker multi-arch build broken | MEDIUM | Fix Dockerfile per-arch conditionals. Use `docker buildx` with explicit platform targets. Test per-arch. |
| Token file corruption (concurrent writes) | MEDIUM | Restore from backup. Add file locking (`proper-lockfile` npm package). Consider SQLite migration. |
| Auth endpoint exploited | HIGH | Rotate all Qwen tokens. Audit `session/tokens.json` for unknown tokens. Add API key auth to auth endpoints. Add rate limiting. |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Puppeteer x86_64-only Chrome | Phase 1: Chrome auto-detection | ARM64 Docker image launches browser successfully |
| No Chromium on RISC-V/ARM32 | Phase 1: Browser-free mode | Proxy runs all API calls without browser |
| Headless auth security | Phase 2: Headless auth | Security review: CSRF, token leakage, rate limiting |
| Dual runtime divergence | Phase 0: Architecture decision | Feature parity matrix test passes for both runtimes |
| Qwen API instability | Phase 1: Response validation layer | Canary health check detects API format changes |
| Token lifecycle on headless | Phase 2: Remote re-auth | Full re-auth cycle from phone completes in <30s |
| Multi-arch Docker failures | Phase 1: Docker multi-arch | `docker buildx` succeeds for amd64, arm64, riscv64 |
| CI/CD matrix explosion | Phase 3: CI/CD setup | CI completes in <15 min with multi-arch testing |
| Concurrent token file writes | Phase 1: Token manager refactor | Run 10 parallel token updates without corruption |

## Sources

- Puppeteer troubleshooting docs (official) — ARM64 Linux Chrome unavailability, Docker setup, Alpine issues
- Puppeteer issue #14258 — `--platform linux_arm` installs x86_64 binary
- Playwright release notes — ARM64 Docker support since v1.16, Ubuntu ARM64 since v1.17
- FreeQwenApi CONCERNS.md — Existing security, performance, and fragility analysis
- FreeQwenApi ARCHITECTURE.md — Anti-patterns (monolithic routes, circular dependencies, duplicated logic)
- FreeQwenApi Dockerfile — Current x86_64-only build configuration
- FreeQwenApi config.js — Current configuration surface

---
*Pitfalls research for: Headless multi-platform Qwen API proxy*
*Researched: 2026-06-06*
