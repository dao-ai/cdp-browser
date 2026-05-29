/**
 * CDP 反检测浏览器 — Raw CDP Protocol Client
 *
 * 零第三方自动化库依赖，通过 WebSocket 直连 Chrome DevTools Protocol。
 * 每次新建页面自动注入 anti-detection 脚本，隐藏所有自动化特征。
 *
 *    const browser = new CdpBrowser(wsEndpoint);
 *    const page = await browser.newPage();
 *    await page.goto('https://example.com');
 *    const text = await page.innerText();
 *    await page.close();
 *    await browser.close();
 */
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { BehaviorProfile } from './behavior-profile';
import { getScriptsForUrl, baseScripts } from './anti-detection';

// ─── helpers ────────────────────────────────────────────────

export function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

export function randomRange(min: number, max: number) {
  return Math.floor(Math.random() * (max - min) + min);
}

export function randomDelay(min: number, max: number) {
  return sleep(randomRange(min, max));
}

/** Log-normal-ish delay: mostly fast with occasional pauses */
export function humanDelay(fastMs = 28, slowMs = 55, burstPause = 0.08) {
  if (Math.random() < burstPause) return randomRange(120, 350);
  return randomRange(fastMs, slowMs);
}

/**
 * Log-normal delay distribution.
 * Most values cluster near lo, with a long tail stretching toward hi.
 */
export function lognormalDelay(lo: number, hi: number) {
  const u1 = Math.random() || 0.001;
  const u2 = Math.random() || 0.001;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const mu = Math.log(lo);
  const sigma = Math.log(hi / lo) / 2.5;
  const val = Math.exp(mu + sigma * z);
  return Math.round(Math.min(Math.max(val, lo * 0.6), hi * 1.3));
}

// ─── Platform-aware path conversion ────────────────────────

function wslToWindowsPath(filePath: string) {
  // Already a Windows path
  if (/^[A-Z]:\\/i.test(filePath)) return filePath;

  // On Windows natively — just return as-is
  if (process.platform === 'win32') return filePath;

  // On WSL: /mnt/c/... → C:\...
  const mntMatch = filePath.match(/^\/mnt\/([a-zA-Z])\/(.*)/);
  if (mntMatch) return `${mntMatch[1].toUpperCase()}:\\${mntMatch[2].replace(/\//g, '\\')}`;

  // Fallback: try wslpath
  try {
    const winPath = execSync(`wslpath -w "${filePath}"`, { encoding: 'utf-8', timeout: 2000 }).trim();
    if (winPath && !winPath.startsWith('%')) return winPath;
  } catch {}

  // Last resort: WSL network path
  const distro = process.env.WSL_DISTRO_NAME || 'Ubuntu';
  return `\\\\wsl.localhost\\${distro}${filePath.replace(/\//g, '\\')}`;
}

// ─── CdpConnection ──────────────────────────────────────────

export class CdpConnection {
  private _ws: WebSocket | null = null;
  private _msgId = 0;
  private _pending = new Map<number, { resolve: Function; reject: Function }>();
  private _events = new Map<string, Set<Function>>();
  private _closed = false;

  constructor(private _wsUrl: string) {}

