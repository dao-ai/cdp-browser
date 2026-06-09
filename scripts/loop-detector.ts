/**
 * LoopDetector — 行为循环检测系统
 *
 * 参考 browser-use 的 ActionLoopDetector 设计：
 * - 滑动窗口追踪最近动作的归一化哈希（默认 20 步）
 * - 页面指纹检测停滞（URL + 元素数 + DOM 文本哈希）
 * - 动作重复检测（归一化哈希出现频率，分 5/8/12 三级警示）
 * - 页面停滞检测（连续 5 步指纹不变）
 * - 自动注入 nudge 消息到 LLM prompt，不断阻塞仅提醒
 *
 * 归一化哈希策略:
 *   search → 排序 token + 引擎名（去关键词顺序干扰）
 *   click  → type + text（去索引干扰）
 *   input  → index + 清过前缀的 text
 *   navigate → full URL（仅完全相同才算重复）
 *   scroll → direction + index
 *   other → action name + 排序后的参数字典
 *
 * 用法:
 *   const detector = new LoopDetector({ windowSize: 20 });
 *   detector.recordAction('click_element', { index: 3 });
 *   detector.recordPageState(url, domText, elementCount);
 *   const nudge = detector.getNudgeMessage(); // string | null
 *   if (nudge) prompt += nudge;
 */

import { createHash } from 'crypto';

// ─── 配置 ──────────────────────────────────────────────────

export interface LoopDetectorConfig {
  /** 滑动窗口大小（默认 20） */
  windowSize?: number;
  /** 动作重复警示阈值（默认为 [5, 8, 12]） */
  repetitionThresholds?: [number, number, number];
  /** 页面停滞警示阈值（默认 5 步） */
  stagnationThreshold?: number;
}

const DEFAULT_CONFIG: Required<LoopDetectorConfig> = {
  windowSize: 20,
  repetitionThresholds: [5, 8, 12],
  stagnationThreshold: 5,
};

// ─── 页面指纹 ──────────────────────────────────────────────

export interface PageFingerprint {
  url: string;
  elementCount: number;
  textHash: string; // SHA-256 前 16 位
}

export function createPageFingerprint(url: string, domText: string, elementCount: number): PageFingerprint {
  const hash = createHash('sha256').update(domText, 'utf-8').digest('hex').slice(0, 16);
  return { url, elementCount, textHash: hash };
}

export function fingerprintsEqual(a: PageFingerprint, b: PageFingerprint): boolean {
  return a.url === b.url && a.elementCount === b.elementCount && a.textHash === b.textHash;
}

// ─── 动作归一化 ─────────────────────────────────────────────

/** 首屏 X 个文本字符就够了，不需要全 DOM */
const DOM_TEXT_HASH_MAX = 5000;

function _normalizeActionForHash(actionName: string, params: Record<string, any>): string {
  switch (actionName) {
    case 'search':
    case 'search_page': {
      const query = String(params.query ?? '');
      const engine = String(params.engine ?? 'google');
      // 归一化搜索词: 小写 + 排序 token + 去标点
      const tokens = [...new Set(query.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean))].sort();
      return `search|${engine}|${tokens.join('|')}`;
    }

    case 'click_element':
    case 'click': {
      // click 只按位置哈希（忽略 index，因为同一个位置连续点是循环信号）
      const x = params.coordinate_x;
      const y = params.coordinate_y;
      if (x != null && y != null) return `click|pos|${x},${y}`;
      const idx = params.index;
      return `click|idx|${idx}`;
    }

    case 'type_text':
    case 'input': {
      const idx = params.index;
      const text = String(params.text ?? '').trim().toLowerCase();
      return `input|${idx}|${text.slice(0, 100)}`;
    }

    case 'navigate':
    case 'goto': {
      // full URL 去 scheme
      const url = String(params.url ?? '');
      try {
        const u = new URL(url);
        return `navigate|${u.hostname}${u.pathname}${u.search}`;
      } catch {
        return `navigate|${url}`;
      }
    }

    case 'scroll_down':
    case 'scroll_up':
    case 'scroll': {
      const dir = actionName === 'scroll_up' ? 'up' : (params.down !== false ? 'down' : 'up');
      const idx = params.index;
      return `scroll|${dir}|${idx ?? ''}`;
    }

    case 'extract':
    case 'read_text':
    case 'get_page_text':
    case 'get_dom_state':
      return `${actionName}|read`;

    case 'press_enter':
    case 'go_back':
    case 'wait':
      return actionName;

    default: {
      // 其他: 按 action name + 排序后的参数（去 null）
      const filtered: Record<string, any> = {};
      for (const [k, v] of Object.entries(params).sort()) {
        if (v != null) filtered[k] = v;
      }
      return `${actionName}|${JSON.stringify(filtered)}`;
    }
  }
}

function _computeActionHash(actionName: string, params: Record<string, any>): string {
  const normalized = _normalizeActionForHash(actionName, params);
  return createHash('sha256').update(normalized, 'utf-8').digest('hex').slice(0, 12);
}

// ─── ActionLoopDetector ────────────────────────────────────

export class LoopDetector {
  private _config: Required<LoopDetectorConfig>;

  // 滑动窗口
  private _recentActionHashes: string[] = [];
  private _windowSize: number;

  // 页面指纹
  private _recentPageFingerprints: PageFingerprint[] = [];

  // 当前状态
  private _maxRepetitionCount = 0;
  private _mostRepeatedHash: string | null = null;
  private _consecutiveStagnantPages = 0;

