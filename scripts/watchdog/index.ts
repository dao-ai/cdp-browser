/**
 * Watchdog 系统 — 浏览器状态监控
 *
 * 参考 browser-use 的 watchdog 架构：
 * 事件驱动、可插拔、自动注册
 */

export { EventBus } from './event-bus';
export type { WatchdogEventMap, WatchdogEventName } from './event-bus';

export { BaseWatchdog } from './base-watchdog';
export type { WatchdogOptions } from './base-watchdog';

export { PopupsWatchdog } from './popups-watchdog';
export type { PopupsWatchdogOptions } from './popups-watchdog';

export { CrashWatchdog } from './crash-watchdog';
export type { CrashWatchdogOptions } from './crash-watchdog';

export { CaptchaWatchdog } from './captcha-watchdog';
export type { CaptchaWatchdogOptions, CaptchaDetectResult } from './captcha-watchdog';

/** 默认所有 Watchdog */
export { createDefaultWatchdogs } from './setup';
export type { WatchdogSet, CreateWatchdogsOptions } from './setup';
