# Technology Stack — Headless Multi-Platform Extension

**Project:** FreeQwenApi — Headless Multi-Platform Milestone
**Researched:** 2026-06-06
**Focus:** Stack additions for headless server support, multi-arch, and alternative auth flows

This document covers **new technology choices** for the milestone. The existing stack (Express 4.18, Puppeteer 24, FastAPI, Playwright, Node 20, Python 3) is retained — only additive or replacement recommendations are listed.

---

## 1. Browser Automation on Multi-Arch

### Problem

Puppeteer bundles Chrome for Testing binaries for x86_64 and some ARM64 platforms. On RISC-V (`linux/riscv64`) and ARM32 (`linux/arm/v7`), no prebuilt Chrome binary exists. The current code crashes on fresh `npm install` because Puppeteer can't download Chrome.

### Recommendation: Browser Detection Cascade

| Layer | Technology | Version | Purpose | Confidence |
|-------|-----------|---------|---------|------------|
| Primary | Puppeteer (keep) | ^24.31 (current: 25.1) | Browser automation for x86_64, ARM64 where Chrome for Testing exists | HIGH |
| Fallback 1 | `executablePath` + system Chromium | N/A | Use OS-installed Chromium (`apt-get install chromium`, `chromium-browser`) when Puppeteer's bundled binary is absent | HIGH |
| Fallback 2 | Playwright (Node.js) | ^1.53 | Alternative automation with better system-browser support; can use `channel: 'chromium'` to connect to system Chromium | HIGH |
| Fallback 3 | No-browser auth flow | N/A | QR/link-based auth that bypasses browser entirely (see Section 2) | HIGH |

### Why not switch entirely to Playwright?

- Puppeteer + `puppeteer-extra-plugin-stealth` is deeply integrated in `src/browser/browser.js` for anti-detection against Qwen Chat.
- Playwright does not have equivalent stealth plugin ecosystem maturity. The Python side already uses Playwright; keeping Puppeteer for Node preserves stealth capabilities.
- Playwright's browser management is actually more opinionated (downloads its own Chromium), but it does support `channel` to use system browsers — this is useful as a detection layer, not a wholesale replacement.

### What NOT to use

| Avoid | Why |
|-------|-----|
| Selenium/WebDriver | Heavier, slower, no stealth plugins, worse async API for Node.js |
| `chrome-remote-interface` (raw CDP) | Too low-level; Puppeteer already wraps this |
| JSDOM / cheerio for auth | Cannot execute JavaScript; Qwen Chat auth requires a real browser JS runtime |

### Chrome/Chromium Availability by Architecture

| Architecture | Puppeteer Chrome | System Chromium | Auth Without Browser |
|--------------|-----------------|-----------------|---------------------|
| x86_64 (linux/amd64) | YES | YES | Optional |
| ARM64 (linux/arm64) | YES (since Puppeteer 21+) | YES | Optional |
| ARM32 (linux/arm/v7) | NO | YES (Debian: `chromium`) | Recommended |
| RISC-V (linux/riscv64) | NO | Partial (Debian sid has Chromium; Ubuntu experimental) | Required |
| macOS (M-series) | YES | YES (Homebrew) | Optional |
| macOS (Intel) | YES | YES | Optional |
| Windows | YES | YES | Optional |

### Implementation Strategy

```
Browser Detection Cascade:
1. Check CHROME_PATH env var → use if set
2. Check Puppeteer cache (`~/.cache/puppeteer`) → use if Chrome binary found
3. Check system paths: `/usr/bin/chromium`, `/usr/bin/chromium-browser`, etc.
4. If no browser found → fall back to link/QR auth (no browser needed)
```

**Sources:** Puppeteer 25.1.0 docs (pptr.dev), Playwright browsers docs (playwright.dev) — both verified 2026-06-06.

---

## 2. Headless Authentication (No Physical Browser)

### Problem

Current auth requires interactive browser login (Puppeteer opens visible Chrome window). On headless servers (SSH, VPS, Docker), there's no display and no way to interact with a browser GUI.

### Recommendation: Three-Mode Auth System

