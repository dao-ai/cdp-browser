/**
 * PlanningSystem — Agent 规划系统
 *
 * 参考 browser-use 的 planning 设计：
 * - LLM 在每一步可以输出 plan_update（新计划）和 current_plan_item（进度）
 * - Plan 在 prompt 中以 [x] [>] [ ] 标记显示
 * - 连续失败触发 replan nudge（建议 LLM 重新规划）
 * - 超过 N 步还没计划触发 exploration nudge（建议创建计划或结束）
 *
 * 三个核心 nudge:
 *   replan_nudge     — 连续失败超过阈值 → "你的计划可能需要修订"
 *   exploration_nudge — N 步无计划        → "该创建计划了，或直接结束"
 *   plan_progress    — 正常               → 展示当前计划和进度
 *
 * 用法:
 *   const planner = new PlanningSystem({ replanOnStall: 3 });
 *   planner.recordConsecutiveFailure();
 *   const planText = planner.render(); // "[x] 搜索\n[>] 点击结果\n[ ] 提取信息"
 *   // 注入到 LLM prompt 中
 *   // LLM 返回 plan_update + current_plan_item
 *   planner.applyPlanUpdate(['搜索', '点击结果', '提取信息']);
 *   planner.advancePlan(2); // 跳到第 2 步
 */

import type { LlmClient } from './llm-client';

// ─── 类型 ──────────────────────────────────────────────────

export type PlanItemStatus = 'pending' | 'current' | 'done' | 'skipped';

export interface PlanItem {
  text: string;
  status: PlanItemStatus;
}

export interface PlanningConfig {
  /** 连续失败多少次后触发 replan nudge（默认 3，0 禁用） */
  replanOnStall?: number;
  /** 多少步无计划后触发 exploration nudge（默认 5，0 禁用） */
  explorationLimit?: number;
  /** 计划是否默认启用（默认 true） */
  enabled?: boolean;
}

export interface PlanSnapshot {
  /** 当前计划文本（用于 prompt 渲染） */
  rendered: string;
  /** 是否有活跃计划 */
  hasPlan: boolean;
  /** 当前步骤索引 */
  currentIndex: number;
  /** 总步骤数 */
  totalSteps: number;
  /** 进度百分比 */
  progress: number;
}

// ─── PlanningSystem ────────────────────────────────────────

export class PlanningSystem {
  private _config: Required<PlanningConfig>;
  private _plan: PlanItem[] = [];
  private _currentIndex = 0;
  private _planGenerationStep = -1; // 在第几步生成的计划

  // 步数追踪
  private _stepsSincePlan = 0;
  private _consecutiveFailures = 0;
  private _totalSteps = 0;

  constructor(config?: PlanningConfig) {
    this._config = {
      replanOnStall: config?.replanOnStall ?? 3,
      explorationLimit: config?.explorationLimit ?? 5,
      enabled: config?.enabled ?? true,
    };
  }

  /** 是否启用 */
  get enabled(): boolean { return this._config.enabled; }

  /** 是否有计划 */
  get hasPlan(): boolean { return this._plan.length > 0; }

  /** 当前计划 */
  get plan(): readonly PlanItem[] { return this._plan; }

  /** 当前步骤索引 */
  get currentIndex(): number { return this._currentIndex; }

  /** 总步数 */
  get totalSteps(): number { return this._plan.length; }

  /** 连续失败次数 */
  get consecutiveFailures(): number { return this._consecutiveFailures; }

  /** 累计步骤 */
  get totalAgentSteps(): number { return this._totalSteps; }

  /** 重置（新任务时调用） */
  reset(): void {
    this._plan = [];
    this._currentIndex = 0;
    this._planGenerationStep = -1;
    this._stepsSincePlan = 0;
    this._consecutiveFailures = 0;
    this._totalSteps = 0;
  }

  /** 每步调用一次（记录总步数） */
  tick(): void {
    this._totalSteps++;
    if (!this.hasPlan) {
      this._stepsSincePlan++;
    }
  }

  /** 记录一次成功 */
  recordSuccess(): void {
    this._consecutiveFailures = 0;
  }

  /** 记录一次失败 */
  recordFailure(): void {
    this._consecutiveFailures++;
  }

  // ── Plan 管理 ──

