# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

CDP Browser is a **pure Chrome DevTools Protocol** browser automation library — zero Playwright/Puppeteer/Selenium dependency. It speaks raw CDP over WebSocket (`ws`), with anti-detection injection, humanized interaction (bezier mouse, realistic typing, viewport jitter), and 10+ site-specific content extractors. Designed for Chinese web platforms (Douyin, Xiaohongshu, JD, Taobao, etc.) that aggressively detect automation frameworks.

**Key architectural constraint:** This runs as a skill inside OpenClaw. The `SKILL.md` file is the OpenClaw skill definition — any API changes to core classes must be reflected there.

## Commands

```bash
# No build step — TypeScript is run directly via tsx
npx tsx scripts/cdp-manager.ts --test      # Test CDP connection
npx tsx scripts/cdp-manager.ts --status    # Check Chrome debug status
npx tsx scripts/cdp-manager.ts --login <url>  # Open page, wait for manual login
npx tsx scripts/cdp-manager.ts --open-url <url>  # Open page and print title

# Content extraction
npx tsx scripts/extract.ts '<url>'          # Single URL extraction
npx tsx scripts/extract.ts --json '<url>'   # JSON output mode
npx tsx scripts/extract.ts --retries 3 '<url>'  # With retries

# Cookie management
npx tsx scripts/cookie-manager.ts --save <site> --login  # Save login state
npx tsx scripts/cookie-manager.ts --list                   # List saved logins
npx tsx scripts/cookie-manager.ts --extract '<url>'        # Extract with saved cookies

# Media sniffing
npx tsx scripts/media-sniff.ts '<url>'

# Form submission
npx tsx scripts/form-submit.ts --url '<url>' --field 'selector=value' --submit 'button'

# Behavior profiling
npx tsx scripts/behavior-profile.ts --record 30  # Record 30s of human behavior

# Tests (informal — run and inspect output)
npx tsx scripts/pool-test.ts
npx tsx scripts/reconnect-test.ts
npx tsx scripts/resource-block-test.ts
npx tsx scripts/extractors/test-all.ts
```

Dependencies: `ws` (only prod dependency), `typescript` + `@types/ws` (dev).

## Core architecture

### Layer 1: `cdp-client.ts` — Raw CDP primitives

Three classes form the foundation:

- **`CdpConnection`** — WebSocket connection to a Chrome debug endpoint. Handles message ID tracking, event subscriptions (`on`/`once`), auto-reconnect with exponential backoff (max 10 attempts), and pending-request timeout (30s). The `send<T>(method, params)` method is the single entry point for all CDP commands.

- **`CdpBrowser`** — Represents a browser instance (1:1 with a `CdpConnection`). Creates pages via `Target.createTarget`, manages page lifecycle, auto re-attaches all pages on reconnect, exposes crash/reconnect callbacks.

- **`CdpPage`** — A single tab, scoped via `Target.attachToTarget` session ID. ALL page operations go through `_sessionCall()` which wraps `Target.sendMessageToTarget` / `Target.receivedMessageFromTarget`. This is critical: page-level CDP commands are NOT sent directly on the browser WebSocket — they're tunneled through the session. The constructor auto-injects base anti-detection scripts via `Page.addScriptToEvaluateOnNewDocument`.

Key `CdpPage` capabilities: navigation (`goto`, `reload`, `goBack`), viewport (with ±18px jitter), JS evaluation, DOM queries, humanized mouse/keyboard (bezier curves, realistic typing delays), scrolling, screenshots, PDF export, cookie save/load, network interception, media sniffing, console capture, dialog auto-handling, crash auto-restore.

### Layer 2: `cdp-manager.ts` — Cross-platform connection management

`connectBrowser(opts?)` is the main entry point. Platform detection logic:

- **Windows**: Direct `127.0.0.1:9222` connection
- **WSL**: Connects to Windows host Chrome (`172.20.48.1`), port 9223→9222 mapping
- **Linux**: Connects to remote Chrome host

When Chrome isn't running, `ensureChrome()` auto-launches it with `--remote-debugging-port`. Two modes:

- **Existing mode** (default): Connects to user's already-running Chrome, reuses their profile/login state
- **Instance mode** (`launchNew: true`): Starts an isolated Chrome with separate `--user-data-dir` and optional `--proxy-server`. Port defaults to 9244. This is the recommended approach for proxy usage.

WSL path conversion: `wslToWindowsPath()` handles `/mnt/c/...` → `C:\...` translation for file uploads.

### Layer 3: `anti-detection.ts` — Per-site script injection

`baseScripts()` covers all sites: hide `navigator.webdriver`, delete `__playwright`/`__puppeteer`/`__selenium`/`__nightmare`/`__katalon` marks, fake `window.chrome.runtime`.

