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

// ─── AI Agent ──────────────────────────────────────────────

export {
  BrowserAgent,
  runAgent,
  runAgentMultiPage,
} from './agent';

export type {
  AgentConfig,
  AgentRunOptions,
  AgentStepDecision,
  AgentResult,
} from './agent';

// ─── LLM Client ────────────────────────────────────────────

export {
  LlmClient,
  createLlmClient,
} from './llm-client';

export type {
  LlmMessage,
  LlmClientConfig,
  LlmChatOptions,
  LlmChatResponse,
} from './llm-client';

// ─── DOM → LLM 接口 ───────────────────────────────────────

export {
  DomService,
} from './dom-service';

export type {
  DomElement,
  DomState,
  DomServiceOptions,
} from './dom-service';

// ─── Action Registry ───────────────────────────────────────

export {
  ActionRegistry,
  createActionRegistry,
} from './action-registry';

export type {
  ActionParameter,
  ActionDefinition,
  ActionEntry,
  ActionResult,
} from './action-registry';

// ─── Agent History ─────────────────────────────────────────

export {
  AgentHistory,
  MiniAgentHistory,
} from './agent-history';

export type {
  AgentAction,
  AgentStepResult,
  AgentStep,
} from './agent-history';

// ─── Agent Prompts ─────────────────────────────────────────

export {
  AgentPrompts,
} from './agent-prompts';

export type {
  AgentPromptOptions,
} from './agent-prompts';

// ─── Message Compaction ────────────────────────────────────

export {
  MessageCompactor,
} from './message-compactor';

export type {
  CompactionSettings,
  CompactionContext,
} from './message-compactor';

// ─── Loop Detection ────────────────────────────────────────

export {
  LoopDetector,
  createPageFingerprint,
  fingerprintsEqual,
} from './loop-detector';

export type {
  LoopDetectorConfig,
  PageFingerprint,
} from './loop-detector';

// ─── Planning System ───────────────────────────────────────

export {
  PlanningSystem,
} from './planning-system';

export type {
  PlanningConfig,
  PlanItem,
  PlanItemStatus,
  PlanSnapshot,
} from './planning-system';

// ─── JSON Extractor ────────────────────────────────────────

export {
  extractJson,
  extractValidatedJson,
  isValidAgentDecision,
  hasFields,
  buildAgentOutputSchema,
  buildAgentOutputJsonSchema,
} from './json-extractor';

export type {
  JsonExtractOptions,
  JsonExtractResult,
} from './json-extractor';

// ─── Watchdog System ───────────────────────────────────────

export {
  EventBus,
  BaseWatchdog,
  PopupsWatchdog,
  CrashWatchdog,
  CaptchaWatchdog,
  createDefaultWatchdogs,
} from './watchdog';

export type {
  WatchdogEventMap,
  WatchdogEventName,
  WatchdogOptions,
  PopupsWatchdogOptions,
  CrashWatchdogOptions,
  CaptchaWatchdogOptions,
  CaptchaDetectResult,
  WatchdogSet,
} from './watchdog';