| Mode | Technology | When | Confidence |
|------|-----------|------|------------|
| **HTTP API auth** | Express endpoint + `qrcode` (npm) + short-lived token exchange | Headless server, remote auth via phone/another device | HIGH |
| **CLI link auth** | Terminal-rendered QR (`qrcode-terminal`) + clickable URL | SSH sessions, no API endpoint needed | HIGH |
| **Headless browser auth** | Puppeteer in `headless: 'new'` mode + cookie injection | Server with Chromium available, automated re-auth | MEDIUM |

### HTTP API Auth Flow (Primary Headless Method)

This is **not** OAuth Device Flow (RFC 8628) because Qwen Chat doesn't implement OAuth. Instead, it's a custom proxy flow that mimics the pattern:

```
┌──────────┐     GET /api/auth/start      ┌──────────────┐
│  Client   │ ──────────────────────────►  │  FreeQwenApi  │
│ (phone/   │ ◄────────────────────────── │    Server     │
│  browser) │   QR code + auth URL         │              │
│           │                              │              │
│           │  Opens URL in phone browser  │              │
│           │  → logs into chat.qwen.ai    │              │
│           │                              │              │
│  Server   │  POST /api/auth/callback     │              │
│  (polls)  │ ──────────────────────────►  │              │
│           │ ◄──────────────────────────  │  token saved  │
│           │   { success: true }          │  to tokens.json│
└──────────┘                              └──────────────┘
```

**How it works:**
1. Server starts a headless browser pointed at `chat.qwen.ai` login page
2. Server generates a URL like `http://server-ip:3264/auth/pending?id=SESSION_ID`
3. This URL is encoded as a QR code (displayed in terminal or returned via API)
4. User scans QR or opens the link on their phone
5. The phone page shows a "waiting for login..." status and polls the server
6. Meanwhile, the headless browser on the server has `chat.qwen.ai` open for login
7. The headless browser waits for the user to complete login in the **same browser session** (if cookies are shared) or the user manually copies the token from their phone browser's localStorage
8. **Simpler alternative**: The QR code links to `chat.qwen.ai` directly on the user's phone. After login, the user copies their token and submits it via `POST /api/auth/callback` with the token value. This avoids the complexity of cross-device session sharing.

**Simplest viable approach (recommended):**

```
1. GET /api/auth/start → server returns { auth_url: "https://chat.qwen.ai", qr_code: "data:image/png;base64,...", session_id: "..." }
2. User opens chat.qwen.ai on their phone, logs in
3. User extracts token from browser devtools (localStorage.getItem('token'))
4. POST /api/auth/callback { session_id: "...", token: "..." }
5. Server validates token with Qwen API, saves to tokens.json
```

### QR Code Libraries

| Library | Version | Purpose | Why | Confidence |
|---------|---------|---------|-----|------------|
| `qrcode` | ^1.5.x | Server-side QR code generation (PNG/SVG/data URI) | Most popular Node.js QR library, 3M+ weekly downloads, generates to data URI perfect for API responses and terminal | HIGH |
| `qrcode-terminal` | ^0.12.x | Render QR codes directly in terminal (CLI mode) | Lightweight, no dependencies, perfect for SSH sessions | HIGH |

### What NOT to use

| Avoid | Why |
|-------|-----|
| OAuth 2.0 Device Flow (RFC 8628) | Qwen Chat doesn't implement OAuth — can't use standard device flow |
| Puppeteer `page.exposeFunction()` for cross-device token relay | Overly complex, fragile across browser instances |
| Selenium Grid for remote browser | Massive infrastructure overhead for a simple auth flow |

**Sources:** `qrcode` npm package (npmjs.com), `qrcode-terminal` npm package — verified via npm registry.

---

## 3. Multi-Arch Docker Builds

### Recommendation: Docker Buildx with QEMU Emulation

| Technology | Version | Purpose | Why | Confidence |
|-----------|---------|---------|-----|------------|
| Docker Buildx | Latest (bundled with Docker 27+) | Multi-platform build driver | Standard tool for multi-arch Docker images; supports QEMU emulation and cross-compilation | HIGH |
| `tonistiigi/binfmt` | v10.2.1 | Register QEMU emulators for non-native architectures | De facto standard for enabling cross-arch builds; supports `arm64`, `riscv64`, `arm/v7`, `ppc64le`, `s390x` | HIGH |
| Docker `--platform` flag | N/A | Target specific architectures in Dockerfile | Works with Buildx for per-stage platform selection | HIGH |
| QEMU user-mode emulation | v6.0+ (bundled) | Run non-native binaries during build | Required for architectures without native runners; slower than native but functional | HIGH |

