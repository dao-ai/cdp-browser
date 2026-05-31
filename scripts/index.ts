/**
 * CDP Browser — 纯 Chrome DevTools Protocol 浏览器自动化库
 *
 * 入口文件 — 从这里导入所有公开 API。
 *
 * 用法:
 *   import { connectBrowser, CdpPage } from './scripts';
 *   const browser = await connectBrowser();
 *   const page = await browser.newPage();
 *   await page.goto('https://example.com');
 */

// ─── CDP 核心 ──────────────────────────────────────────────

export {
  CdpConnection,
  CdpBrowser,
  CdpPage,
  sleep,
  randomDelay,
  humanDelay,
  lognormalDelay,
  randomRange,
} from './cdp-client';

export type {
  ConsoleEntry,
  DialogEvent,
  MediaEntry,
} from './cdp-client';

export { MediaType } from './cdp-client';

// ─── 连接管理 ──────────────────────────────────────────────

export {
  connectBrowser,
  detectPlatform,
  isWindows,
  isWsl,
  isLinux,
  setConnectOptions,
  getConnectOptions,
  killInstance,
  testConnection,
  getConnectionInfo,
} from './cdp-manager';

export type { ConnectOptions } from './cdp-manager';

// ─── 连接池 ────────────────────────────────────────────────

export {
  CdpPool,
  createPool,
  getPool,
  closePool,
} from './cdp-pool';

export type { PoolOptions } from './cdp-pool';

// ─── 内容提取 ──────────────────────────────────────────────

export {
  extract,
  batchExtract,
  listSites,
} from './extractors';

export type {
  ExtractorResult,
  ExtractorRule,
  ExtractOptions,
  TimedExtractorResult,
  BatchSummary,
} from './extractors';

// ─── 表单辅助 ──────────────────────────────────────────────

export {
  fillForm,
  submitForm,
  formSubmit,
  selectOption,
  setChecked,
  check,
  uncheck,
  waitAndFill,
} from './form-helper';

export type { FormConfig, FormFieldValue } from './form-helper';

// ─── 反检测 ────────────────────────────────────────────────

export {
  getScriptsForUrl,
  deployAntiDetection,
} from './anti-detection';

// ─── 行为画像 ──────────────────────────────────────────────

export { BehaviorProfile } from './behavior-profile';

// ─── 站点注册表 ────────────────────────────────────────────

export { matchSite, SITE_REGISTRY, isCliMain } from './sites';
export type { SiteInfo } from './sites';

// ─── 常量 ──────────────────────────────────────────────────

export {
  TIMEOUTS,
  RECONNECT,
  HUMAN_DELAY,
  LOGNORMAL,
  VIEWPORT_JITTER,
  MOUSE,
  SCROLL,
  POLL,
  BUFFER_LIMITS,
} from './constants';