  /**
   * LLM 输出了新计划时调用（plan_update）
   * 替换整个计划
   */
  applyPlanUpdate(steps: string[]): void {
    this._plan = steps.map((text, i) => ({
      text,
      status: i === 0 ? 'current' as const : 'pending' as const,
    }));
    this._currentIndex = 0;
    this._planGenerationStep = this._totalSteps;
    this._consecutiveFailures = 0; // 重规划后重置失败计数
  }

  /**
   * LLM 指示跳到第几步时调用（current_plan_item）
   * 自动标记途经步骤为 done
   */
  advancePlan(newIndex: number): void {
    if (this._plan.length === 0) return;

    // 钳制到有效范围
    newIndex = Math.max(0, Math.min(newIndex, this._plan.length - 1));
    const oldIndex = this._currentIndex;

    if (newIndex === oldIndex) return;

    // 标记 oldIndex → newIndex-1 之间所有未完成的为 done
    const start = Math.min(oldIndex, newIndex);
    const end = Math.max(oldIndex, newIndex);

    for (let i = start; i < end; i++) {
      if (i < this._plan.length && (this._plan[i].status === 'current' || this._plan[i].status === 'pending')) {
        this._plan[i].status = 'done';
      }
    }

    // 设置新步骤为 current
    if (newIndex < this._plan.length) {
      this._plan[newIndex].status = 'current';
    }

    this._currentIndex = newIndex;
  }

  // ── Nudge 检测 ──

  /**
   * 检测是否需要 replan nudge
   * 当有计划的连续失败 ≥ 阈值时触发
   */
  getReplanNudge(): string | null {
    if (!this._config.enabled) return null;
    if (!this.hasPlan) return null;
    if (this._config.replanOnStall <= 0) return null;
    if (this._consecutiveFailures < this._config.replanOnStall) return null;

    return (
      `[系统提示] 你已连续 ${this._consecutiveFailures} 次操作失败。` +
      '当前计划可能需要调整。请重新规划（输出 plan_update）以修复问题。'
    );
  }

  /**
   * 检测是否需要 exploration nudge
   * 当没有计划且步数 ≥ 阈值时触发
   */
  getExplorationNudge(): string | null {
    if (!this._config.enabled) return null;
    if (this.hasPlan) return null;
    if (this._config.explorationLimit <= 0) return null;
    if (this._stepsSincePlan < this._config.explorationLimit) return null;

    return (
      `[系统提示] 你已经执行了 ${this._stepsSincePlan} 步但没有创建计划。` +
      '如果任务复杂，请输出 plan_update 列出待办步骤。如果任务已基本完成，请直接调用 task_done。'
    );
  }

  // ── 渲染 ──

  /**
   * 渲染计划文本（用于注入 LLM prompt）
   * 返回形如:
   *   [x] 0: 搜索内容
   *   [>] 1: 点击结果
   *   [ ] 2: 提取信息
   */
  render(): string | null {
    if (this._plan.length === 0) return null;

    const markers: Record<PlanItemStatus, string> = {
      done: '[x]',
      current: '[>]',
      pending: '[ ]',
      skipped: '[-]',
    };

    const lines = ['📋 当前计划:'];
    for (let i = 0; i < this._plan.length; i++) {
      const marker = markers[this._plan[i].status] || '[ ]';
      lines.push(`  ${marker} ${i}: ${this._plan[i].text}`);
    }

    return lines.join('\n');
  }

  /** 获取当前快照（调试用） */
  getSnapshot(): PlanSnapshot {
    const rendered = this.render();
    const total = this._plan.length;
    const current = this._currentIndex;

    return {
      rendered: rendered ?? '（无计划）',
      hasPlan: this.hasPlan,
      currentIndex: current,
      totalSteps: total,
      progress: total > 0 ? Math.round((current / total) * 100) : 0,
    };
  }

  /** 调试状态 */
  get status(): string {
    if (!this.hasPlan) return `no-plan (stepsSincePlan=${this._stepsSincePlan})`;
    const p = this._plan;
    return `plan=${p.length}step ` +
      `at=${this._currentIndex}/${p.length - 1} ` +
      `done=${p.filter(i => i.status === 'done').length} ` +
      `fail=${this._consecutiveFailures}`;
  }
}