### Target Architecture Support

| Architecture | Docker Platform | Chromium Available | Build Strategy | CI Feasibility |
|--------------|----------------|-------------------|----------------|---------------|
| x86_64 | `linux/amd64` | YES | Native build on GitHub runners | Native runner available |
| ARM64 | `linux/arm64` | YES | Native build on ARM runners, or QEMU | GitHub ARM64 runners available |
| ARM32 | `linux/arm/v7` | YES (system) | QEMU emulation | QEMU on x86_64 runner |
| RISC-V | `linux/riscv64` | Partial | QEMU emulation | QEMU on x86_64 runner, may need Chromium source build |

### Dockerfile Strategy

```dockerfile
# Multi-stage: browser-optional architecture
FROM --platform=$TARGETPLATFORM node:20-slim AS base
RUN apt-get update && apt-get install -y chromium || echo "Chromium not available for this arch"
# ... rest of build

# At runtime: detect if chromium is available
ENV PUPPETEER_SKIP_DOWNLOAD=true
# Browser detection cascade handles missing chromium gracefully
```

### What NOT to use

| Avoid | Why |
|-------|-----|
| Docker Build Cloud (paid) | Unnecessary cost for this project scale; QEMU emulation is sufficient |
| Cross-compilation for Node.js | Node.js doesn't cross-compile — it's interpreted; just need correct arch Node.js binary (Docker handles this via `--platform`) |
| Custom RISC-V Chromium build from source | Extremely slow (8+ hours), impractical in CI; rely on system packages or skip browser on RISC-V |

**Sources:** Docker multi-platform docs (docs.docker.com), `tonistiigi/binfmt` GitHub repo — verified 2026-06-06.

---

## 4. Testing Frameworks

### Node.js Testing: Vitest

| Library | Version | Purpose | Why | Confidence |
|---------|---------|---------|-----|------------|
| `vitest` | ^4.1 | Unit + integration testing | Fastest Node.js test runner (Vite-powered), Jest-compatible API, native ESM support, built-in coverage via c8/v8, watch mode | HIGH |
| `supertest` | ^7.0 | HTTP assertion library for Express | De facto standard for testing Express routes; works with Vitest | HIGH |
| `@vitest/coverage-v8` | ^4.1 | Code coverage | Built-in Vitest coverage provider | HIGH |
| `playwright` (as test runner) | ^1.53 | E2E browser tests | For testing actual browser automation flows (auth, token extraction) | HIGH |

**Why Vitest over Jest:**
- Native ES Module support (project uses `"type": "module"`)
- Faster than Jest (no Babel transform needed)
- Jest-compatible assertions (`expect`) — minimal migration effort
- Better watch mode and HMR integration
- Current latest: v4.1.7 (requires Vite >=6, Node >=20 — both satisfied)

### Python Testing: pytest

| Library | Version | Purpose | Why | Confidence |
|---------|---------|---------|-----|------------|
| `pytest` | ^8.3 | Unit + integration testing | Standard Python test framework; extensive plugin ecosystem | HIGH |
| `pytest-asyncio` | ^0.24 | Async test support for FastAPI | FastAPI endpoints are async; pytest-asyncio enables `async def test_()` | HIGH |
| `httpx` | ^0.28 | Test client for FastAPI | FastAPI's `TestClient` is built on httpx; used for endpoint testing | HIGH |

### What NOT to use

| Avoid | Why |
|-------|-----|
| Jest | Requires Babel/CommonJS transform for ESM; Vitest is native ESM |
| Mocha + Chai | Older ecosystem, less integrated; Vitest is the 2025 standard |
| `unittest` (Python stdlib) | Verbose, less flexible than pytest; pytest is the community standard |
| Cypress | Browser testing tool, not suitable for API/server testing; Playwright is better for browser automation tests |

### Installation

```bash
# Node.js
npm install -D vitest @vitest/coverage-v8 supertest

# Python (add to requirements.txt)
pytest>=8.3
pytest-asyncio>=0.24
httpx>=0.28
```

