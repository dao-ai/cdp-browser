/**
 * PopupsWatchdog — 页面弹窗自动处理
 *
 * 监听 CDP 的 Page.javascriptDialogOpening 事件，自动 accept/dismiss，
 * 并将弹窗消息记录到 EventBus 供 Agent 感知。
 *
 * 支持:
 * - alert → 自动 accept
 * - confirm → 自动 accept（更安全）
 * - prompt → 自动 dismiss（因为 AI 无法提供输入）
 * - beforeunload → 自动 accept（允许导航）
 *
 * 同时把弹窗消息保存到内存，Agent 通过 getClosedPopups() 获取。
 */

import type { CdpPage } from '../cdp-client';
import { BaseWatchdog, type WatchdogOptions } from './base-watchdog';
import type { WatchdogEventName } from './event-bus';

export interface PopupsWatchdogOptions extends WatchdogOptions {
  page: CdpPage;
  /** 是否自动处理弹窗（默认 true） */
  autoHandle?: boolean;
  /** 最大记录弹窗数（默认 50） */
  maxRecords?: number;
}

export class PopupsWatchdog extends BaseWatchdog {
  static override LISTENS_TO: readonly WatchdogEventName[] = ['TabCreated'];
  static override EMITS: readonly WatchdogEventName[] = ['DialogHandled'];

  private _page: CdpPage;
  private _autoHandle: boolean;
  private _maxRecords: number;
  private _closedPopups: { type: string; message: string; action: 'accept' | 'dismiss'; timestamp: number }[] = [];
  /** 已经注册了 dialog handler 的 targetId */
  private _registeredTargets = new Set<string>();

  constructor(opts: PopupsWatchdogOptions) {
    super(opts);
    this._page = opts.page;
    this._autoHandle = opts.autoHandle ?? true;
    this._maxRecords = opts.maxRecords ?? 50;

    // 主页面从创建时就设置 dialog handler
    if (this._autoHandle) {
      this._setupDialogHandler(this._page);
    }
  }

  override attach(): void {
    super.attach();
    // 主页面已经有了 handler（在 constructor 中设置），
    // attach 会把 on_TabCreated 注册上，新标签页也能自动处理
  }

  /** 新标签页创建时，也设置 dialog handler */
  async on_TabCreated(event: { targetId: string; url: string }): Promise<void> {
    if (!this._autoHandle) return;
    if (this._registeredTargets.has(event.targetId)) return;

    // 获取新页面的 CdpPage 实例
    // 由调用方在创建新 tab 时通过 registerPage() 注册
    this.logger.debug(`[PopupsWatchdog] 新标签页 ${event.targetId} 等待注册 dialog handler`);
  }

  /**
   * 为某个 CdpPage 设置 dialog handler
   * 主页面在 constructor 时自动设置，新页面由外部调用
   */
  registerPage(page: CdpPage, targetId?: string): void {
    const id = targetId || 'main';
    if (this._registeredTargets.has(id)) return;
    this._setupDialogHandler(page);
    this._registeredTargets.add(id);
  }

  /** 获取已关闭的弹窗列表 */
  getClosedPopups(): { type: string; message: string; action: 'accept' | 'dismiss' }[] {
    return this._closedPopups.slice();
  }

  /** 清空弹窗记录 */
  clearPopups(): void {
    this._closedPopups = [];
  }

  /** 弹窗数量 */
  get popupCount(): number {
    return this._closedPopups.length;
  }

  private _setupDialogHandler(page: CdpPage): void {
    // 使用 CdpPage 已有的 dialog handler
    // mode: alert/confirm → accept, prompt/beforeunload → dismiss
    page.enableAutoDialog('accept', '', (dialog) => {
      const action = this._handleDialog(dialog);
      return action;
    }).catch((err) => {
      this.logger.warn(`[PopupsWatchdog] 设置 dialog handler 失败: ${err.message}`);
    });
  }

  private _handleDialog(dialog: { type: string; message: string }): 'accept' | 'dismiss' {
    const { type, message } = dialog;

    // 根据类型决定动作
    let action: 'accept' | 'dismiss';
    let actionMsg: string;

    switch (type) {
      case 'alert':
        action = 'accept';
        actionMsg = '已自动确认';
        break;
      case 'confirm':
        action = 'accept';
        actionMsg = '已自动确认';
        break;
      case 'prompt':
        action = 'dismiss';
        actionMsg = '已自动取消（AI 无法输入）';
        break;
      case 'beforeunload':
        action = 'accept';
        actionMsg = '已允许导航';
        break;
      default:
        action = 'accept';
        actionMsg = `已自动处理(${type})`;
    }

    const record = { type, message: message.slice(0, 200), action, timestamp: Date.now() };
    this._closedPopups.push(record);

    // 限制记录数量
    if (this._closedPopups.length > this._maxRecords) {
      this._closedPopups = this._closedPopups.slice(-this._maxRecords);
    }

    this.logger.info(
      `[PopupsWatchdog] 🔔 ${type}: "${message.slice(0, 80)}" → ${actionMsg}`
    );

    // 发事件
    this.emit('DialogHandled', { type, message: message.slice(0, 200), action });

    return action;
  }
}
