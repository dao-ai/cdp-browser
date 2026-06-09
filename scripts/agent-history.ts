/**
 * Agent History — 结构化操作历史记录
 *
 * 追踪 Agent 的每一步操作：LLM 决策、执行结果、页面快照。
 * 支持失败回溯、历史索引、导出报告。
 *
 * 用法:
 *   const history = new AgentHistory();
 *   history.recordStep({
 *     action: { name: 'click_element', args: { index: 3 } },
 *     llmReasoning: '需要点击搜索按钮',
 *     state: domState,
 *     success: true,
 *   });
 *   console.log(history.summary());
 */

import type { DomState } from './dom-service';

// ─── 类型定义 ──────────────────────────────────────────────

export interface AgentAction {
  /** 动作名称（对应 Action Registry 中的注册名） */
  name: string;
  /** 动作参数 */
  args: Record<string, any>;
  /** LLM 的思考过程（为什么执行这个动作） */
  reasoning?: string;
}

export interface AgentStepResult {
  /** 执行是否成功 */
  success: boolean;
  /** 错误信息（如果失败） */
  error?: string;
  /** 执行输出（文本/数据） */
  output?: string;
}

export interface AgentStep {
  /** 步数编号 */
  stepNumber: number;
  /** LLM 决策的动作 */
  action: AgentAction;
  /** 执行结果 */
  result: AgentStepResult;
  /** 执行前的页面状态 */
  stateBefore?: DomState;
  /** 执行后的页面状态 */
  stateAfter?: DomState;
  /** 页面截图（base64） */
  screenshotBefore?: string;
  screenshotAfter?: string;
  /** 时间戳 */
  timestamp: number;
  /** 耗时 (ms) */
  durationMs?: number;
  /** LLM token 使用 */
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  /** 下一步目标（LLM 判断） */
  nextGoal?: string;
  /** 任务是否已完成 */
  taskComplete?: boolean;
}

// ─── Agent History ─────────────────────────────────────────

export class AgentHistory {
  private _steps: AgentStep[] = [];
  private _maxSteps = 200;

  constructor(maxSteps = 200) {
    this._maxSteps = maxSteps;
  }

  /** 记录一步操作 */
  recordStep(step: Omit<AgentStep, 'stepNumber' | 'timestamp'>): AgentStep {
    const full: AgentStep = {
      ...step,
      stepNumber: this._steps.length + 1,
      timestamp: Date.now(),
    };
    this._steps.push(full);
    // 限制历史长度
    if (this._steps.length > this._maxSteps) {
      this._steps = this._steps.slice(-this._maxSteps);
    }
    return full;
  }

  /** 获取所有步骤 */
  get steps(): readonly AgentStep[] {
    return this._steps;
  }

  /** 获取最后 N 步 */
  last(n = 5): AgentStep[] {
    return this._steps.slice(-n);
  }

  /** 获取最近一步 */
  get lastStep(): AgentStep | undefined {
    return this._steps[this._steps.length - 1];
  }

  /** 获取第 n 步 */
  getStep(index: number): AgentStep | undefined {
    return this._steps[index - 1];
  }

  /** 成功步数 */
  get successCount(): number {
    return this._steps.filter(s => s.result.success).length;
  }

  /** 失败步数 */
  get failureCount(): number {
    return this._steps.filter(s => !s.result.success).length;
  }

  /** 总步数 */
  get totalSteps(): number {
    return this._steps.length;
  }

  /** 最近一次失败的步骤 */
  get lastFailure(): AgentStep | undefined {
    return [...this._steps].reverse().find(s => !s.result.success);
  }

  /** 是否发生连续失败 */
  hasConsecutiveFailures(count = 3): boolean {
    if (this._steps.length < count) return false;
    return this._steps.slice(-count).every(s => !s.result.success);
  }

  /** 清空历史 */
  clear() {
    this._steps = [];
  }

  /** 获取执行摘要（用于 LLM 上下文） */
  summary(maxSteps = 10): string {
    const steps = this._steps.slice(-maxSteps);
    if (steps.length === 0) return '（暂无操作历史）';

    const lines: string[] = [];
    lines.push(`📋 操作历史（最近 ${steps.length} 步，共 ${this._steps.length} 步）:`);
    lines.push('');

    for (const step of steps) {
      const icon = step.result.success ? '✅' : '❌';
      const dur = step.durationMs ? ` (${step.durationMs}ms)` : '';
      lines.push(`  ${icon} ${step.action.name}(${JSON.stringify(step.action.args)})${dur}`);
      if (step.action.reasoning) {
        lines.push(`      → ${step.action.reasoning.slice(0, 120)}`);
      }
      if (step.result.error) {
        lines.push(`      ⚠️ ${step.result.error.slice(0, 100)}`);
      }
      if (step.result.output && step.result.output.length < 200) {
        lines.push(`      📄 ${step.result.output}`);
      }
    }

    return lines.join('\n');
  }

  /** 生成详细报告 */
  fullReport(): string {
    const lines: string[] = [];
    lines.push('═'.repeat(60));
    lines.push('🤖 Browser Agent 操作报告');
    lines.push(`   总步数: ${this.totalSteps}`);
    lines.push(`   成功: ${this.successCount}`);
    lines.push(`   失败: ${this.failureCount}`);
    lines.push(`   成功率: ${this.totalSteps > 0 ? Math.round(this.successCount / this.totalSteps * 100) : 0}%`);
    lines.push('═'.repeat(60));
    lines.push('');

    for (const step of this._steps) {
      const icon = step.result.success ? '✅' : '❌';
      const date = new Date(step.timestamp);
      lines.push(`[${step.stepNumber}] ${icon} ${step.action.name} @ ${date.toLocaleTimeString()}`);
      lines.push(`  参数: ${JSON.stringify(step.action.args)}`);
      if (step.action.reasoning) lines.push(`  推理: ${step.action.reasoning}`);
      if (step.result.error) lines.push(`  错误: ${step.result.error}`);
      if (step.result.output) lines.push(`  输出: ${step.result.output.slice(0, 300)}`);
      if (step.nextGoal) lines.push(`  目标: ${step.nextGoal}`);
      if (step.durationMs) lines.push(`  耗时: ${step.durationMs}ms`);
      lines.push('');
    }

    return lines.join('\n');
  }
}

/** 最简化的 Agent 历史（内存友好） */
export class MiniAgentHistory {
  private _entries: Array<{ name: string; args: any; success: boolean; error?: string; goal?: string }> = [];
  private _max: number;

  constructor(maxEntries = 30) {
    this._max = maxEntries;
  }

  record(name: string, args: any, success: boolean, error?: string, goal?: string) {
    this._entries.push({ name, args, success, error, goal });
    if (this._entries.length > this._max) this._entries.shift();
  }

  /** 格式化为 LLM 友好的历史摘要 */
  format(): string {
    if (this._entries.length === 0) return '';
    const lines = ['操作历史:'];
    for (const e of this._entries) {
      const icon = e.success ? '✓' : '✗';
      const argStr = typeof e.args === 'object' ? JSON.stringify(e.args) : String(e.args);
      lines.push(`  ${icon} ${e.name}(${argStr})`);
      if (e.error) lines.push(`    ⚠️ ${e.error.slice(0, 80)}`);
      if (e.goal) lines.push(`    → ${e.goal}`);
    }
    return lines.join('\n');
  }
}