**Sources:** Vitest docs (vitest.dev v4.1.7), pytest docs — verified 2026-06-06.

---

## 5. CI/CD: GitHub Actions Multi-Arch

### Recommendation: Matrix Build with QEMU

| Technology | Version | Purpose | Why | Confidence |
|-----------|---------|---------|-----|------------|
| `docker/setup-qemu-action` | v4.1 | Install QEMU for cross-platform builds | Official Docker action; supports arm64, riscv64, arm, ppc64le, s390x | HIGH |
| `docker/setup-buildx-action` | v4 | Create BuildKit builder instance | Required for multi-platform builds via buildx | HIGH |
| `docker/build-push-action` | v6 | Build and push multi-arch images | Official Docker action; handles multi-platform builds with provenance/attestations | HIGH |
| `docker/login-action` | v3 | Registry authentication | Supports Docker Hub, GHCR, and others | HIGH |
| GitHub-hosted runners | ubuntu-latest (x86_64), ubuntu-24.04-arm (ARM64) | Native build runners | GitHub now offers ARM64 runners; x86_64 runners are standard | HIGH |

### CI Strategy

```
┌─────────────────────────────────────────────────────────────┐
│ GitHub Actions Workflow                                      │
├───────────────────┬───────────────────┬─────────────────────┤
│ Test Matrix       │ Build Matrix      │ Security            │
│                   │                   │                     │
│ ubuntu-latest     │ amd64 (native)    │ npm audit           │
│   ├─ Node 20      │ arm64 (native or  │ pip audit           │
│   └─ Python 3     │   QEMU)           │ Trivy image scan    │
│                   │ arm/v7 (QEMU)     │                     │
│ macos-latest      │ riscv64 (QEMU)    │                     │
│   └─ Node 20      │                   │                     │
│                   │ Push to GHCR or   │                     │
│                   │ Docker Hub        │                     │
└───────────────────┴───────────────────┴─────────────────────┘
```

