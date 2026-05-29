<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript">
  <img src="https://img.shields.io/badge/dependencies-ws%20only-2ea44f">
  <img src="https://img.shields.io/badge/chrome-cdp-brightgreen">
  <img src="https://img.shields.io/badge/platform-Windows%20|%20WSL%20|%20Linux-lightgrey">
</p>

# CDP Browser — Anti-Detection Browser Automation

> **Zero Playwright / Puppeteer / Selenium dependency.** Pure Chrome DevTools Protocol over WebSocket, with anti-detection injection, humanized interaction, and cross-platform auto-connect. Bypass anti-bot detection on Douyin, Xiaohongshu, Kuaishou and more.

---

## ✨ Features

- **Zero automation framework dependency** — No Playwright, Puppeteer, or Selenium. Pure WebSocket CDP connection.
- **Anti-detection engine** — Hides `navigator.webdriver`, `__playwright`, `__puppeteer`, `__nightmare`, `__selenium` and more. Fakes `window.chrome.runtime`, `navigator.plugins`, `navigator.languages`.
- **Humanized interaction** — Bézier-curve mouse movement, character-by-character typing (28-55ms intervals + burst pauses), multi-step natural scrolling, viewport jitter (±18px).
- **Behavior profiles** — Record real user interaction patterns and replay them for deeper realism.
- **Cross-platform** — Works on Windows (direct), WSL (netsh port forwarding), and Linux (remote Chrome). Auto-detect and launch.
- **Built-in extractors** — One-command extraction for Douyin, Kuaishou, and Xiaohongshu with unified output format, batch mode, and auto-retry.
- **Pure TypeScript** — Full type safety throughout.

---

## 🚀 Quick Start

### Installation

```bash
git clone https://github.com/dao-ai/cdp-browser.git
cd cdp-browser
npm install
```

### Requirements

- Chrome / Edge / Chromium (latest stable recommended)
- Node.js >= 18
- OS: Windows, WSL2, or Linux

### Test Connection

```bash
npx tsx scripts/cdp-manager.ts --test
# → { ok: true, host: "127.0.0.1", port: 9222 }
```

---

## 📖 Usage

### Basic Automation

```typescript
import { connectBrowser } from './scripts/cdp-manager';

const browser = await connectBrowser();       // auto-launch Chrome
const page = await browser.newPage();          // anti-detection injected
await page.setViewport(1280, 720);             // ±18px jitter
await page.goto('https://example.com');        // site-specific scripts

await page.click('#search-input');             // bézier mouse path
await page.typeText('keyword');                // realistic typing
await page.scrollBy(0, 1000);                  // multi-step scroll

const html = await page.content();
const title = await page.evaluate('document.title');
await page.screenshot({ path: 'screenshot.png' });

await page.close();
await browser.close();
```

### Extract Content

```bash
npx tsx scripts/extract.ts 'https://v.douyin.com/xxxx/'
npx tsx scripts/extract.ts --json 'https://v.douyin.com/xxxx/'
npx tsx scripts/extract.ts https://v.douyin.com/aaa/ https://v.douyin.com/bbb/
```

```typescript
import { extract, batchExtract } from './scripts/extractors';

const info = await extract('https://v.douyin.com/xxxxx/', { retries: 3 });
// info.title, info.author, info.elapsedMs, info.retries

const batch = await batchExtract([url1, url2], { retries: 2 });
// batch.summary → { total, success, failed, totalElapsedMs, avgElapsedMs }
```

### Behavior Profiles

```typescript
import { BehaviorProfile } from './scripts/behavior-profile';

const profile = await BehaviorProfile.record(page, 30);  // record 30 seconds
profile.save('my-behavior.json');
CdpPage.setBehaviorProfile(profile);                     // apply globally
```

---

## 📋 API Reference

| Operation | Method | Notes |
|-----------|--------|-------|
| Connect | `connectBrowser()` | Auto-detect/launch Chrome |
| New tab | `browser.newPage()` | Anti-detection injected |
| Navigate | `page.goto(url, opts?)` | + site-specific scripts |
| Reload/Back/Forward | `page.reload()` / `goBack()` / `goForward()` | |
| Evaluate JS | `page.evaluate(expr)` | String expressions only |
| Click | `page.click(selector)` | Bézier mouse path |
| Type | `page.typeText(text)` | Per-char realistic input |
| Fill input | `page.fillInput(sel, val)` | React/Vue compatible |
| Scroll | `page.scrollBy(dx, dy)` | Multi-step |
| Screenshot | `page.screenshot(opts?)` | Clip support |
| Screenshot element | `page.screenshotElement(sel, path)` | |
| Wait for response | `page.waitForResponse(pattern)` | URL keyword match |
| Wait for popup | `browser.waitForNewPage()` | |
| HTML content | `page.content()` | Full source |
| Wait for selector | `page.waitForSelector(sel, ms)` | SPA-ready polling |
| Script injection | `page.addInitScript(src)` | Before page loads |
| Cookie API | `getCookies()` / `setCookie()` / `clearCookies()` | |
| Clear data | `browser.clearSiteData(origins)` | Cookies/storage/cache |
| Close | `page.close()` / `browser.close()` | |

### Extractor Types

```typescript
interface ExtractorResult {
  id: string; title: string; author: string; url: string;
  description?: string; publishDate?: string;
  likes?: number; comments?: number; shares?: number;
  coverUrl?: string; raw?: Record<string, any>;
}

interface TimedExtractorResult extends ExtractorResult {
  site: string; elapsedMs: number; retries: number;
}
```

---

## 🔧 Configuration

| Variable | Windows | WSL | Description |
|----------|---------|-----|-------------|
| `CHROME_DEBUG_HOST` | `127.0.0.1` | `172.20.48.1` | CDP host address |
| `CHROME_DEBUG_PORT` | `9222` | `9223` | Connection port |
| `CHROME_PORT` | — | `9222` | Chrome listen port (WSL) |
| `CHROME_DATA_DIR` | `C:\temp\chrome-debug` | same | User data directory |

Platform auto-detection: `win32` → direct | `WSL_DISTRO_NAME` → netsh proxy | other → remote Linux

---

## 🛡️ Anti-Detection

| Site | Detection Methods | Countermeasures |
|------|------------------|----------------|
| Douyin | `webdriver`, framework markers, incognito | CDP direct + injections + login reuse |
| Xiaohongshu | `__playwright`, `__puppeteer` | CDP cleanup + real UA + random delays |
| Taobao/JD | canvas fingerprint, resolution | Viewport jitter + canvas noise |
| Zhihu | behavior analysis, mouse path | Bézier mouse + natural scroll |
| WeChat | cookie, referer checks | Existing browser profile |

---

## 📁 Project Structure

```
cdp-browser/
├── scripts/
│   ├── cdp-client.ts          # Core CDP client
│   ├── cdp-manager.ts         # Cross-platform Chrome manager
│   ├── anti-detection.ts      # Anti-detection script engine
│   ├── behavior-profile.ts    # Behavior recording & playback
│   ├── extract.ts             # Extraction CLI
│   └── extractors/
│       ├── index.ts           # Registry + extract/batchExtract
│       ├── types.ts           # Result type definitions
│       ├── douyin.ts          # Douyin extractor
│       ├── kuaishou.ts        # Kuaishou extractor
│       └── xiaohongshu.ts     # Xiaohongshu extractor
├── references/
│   ├── extractors.md          # Extractor guide
│   └── site-strategies.md     # Anti-detection strategies
├── package.json / tsconfig.json
└── LICENSE
```

---

## License

[MIT](./LICENSE) © 2026 dao-ai
