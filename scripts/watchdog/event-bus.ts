/**
 * EventBus — 类型安全的高层事件总线
 *
 * 用于 Agent 和 Watchdog 之间的事件通信。
 * 区别于 CdpConnection 的原始 CDP 事件，这是 Agent 层面的业务事件。
 *
 * 用法:
 *   const bus = new EventBus();
 *   bus.on('PagePopupsDetected', (event) => { ... });
 *   bus.emit('PagePopupsDetected', { count: 3, messages: [...] });
 */

export type WatchdogEventMap = {
  /** 页面弹窗被检测到并已处理 */
  DialogHandled: { type: string; message: string; action: 'accept' | 'dismiss' };
  /** 新的标签页被创建 */
  TabCreated: { targetId: string; url: string };
  /** 标签页被关闭 */
  TabClosed: { targetId: string };
  /** CDP 连接断开 */
  ConnectionLost: { reason: string };
  /** CDP 连接恢复 */
  ConnectionRestored: {};
  /** 页面崩溃 */
  PageCrashed: { targetId: string; autoRestored: boolean };
  /** 页面加载完成 */
  PageLoaded: { url: string };
  /** 导航开始 */
  NavigationStarted: { url: string };
  /** 导航完成 */
  NavigationCompleted: { url: string; success: boolean };
  /** 检测到验证码（触发 agent 暂停，等待人工解） */
  CaptchaDetected: { vendor?: string; url: string };
  /** 验证码已解除（可继续） */
  CaptchaResolved: { result: 'success' | 'failed' | 'timeout' };
  /** 文件下载完成 */
  FileDownloaded: { path: string; url?: string };
  /** Agent 步骤开始 */
  AgentStepStart: { step: number };
  /** Agent 步骤结束 */
  AgentStepEnd: { step: number; success: boolean; durationMs: number };
  /** Agent 任务完成 */
  AgentTaskDone: { success: boolean; output?: string };
};

export type WatchdogEventName = keyof WatchdogEventMap;
type Handler<T = any> = (event: T) => void | Promise<void>;

export class EventBus {
  private _handlers = new Map<string, Set<Handler>>();
  private _history: { event: string; data: any; timestamp: number }[] = [];
  private _maxHistory = 100;

  /** 订阅事件 */
  on<K extends WatchdogEventName>(event: K, handler: Handler<WatchdogEventMap[K]>): () => void {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event)!.add(handler);
    return () => { this._handlers.get(event)?.delete(handler); };
  }

  /** 一次性订阅 */
  once<K extends WatchdogEventName>(event: K, handler: Handler<WatchdogEventMap[K]>): void {
    const wrapper = (data: WatchdogEventMap[K]) => {
      unsub();
      return handler(data);
    };
    const unsub = this.on(event, wrapper);
  }

  /** 发布事件 */
  emit<K extends WatchdogEventName>(event: K, data: WatchdogEventMap[K]): void {
    // 记录历史
    this._history.push({ event, data, timestamp: Date.now() });
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    const handlers = this._handlers.get(event);
    if (!handlers || handlers.size === 0) return;

    for (const handler of handlers) {
      try {
        const result = handler(data);
        if (result instanceof Promise) {
          result.catch((err) => console.error(`[EventBus] handler error on ${event}:`, err));
        }
      } catch (err) {
        console.error(`[EventBus] handler error on ${event}:`, err);
      }
    }
  }

  /** 获取事件历史（调试用） */
  getHistory(limit = 20): { event: string; data: any; timestamp: number }[] {
    return this._history.slice(-limit);
  }

  /** 移除某个事件的所有 handler */
  clear(event?: WatchdogEventName): void {
    if (event) {
      this._handlers.delete(event);
    } else {
      this._handlers.clear();
    }
  }

  /** 获取 handler 数量 */
  get handlerCount(): number {
    let count = 0;
    for (const handlers of this._handlers.values()) {
      count += handlers.size;
    }
    return count;
  }
}
