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
  private _reconnecting = false;
  private _reconnectAttempts = 0;
  private _maxReconnectAttempts = 10;
  private _reconnectDelayMs = 1000;
  private _reconnectCallbacks: Set<() => void> = new Set();
  private _disconnectCallbacks: Set<() => void> = new Set();

  constructor(private _wsUrl: string) {}

  async connect() {
    if (this._ws?.readyState === WebSocket.OPEN) return this;
    this._closed = false;
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this._wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connect timeout'));
      }, 15000);
      ws.on('open', () => {
        clearTimeout(timeout);
        this._ws = ws;
        this._reconnecting = false;
        this._reconnectAttempts = 0;
        // Notify reconnect listeners
        for (const cb of this._reconnectCallbacks) try { cb(); } catch {}
        resolve();
      });
      ws.on('message', (data: WebSocket.Data) => this._onMessage(data.toString()));
      ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
      ws.on('close', () => {
        clearTimeout(timeout);
        this._closed = true;
        this._ws = null;
        // Reject pending calls
        for (const [, p] of this._pending) p.reject(new Error('CDP connection closed'));
        this._pending.clear();
        // Notify disconnect
        for (const cb of this._disconnectCallbacks) try { cb(); } catch {}
        // Auto-reconnect
        if (!this._closed) this._startReconnect();
      });
    });
  }

  private _startReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    const attempt = () => {
      this._reconnectAttempts++;
      if (this._reconnectAttempts > this._maxReconnectAttempts) {
        console.error(`CDP 重连失败: 已达最大尝试次数 ${this._maxReconnectAttempts}`);
        this._reconnecting = false;
        return;
      }
      const delay = Math.min(this._reconnectDelayMs * Math.pow(1.5, this._reconnectAttempts - 1), 15000);
      const jitter = Math.random() * 1000;
      console.log(`🔄 CDP 重连中 (第 ${this._reconnectAttempts} 次, 等待 ${Math.round(delay + jitter)}ms)...`);
      setTimeout(async () => {
        try {
          await this.connect();
          console.log('✅ CDP 重连成功');
          this._reconnecting = false;
        } catch (err: any) {
          console.warn(`  ⚠️  重连失败: ${err.message}`);
          attempt();
        }
      }, delay + jitter);
    };
    attempt();
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

  /**
   * Send CDP command with auto-reconnect support.
   * If connection is down, waits for reconnect before sending.
   */
  async send<T = any>(method: string, params: any = {}): Promise<T> {
    // If reconnecting, wait for it
    if (this._closed && this._reconnecting) {
      await new Promise<void>(resolve => {
        const unsub = this.onReconnect(() => { unsub(); resolve(); });
      });
    }
    if (this._closed) throw new Error('Connection closed (not reconnecting)');
    const id = ++this._msgId;
    return new Promise<T>((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws!.send(JSON.stringify({ id, method, params }), (err) => {
          if (err) { this._pending.delete(id); reject(err); }
        });
      } else {
        // Will be rejected when connection closes, or we could queue
        this._pending.delete(id);
        reject(new Error('WebSocket not open'));
      }
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

  /** 连接断开时触发 */
  onDisconnect(cb: () => void) { this._disconnectCallbacks.add(cb); return () => this._disconnectCallbacks.delete(cb); }

  /** 重连成功时触发 */
  onReconnect(cb: () => void) { this._reconnectCallbacks.add(cb); return () => this._reconnectCallbacks.delete(cb); }

  /** 获取连接状态 */
  get status() {
    if (this._closed) return 'disconnected';
    if (this._reconnecting) return 'reconnecting';
    if (this._ws?.readyState === WebSocket.OPEN) return 'connected';
    if (this._ws?.readyState === WebSocket.CONNECTING) return 'connecting';
    return 'unknown';
  }

  async close() {
    this._closed = true;
    this._reconnecting = false;
    this._reconnectAttempts = this._maxReconnectAttempts + 1; // stop reconnect
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
  private _reconnectUnsub: Function | null = null;
  private _disconnectUnsub: Function | null = null;
  private _crashCallbacks: Set<(targetId: string) => void> = new Set();
  private _reconnectCallbacks: Set<() => void> = new Set();

  constructor(wsUrl: string) {
    this._conn = new CdpConnection(wsUrl);
  }

  async connect() {
    await this._conn.connect();
    // Auto re-attach pages on reconnect
    this._reconnectUnsub = this._conn.onReconnect(async () => {
      console.log('  🔄 浏览器重连，重新附加页面...');
      for (const page of this._pages) {
        try {
          await page._reAttach();
        } catch (err: any) {
          console.warn(`  ⚠️  页面重连失败: ${err.message}`);
          this._pages.delete(page);
        }
      }
      for (const cb of this._reconnectCallbacks) try { cb(); } catch {}
    });
    this._disconnectUnsub = this._conn.onDisconnect(() => {
      console.warn('  ⚠️  CDP 连接断开，正在尝试重连...');
    });
    return this;
  }

  /** Create a new page (tab). Auto-injects anti-detection scripts. */
  async newPage() {
    const { targetId } = await this._conn.send('Target.createTarget', { url: 'about:blank' });
    const page = await CdpPage._fromTarget(this._conn, targetId);
    this._pages.add(page);
    this._setupPageCrashHandler(page);
    return page;
  }

  /** Get first existing page target (skip chrome:// and blank), or create new. */
  async getExistingPage() {
    const { targetInfos } = await this._conn.send('Target.getTargets');
    const pageTarget = targetInfos.find(
      (t: any) => t.type === 'page' && t.url && !t.url.startsWith('chrome://') && t.url !== 'about:blank'
    );
    if (pageTarget) {
      const page = await CdpPage._fromExistingTarget(this._conn, pageTarget.targetId);
      this._pages.add(page);
      this._setupPageCrashHandler(page);
      return page;
    }
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
    this._setupPageCrashHandler(page);
    return page;
  }

  /**
   * 监听页面崩溃事件，自动恢复页面
   */
  private _setupPageCrashHandler(page: CdpPage) {
    const handler = async (params: any) => {
      if (params.targetId !== (page as any)._targetId) return;
      console.warn(`💥 页面崩溃: ${await page.url().catch(() => 'unknown')}`);
      // 通知外部
      for (const cb of this._crashCallbacks) try { cb((page as any)._targetId); } catch {}
    };
    try {
      this._conn.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
      this._conn.on('Target.targetDestroyed', handler);
    } catch {}
  }

  /** 页面崩溃时触发 */
  onPageCrash(cb: (targetId: string) => void) { this._crashCallbacks.add(cb); return () => this._crashCallbacks.delete(cb); }

  /** 重连成功时触发 */
  onReconnect(cb: () => void) { this._reconnectCallbacks.add(cb); return () => this._reconnectCallbacks.delete(cb); }

  /** 获取连接状态 */
  get status() { return this._conn.status; }

  get connection() { return this._conn; }

  async close() {
    for (const page of this._pages) { try { await page.close(); } catch {} }
    this._pages.clear();
    if (this._reconnectUnsub) this._reconnectUnsub();
    if (this._disconnectUnsub) this._disconnectUnsub();
    await this._conn.close();
  }
}

// ─── CdpPage ────────────────────────────────────────────────

/**
 * A single page/tab. All operations scoped via sessionId.
 */
// ─── 媒体嗅探类型 ────────────────────────────────────────

/** Console log entry captured from the page */
export interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: number;
  url: string;
  line?: number;
  column?: number;
}

/** JavaScript dialog event (alert / confirm / prompt) */
export interface DialogEvent {
  type: string;
  message: string;
  defaultPrompt: string;
  url: string;
  hasBrowserHandler: boolean;
}

/** Detected media entry from network traffic */
export interface MediaEntry {
  /** Media type (hls, mp4, webm, flv, mp3, aac, ts, m4s, m4a, wav, ogg, dash, stream) */
  type: string;
  /** Full URL of the media */
  url: string;
  /** HTTP method */
  method: string;
  /** MIME type from response headers */
  mimeType: string;
  /** Content size in bytes (0 if unknown) */
  size: number;
  /** HTTP status code */
  status: number;
  /** Response headers */
  headers?: Record<string, string>;
  /** When the request was sent */
  timestamp: number;
  /** Request ID (for dedup) */
  requestId: string;
}

/** Media type constants for filtering */
export const MediaType = {
  HLS: 'hls' as const,
  DASH: 'dash' as const,
  MP4: 'mp4' as const,
  WEBM: 'webm' as const,
  FLV: 'flv' as const,
  MP3: 'mp3' as const,
  AAC: 'aac' as const,
  OGG: 'ogg' as const,
  TS: 'ts' as const,
  M4S: 'm4s' as const,
  M4A: 'm4a' as const,
  WAV: 'wav' as const,
  STREAM: 'stream' as const,
};

// ─── CdpPage ───────────────────────────────────────────────

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
  private _lastUrl = '';
  private _crashAutoRestore = false;

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

  // ── 断线重连 & 崩溃恢复 ──

  /**
   * 重连后重新附加到 target（由 CdpBrowser 自动调用）
   */
  async _reAttach() {
    const { sessionId } = await this._conn.send('Target.attachToTarget', {
      targetId: this._targetId,
      flatten: false,
    });
    this._sessionId = sessionId;
    // 重新部署 anti-detection + load 监听
    this._deployAntiDetection();
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
    return this;
  }

  /**
   * 启用页面崩溃自动恢复
   * 开启后如果页面崩溃，会自动 re-navigate 到当前 URL
   */
  async enableCrashAutoRestore() {
    this._crashAutoRestore = true;
    try {
      await this._sessionCall('Page.enable');

      // 统一恢复逻辑
      const restore = async (reason: string) => {
        if (this._closed) {
          console.log(`  ℹ️ 页面已主动关闭，跳过恢复 (${reason})`);
          return;
        }
        console.warn(`💥 检测到页面${reason}，尝试自动恢复...`);
        const url = this._lastUrl || 'about:blank';
        try {
          const { targetId } = await this._conn.send('Target.createTarget', { url });
          const { sessionId } = await this._conn.send('Target.attachToTarget', { targetId, flatten: false });
          this._targetId = targetId;
          this._sessionId = sessionId;
          this._reDeploy();
          console.log(`  ✅ 页面已恢复: ${url.slice(0, 80)}`);
          await this.goto(url);
        } catch (err: any) {
          console.error(`  ❌ 自动恢复失败: ${err.message}`);
        }
      };

      // 页面崩溃（Inspector.targetCrashed）
      this._unsubs.push(
        this._onBrowserEvent('Inspector.targetCrashed', () => restore('崩溃')),
      );

      // 页面异常关闭（Target.targetDestroyed）
      const destroyHandler = (params: any) => {
        if (params.targetId === this._targetId) restore('异常关闭/崩溃');
      };
      const unsubDestroy = this._conn.on('Target.targetDestroyed', destroyHandler);
      this._unsubs.push(unsubDestroy);

      // 也监听 Target 关联网关事件（浏览器级别）
      try {
        await this._conn.send('Target.setDiscoverTargets', { discover: true });
      } catch {}
    } catch {}
  }

  /**
   * 重新部署所有初始化脚本（崩溃恢复后）
   */
  private _reDeploy() {
    // 清理旧的监听
    for (const unsub of this._unsubs) try { unsub(); } catch {}
    this._unsubs = [];
    this._loadWaiters = [];
    this._networkEnabled = false;
    // 重新部署
    this._deployAntiDetection();
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
    this._lastUrl = url;
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
   * Navigate to URL, detect login wall, wait for user to manually log in.
   * If a login wall is detected (redirect to login page), it prints a prompt
   * and polls until the user completes login in the Chrome window.
   */
  async gotoWithLogin(url: string, opts: {
    timeoutMs?: number;
    /** URL patterns that indicate a login page (e.g. 'login', 'passport') */
    loginPatterns?: string[];
    /** URL patterns that indicate login success (homepage, feed) */
    successPatterns?: string[];
  } = {}) {
    const timeoutMs = opts.timeoutMs || 120_000;
    const loginPatterns = opts.loginPatterns || [
      'login', 'passport', 'signin', 'sign_in', 'sign-in',
      'accounts.google.com', 'verify', 'captcha',
    ];
    const successPatterns = opts.successPatterns || [];

    await this.goto(url, { timeoutMs: 35000 });
    await sleep(1000);

    const currentUrl = await this.url();
    const isLoginPage = loginPatterns.some(p => currentUrl.includes(p));

    if (!isLoginPage) {
      console.log('  ✅ 无需登录，直接进入');
      return this;
    }

    console.log(`\n🔐 检测到登录页，请在 Chrome 窗口中手动登录：`);
    console.log(`   当前: ${currentUrl}`);
    console.log(`   ⏳ 等待登录完成（最多 ${Math.round(timeoutMs / 1000)} 秒）...\n`);

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(3000);
      const u = await this.url().catch(() => '');

      // Still on login page? Keep waiting
      if (loginPatterns.some(p => u.includes(p))) {
        if (Date.now() % 15000 < 3000) {
          console.log('  ⏳ 仍在登录页面，继续等待...');
        }
        continue;
      }

      // If success patterns specified, check them
      if (successPatterns.length > 0) {
        if (successPatterns.some(p => u.includes(p))) {
          console.log('  ✅ 登录成功！');
          await sleep(2000);
          return this;
        }
        continue;
      }

      // URL changed away from login page
      console.log('  ✅ 登录成功！');
      await sleep(2000);
      return this;
    }

    throw new Error(`登录超时（${Math.round(timeoutMs / 1000)} 秒）`);
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

  // ── media sniffing ──

  /**
   * MIME type → 媒体类型映射
   */
  private static MEDIA_MIME_TYPES: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/ogg': 'ogg',
    'video/x-flv': 'flv',
    'video/quicktime': 'mp4',
    'video/x-msvideo': 'avi',
    'video/x-ms-wmv': 'wmv',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/aac': 'aac',
    'audio/x-aac': 'aac',
    'audio/flac': 'flac',
    'application/vnd.apple.mpegurl': 'hls',
    'application/x-mpegurl': 'hls',
    'application/dash+xml': 'dash',
    'video/MP2T': 'ts',
    'video/mp2t': 'ts',
  };

  /**
   * URL 后缀 → 媒体类型映射
   */
  private static MEDIA_URL_PATTERNS: Array<{ re: RegExp; type: string }> = [
    { re: /\.m3u8(\?|$)/i, type: 'hls' },
    { re: /\.mpd(\?|$)/i, type: 'dash' },
    { re: /\.mp4(\?|$)/i, type: 'mp4' },
    { re: /\.webm(\?|$)/i, type: 'webm' },
    { re: /\.flv(\?|$)/i, type: 'flv' },
    { re: /\.ts(\?|$)/i, type: 'ts' },
    { re: /\.m4s(\?|$)/i, type: 'm4s' },
    { re: /\.m4a(\?|$)/i, type: 'm4a' },
    { re: /\.mp3(\?|$)/i, type: 'mp3' },
    { re: /\.aac(\?|$)/i, type: 'aac' },
    { re: /\.ogg(\?|$)/i, type: 'ogg' },
    { re: /\.wav(\?|$)/i, type: 'wav' },
    { re: /\.f4v(\?|$)/i, type: 'flv' },
  ];

  private _mediaSniffingEnabled = false;
  private _detectedMedia: Map<string, MediaEntry> = new Map();
  private _mediaUnsubs: Function[] = [];

  /**
   * 开启媒体流嗅探。自动监听网络请求，发现视频/音频资源后
   * 记录到内部列表，可通过 getDetectedMedia() 随时取出。
   *
   * 用法:
   *   await page.enableMediaSniffing();
   *   await page.goto('https://example.com/video');
   *   const media = page.getDetectedMedia();
   *   console.log(media);
   *
   *   // 只记录特定类型的媒体
   *   await page.enableMediaSniffing({ types: ['mp4', 'hls'] });
   */
  async enableMediaSniffing(opts: {
    /** 只记录这些类型的媒体（默认记录所有类型） */
    types?: string[];
    /** 是否在控制台打印发现的媒体（默认 false） */
    verbose?: boolean;
    /** 是否同时记录 HLS/TS 分片（默认 true，可能非常多） */
    includeSegments?: boolean;
    /** 是否记录已拦截的请求（默认 false） */
    includeBlocked?: boolean;
  } = {}) {
    if (this._mediaSniffingEnabled) return;
    this._mediaSniffingEnabled = true;
    this._detectedMedia.clear();

    const types = opts.types || null;
    const includeSegments = opts.includeSegments !== false;
    const verbose = opts.verbose || false;

    // 启用 Network 域（如果还没启）
    await this._ensureNetworkEnabled();

    // 监听 responseReceived
    const unsubResp = this._onBrowserEvent('Network.responseReceived', (params: any) => {
      this._checkMediaResponse(params, { types, includeSegments, verbose });
    });
    this._mediaUnsubs.push(unsubResp);
    this._unsubs.push(unsubResp);

    // 监听 loadingFinished（获取实际传输大小）
    const unsubLoad = this._onBrowserEvent('Network.loadingFinished', (params: any) => {
      const requestId = params.requestId;
      const entry = this._detectedMedia.get(requestId);
      if (entry && params.encodedDataLength != null) {
        entry.size = params.encodedDataLength;
      }
    });
    this._mediaUnsubs.push(unsubLoad);
    this._unsubs.push(unsubLoad);
  }

  /**
   * 检查一个 network response 是否为媒体资源
   */
  private _checkMediaResponse(
    params: any,
    opts: { types: string[] | null; includeSegments: boolean; verbose: boolean }
  ) {
    if (!params.response) return;

    const { response, requestId } = params;
    const url = response.url || '';
    const mimeType = (response.mimeType || '').toLowerCase();
    const status = response.status || 0;
    const headers = response.headers || {};

    // 跳过非 2xx
    if (status !== 0 && (status < 200 || status >= 300)) return;

    // 1. 根据 MIME type 检测
    let detectedType = CdpPage.MEDIA_MIME_TYPES[mimeType] || null;

    // 2. 根据 URL 后缀检测
    if (!detectedType) {
      for (const pattern of CdpPage.MEDIA_URL_PATTERNS) {
        if (pattern.re.test(url)) {
          detectedType = pattern.type;
          break;
        }
      }
    }

    // 3. 特殊：mimeType 包含 video/ 或 audio/
    if (!detectedType) {
      if (mimeType.startsWith('video/')) detectedType = 'stream';
      else if (mimeType.startsWith('audio/')) detectedType = 'stream';
    }

    if (!detectedType) return;

    // 4. 过滤
    if (opts.types && !opts.types.includes(detectedType)) return;
    if (!opts.includeSegments && (detectedType === 'ts' || detectedType === 'm4s')) return;

    // 去重
    const key = `${requestId}:${url}`;
    if (this._detectedMedia.has(key)) return;

    const entry: MediaEntry = {
      type: detectedType,
      url,
      method: response.requestHeaders?.method || (params.request?.method || 'GET'),
      mimeType,
      size: 0, // loadingFinished 会补上
      status,
      headers,
      timestamp: Date.now(),
      requestId,
    };

    this._detectedMedia.set(key, entry);

    // 尝试从 Content-Length 头拿大小
    const cl = headers['content-length'] || headers['Content-Length'];
    if (cl) entry.size = parseInt(cl) || 0;

    if (opts.verbose) {
      const sizeStr = entry.size > 0 ? ` (${(entry.size / 1024).toFixed(1)}KB)` : '';
      console.log(`  🎬 发现 [${detectedType}] ${url.slice(0, 120)}${sizeStr}`);
    }
  }

  /**
   * 停止媒体嗅探并清理监听器
   */
  async disableMediaSniffing() {
    this._mediaSniffingEnabled = false;
    for (const unsub of this._mediaUnsubs) {
      try { unsub(); } catch {}
    }
    this._mediaUnsubs = [];
  }

  /**
   * 获取检测到的媒体列表
   * @param opts.sortBy 排序方式：'type' | 'size' | 'timestamp'（默认 timestamp）
   * @param opts.filter 按类型过滤
   */
  getDetectedMedia(opts: {
    sortBy?: 'type' | 'size' | 'timestamp';
    filter?: { types?: string[] };
  } = {}): MediaEntry[] {
    let entries = Array.from(this._detectedMedia.values());

    // 过滤
    if (opts.filter?.types) {
      entries = entries.filter(e => opts.filter!.types!.includes(e.type));
    }

    // 去重（相同 URL 只保留一个）
    const seen = new Set<string>();
    entries = entries.filter(e => {
      if (seen.has(e.url)) return false;
      seen.add(e.url);
      return true;
    });

    // 排序
    if (opts.sortBy === 'size') {
      entries.sort((a, b) => b.size - a.size);
    } else if (opts.sortBy === 'type') {
      entries.sort((a, b) => a.type.localeCompare(b.type));
    } else {
      entries.sort((a, b) => a.timestamp - b.timestamp);
    }

    return entries;
  }

  /**
   * 获取媒体统计摘要
   */
  getMediaSummary(): {
    total: number;
    byType: Record<string, number>;
    totalSize: number;
    formats: string[];
  } {
    const entries = Array.from(this._detectedMedia.values());
    const byType: Record<string, number> = {};
    let totalSize = 0;
    const formats = new Set<string>();

    for (const e of entries) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      totalSize += e.size;
      formats.add(e.type);
    }

    // 去重 URL 后统计
    const seen = new Set<string>();
    const deduped = entries.filter(e => {
      if (seen.has(e.url)) return false;
      seen.add(e.url);
      return true;
    });

    return {
      total: deduped.length,
      byType,
      totalSize,
      formats: Array.from(formats),
    };
  }

  // ── request interception ──

  private _interceptionEnabled = false;
  private _interceptedCount = 0;
  private _blockedCount = 0;
  private _interceptionUnsub: Function | null = null;

  /**
   * CDP resource types you can intercept
   */
  static ResourceType = {
    DOCUMENT: 'Document',
    STYLESHEET: 'Stylesheet',
    IMAGE: 'Image',
    MEDIA: 'Media',
    FONT: 'Font',
    SCRIPT: 'Script',
    TEXTTRACK: 'TextTrack',
    XHR: 'XHR',
    FETCH: 'Fetch',
    EVENT_SOURCE: 'EventSource',
    WEB_SOCKET: 'WebSocket',
    MANIFEST: 'Manifest',
    OTHER: 'Other',
  } as const;

  /**
   * Enable request interception to block/modify network requests.
   *
   * 用法:
   *   // 屏蔽图片 + 字体（加速页面加载）
   *   await page.enableRequestInterception({
   *     blockResources: ['Image', 'Font', 'Media'],
   *   });
   *
   *   // 屏蔽指定 URL
   *   await page.enableRequestInterception({
   *     blockUrls: ['analytics.google.com', 'tracking.js'],
   *   });
   *
   *   // 自定义拦截逻辑
   *   await page.enableRequestInterception({
   *     handler: (req) => {
   *       if (req.url.includes('ad.')) return 'block';
   *       if (req.type === 'Image') return 'block';
   *       return 'continue';
   *     }
   *   });
   *
   * @returns 拦截统计的更新函数，可随时调用 page.getInterceptionStats()
   */
  async enableRequestInterception(opts: {
    /** 要拦截的资源类型（不传则拦截所有） */
    resourceTypes?: string[];
    /** URL 匹配模式（默认 '*'） */
    urlPattern?: string;
    /** 拦截阶段（默认 'HeadersReceived'） */
    interceptionStage?: 'Request' | 'HeadersReceived';
    /** 要屏蔽的资源类型列表（快速过滤模式） */
    blockResources?: string[];
    /** 要屏蔽的 URL 关键词列表 */
    blockUrls?: string[];
    /** 自定义拦截处理函数：返回 'continue' | 'block' | 'abort' */
    handler?: (req: { url: string; type: string; method: string; requestId: string }) => 'continue' | 'block' | 'abort';
    /** 是否在控制台打印拦截信息 */
    verbose?: boolean;
  } = {}) {
    if (this._interceptionEnabled) {
      await this.disableRequestInterception();
    }

    const types = opts.resourceTypes || undefined;
    const pattern = opts.urlPattern || '*';
    const stage = opts.interceptionStage || 'HeadersReceived';

    // 设置拦截模式
    const patterns: any[] = types
      ? types.map(t => ({ urlPattern: pattern, resourceType: t, interceptionStage: stage }))
      : [{ urlPattern: pattern, interceptionStage: stage }];

    await this._sessionCall('Network.setRequestInterception', { patterns });

    this._interceptedCount = 0;
    this._blockedCount = 0;
    this._interceptionEnabled = true;

    // 监听请求拦截事件
    this._interceptionUnsub = this._onBrowserEvent('Network.requestIntercepted', async (params: any) => {
      if (!this._interceptionEnabled) return;

      const { interceptionId, request, resourceType } = params;
      this._interceptedCount++;

      const reqInfo = {
        url: request?.url || '',
        type: resourceType || 'Other',
        method: request?.method || 'GET',
        requestId: params.requestId || '',
      };

      // 1. 自定义处理函数优先
      if (opts.handler) {
        try {
          const action = opts.handler(reqInfo);
          if (action === 'block' || action === 'abort') {
            this._blockedCount++;
            if (opts.verbose) {
              console.log(`  🚫 拦截 [${reqInfo.type}] ${reqInfo.url.slice(0, 100)}`);
            }
            await this._continueIntercepted(interceptionId, { errorReason: 'BlockedByClient' });
            return;
          }
          // 'continue' → 放行
          await this._continueIntercepted(interceptionId);
          return;
        } catch { /* fall through to default */ }
      }

      // 2. blockResources 列表
      if (opts.blockResources && opts.blockResources.includes(resourceType)) {
        this._blockedCount++;
        if (opts.verbose) {
          console.log(`  🚫 拦截 [${resourceType}] ${(request?.url || '').slice(0, 100)}`);
        }
        await this._continueIntercepted(interceptionId, { errorReason: 'BlockedByClient' });
        return;
      }

      // 3. blockUrls 列表
      if (opts.blockUrls) {
        const url = request?.url || '';
        for (const pattern of opts.blockUrls) {
          if (url.includes(pattern)) {
            this._blockedCount++;
            if (opts.verbose) {
              console.log(`  🚫 拦截 [${resourceType}] ${url.slice(0, 100)}`);
            }
            await this._continueIntercepted(interceptionId, { errorReason: 'BlockedByClient' });
            return;
          }
        }
      }

      // 默认放行
      await this._continueIntercepted(interceptionId);
    });

    this._unsubs.push(this._interceptionUnsub);
  }

  /**
   * 快速模式：屏蔽资源类型加速加载
   *
   * @param resourceTypes 要屏蔽的资源类型，默认 ['Image', 'Font', 'Media']
   *
   * 示例:
   *   await page.blockResources(['Image', 'Font']);        // 屏蔽图片+字体
   *   await page.blockResources();                         // 屏蔽图片+字体+媒体
   *   await page.blockResources([]);                       // 取消拦截
   */
  async blockResources(resourceTypes?: string[]) {
    if (!resourceTypes || resourceTypes.length === 0) {
      return this.disableRequestInterception();
    }
    return this.enableRequestInterception({
      blockResources: resourceTypes,
    });
  }

  /** 获取拦截统计 */
  getInterceptionStats() {
    return {
      enabled: this._interceptionEnabled,
      intercepted: this._interceptedCount,
      blocked: this._blockedCount,
    };
  }

  /**
   * 发送 continueInterceptedRequest
   */
  private async _continueIntercepted(
    interceptionId: string,
    opts?: { errorReason?: string; headers?: Record<string, string> }
  ) {
    try {
      const params: any = { interceptionId };
      if (opts?.errorReason) params.errorReason = opts.errorReason;
      if (opts?.headers) params.headers = opts.headers;
      await this._sessionCall('Network.continueInterceptedRequest', params);
    } catch {
      // request may have already completed, ignore
    }
  }

  /**
   * Disable request interception and clean up
   */
  async disableRequestInterception() {
    this._interceptionEnabled = false;
    try {
      await this._sessionCall('Network.setRequestInterception', { patterns: [] });
    } catch {}
    this._interceptionEnabled = false;
  }

  /**
   * Set extra HTTP headers for all outgoing requests from this page.
   * 常用于自定义 User-Agent、Referer、Authorization 等。
   *
   * 示例:
   *   await page.setExtraHTTPHeaders({
   *     'X-Custom-Header': 'value',
   *     'Authorization': 'Bearer token123',
   *   });
   *
   *   // 清空自定义头
   *   await page.setExtraHTTPHeaders({});
   */
  async setExtraHTTPHeaders(headers: Record<string, string>) {
    return this._sessionCall('Network.setExtraHTTPHeaders', { headers });
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

  /**
   * 保存页面为 PDF（基于 Chrome 的 Print → Save as PDF）。
   *
   * @param filePath 保存路径（不传则返回 base64 Buffer）
   * @param opts PDF 选项
   *
   * 示例:
   *   // 保存为 A4 PDF
   *   await page.saveAsPDF('/tmp/page.pdf');
   *
   *   // 横向 + 背景色
   *   await page.saveAsPDF('/tmp/page.pdf', { landscape: true, printBackground: true });
   *
   *   // 不保存文件，拿 base64
   *   await page.saveAsPDF();  // → { data: 'base64...' }
   */
  async saveAsPDF(
    filePath?: string,
    opts: {
      /** 横向（默认 false） */
      landscape?: boolean;
      /** 打印背景色和图片（默认 false） */
      printBackground?: boolean;
      /** 缩放比例，默认 1 */
      scale?: number;
      /** 纸张宽度（英寸），默认 8.5（A4） */
      paperWidth?: number;
      /** 纸张高度（英寸），默认 11（A4） */
      paperHeight?: number;
      /** 上边距（英寸） */
      marginTop?: number;
      /** 下边距（英寸） */
      marginBottom?: number;
      /** 左边距（英寸） */
      marginLeft?: number;
      /** 右边距（英寸） */
      marginRight?: number;
      /** 页眉页脚（默认 false） */
      displayHeaderFooter?: boolean;
      /** 页眉模板 */
      headerTemplate?: string;
      /** 页脚模板 */
      footerTemplate?: string;
      /** 页码范围，如 '1-5, 8' */
      pageRanges?: string;
      /** 优先使用 CSS @page 定义（默认 false） */
      preferCSSPageSize?: boolean;
    } = {},
  ) {
    const params: any = {
      landscape: opts.landscape ?? false,
      printBackground: opts.printBackground ?? false,
      scale: opts.scale ?? 1,
      displayHeaderFooter: opts.displayHeaderFooter ?? false,
      preferCSSPageSize: opts.preferCSSPageSize ?? false,
    };

    if (opts.paperWidth) params.paperWidth = opts.paperWidth;
    if (opts.paperHeight) params.paperHeight = opts.paperHeight;
    if (opts.marginTop !== undefined) params.marginTop = opts.marginTop;
    if (opts.marginBottom !== undefined) params.marginBottom = opts.marginBottom;
    if (opts.marginLeft !== undefined) params.marginLeft = opts.marginLeft;
    if (opts.marginRight !== undefined) params.marginRight = opts.marginRight;
    if (opts.headerTemplate) params.headerTemplate = opts.headerTemplate;
    if (opts.footerTemplate) params.footerTemplate = opts.footerTemplate;
    if (opts.pageRanges) params.pageRanges = opts.pageRanges;

    const result = await this._sessionCall('Page.printToPDF', params, 60000);

    if (filePath && result.data) {
      fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
      const stats = fs.statSync(filePath);
      console.log(`📄 PDF 已保存: ${filePath} (${(stats.size / 1024).toFixed(1)}KB)`);
    }

    return result;
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
      const url = await this.url();
      try { await this._sessionCall('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'cookies' }); } catch {}
    }
  }

  /**
   * 保存当前页面的 cookie 到文件（JSON）。
   * 配合 loadCookies() 实现一次登录，永久复用。
   *
   * 示例:
   *   // 登录后保存
   *   await page.goto('https://www.taobao.com');
   *   await page.gotoWithLogin(...);  // 手动登录
   *   await page.saveCookies('/data/cookies/taobao.json');
   *
   *   // 下次直接恢复
   *   await page.loadCookies('/data/cookies/taobao.json');
   *   await page.goto('https://item.taobao.com/...');  // 已登录！
   */
  async saveCookies(filePath: string) {
    const cookies = await this.getCookies();
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ savedAt: new Date().toISOString(), count: cookies.length, cookies }, null, 2));
    console.log(`💾 保存 ${cookies.length} 个 cookie → ${filePath}`);
    return cookies.length;
  }

  /**
   * 从文件恢复 cookie 到当前页面。
   * 恢复前会自动导航到目标域名（确保 cookie domain 匹配）。
   */
  async loadCookies(filePath: string) {
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️ Cookie 文件不存在: ${filePath}`);
      return 0;
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const cookies = data.cookies || [];
    if (cookies.length === 0) return 0;

    // 先导航到目标域（cookie 需要 domain 匹配）
    const domain = cookies[0].domain;
    if (domain && !domain.startsWith('.')) {
      const currentUrl = await this.url().catch(() => 'about:blank');
      if (!currentUrl.includes(domain.replace(/^\./, ''))) {
        await this.goto(`https://${domain.replace(/^\./, '')}`, { timeoutMs: 15000 }).catch(() => {});
      }
    }

    let set = 0;
    for (const c of cookies) {
      try {
        await this.setCookie({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expires: c.expires,
        });
        set++;
      } catch {}
    }
    console.log(`🍪 恢复 ${set}/${cookies.length} 个 cookie ← ${filePath}`);
    return set;
  }

  // ── console capture ──

  private _consoleEnabled = false;
  private _consoleLogs: ConsoleEntry[] = [];
  private _consoleUnsubs: Function[] = [];
  private _consoleMaxEntries = 500;

  /**
   * 开启控制台日志捕获。自动监听 page 上的 console.log/warn/error 等调用。
   *
   * @param opts.filter 只捕获这些级别（默认全部: log/warn/error/info/debug）
   * @param opts.verbose 实时打印到 Node 控制台
   * @param opts.maxEntries 最大缓存条数（默认 500，超了踢旧）
   *
   * 示例:
   *   await page.enableConsoleCapture({ verbose: true });
   *   await page.goto('https://example.com');
   *   const errors = page.getConsoleLogs({ level: 'error' });
   *
   *   // 带标签监控
   *   page.onConsoleEntry((e) => {
   *     if (e.text.includes('Failed')) console.error('FAIL:', e.text);
   *   });
   */
  async enableConsoleCapture(opts: {
    filter?: ('log' | 'warn' | 'error' | 'info' | 'debug')[];
    verbose?: boolean;
    maxEntries?: number;
  } = {}) {
    if (this._consoleEnabled) {
      await this.disableConsoleCapture();
    }

    this._consoleEnabled = true;
    this._consoleLogs = [];
    this._consoleMaxEntries = opts.maxEntries ?? 500;
    const filter = opts.filter || null;
    const verbose = opts.verbose ?? false;

    await this._sessionCall('Runtime.enable').catch(() => {});

    const handler = (params: any) => {
      try {
        const entry: ConsoleEntry = {
          level: params.type || 'log',
          text: params.args?.map((a: any) => {
            if (a.type === 'string') return a.value ?? '';
            if (a.type === 'number') return String(a.value ?? a.unserializableValue ?? '');
            if (a.type === 'boolean') return String(a.value);
            if (a.type === 'undefined') return 'undefined';
            if (a.type === 'null') return 'null';
            if (a.type === 'object') {
              if (a.preview) return a.preview.description || a.preview.type || 'object';
              return a.description || '[object]';
            }
            return a.description || a.value || `[${a.type}]`;
          }).join(' '),
          timestamp: Date.now(),
          url: params.stackTrace?.callFrames?.[0]?.url || '',
          line: params.stackTrace?.callFrames?.[0]?.lineNumber,
          column: params.stackTrace?.callFrames?.[0]?.columnNumber,
        };

        // 过滤
        if (filter && !filter.includes(entry.level as any)) return;

        // 缓存
        this._consoleLogs.push(entry);
        while (this._consoleLogs.length > this._consoleMaxEntries) {
          this._consoleLogs.shift();
        }

        // 实时输出
        if (verbose) {
          const icon = { log: '📝', warn: '⚠️', error: '❌', info: 'ℹ️', debug: '🐛' }[entry.level] || '📝';
          console.log(`  ${icon} [${entry.level}] ${entry.text.slice(0, 200)}`);
        }

        // 回调
        for (const cb of this._consoleCallbacks) try { cb(entry); } catch {}
      } catch { /* ignore malformed entries */ }
    };

    this._consoleUnsubs.push(this._onBrowserEvent('Runtime.consoleAPICalled', handler));
    this._unsubs.push(this._consoleUnsubs[0]);
  }

  private _consoleCallbacks: Set<(entry: ConsoleEntry) => void> = new Set();

  /** 监听控制台输出（不缓存，回调模式） */
  onConsoleEntry(cb: (entry: ConsoleEntry) => void) {
    this._consoleCallbacks.add(cb);
    return () => this._consoleCallbacks.delete(cb);
  }

  /**
   * 获取捕获的控制台日志
   * @param opts.level 按级别过滤
   * @param opts.text 文本关键词搜索
   */
  getConsoleLogs(opts: {
    level?: string;
    text?: string;
  } = {}): ConsoleEntry[] {
    let logs = this._consoleLogs;
    if (opts.level) {
      logs = logs.filter(e => e.level === opts.level);
    }
    if (opts.text) {
      const kw = opts.text.toLowerCase();
      logs = logs.filter(e => e.text.toLowerCase().includes(kw));
    }
    return logs;
  }

  /** 清空控制台日志缓存 */
  clearConsoleLogs() {
    this._consoleLogs = [];
  }

  /** 关闭控制台日志捕获 */
  async disableConsoleCapture() {
    this._consoleEnabled = false;
    for (const unsub of this._consoleUnsubs) try { unsub(); } catch {}
    this._consoleUnsubs = [];
  }

  // ── dialog handling ──

  private _dialogAutoMode: 'accept' | 'dismiss' | null = null;
  private _dialogCallbacks: Set<(dialog: DialogEvent) => void> = new Set();
  private _dialogUnsub: Function | null = null;

  /**
   * 自动处理 JavaScript 对话框（alert / confirm / prompt）。
   * 开启后页面弹框会自动点掉，不再卡住自动化流程。
   *
   * @param mode 'accept' 自动点确定（默认），'dismiss' 自动点取消
   * @param promptText 如果是 prompt，填入此文本
   * @param callback 可选回调，决定每个对话框的处理方式
   *
   * 示例:
   *   // 自动点确定
   *   await page.enableAutoDialog();
   *   await page.enableAutoDialog('accept');
   *
   *   // 自动点取消
   *   await page.enableAutoDialog('dismiss');
   *
   *   // prompt 自动填入文本
   *   await page.enableAutoDialog('accept', '默认回答');
   *
   *   // 自定义处理逻辑
   *   await page.enableAutoDialog('accept', '', (dialog) => {
   *     if (dialog.message.includes('确认删除')) return 'dismiss';
   *     return 'accept';
   *   });
   *
   *   // 关闭自动处理
   *   await page.disableAutoDialog();
   */
  async enableAutoDialog(
    mode: 'accept' | 'dismiss' = 'accept',
    promptText: string = '',
    callback?: (dialog: DialogEvent) => 'accept' | 'dismiss' | string
  ) {
    if (this._dialogAutoMode) {
      await this.disableAutoDialog();
    }

    this._dialogAutoMode = mode;
    await this._sessionCall('Page.enable').catch(() => {});

    this._dialogUnsub = this._onBrowserEvent('Page.javascriptDialogOpening', async (params: any) => {
      const dialog: DialogEvent = {
        type: params.type || 'alert',
        message: params.message || '',
        defaultPrompt: params.defaultPrompt || '',
        url: params.url || '',
        hasBrowserHandler: params.hasBrowserHandler || false,
      };

      // 通知所有回调
      for (const cb of this._dialogCallbacks) {
        try { cb(dialog); } catch {}
      }

      let action: 'accept' | 'dismiss' = mode;
      let promptValue = promptText;

      // 自定义回调
      if (callback) {
        const result = callback(dialog);
        if (result === 'accept' || result === 'dismiss') {
          action = result;
        } else {
          action = 'accept';
          promptValue = result;
        }
      }

      console.log(`  💬 ${dialog.type}: ${dialog.message.slice(0, 80)} → ${action === 'accept' ? '✅ 确定' : '❌ 取消'}`);

      try {
        await this._sessionCall('Page.handleJavaScriptDialog', {
          accept: action === 'accept',
          promptText: promptValue || dialog.defaultPrompt || '',
        }, 5000);
      } catch (err: any) {
        console.warn(`  ⚠️  对话框处理失败: ${err.message}`);
      }
    });

    this._unsubs.push(this._dialogUnsub);
  }

  /**
   * 关闭对话框自动处理
   */
  async disableAutoDialog() {
    this._dialogAutoMode = null;
    if (this._dialogUnsub) {
      try { this._dialogUnsub(); } catch {}
      this._dialogUnsub = null;
    }
  }

  /**
   * 监听对话框事件（不自动处理）
   */
  onDialog(cb: (dialog: DialogEvent) => void) {
    this._dialogCallbacks.add(cb);
    return () => this._dialogCallbacks.delete(cb);
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
