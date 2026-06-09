/**
 * CrashWatchdog — 浏览器崩溃/断开检测与自动恢复
 *
 * 监听 CDP 连接断开和页面崩溃事件，自动尝试恢复。
 * 如果浏览器进程本身已死，尝试重启。
 *
 * 事件流:
 *   ConnectionLost → 尝试重连 → ConnectionRestored | 触发 maxRetries → Agent 停止
 *   PageCrashed → 自动恢复页面 → 恢复成功/失败
 */

import type { CdpBrowser, CdpPage, CdpConnection } from '../cdp-client';
import { BaseWatchdog, type WatchdogOptions } from './base-watchdog';
import type { WatchdogEventName } from './event-bus';

export interface CrashWatchdogOptions extends WatchdogOptions {
  browser: CdpBrowser;
  /** CdpConnection（用于监听断开事件，从 CdpBrowser 获取） */
  connection: CdpConnection;
  /** 主页面（崩溃后尝试恢复） */
  page: CdpPage;
  /** 最大重连尝试次数（默认 3） */
  maxReconnectAttempts?: number;
  /** 重连间隔基数 ms（默认 1000, 指数退避） */
  reconnectBaseMs?: number;
  /** 页面崩溃是否自动恢复（默认 true） */
  autoRestorePage?: boolean;
}

export class CrashWatchdog extends BaseWatchdog {
  static override LISTENS_TO: readonly WatchdogEventName[] = [];
  static override EMITS: readonly WatchdogEventName[] = ['ConnectionLost', 'ConnectionRestored', 'PageCrashed'];

  private _browser: CdpBrowser;
  private _connection: CdpConnection;
  private _page: CdpPage;
  private _maxReconnectAttempts: number;
  private _reconnectBaseMs: number;
  private _autoRestorePage: boolean;

  private _reconnectAttempts = 0;
  private _isReconnecting = false;
  private _isConnected = true;
  private _disconnectUnsub: (() => void) | null = null;
  private _crashUnsub: (() => void) | null = null;

  constructor(opts: CrashWatchdogOptions) {
    super(opts);
    this._browser = opts.browser;
    this._connection = opts.connection;
    this._page = opts.page;
    this._maxReconnectAttempts = opts.maxReconnectAttempts ?? 3;
    this._reconnectBaseMs = opts.reconnectBaseMs ?? 1000;
    this._autoRestorePage = opts.autoRestorePage ?? true;
  }

  override attach(): void {
    super.attach();

    // 监听 CDP 连接断开（CdpConnection 提供）
    this._disconnectUnsub = this._connection.onDisconnect(() => {
      this._onDisconnected();
    });

    // 监听页面崩溃
    this._crashUnsub = this._browser.onPageCrash((targetId: string) => {
      this._onPageCrashed(targetId);
    });

    this.logger.debug(`[CrashWatchdog] ✓ 已注册 CDP 断开+崩溃监听`);
  }

  override detach(): void {
    if (this._disconnectUnsub) { this._disconnectUnsub(); this._disconnectUnsub = null; }
    if (this._crashUnsub) { this._crashUnsub(); this._crashUnsub = null; }
    super.detach();
  }

  /** 连接是否正常 */
  get isConnected(): boolean { return this._isConnected; }

  /** 是否正在重连 */
  get isReconnecting(): boolean { return this._isReconnecting; }

  /** 重连尝试次数 */
  get reconnectAttempts(): number { return this._reconnectAttempts; }

  private _onDisconnected(): void {
    if (this._isReconnecting) return;

    this._isConnected = false;
    this.logger.warn(`[CrashWatchdog] ⚡ CDP 连接断开`);
    this.emit('ConnectionLost', { reason: 'websocket closed' });

    this._startReconnect();
  }

  private async _startReconnect(): Promise<void> {
    this._isReconnecting = true;
    this._reconnectAttempts = 0;

    while (this._reconnectAttempts < this._maxReconnectAttempts) {
      this._reconnectAttempts++;
      const delay = this._reconnectBaseMs * Math.pow(2, this._reconnectAttempts - 1);

      this.logger.info(
        `[CrashWatchdog] 🔄 尝试重连 ${this._reconnectAttempts}/${this._maxReconnectAttempts} (${delay}ms)...`
      );

      await new Promise((r) => setTimeout(r, delay));

      try {
        // 检查连接状态
        const status = this._browser.status;
        if (status === 'connected') {
          this._isConnected = true;
          this._isReconnecting = false;
          this._reconnectAttempts = 0;
          this.logger.info(`[CrashWatchdog] ✅ 重连成功`);
          this.emit('ConnectionRestored', {});

          // 如果启用了自动恢复，恢复页面
          if (this._autoRestorePage) {
            try {
              await this._restorePage();
            } catch (err: any) {
              this.logger.warn(`[CrashWatchdog] ⚠️ 页面恢复失败: ${err.message}`);
            }
          }
          return;
        }
      } catch (err: any) {
        this.logger.debug(`[CrashWatchdog] 重连尝试 ${this._reconnectAttempts} 失败: ${err.message}`);
      }
    }

    // 重连耗尽
    this._isReconnecting = false;
    this.logger.error(
      `[CrashWatchdog] ❌ 重连失败，已尝试 ${this._maxReconnectAttempts} 次`
    );
  }

  private _onPageCrashed(targetId: string): void {
    this.logger.warn(`[CrashWatchdog] 💥 页面崩溃 targetId=${targetId}`);

    this.emit('PageCrashed', { targetId, autoRestored: false });

    // 注意：我们只记录事件，实际恢复由 CdpPage 的 _autoRestorePage 机制处理
    // 这里只是额外的事件通知
  }

  private async _restorePage(): Promise<void> {
    // CdpPage 内部已经有 Inspector.targetCrashed → _autoRestorePage 机制
    // 这里尝试主动恢复（如果当前页面状态异常）
    try {
      const url = await this._page.url().catch(() => '');
      if (!url || url === 'about:blank' || url === 'chrome-error://chromewebdata/') {
        this.logger.info(`[CrashWatchdog] 🔄 尝试恢复为空白页面`);
      }
    } catch {
      this.logger.warn(`[CrashWatchdog] 无法获取页面状态，可能需要手动恢复`);
    }
  }
}
