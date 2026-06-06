# FreeQwenApi — Headless Multi-Platform

## What This Is

FreeQwenApi is an OpenAI-compatible API proxy that turns Qwen Chat web sessions into a local REST API endpoint. Currently it requires a GUI browser for login (Puppeteer opens Chrome). The goal is to make it work on any platform — headless Linux servers (x86_64, ARM64/aarch64, RISC-V, ARM32), macOS (M-series), Windows — and allow authentication without physical access to a browser on that machine.

The proxy is used as a backend for AI tools: OpenCode, Hermes (via Telegram/Signal), Open WebUI, LiteLLM, and the OpenAI SDK.

## Core Value

FreeQwenApi must work reliably on **any platform without a GUI**, allowing login from a phone or remote device, while preserving existing Windows/GUI workflows.

## Requirements

### Validated

<!-- Shipped and confirmed valuable — inferred from existing codebase. -->

- ✓ OpenAI-compatible chat completions API (streaming + non-streaming) — existing
- ✓ Multi-account round-robin token rotation with rate-limit handling — existing
- ✓ Model mapping and alias resolution (qwen3.7-max, qwen3.7-plus, etc.) — existing
- ✓ DashScope image generation — existing
- ✓ Qwen Chat image and video generation via chatType — existing
- ✓ File upload via STS/OSS — existing
- ✓ Browser-based auth via Puppeteer Stealth (interactive, GUI required) — existing
- ✓ Docker containerization (x86_64 only) — existing
- ✓ Tool call adapter for Hermes agent loop — existing
- ✓ Open WebUI / LiteLLM / OpenAI SDK compatibility — existing
- ✓ Health/status/models endpoints — existing
- ✓ Session-based chat history persistence — existing

### Active

- [ ] Fix crash on fresh install (Puppeteer can't find Chrome after `npm install` — requires `npx puppeteer browsers install chrome`)
- [ ] Chrome/Chromium auto-detection and fallback on all platforms (system Chrome, Puppeteer cache, CHROME_PATH env)
- [ ] Headless auth method 1: HTTP endpoint (`/api/auth/start` → QR code or link → `/api/auth/callback` → token saved) for API/bot/remote usage
- [ ] Headless auth method 2: CLI flag (`npm run auth -- --headless`) for SSH sessions with link/QR in terminal
- [ ] Headless auth method 3: Puppeteer/Playwright in headless mode with cookie-based login for servers with browser available
- [ ] Full headless Linux server support — zero GUI dependency for proxy operation
- [ ] Cross-platform support: x86_64, ARM64/aarch64, ARM32, RISC-V, macOS (M-series Apple Silicon)
- [ ] Python server (FastAPI/Playwright) feature parity with Node.js server
- [ ] Both Node.js and Python servers actively maintained and tested
- [ ] OpenCode integration as OpenAI-compatible backend provider
- [ ] Hermes integration via Telegram/Signal for auth and chat
- [ ] Docker multi-arch images (x86_64, ARM64, RISC-V via QEMU)
- [ ] Full test pyramid: unit + integration + E2E + cross-platform matrix
- [ ] CI/CD on GitHub Actions with GitHub-hosted runners (QEMU emulation for RISC-V)
- [ ] Smoke tests for all client integrations (OpenCode, Hermes, Open WebUI, LiteLLM, OpenAI SDK)

### Out of Scope

- Local model inference — this is a proxy, not a model runner
- Official Qwen API integration — project intentionally uses browser-based auth
- Web UI dashboard for account management — can be added later

## Context

**Repository:** https://github.com/senovr/FreeQwenApi (fork of ForgetMeAI/FreeQwenApi)

**Architecture:** Dual implementation — Node.js (Express + Puppeteer) primary, Python (FastAPI + Playwright) secondary. Both share `session/tokens.json` and `src/AvailableModels.txt`. Browser automation extracts auth tokens from Qwen Chat (`chat.qwen.ai`) via `localStorage`. API calls use Qwen's private v2 endpoints with Bearer tokens. OpenAI-compatible surface for external clients.

**Known issues:**
- Puppeteer crashes on fresh `npm install` — Chrome binary not downloaded automatically. Needs `postinstall` script or graceful fallback.
- `src/api/routes.js` is ~2090 lines monolith with duplicated streaming logic.
- Circular dependency between `src/browser/browser.js` and `src/api/chat.js`.
- No test framework configured (`"test": "echo ... && exit 1"`).
- Python server (`main.py`) lacks image/video generation, file upload, and multi-account features present in Node.js version.

**Existing codebase map:** `.planning/codebase/` (ARCHITECTURE.md, STACK.md, STRUCTURE.md, CONVENTIONS.md, INTEGRATIONS.md, CONCERNS.md, TESTING.md)

**Deployment targets:** Local desktop (Windows/macOS), VPS (headless Linux), Docker (multi-arch), potentially embedded ARM devices.

## Constraints

- **Browser dependency:** Puppeteer requires Chrome/Chromium binary. Must detect system browser or auto-install. On some architectures (RISC-V) Chromium may not be available — need fallback auth flow.
- **Qwen API stability:** Upstream Qwen Chat API is unofficial and may change. Proxy must handle breaking changes gracefully.
- **Token lifecycle:** Tokens expire. Need re-auth without physical access to the server.
- **Multi-arch binaries:** Puppeteer ships Chrome for x86_64 and some ARM. RISC-V and ARM32 have limited browser support.
- **Security:** Tokens and cookies stored in `session/` — must never be committed. Auth endpoints must be protected.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Keep both Node.js and Python servers | User explicitly requested both maintained | — Pending |
| GitHub-hosted runners for CI | Sufficient for x86_64 and ARM64; RISC-V via QEMU | — Pending |
| Link/QR auth for headless | Enables login from phone/messenger without browser on server | — Pending |
| GitHub repo: senovr/FreeQwenApi | User's fork, all development here | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-06-06 after initialization*