`SITE_STRATEGIES` maps domains to extended scripts:
- **Douyin**: fake `navigator.plugins`, `navigator.languages`, performance entry type
- **Taobao/JD**: canvas fingerprint noise injection via `HTMLCanvasElement.prototype.getContext` monkey-patch
- **Zhihu**: fake `hardwareConcurrency`, `deviceMemory`
- **WeChat**: UA scrubbing, platform spoofing

`getScriptsForUrl(url)` auto-selects the right strategy. `CdpPage.goto()` calls this and injects the extra scripts before navigation.

### Layer 4: `cdp-pool.ts` — Page connection pool

`CdpPool` manages a fixed-size pool of pages sharing one browser instance. Key behaviors:
- Serial acquire lock — prevents creating more pages than `maxPages`
- Wait queue when pool is full
- Idle page reaping (default 60s timeout)
- `withPage(fn)` for acquire→use→release in one call
- Global singleton via `getPool()`

### Layer 5: `extractors/` — Site-specific content extractors

Each site has its own `extract(url, browser?)` function in `scripts/extractors/<site>.ts`. The `browser` parameter is optional — when provided (batch mode), the extractor reuses the browser; when absent, it creates and closes its own.

`extractors/index.ts` contains:
- `REGISTRY`: maps domain patterns → extractor functions
- `matchExtractor(url)`: auto-selects the right extractor
- `extract(url, opts?)`: single-URL extraction with retry support
- `batchExtract(urls, opts?)`: shares one browser across all URLs, returns `BatchSummary`
- `isLoginWall(result)`: detects if extraction hit a login wall

### Supporting modules

- **`behavior-profile.ts`**: Injects a JS event recorder into the page, captures mouse/keyboard/scroll events, builds statistical distributions (log-normal typing delays, bezier control point offsets, click durations), and provides sampling methods used by `CdpPage` when `CdpPage.setBehaviorProfile()` is set.
- **`form-helper.ts` / `form-submit.ts`**: Form filling with React/Vue compatibility (uses native value setter + `input`/`change` event dispatch).
- **`media-sniff.ts`**: MIME type + URL pattern matching for detecting video/audio streams.
- **`cookie-manager.ts`**: CLI and programmatic API for cookie persistence.
- **`login-gate.ts`**: Detects login walls, waits for manual login, signals success.

## Critical conventions

### String expressions only in `page.evaluate()`

**Never pass arrow functions to `page.evaluate()`**. tsx injects a `__name` helper into arrow functions that's undefined in the browser context. Always use string expressions:

```typescript
// ✅ Correct
await page.evaluate('document.title');
await page.evaluate('document.querySelector("meta[name=description]").content');

// ❌ Wrong — will throw __name is not defined
await page.evaluate(() => document.title);
```

### Regex escaping in evaluate strings

In TypeScript string literals passed to `evaluate()`, double-escape backslashes:

```typescript
await page.evaluate(`body.innerText.match(/\\d{4}/)`);
// TS string: \d → browser receives: \d
```

### Extractor browser ownership pattern

```typescript
export async function extract(url: string, browser?: CdpBrowser): Promise<ExtractorResult> {
  const ownBrowser = !browser;
  if (!browser) browser = await connectBrowser();
  try {
    // ... use browser ...
  } finally {
    if (ownBrowser) await browser.close(); // Only close what you created
  }
}
```

### CDP session protocol

`CdpPage._sessionCall()` is the only way to send commands scoped to a page. It:
1. Assigns a per-session message ID
2. Sends via `Target.sendMessageToTarget` with the page's `sessionId`
3. Listens on `Target.receivedMessageFromTarget`, filtering by `sessionId` and message `id`

This indirection is required because multiple pages share one WebSocket — each page's commands/responses are multiplexed through session-scoped messages.

## Platform-specific paths

When setting file inputs, paths must be Windows-native. `wslToWindowsPath()` in `cdp-client.ts` handles `/mnt/c/...` → `C:\...` conversion. For WSL, it tries `wslpath -w` first, then falls back to UNC `\\wsl.localhost\...`.

## Adding a new site extractor

1. Create `scripts/extractors/<site>.ts` exporting `extract(url, browser?)`
2. Import and add to `REGISTRY` in `scripts/extractors/index.ts`
3. Optionally add anti-detection strategy in `scripts/anti-detection.ts` (`SITE_STRATEGIES` map)
4. Optionally add domain→site mapping for cookie/login in `scripts/cookie-manager.ts`

## Code style

- Chinese comments throughout (documentation, logs, error messages)
- No linting or formatting config — no ESLint, Prettier, or similar
- No test framework — "tests" are runnable scripts that output results to stdout
- No build step — ESNext modules, target ES2020, run directly with `tsx`
- Uses `import.meta.url` for CLI entry detection (`isMain()` pattern)