  async connect() {
    if (this._ws) return this;
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this._wsUrl);
      ws.on('open', () => {
        this._ws = ws;
        resolve();
      });
      ws.on('message', (data: WebSocket.Data) => this._onMessage(data.toString()));
      ws.on('error', reject);
      ws.on('close', () => {
        this._closed = true;
        for (const [, p] of this._pending) p.reject(new Error('CDP connection closed'));
        this._pending.clear();
      });
    });
  }

  private _onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id)!;
      this._pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message || 'CDP error'} (${msg.error.code || '?'})`));
      else p.resolve(msg.result);
    }
    if (msg.method && this._events.has(msg.method)) {
      for (const handler of this._events.get(msg.method)!) {
        try { handler(msg.params); } catch {}
      }
    }
  }

  send<T = any>(method: string, params: any = {}) {
    if (this._closed) return Promise.reject(new Error('Connection closed'));
    const id = ++this._msgId;
    return new Promise<T>((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._ws!.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) { this._pending.delete(id); reject(err); }
      });
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(method: string, handler: Function) {
    if (!this._events.has(method)) this._events.set(method, new Set());
    this._events.get(method)!.add(handler);
    return () => { this._events.get(method)?.delete(handler); };
  }

  once(method: string, timeoutMs = 15000) {
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { unsub(); reject(new Error(`CDP event timeout: ${method}`)); }, timeoutMs);
      const unsub = this.on(method, (params: any) => {
        clearTimeout(timer);
        unsub();
        resolve(params);
      });
    });
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    for (const [, p] of this._pending) p.reject(new Error('Connection closed'));
    this._pending.clear();
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
  }
}

// ─── CdpBrowser ─────────────────────────────────────────────

/**
 * Represents the browser instance (1:1 with a CDP WebSocket endpoint).
 * Created by `connectBrowser()` in cdp-manager.ts.
 */
export class CdpBrowser {
  private _conn: CdpConnection;
  private _pages = new Set<CdpPage>();

  constructor(wsUrl: string) {
    this._conn = new CdpConnection(wsUrl);
  }

  async connect() {
    await this._conn.connect();
    return this;
  }

  /** Create a new page (tab). Auto-injects anti-detection scripts. */
  async newPage() {
    const { targetId } = await this._conn.send('Target.createTarget', { url: 'about:blank' });
    return CdpPage._fromTarget(this._conn, targetId);
  }

  /** Get first existing page target (skip chrome:// and blank), or create new. */
  async getExistingPage() {
    const { targetInfos } = await this._conn.send('Target.getTargets');
    const pageTarget = targetInfos.find(
      (t: any) => t.type === 'page' && t.url && !t.url.startsWith('chrome://') && t.url !== 'about:blank'
    );
    if (pageTarget) return CdpPage._fromExistingTarget(this._conn, pageTarget.targetId);
    return this.newPage();
  }

  /** Wait for a new popup/tab to open */
  async waitForNewPage(timeoutMs = 15000) {
    try { await this._conn.send('Target.setDiscoverTargets', { discover: true }); } catch {}
    const params: any = await this._conn.once('Target.targetCreated', timeoutMs);
    const targetId = params.targetInfo?.targetId;
    if (!targetId) throw new Error('TargetCreated without targetId');
    const { sessionId } = await this._conn.send('Target.attachToTarget', { targetId, flatten: false });
    const page = new CdpPage(this._conn, targetId, sessionId);
    this._pages.add(page);
    return page;
  }

  /** Clear site data for given origins. Helps prevent fingerprinting accumulation */
  async clearSiteData(origins: string[]) {
    for (const origin of origins) {
      try {
        await this._conn.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
      } catch {
        for (const type of ['cookies', 'local_storage', 'indexeddb', 'cache_storage', 'service_workers']) {
          await this._conn.send('Storage.clearDataForOrigin', { origin, storageTypes: type }).catch(() => {});
        }
      }
    }
  }

  get connection() { return this._conn; }

  async close() {
    for (const page of this._pages) { try { await page.close(); } catch {} }
    this._pages.clear();
    await this._conn.close();
  }
}

// ─── CdpPage ────────────────────────────────────────────────

/**
 * A single page/tab. All operations scoped via sessionId.
 */
export class CdpPage {
  private static _behaviorProfile: BehaviorProfile | null = null;

  /**
   * Set global behavior profile for humanized interaction.
   * All subsequent pages will use this profile for mouse/keyboard/scroll simulation.
   * Call with null to disable.
   */
  static setBehaviorProfile(profile: BehaviorProfile | null) {
    CdpPage._behaviorProfile = profile;
  }

  static getBehaviorProfile() {
    return CdpPage._behaviorProfile;
  }

  private _closed = false;
  private _loadWaiters: Function[] = [];
  private _networkEnabled = false;
  private _networkEvents: any[] = [];
  private _unsubs: Function[] = [];
  private _sessionMsgId = 0;
  private _mouseX = 0;
  private _mouseY = 0;

  constructor(
    private _conn: CdpConnection,
    private _targetId: string,
    private _sessionId: string
  ) {
    // Auto-inject anti-detection scripts
    this._deployAntiDetection();

    // Auto-detect load events
    this._unsubs.push(
      this._onBrowserEvent('Page.loadEventFired', () => {
        for (const w of this._loadWaiters) w();
        this._loadWaiters = [];
      }),
      this._onBrowserEvent('Page.frameStoppedLoading', () => {
        for (const w of this._loadWaiters) w();
        this._loadWaiters = [];
      }),
    );
  }

  static async _fromTarget(conn: CdpConnection, targetId: string) {
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: false });
    return new CdpPage(conn, targetId, sessionId);
  }

  static async _fromExistingTarget(conn: CdpConnection, targetId: string) {
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: false });
    return new CdpPage(conn, targetId, sessionId);
  }

  // ── anti-detection injection ──

  /**
   * Inject scripts before every page load to hide automation markers.
   * Called automatically on page creation.
   */
  private async _deployAntiDetection() {
    const scripts = [
      // Hide webdriver flag
      `Object.defineProperty(navigator, 'webdriver', { get: () => false })`,
      // Delete automation framework markers
      `delete window.__playwright`,
      `delete window.__pwInitScripts`,
      `delete window.__pwScriptsToEvaluateOnNewDocument`,
      `delete window.__nightmare`,
      `delete window.__selenium`,
      `delete window.__driver_evaluate`,
      `delete window.__webdriver_evaluate`,
      `delete window.__fxdriver_evaluate`,
      `delete window.__selenium_evaluate`,
      `delete window.__lastWatirAlert`,
      `delete window.__lastWatirConfirm`,
      `delete window.__lastWatirPrompt`,
      `delete window.__webdriverFunc`,
      `delete window.__webdriver_script_fn`,
      `delete window.__webdriver_script_func`,
      `delete window.__$webdriverAsyncExecutor`,
      `delete window.__$webdriver`,
      `delete window.__puppeteer`,
      `delete window.__katalon`,
      `delete window.__CEDAR`,
      // Fake chrome.runtime
      `if (!window.chrome) window.chrome = {}`,
      `if (!window.chrome.runtime) window.chrome.runtime = {}`,
      `window.chrome.runtime.id = 'cdp-browser'`,
      `window.chrome.runtime.connect = () => ({ onMessage: { addListener() {}, removeListener() {} }, onDisconnect: { addListener() {}, removeListener() {} } })`,
      // Fake navigator.plugins (length > 0 for real browsers)
      `if (navigator.plugins && navigator.plugins.length === 0) {
        Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] })
      }`,
      // Fake navigator.languages if missing
      `if (!navigator.languages || navigator.languages.length === 0) {
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
      }`,
      // Remove CDP-specific frame properties
      `window.performance?.getEntriesByType?.('navigation')?.forEach?.((e) => { if (e.type !== 'navigate' && e.type !== 'reload') e.type = 'navigate' })`,
    ];

    for (const script of scripts) {
      try { await this._sessionCall('Page.addScriptToEvaluateOnNewDocument', { source: script }); } catch {}
    }
  }

  // ── internal helpers ──

  private async _sessionCall(method: string, params: any = {}, timeoutMs = 30000) {
    if (!this._sessionId) return this._conn.send(method, params);
    const id = ++this._sessionMsgId;
    const msg = JSON.stringify({ id, method, params });

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { unsub(); reject(new Error(`CDP session timeout: ${method}`)); }, timeoutMs);
      const handler = (eventParams: any) => {
        if (eventParams.sessionId !== this._sessionId) return;
        let resp: any;
        try { resp = JSON.parse(eventParams.message); } catch { return; }
        if (resp.id !== id) return;
        clearTimeout(timer);
        unsub();
        if (resp.error) reject(new Error(resp.error.message || 'CDP session error'));
        else resolve(resp.result);
      };
      const unsub = this._conn.on('Target.receivedMessageFromTarget', handler);
      this._conn.send('Target.sendMessageToTarget', { message: msg, sessionId: this._sessionId }).catch(reject);
    });
  }

  private _onBrowserEvent(eventName: string, handler: Function) {
    return this._conn.on('Target.receivedMessageFromTarget', (params: any) => {
      if (params.sessionId !== this._sessionId) return;
      let msg: any;
      try { msg = JSON.parse(params.message); } catch { return; }
      if (msg.method === eventName && !msg.id) handler(msg.params);
    });
  }

  private _waitForLoad(timeoutMs = 30000) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      this._loadWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  // ── public API ──

  /** Add a script that runs on every new document before page JS */
  async addInitScript(source: string) {
    return this._sessionCall('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  /** Navigate to URL */
  async goto(url: string, { timeoutMs = 30000 } = {}) {
    await this._sessionCall('Page.enable');

    // Deploy site-specific anti-detection scripts before navigation
    const siteScripts = getScriptsForUrl(url);
    const baseLen = baseScripts().length;
    const extra = siteScripts.slice(baseLen);
    for (const script of extra) {
      try { await this.addInitScript(script); } catch {}
    }

    const loadPromise = this._waitForLoad(timeoutMs);
    await this._sessionCall('Page.navigate', { url });
    await loadPromise;
    await sleep(500);
    return this;
  }

  /** Set HTML content via data: URI */
  async setContent(html: string) {
    return this.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  }

  /** Reload the current page */
  async reload(timeoutMs = 30000) {
    const loadPromise = this._waitForLoad(timeoutMs);
    await this._sessionCall('Page.reload');
    await loadPromise;
    await sleep(500);
    return this;
  }

  /** Navigate back in history */
  async goBack(timeoutMs = 30000) {
    const loadPromise = this._waitForLoad(timeoutMs);
    await this.evaluate('window.history.back()');
    await loadPromise;
    await sleep(500);
    return this;
  }

  /** Navigate forward in history */
  async goForward(timeoutMs = 30000) {
    const loadPromise = this._waitForLoad(timeoutMs);
    await this.evaluate('window.history.forward()');
    await loadPromise;
    await sleep(500);
    return this;
  }

  /**
   * Set viewport with random jitter (±18px width, ±12px height)
   * to avoid resolution fingerprinting.
   */
  async setViewport(width: number, height: number) {
    const jw = width + randomRange(-18, 18);
    const jh = height + randomRange(-12, 12);
    return this._sessionCall('Emulation.setDeviceMetricsOverride', { width: jw, height: jh, deviceScaleFactor: 1, mobile: false });
  }

  /** Set exact viewport (no jitter). Use for screenshots. */
  async setViewportExact(width: number, height: number) {
    return this._sessionCall('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  /**
   * Evaluate JavaScript in page context.
   * ⚠️ IMPORTANT: Pass STRING EXPRESSIONS, not arrow functions!
   *    tsx injects `__name` helper into arrow functions, which breaks in
   *    browser context. Use string expressions instead.
   *
   *    ✅ await page.evaluate('document.title');
   *    ✅ await page.evaluate('document.querySelector("meta[name=description]").content');
   *    ❌ await page.evaluate(() => document.title);
   */
  async evaluate(expression: string): Promise<any> {
    const result = await this._sessionCall('Runtime.evaluate', {
      expression: String(expression),
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const err = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate error';
      throw new Error(err);
    }
    return result.result?.value;
  }

  /** Get full page HTML */
  async content() {
    return this.evaluate('document.documentElement.outerHTML || ""');
  }

  /** Get innerText of body */
  async innerText() {
    return this.evaluate('document.body?.innerText || ""');
  }

  /** Get current page URL */
  async url() {
    return this.evaluate('location.href');
  }

  async bringToFront() {
    return this._sessionCall('Page.bringToFront');
  }

  // ── DOM operations ──

  private async _getRootNode() {
    const doc = await this._sessionCall('DOM.getDocument', { depth: 0 });
    return doc.root.nodeId;
  }

  async querySelector(selector: string) {
    const rootId = await this._getRootNode();
    const { nodeId } = await this._sessionCall('DOM.querySelector', { nodeId: rootId, selector });
    if (!nodeId) return null;
    try {
      const { model } = await this._sessionCall('DOM.getBoxModel', { nodeId });
      return { nodeId, box: model };
    } catch {
      return { nodeId, box: null };
    }
  }

  /**
   * Wait for a CSS selector to appear in the DOM.
   * Polls every 200ms, useful for SPA pages where content loads async.
   */
  async waitForSelector(selector: string, timeoutMs = 15000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.evaluate(
        `!!document.querySelector(${JSON.stringify(selector)})`
      );
      if (found) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  }

  private async _getClickPoint(selector: string) {
    const el = await this.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    if (!el.box) throw new Error(`Element has no box model: ${selector}`);
    const quad = el.box.content || el.box.border || el.box.margin;
    if (!quad || quad.length < 8) throw new Error(`Cannot determine position for: ${selector}`);
    return {
      x: Math.round((quad[0] + quad[4]) / 2),
      y: Math.round((quad[1] + quad[5]) / 2),
      nodeId: el.nodeId,
    };
  }

  /** Click element by CSS selector with bezier mouse path */
  async click(selector: string) {
    const { x, y } = await this._getClickPoint(selector);
    const profile = CdpPage._behaviorProfile;
    const config = profile ? profile.getHumanizeConfig() : null;
    await this._humanMouseMove(this._mouseX, this._mouseY, x, y, config);
    const pause1 = profile ? profile.samplePause() : humanDelay(20, 40);
    await sleep(pause1);
    await this._mouseDown(x, y);
    const clickDur = profile ? profile.sampleClickDuration() : humanDelay(30, 80);
    await sleep(clickDur);
    await this._mouseUp(x, y);
    const pause2 = profile ? profile.samplePause() : humanDelay(50, 120);
    await sleep(pause2);
  }

  /** Bezier-curve mouse movement */
  private async _humanMouseMove(fromX: number, fromY: number, toX: number, toY: number, config: any) {
    const cpRange = config?.cpOffset ?? 60;
    const steps = config?.steps ?? randomRange(22, 38);
    const stepDelay = config?.stepDelayMs ?? randomRange(3, 9);
    const jitter = config?.jitterAmplitude ?? 1.5;

    const cp1x = fromX + (toX - fromX) * randomRange(25, 45) / 100 + randomRange(-cpRange, cpRange);
    const cp1y = fromY + (toY - fromY) * randomRange(20, 40) / 100 + randomRange(-Math.round(cpRange * 0.6), Math.round(cpRange * 0.6));
    const cp2x = fromX + (toX - fromX) * randomRange(55, 75) / 100 + randomRange(-Math.round(cpRange * 0.6), Math.round(cpRange * 0.6));
    const cp2y = fromY + (toY - fromY) * randomRange(60, 80) / 100 + randomRange(-cpRange, cpRange);

    const points: { x: number; y: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const et = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;  // ease-in-out
      const mt = 1 - et;
      let px = mt * mt * mt * fromX + 3 * mt * mt * et * cp1x + 3 * mt * et * et * cp2x + et * et * et * toX;
      let py = mt * mt * mt * fromY + 3 * mt * mt * et * cp1y + 3 * mt * et * et * cp2y + et * et * et * toY;
      if (i > 2 && i < steps - 2) {
        px += (Math.random() - 0.5) * jitter * 2;
        py += (Math.random() - 0.5) * jitter * 2;
      }
      points.push({ x: Math.round(px), y: Math.round(py) });
    }

    for (const pt of points) {
      await this._sessionCall('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
      await sleep(stepDelay + (Math.random() - 0.5) * stepDelay * 0.6);
    }
    this._mouseX = toX;
    this._mouseY = toY;
  }

  private async _mouseDown(x: number, y: number, button = 'left') {
    return this._sessionCall('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
  }

  private async _mouseUp(x: number, y: number, button = 'left') {
    return this._sessionCall('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
  }

  // ── keyboard ──

  /** Type text one character at a time with human-like delays */
  async typeText(text: string, { delayMs }: { delayMs?: number } = {}) {
    const profile = CdpPage._behaviorProfile;
    for (const ch of text) {
      if (ch === '\n') { await this.pressKey('Enter'); continue; }
      if (profile && profile.shouldBurstPause()) await sleep(profile.sampleBurstPause());
      const vk = ch.charCodeAt(0);
      await this._sessionCall('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, windowsVirtualKeyCode: vk >= 65 && vk <= 90 ? vk : undefined });
      await this._sessionCall('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch });
      await this._sessionCall('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk >= 65 && vk <= 90 ? vk : undefined });
      const d = delayMs || (profile ? profile.sampleTypingDelay() : humanDelay());
      await sleep(d);
    }
  }

  /** Press a single key (Enter, Backspace, Tab, etc.) */
  async pressKey(key: string) {
    const VK: Record<string, number> = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Space: 32 };
    const vk = VK[key];
    await this._sessionCall('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: vk, key });
    if (!['Enter', 'Backspace', 'Tab', 'Escape', 'Space'].includes(key)) {
      await this._sessionCall('Input.dispatchKeyEvent', { type: 'char', text: key, key });
    }
    await this._sessionCall('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: vk, key });
  }

  // ── input manipulation ──

  /**
   * Fill an input element with proper React/Vue compatibility.
   * Uses native value setter + dispatches 'input' and 'change' events
   * so framework synthetic event systems detect the change.
   */
  async fillInput(selector: string, value: string) {
    const sel = JSON.stringify(selector);
    const val = JSON.stringify(value);
    const ok = await this.evaluate(`
      (function() {
        var el = document.querySelector(${sel});
        if (!el) return false;
        el.focus();
        var desc = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        );
        if (desc && desc.set) {
          desc.set.call(el, ${val});
        } else {
          el.value = ${val};
        }
        el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        return true;
      })()
    `);
    if (!ok) throw new Error(`Input not found: ${selector}`);
  }

  /** Upload files to file input */
  async setInputFiles(selector: string, filePaths: string[]) {
    const el = await this.querySelector(selector);
    if (!el?.nodeId) throw new Error(`File input not found: ${selector}`);
    for (const p of filePaths) {
      if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
    }
    const winPaths = filePaths.map(p => wslToWindowsPath(p));
    await this._sessionCall('DOM.setFileInputFiles', { nodeId: el.nodeId, files: winPaths });
  }

  // ── network ──

  private async _ensureNetworkEnabled() {
    if (this._networkEnabled) return;
    await this._sessionCall('Network.enable');
    this._unsubs.push(
      this._onBrowserEvent('Network.responseReceived', (params: any) => {
        this._networkEvents.push(params);
        if (this._networkEvents.length > 200) this._networkEvents.shift();
      }),
    );
    this._networkEnabled = true;
  }

  /** Wait for a network response matching the URL pattern */
  async waitForResponse(urlPattern: string, timeoutMs = 30000) {
    await this._ensureNetworkEnabled();
    return new Promise<any>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const handler = (params: any) => {
        if (params.response?.url?.includes(urlPattern)) { unsub(); resolve(params); }
      };
      const unsub = this._onBrowserEvent('Network.responseReceived', handler);
      const check = () => {
        for (const ev of this._networkEvents) {
          if (ev.response?.url?.includes(urlPattern)) { unsub(); resolve(ev); return; }
        }
        if (Date.now() > deadline) { unsub(); reject(new Error(`Timeout: ${urlPattern}`)); return; }
        setTimeout(check, 200);
      };
      check();
    });
  }

  // ── screenshot ──

  async screenshot(opts: { path?: string; clip?: { x: number; y: number; width: number; height: number; scale?: number } } = {}) {
    const params: any = { format: 'png' };
    if (opts.clip) {
      params.clip = { x: opts.clip.x, y: opts.clip.y, width: opts.clip.width, height: opts.clip.height, scale: opts.clip.scale || 1 };
    }
    const result = await this._sessionCall('Page.captureScreenshot', params);
    if (opts.path && result.data) {
      fs.writeFileSync(opts.path, Buffer.from(result.data, 'base64'));
    }
    return result;
  }

  /** Screenshot a specific element by selector */
  async screenshotElement(selector: string, filePath: string) {
    const el = await this.querySelector(selector);
    if (!el?.box) throw new Error(`Element not found: ${selector}`);
    const quad = el.box.content || el.box.border;
    return this.screenshot({
      path: filePath,
      clip: { x: quad[0], y: quad[1], width: quad[2] - quad[0], height: quad[7] - quad[1] },
    });
  }

  // ── scrolling ──

  /**
   * Scroll using native mouseWheel events in multiple small steps.
   * Real humans scroll in ~100-200px bursts with micro-pauses.
   */
  async scrollBy(dx = 0, dy = 0) {
    const absMax = Math.max(Math.abs(dx), Math.abs(dy));
    const steps = Math.max(1, Math.ceil(absMax / randomRange(80, 180)));
    const stepDx = Math.round(dx / steps);
    const stepDy = Math.round(dy / steps);

    for (let i = 0; i < steps; i++) {
      const jx = i < steps - 1 ? stepDx + randomRange(-15, 15) : (dx - stepDx * (steps - 1));
      const jy = i < steps - 1 ? stepDy + randomRange(-20, 20) : (dy - stepDy * (steps - 1));
      await this._sessionCall('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: this._mouseX || randomRange(200, 600),
        y: this._mouseY || randomRange(300, 500),
        deltaX: jx,
        deltaY: jy,
      });
      await sleep(randomRange(40, 120));
    }
  }

  /** Fast scroll via JS (less realistic, use scrollBy for realism) */
  async scrollByJs(dx = 0, dy = 0) {
    return this.evaluate(`window.scrollBy(${dx}, ${dy})`);
  }

  // ── cookies ──

  /** Get all cookies for the current page */
  async getCookies() {
    return this._sessionCall('Network.getCookies', { urls: [await this.url()] }).then((r: any) => r.cookies || []);
  }

  /** Set a cookie on the current page */
  async setCookie(opts: {
    name: string; value: string; domain?: string; path?: string;
    httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None';
    expires?: number; // unix timestamp (seconds)
  }) {
    return this._sessionCall('Network.setCookie', {
      ...opts,
      url: await this.url(),
    });
  }

  /** Set multiple cookies at once */
  async setCookies(cookies: Array<{
    name: string; value: string; domain?: string; path?: string;
    httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None';
    expires?: number;
  }>) {
    const url = await this.url();
    return this._sessionCall('Network.setCookies', {
      cookies: cookies.map(c => ({ ...c, url })),
    });
  }

  /** Clear all cookies for the current page */
  async clearCookies() {
    try {
      await this._sessionCall('Network.clearBrowserCookies');
    } catch {
      // Fallback: clear per-origin
      const url = await this.url();
      try { await this._sessionCall('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'cookies' }); } catch {}
    }
  }

  // ── lifecycle ──

  async close() {
    if (this._closed) return;
    this._closed = true;
    for (const unsub of this._unsubs) try { unsub(); } catch {}
    this._unsubs = [];
    this._loadWaiters = [];
    try { await this._conn.send('Target.closeTarget', { targetId: this._targetId }); } catch {}
  }
}

export { CdpConnection as CdpConnectionRaw };
