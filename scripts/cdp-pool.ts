/**
 * CDP 页面连接池
 *
 * 共享一个浏览器实例，按需分配/回收页面，避免频繁启动关闭 Chrome。
 *
 * 核心优势:
 *   - 单次批量提取 50 条 → 只启动一次 Chrome（原来 50 次）
 *   - 页面预热 → acquire 直接可用，不用等 newPage + anti-detection
 *   - 自动回收空闲页面
 *   - withPage() 一行搞定临时用页
 *   - 并发安全: 串行锁防超限、防重复连接
 *
 * 用法:
 *   import { createPool } from './cdp-pool';
 *
 *   const pool = createPool({ maxPages: 3, verbose: true });
 *
 *   // 推荐: withPage 自动 acquire + release
 *   const results = await Promise.all(urls.map(url =>
 *     pool.withPage(async (page) => {
 *       await page.goto(url);
 *       return await page.evaluate('document.title');
 *     })
 *   ));
 *
 *   // 或手动
 *   const page = await pool.acquire();
 *   await page.goto('https://example.com');
 *   pool.release(page);
 */
import { CdpBrowser, CdpPage } from './cdp-client';
import { connectBrowser, ConnectOptions } from './cdp-manager';

// ─── 类型 ──────────────────────────────────────────────────

export interface PoolOptions {
  maxPages?: number;
  idleTimeoutMs?: number;
  connectOptions?: ConnectOptions;
  verbose?: boolean;
}

interface PooledPage {
  page: CdpPage;
  createdAt: number;
  lastUsed: number;
  inUse: boolean;
}

// ─── CdpPool ───────────────────────────────────────────────

export class CdpPool {
  private _browser: CdpBrowser | null = null;
  private _browserPromise: Promise<CdpBrowser> | null = null;
  private _pages: Map<CdpPage, PooledPage> = new Map();
  private _options: Required<PoolOptions>;
  private _idleTimer: ReturnType<typeof setInterval> | null = null;
  private _closed = false;
  private _acquireLock: Promise<void> = Promise.resolve();
  private _waitQueue: Array<{
    resolve: (page: CdpPage) => void;
    reject: (err: Error) => void;
    fresh?: boolean;
  }> = [];

  constructor(options: PoolOptions = {}) {
    this._options = {
      maxPages: options.maxPages ?? 4,
      idleTimeoutMs: options.idleTimeoutMs ?? 60000,
      connectOptions: options.connectOptions ?? {},
      verbose: options.verbose ?? false,
    };
  }

  // ── 生命周期 ─────────────────────────────────────────────

  /** 获取浏览器（并发安全：同一次 connect 不重复调用） */
  private async _ensureBrowser(): Promise<CdpBrowser> {
    if (this._browser) return this._browser;
    if (this._browserPromise) return this._browserPromise;
    this._log('🔧 连接浏览器...');
    this._browserPromise = connectBrowser(this._options.connectOptions);
    const b = await this._browserPromise;
    this._browser = b;
    this._browserPromise = null;
    b.onReconnect(() => {
      this._log('🔄 浏览器重连，清空页面缓存');
      this._pages.clear();
    });
    if (this._idleTimer) clearInterval(this._idleTimer);
    this._idleTimer = setInterval(() => this._reapIdle(), 15000);
    return b;
  }