  // 上次注入的 nudge 等级（防重复刷屏）
  private _lastNudgeLevel = 0; // 0=无, 1=level1, 2=level2, 3=level3

  constructor(config?: LoopDetectorConfig) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._windowSize = this._config.windowSize;
  }

  /** 重置检测器（新任务时调用） */
  reset(): void {
    this._recentActionHashes = [];
    this._recentPageFingerprints = [];
    this._maxRepetitionCount = 0;
    this._mostRepeatedHash = null;
    this._consecutiveStagnantPages = 0;
    this._lastNudgeLevel = 0;
  }

  /** 重置 nudge 等级（在注入 nudge 后调用，允许同一等级再次注入） */
  resetNudgeLevel(): void {
    this._lastNudgeLevel = 0;
  }

  /** 记录一个动作 */
  recordAction(actionName: string, params: Record<string, any>): void {
    const h = _computeActionHash(actionName, params);
    this._recentActionHashes.push(h);

    // 裁剪窗口
    if (this._recentActionHashes.length > this._windowSize) {
      this._recentActionHashes = this._recentActionHashes.slice(-this._windowSize);
    }

    this._updateRepetitionStats();
  }

  /** 记录页面状态（用于停滞检测） */
  recordPageState(url: string, domText: string, elementCount: number): void {
    const fp = createPageFingerprint(url, domText.slice(0, DOM_TEXT_HASH_MAX), elementCount);

    if (this._recentPageFingerprints.length > 0 &&
        fingerprintsEqual(this._recentPageFingerprints[this._recentPageFingerprints.length - 1], fp)) {
      this._consecutiveStagnantPages++;
    } else {
      this._consecutiveStagnantPages = 0;
    }

    this._recentPageFingerprints.push(fp);

    // 最多保留 5 个指纹
    if (this._recentPageFingerprints.length > 5) {
      this._recentPageFingerprints = this._recentPageFingerprints.slice(-5);
    }
  }

  /**
   * 获取 nudge 消息（基于当前检测状态），等级制防刷屏
   * 返回 string 或 null
   */
  getNudgeMessage(): string | null {
    if (this._recentActionHashes.length < 3) return null; // 窗口太小

    const [t1, t2, t3] = this._config.repetitionThresholds;
    const stagnationThreshold = this._config.stagnationThreshold;
    const messages: string[] = [];
    let currentLevel = 0;

    // 动作重复检测 — 分 5/8/12 三级
    if (this._maxRepetitionCount >= t3) {
      currentLevel = 3;
      if (this._lastNudgeLevel < 3) {
        messages.push(
          `⚠️ 注意：你在最近 ${this._recentActionHashes.length} 步内重复了相似动作 ${this._maxRepetitionCount} 次。` +
          '如果每次都有进展，请继续。否则，换个策略可能会更快。'
        );
      }
    } else if (this._maxRepetitionCount >= t2) {
      currentLevel = 2;
      if (this._lastNudgeLevel < 2) {
        messages.push(
          `⚠️ 注意：你在最近 ${this._recentActionHashes.length} 步内重复了相似动作 ${this._maxRepetitionCount} 次。` +
          '还有进展吗？有就继续，没有就换个思路。'
        );
      }
    } else if (this._maxRepetitionCount >= t1) {
      currentLevel = 1;
      if (this._lastNudgeLevel < 1) {
        messages.push(
          `⚠️ 注意：你在最近 ${this._recentActionHashes.length} 步内重复了相似动作 ${this._maxRepetitionCount} 次。` +
          '如果是有意为之且有进展，请继续。否则考虑换策略。'
        );
      }
    }

    // 页面停滞检测
    if (this._consecutiveStagnantPages >= stagnationThreshold) {
      messages.push(
        `⚠️ 页面内容已经连续 ${this._consecutiveStagnantPages} 步没有变化。` +
        '你的操作可能没有产生预期效果，试试其他元素或方法。'
      );
      currentLevel = Math.max(currentLevel, 2);
    }

    if (messages.length > 0) {
      this._lastNudgeLevel = currentLevel;
      return messages.join('\n\n');
    }

    return null;
  }

  /** 获取当前检测状态（调试用） */
  get status(): string {
    return `window=${this._recentActionHashes.length}/${this._windowSize} ` +
      `maxRepeat=${this._maxRepetitionCount} ` +
      `stagnant=${this._consecutiveStagnantPages}`;
  }

  // ── 内部 ──

  private _updateRepetitionStats(): void {
    if (this._recentActionHashes.length === 0) {
      this._maxRepetitionCount = 0;
      this._mostRepeatedHash = null;
      return;
    }

    const counts = new Map<string, number>();
    let maxCount = 0;
    let maxHash: string | null = null;

    for (const h of this._recentActionHashes) {
      const c = (counts.get(h) ?? 0) + 1;
      counts.set(h, c);
      if (c > maxCount) {
        maxCount = c;
        maxHash = h;
      }
    }

    this._maxRepetitionCount = maxCount;
    this._mostRepeatedHash = maxHash;
  }

  // ── 访问器（供外部读状态） ──

  get maxRepetitionCount(): number { return this._maxRepetitionCount; }
  get mostRepeatedHash(): string | null { return this._mostRepeatedHash; }
  get consecutiveStagnantPages(): number { return this._consecutiveStagnantPages; }
  get windowSize(): number { return this._windowSize; }
  get recentActionHashes(): readonly string[] { return this._recentActionHashes; }
  get recentPageFingerprints(): readonly PageFingerprint[] { return this._recentPageFingerprints; }
}