### Workflow Pattern (Multi-Arch Docker Build)

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v4  # Enables arm64, riscv64, arm/v7
      - uses: docker/setup-buildx-action@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64,linux/arm/v7,linux/riscv64
          push: true
          tags: ghcr.io/${{ github.repository }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### Runner Availability

| Architecture | Runner Type | Native/QEMU | Speed | Availability |
|--------------|-------------|-------------|-------|-------------|
| x86_64 | `ubuntu-latest` | Native | Fast | Free (public repos) |
| ARM64 | `ubuntu-24.04-arm` | Native | Fast | Free (public repos) |
| ARM32 | `ubuntu-latest` + QEMU | Emulated | Slow | Free |
| RISC-V | `ubuntu-latest` + QEMU | Emulated | Slow | Free |

**Note:** QEMU emulation is 5-20x slower than native. For CI, this means RISC-V and ARM32 builds may take 10-30 minutes instead of 2-5 minutes. This is acceptable for Docker image builds (infrequent) but not for test-running (frequent). Testing should be architecture-agnostic (unit/integration tests on x86_64 only, with architecture-specific smoke tests).

### What NOT to use

| Avoid | Why |
|-------|-----|
| Self-hosted RISC-V runner | Maintenance burden; QEMU is sufficient for Docker builds |
| Travis CI / CircleCI | GitHub Actions is free for public repos and has native Docker support |
| Jenkins | Overkill for this project; GitHub Actions is simpler and integrated |
| Build Docker images on every PR | Too slow for QEMU architectures; build on merge to main only |

**Sources:** Docker Setup QEMU Action (GitHub Marketplace v4.1), docker/build-push-action docs — verified 2026-06-06.

---

## 6. Supporting Libraries

### New Dependencies for This Milestone

| Library | Version | Purpose | When to Use | Confidence |
|---------|---------|---------|-------------|------------|
| `qrcode` | ^1.5.4 | Generate QR codes (PNG/SVG/data URI) | Headless auth API endpoint | HIGH |
| `qrcode-terminal` | ^0.12.0 | Render QR in terminal | CLI headless auth (`npm run auth -- --headless`) | HIGH |
| `uuid` | ^10.0 | Generate session IDs for auth flow | Auth session tracking | HIGH |
| `vitest` | ^4.1.7 | Test framework (Node.js) | All Node.js testing | HIGH |
| `supertest` | ^7.0 | HTTP route testing | Testing Express endpoints | HIGH |
| `@vitest/coverage-v8` | ^4.1.7 | Coverage reporting | CI coverage reports | HIGH |
| `playwright` (Node.js) | ^1.53 | Alternative browser automation + E2E testing | When Puppeteer can't find Chrome; for test automation | HIGH |
| `pytest` | ^8.3 | Test framework (Python) | All Python testing | HIGH |
| `pytest-asyncio` | ^0.24 | Async test support | Testing FastAPI async endpoints | HIGH |

### What NOT to add

| Don't Add | Why |
|-----------|-----|
| TypeORM / Prisma / any database | Project uses file-based storage (JSON); adding a DB is over-engineering |
| `socket.io` / WebSocket library | Auth polling via HTTP is simpler and sufficient |
| `bull` / job queue library | Auth flow is synchronous (wait for token); no queue needed |
| `passport.js` | OAuth library — Qwen doesn't support OAuth; custom auth is simpler |
| `swagger-ui-express` | API is OpenAI-compatible (already documented by OpenAI); no need for separate docs |

---

## 7. Version Summary

### Existing Stack (Retained)

| Technology | Current Version | Upgrade? |
|-----------|----------------|----------|
| Node.js | 20 | Keep 20 LTS; consider 22 LTS when Puppeteer confirms support |
| Express | 4.18 | Keep; don't migrate to Express 5 yet (breaking changes, low benefit) |
| Puppeteer | 24.31 | Upgrade to 25.1 for latest Chrome for Testing support |
| Puppeteer-extra + stealth | 3.3.6 / 2.11.2 | Keep; compatible with Puppeteer 25 |
| FastAPI (Python) | Current | Keep; add feature parity in phases |
| Playwright (Python) | Current | Keep |

### New Stack (This Milestone)

| Technology | Version | Role |
|-----------|---------|------|
| Vitest | ^4.1.7 | Node.js testing |
| Supertest | ^7.0 | Express route testing |
| Playwright (Node.js) | ^1.53 | E2E testing + fallback browser automation |
| qrcode | ^1.5.4 | QR code generation |
| qrcode-terminal | ^0.12.0 | Terminal QR rendering |
| pytest | ^8.3 | Python testing |
| pytest-asyncio | ^0.24 | Python async testing |
| Docker Buildx + QEMU | Latest | Multi-arch container builds |
| GitHub Actions (QEMU, buildx) | v4 | CI/CD multi-arch |

---

## 8. Key Decisions

| Decision | Rationale | Confidence |
|----------|-----------|------------|
| Keep Puppeteer, add detection cascade | Stealth plugin is critical for Qwen; switching to Playwright loses anti-detection | HIGH |
| QR/link auth over OAuth Device Flow | Qwen doesn't implement OAuth; custom flow is simpler and matches user's mental model | HIGH |
| Vitest over Jest | Native ESM support, faster, modern; project already uses ESM modules | HIGH |
| QEMU emulation over self-hosted runners | Zero maintenance; acceptable build times for Docker images | HIGH |
| Skip browser on RISC-V | Chromium on RISC-V is experimental; link-based auth works without browser | HIGH |
| File-based state (no database) | Project is a single-user/small-team proxy; JSON files are sufficient and simpler | HIGH |

---

## Sources

- Puppeteer 25.1.0 docs — https://pptr.dev/supported-browsers, https://pptr.dev/guides/configuration (verified 2026-06-06)
- Playwright browser management — https://playwright.dev/docs/browsers (verified 2026-06-06)
- Docker multi-platform builds — https://docs.docker.com/build/building/multi-platform/ (verified 2026-06-06)
- tonistiigi/binfmt — https://github.com/tonistiigi/binfmt (v10.2.1, verified 2026-06-06)
- Docker Setup QEMU Action — https://github.com/marketplace/actions/docker-setup-qemu (v4.1, verified 2026-06-06)
- Vitest 4.1.7 — https://vitest.dev/guide/ (verified 2026-06-06)
- `qrcode` npm package — https://www.npmjs.com/package/qrcode
- `qrcode-terminal` npm package — https://www.npmjs.com/package/qrcode-terminal