  /**
   * 从池中获取页面（并发安全：串行锁防超限）
   */
  async acquire(opts: { fresh?: boolean } = {}): Promise<CdpPage> {
    if (this._closed) throw new Error('Pool is closed');

    // 串行锁 — 同一时刻只有一个 acquire 在分配页面
    const prevLock = this._acquireLock;
    let resolveLock: () => void;
    this._acquireLock = new Promise<void>(r => { resolveLock = r; });
    await prevLock;

    try {
      const browser = await this._ensureBrowser();

      // 1. 找空闲页面
      for (const [page, meta] of this._pages) {
        if (!meta.inUse) {
          meta.inUse = true;
          meta.lastUsed = Date.now();
          this._log(`📄 复用页面 (${this._idleCount()}/${this._pages.size})`);
          if (opts.fresh) {
            try { await page.goto('about:blank', { timeoutMs: 5000 }); } catch {}
          }
          return page;
        }
      }

      // 2. 没到上限，新建
      if (this._pages.size < this._options.maxPages) {
        this._log(`📄 新建页面 (${this._pages.size}/${this._options.maxPages})`);
        const page = await browser.newPage();
        this._pages.set(page, { page, createdAt: Date.now(), lastUsed: Date.now(), inUse: true });
        return page;
      }

      // 3. 池满，等待 release
      this._log(`⏳ 池满 (${this._pages.size}/${this._options.maxPages})，排队等待...`);
      return new Promise<CdpPage>((resolve, reject) => {
        this._waitQueue.push({ resolve, reject, fresh: opts.fresh });
      });
    } finally {
      resolveLock!();
    }
  }

  /** 归还页面 */
  release(page: CdpPage) {
    const meta = this._pages.get(page);
    if (!meta) {
      try { page.close(); } catch {}
      return;
    }
    meta.inUse = false;
    meta.lastUsed = Date.now();

    // 通知等待队列
    const waiter = this._waitQueue.shift();
    if (waiter) {
      meta.inUse = true;
      meta.lastUsed = Date.now();
      if (waiter.fresh) {
        page.goto('about:blank', { timeoutMs: 5000 }).catch(() => {});
      }
      waiter.resolve(page);
      return;
    }
    this._log(`♻️ 归还页面 (空闲 ${this._idleCount()}/${this._pages.size})`);
  }

  /**
   * 获取 → 使用 → 自动归还（推荐）
   */
  async withPage<T>(fn: (page: CdpPage) => Promise<T>, opts?: { fresh?: boolean }): Promise<T> {
    const page = await this.acquire(opts);
    try {
      return await fn(page);
    } finally {
      this.release(page);
    }
  }

  // ── 统计 ────────────────────────────────────────────────

  status() {
    return {
      pages: this._pages.size,
      maxPages: this._options.maxPages,
      idle: this._idleCount(),
      busy: this._pages.size - this._idleCount(),
      waitQueue: this._waitQueue.length,
      closed: this._closed,
    };
  }

  // ── 清理 ────────────────────────────────────────────────

  async close() {
    this._closed = true;
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
    for (const w of this._waitQueue) w.reject(new Error('Pool closed'));
    this._waitQueue = [];
    for (const [page] of this._pages) {
      try { await page.close(); } catch {}
    }
    this._pages.clear();
    if (this._browser) {
      try { await this._browser.close(); } catch {}
      this._browser = null;
    }
    this._log('✅ 池已关闭');
  }

  // ── 内部 ────────────────────────────────────────────────

  private _idleCount() {
    let c = 0;
    for (const m of this._pages.values()) if (!m.inUse) c++;
    return c;
  }

  private _reapIdle() {
    const now = Date.now();
    const timeout = this._options.idleTimeoutMs;
    if (timeout <= 0) return;
    const toReap: CdpPage[] = [];
    for (const [page, meta] of this._pages) {
      if (!meta.inUse && now - meta.lastUsed > timeout) toReap.push(page);
    }
    for (const page of toReap) {
      this._pages.delete(page);
      try { page.close(); } catch {}
    }
    if (toReap.length > 0) this._log(`🧹 回收 ${toReap.length} 个空闲页`);
  }

  private _log(msg: string) {
    if (this._options.verbose) console.log(msg);
  }
}

// ─── 全局单例 ────────────────────────────────────────────

let _defaultPool: CdpPool | null = null;

export async function getPool(opts?: PoolOptions): Promise<CdpPool> {
  if (_defaultPool && !_defaultPool.status().closed) return _defaultPool;
  _defaultPool = createPool(opts);
  return _defaultPool;
}

export function createPool(opts?: PoolOptions) { return new CdpPool(opts); }

export async function closePool() {
  if (_defaultPool) { await _defaultPool.close(); _defaultPool = null; }
}
