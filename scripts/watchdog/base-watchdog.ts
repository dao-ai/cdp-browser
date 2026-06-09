/**
 * BaseWatchdog — Watchdog 基类
 *
 * 参考 browser-use 的 watchdog_base.py 设计：
 * - 声明 LISTENS_TO / EMITS 事件契约
 * - attach() 自动扫描 on_* 方法并注册到 EventBus
 * - 支持生命周期自动清理
 *
 * 用法:
 *   class MyWatchdog extends BaseWatchdog {
 *     static readonly LISTENS_TO = ['TabCreated'];
 *     static readonly EMITS = [];
 *     async on_TabCreated(event: WatchdogEventMap['TabCreated']) { ... }
 *   }
 */

import { EventBus, type WatchdogEventMap, type WatchdogEventName } from './event-bus';

export interface WatchdogOptions {
  eventBus: EventBus;
  logger?: Console;
  /** Watchdog 唯一标识（用于日志前缀） */
  id?: string;
}

export abstract class BaseWatchdog {
  /** 监听的事件列表（声明式，用于调试和验证） */
  static LISTENS_TO: readonly WatchdogEventName[] = [];
  /** 发出的事件列表 */
  static EMITS: readonly WatchdogEventName[] = [];

  protected readonly eventBus: EventBus;
  protected readonly logger: Console;
  readonly id: string;
  protected _unsubs: (() => void)[] = [];
  protected _attached = false;

  constructor(opts: WatchdogOptions) {
    this.eventBus = opts.eventBus;
    this.logger = opts.logger || console;
    this.id = opts.id || this.constructor.name;
  }

  /** 将 watchdog 绑定到 EventBus — 自动扫描 on_* 方法并注册 */
  attach(): void {
    if (this._attached) {
      this.logger.warn(`[${this.id}] 重复 attach，跳过`);
      return;
    }

    const proto = Object.getPrototypeOf(this);
    const methodNames = Object.getOwnPropertyNames(proto).concat(
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(proto))
    ).filter((n) => n.startsWith('on_') && typeof (this as any)[n] === 'function');

    const Ctor = this.constructor as typeof BaseWatchdog;

    for (const methodName of methodNames) {
      const eventName = methodName.slice(3) as WatchdogEventName; // 去掉 "on_" 前缀

      // 如果 LISTENS_TO 声明了，强制校验
      if (Ctor.LISTENS_TO.length > 0 && !Ctor.LISTENS_TO.includes(eventName)) {
        this.logger.warn(
          `[${this.id}] 方法 ${methodName} 监听 ${eventName} 但未在 LISTENS_TO 中声明，跳过`
        );
        continue;
      }

      const handler = (this as any)[methodName].bind(this);

      // 验证 handler 是个函数
      if (typeof handler !== 'function') continue;

      const unsub = this.eventBus.on(eventName, handler);
      this._unsubs.push(unsub);

      this.logger.debug(`[${this.id}] ✓ 已注册 ${methodName} → ${eventName}`);
    }

    // 验证 LISTENS_TO 中有 handler 的声明
    if (Ctor.LISTENS_TO.length > 0) {
      const registered = methodNames.map((n) => n.slice(3));
      const missing = Ctor.LISTENS_TO.filter((e) => !registered.includes(e));
      if (missing.length > 0) {
        this.logger.warn(
          `[${this.id}] LISTENS_TO 声明了 [${missing.join(', ')}] 但找不到对应的 on_* 方法`
        );
      }
    }

    this._attached = true;
    this.logger.debug(`[${this.id}] ✓ 已 attach (${methodNames.length} 个 handler)`);
  }

  /** 从 EventBus 解绑 */
  detach(): void {
    for (const unsub of this._unsubs) {
      try { unsub(); } catch {}
    }
    this._unsubs = [];
    this._attached = false;
    this.logger.debug(`[${this.id}] ✓ 已 detach`);
  }

  /** 发出事件（便捷方法） */
  emit<K extends WatchdogEventName>(event: K, data: WatchdogEventMap[K]): void {
    this.eventBus.emit(event, data);
  }

  /** 是否已 attach */
  get attached(): boolean {
    return this._attached;
  }
}
