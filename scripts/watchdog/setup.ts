/**
 * setup — 创建并 attach 默认 Watchdog 集合
 *
 * 用法:
 *   const { watchdogs, bus } = createDefaultWatchdogs(page, browser, opts);
 *   // watchdogs 可以在 Agent 中访问
 *   // bus 用于发布/消费事件
 */

import { EventBus } from './event-bus';
import { PopupsWatchdog } from './popups-watchdog';
import { CrashWatchdog } from './crash-watchdog';
import { CaptchaWatchdog } from './captcha-watchdog';
import type { CdpBrowser, CdpPage } from '../cdp-client';

export interface WatchdogSet {
  bus: EventBus;
  popups: PopupsWatchdog;
  crash: CrashWatchdog;
  captcha: CaptchaWatchdog;
  all: import('./base-watchdog').BaseWatchdog[];
  /** 全部 attach */
  attachAll(): void;
  /** 全部 detach */
  detachAll(): void;
}

export interface CreateWatchdogsOptions {
  /** 是否启用弹窗处理（默认 true） */
  popups?: boolean;
  /** 是否启用崩溃检测（默认 true） */
  crash?: boolean;
  /** 是否启用验证码检测（默认 true） */
  captcha?: boolean;
  /** 验证码检测超时 ms（默认 120s） */
  captchaTimeoutMs?: number;
  /** 验证码检测的 evaluate 函数（从 page 注入） */
  captchaEvaluateFn?: (script: string) => Promise<any>;
  /** 自定义 debug logger */
  logger?: Console;
}

/**
 * 创建一组默认 Watchdog 并绑定到同一 EventBus
 */
export function createDefaultWatchdogs(
  page: CdpPage,
  browser: CdpBrowser,
  opts: CreateWatchdogsOptions = {},
): WatchdogSet {
  const bus = new EventBus();
  const logger = opts.logger || console;

  const popups = opts.popups !== false
    ? new PopupsWatchdog({ eventBus: bus, page, logger })
    : null as any;

  // CrashWatchdog 使用 page.onDisconnect 而不是 EventBus，
  // 所以即使 EventBus 上没有监听者也能工作
  const crash = opts.crash !== false
    ? new CrashWatchdog({ eventBus: bus, browser, connection: browser.connection, page, logger })
    : null as any;

  const captcha = opts.captcha !== false
    ? new CaptchaWatchdog({
        eventBus: bus,
        logger,
        captchaTimeoutMs: opts.captchaTimeoutMs ?? 120_000,
      })
    : null as any;

  // 给 Captcha 注入 evaluate 函数
  if (captcha && opts.captchaEvaluateFn) {
    captcha.setEvaluateFn(opts.captchaEvaluateFn);
  }

  const all = [popups, crash, captcha].filter(Boolean);

  return {
    bus,
    popups,
    crash,
    captcha,
    all,
    attachAll() {
      for (const w of all) {
        try {
          w.attach();
        } catch (err: any) {
          logger.warn(`[Watchdog] ${w.id} attach 失败: ${err.message}`);
        }
      }
      logger.debug(`[Watchdog] ✓ 已 attach ${all.length} 个 watchdog`);
    },
    detachAll() {
      for (const w of all) {
        try { w.detach(); } catch {}
      }
    },
  };
}
