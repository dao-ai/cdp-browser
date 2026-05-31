/**
 * 全局常量配置
 *
 * 集中管理 cdp-client.ts 中的硬编码值，
 * 避免修改时需要搜索整个文件。
 */

// ─── 超时 ──────────────────────────────────────────────────

export const TIMEOUTS: Record<string, number> = {
  /** WebSocket 连接超时 (ms) */
  WS_CONNECT: 15_000,
  /** CDP 命令超时 (ms) */
  CDP_COMMAND: 30_000,
  /** 页面导航超时 (ms) */
  PAGE_LOAD: 30_000,
  /** 等待选择器默认超时 (ms) */
  WAIT_SELECTOR: 15_000,
  /** 等待响应默认超时 (ms) */
  WAIT_RESPONSE: 30_000,
  /** PDF 生成超时 (ms) */
  PDF: 60_000,
  /** 等待手工登录超时 (ms) */
  LOGIN: 120_000,
  /** 登录轮询间隔 (ms) */
  LOGIN_POLL: 3_000,
  /** 对话框自动处理超时 (ms) */
  DIALOG: 5_000,
  /** wslpath 子进程超时 (ms) */
  WSL_EXEC: 2_000,
  /** 导航后稳定等待 (ms) */
  POST_NAVIGATION: 500,
  /** 登录后稳定等待 (ms) */
  POST_LOGIN: 2_000,
};

// ─── 断线重连 ──────────────────────────────────────────────

export const RECONNECT: Record<string, number> = {
  MAX_ATTEMPTS: 10,
  BASE_DELAY_MS: 1_000,
  BACKOFF_MULTIPLIER: 1.5,
  JITTER_MAX_MS: 1_000,
  BACKOFF_CAP_MS: 15_000,
};

// ─── 人类化交互参数 ────────────────────────────────────────

export const HUMAN_DELAY: Record<string, number> = {
  /** 普通击键间隔范围 (ms) */
  FAST_MS: 28,
  SLOW_MS: 55,
  /** 突发停顿概率 (8%) */
  BURST_PROBABILITY: 0.08,
  /** 突发停顿范围 (ms) */
  BURST_MIN: 120,
  BURST_MAX: 350,
};

export const LOGNORMAL: Record<string, number> = {
  /** sigma 除数 */
  SIGMA_DIVISOR: 2.5,
  /** 下限钳位因子 */
  CLAMP_MIN: 0.6,
  /** 上限钳位因子 */
  CLAMP_MAX: 1.3,
  /** Math.random 保护值 */
  EPSILON: 0.001,
};

// ─── 视口抖动 ──────────────────────────────────────────────

export const VIEWPORT_JITTER: Record<string, number> = {
  WIDTH: 18,
  HEIGHT: 12,
};

// ─── 贝塞尔鼠标参数 ────────────────────────────────────────

export const MOUSE: Record<string, number> = {
  DEFAULT_CP_OFFSET: 60,
  DEFAULT_STEPS_MIN: 22,
  DEFAULT_STEPS_MAX: 38,
  DEFAULT_STEP_DELAY_MIN: 3,
  DEFAULT_STEP_DELAY_MAX: 9,
  DEFAULT_JITTER: 1.5,
};

// ─── 滚动参数 ──────────────────────────────────────────────

export const SCROLL: Record<string, number> = {
  STEP_MIN_PX: 80,
  STEP_MAX_PX: 180,
  DX_JITTER: 15,
  DY_JITTER: 20,
  FALLBACK_MOUSE_X: 200,
  FALLBACK_MOUSE_X_MAX: 600,
  FALLBACK_MOUSE_Y: 300,
  FALLBACK_MOUSE_Y_MAX: 500,
  INTER_STEP_DELAY_MIN: 40,
  INTER_STEP_DELAY_MAX: 120,
};

// ─── 轮询间隔 ──────────────────────────────────────────────

export const POLL: Record<string, number> = {
  /** waitForSelector / waitForResponse 轮询间隔 (ms) */
  INTERVAL_MS: 200,
};

// ─── 内部缓冲区上限 ────────────────────────────────────────

export const BUFFER_LIMITS: Record<string, number> = {
  /** 网络事件缓存上限 */
  NETWORK_EVENTS: 200,
  /** 控制台日志上限 */
  CONSOLE_ENTRIES: 500,
};
