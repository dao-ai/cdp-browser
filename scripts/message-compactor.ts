/**
 * MessageCompactor — 消息压缩系统
 *
 * 参考 browser-use 的 message compaction 设计：
 * - 每 N 步触发一次压缩，把旧历史替换为浓缩摘要
 * - 最近几步保留完整细节（保持上下文精度）
 * - 内置文本压缩（零依赖） + 可选 LLM 摘要增强
 *
 * 策略:
 *   简单模式: 把旧步骤合并为紧凑文本（合并连续成功、忽略成功细节）
 *   LLM 模式: 用 LLM 把旧步骤压缩为一段摘要（更智能，但多一次调用）
 *
 * 用法:
 *   const compactor = new MessageCompactor({ compactEveryNSteps: 15 });
 *   const { compacted, recentSteps } = compactor.buildContext(agentHistory, llmClient);
 *   // compacted ← "紧凑历史" + "最近 N 步详情"
 */

import type { AgentStep } from './agent-history';
import type { LlmClient } from './llm-client';

// ─── 配置 ──────────────────────────────────────────────────

export interface CompactionSettings {
  /** 每隔多少步触发压缩（默认 15） */
  compactEveryNSteps?: number;
  /** 压缩后保留多少步的完整细节（默认 8） */
  keepRecentSteps?: number;
  /** 压缩摘要最大字符数（默认 2000） */
  summaryMaxChars?: number;
  /** 使用 LLM 进行智能摘要（默认 false，用简单文本压缩） */
  useLlm?: boolean;
}

const DEFAULT_SETTINGS: Required<CompactionSettings> = {
  compactEveryNSteps: 15,
  keepRecentSteps: 8,
  summaryMaxChars: 2000,
  useLlm: false,
};

// ─── 压缩输出 ──────────────────────────────────────────────

export interface CompactionContext {
  /** 压缩后的历史文本（步骤 1 到 N-keepRecentSteps 的压缩摘要） */
  compactedHistory: string;
  /** 最近 keepRecentSteps 步的完整详情 */
  recentSteps: string;
  /** 是否执行了压缩 */
  didCompact: boolean;
  /** 距上次压缩的步数 */
  stepsSinceCompact: number;
}

// ─── MessageCompactor ──────────────────────────────────────

export class MessageCompactor {
  private _settings: Required<CompactionSettings>;
  /** 上次压缩时的总步数 */
  private _lastCompactedStepCount = 0;
  /** 上次压缩的 LLM 摘要（缓存，下次可以追加） */
  private _cachedSummary = '';

  constructor(settings?: CompactionSettings) {
    this._settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  /** 重置压缩状态（用于新任务） */
  reset(): void {
    this._lastCompactedStepCount = 0;
    this._cachedSummary = '';
  }

  /** 获取压缩设置 */
  get settings(): Required<CompactionSettings> {
    return this._settings;
  }

  /** 更新压缩设置 */
  updateSettings(settings: Partial<CompactionSettings>): void {
    Object.assign(this._settings, settings);
  }

  /** 是否需要触发压缩 */
  needsCompaction(totalSteps: number): boolean {
    const stepDiff = totalSteps - this._lastCompactedStepCount;
    return stepDiff >= this._settings.compactEveryNSteps && totalSteps > this._settings.keepRecentSteps;
  }

  /** 构建 LLM 上下文（含压缩 + 最近步骤） */
  async buildContext(
    steps: readonly AgentStep[],
    llm?: LlmClient,
  ): Promise<CompactionContext> {
    const totalSteps = steps.length;
    const keepRecent = this._settings.keepRecentSteps;
    const shouldCompact = this.needsCompaction(totalSteps);

    let compactedHistory = this._cachedSummary;
    let stepsSinceCompact = totalSteps - this._lastCompactedStepCount;

    if (shouldCompact && totalSteps > keepRecent) {
      // 需要压缩的旧步骤: 从上次压缩点到现在 减去 保留的最近步骤
      const compactStart = this._lastCompactedStepCount;
      const compactEnd = totalSteps - keepRecent;

      if (compactEnd > compactStart) {
        const oldSteps = steps.slice(compactStart, compactEnd);

        if (this._settings.useLlm && llm) {
          // LLM 模式：智能摘要
          const newSummary = await this._llmCompact(oldSteps, llm);
          if (this._cachedSummary) {
            this._cachedSummary = this._cachedSummary + '\n' + newSummary;
          } else {
            this._cachedSummary = newSummary;
          }
        } else {
          // 简单模式：文本压缩
          const compressed = this._simpleCompact(oldSteps);
          if (this._cachedSummary) {
            this._cachedSummary = this._cachedSummary + '\n' + compressed;
          } else {
            this._cachedSummary = compressed;
          }
        }

        // 截断摘要到最大字符数
        if (this._cachedSummary.length > this._settings.summaryMaxChars) {
          this._cachedSummary = this._cachedSummary.slice(0, this._settings.summaryMaxChars) +
            `\n...（摘要截断，共 ${steps.slice(0, compactEnd).length} 步已处理）`;
        }

        compactedHistory = this._cachedSummary;
        this._lastCompactedStepCount = compactEnd;
        stepsSinceCompact = totalSteps - compactEnd;
      }
    }

    // 最近 N 步完整详情
    const recentSteps = this._formatRecentSteps(steps.slice(-keepRecent), totalSteps);

    return {
      compactedHistory,
      recentSteps,
      didCompact: shouldCompact,
      stepsSinceCompact,
    };
  }

  /**
   * 直接获取紧凑后的上下文文本（最常用的入口）
   * 返回用于 LLM prompt 的历史文本字符串
   */
  async getContextText(
    steps: readonly AgentStep[],
    llm?: LlmClient,
  ): Promise<string> {
    const ctx = await this.buildContext(steps, llm);
    const parts: string[] = [];

    if (ctx.compactedHistory) {
      parts.push(ctx.compactedHistory);
    }

    if (ctx.recentSteps) {
      parts.push(ctx.recentSteps);
    }

    return parts.join('\n\n');
  }

  // ── 简单文本压缩 ──

  private _simpleCompact(steps: AgentStep[]): string {
    const lines: string[] = [];
    const startStep = steps[0]?.stepNumber ?? 1;

    lines.push(`📋 压缩摘要（步骤 ${startStep}-${startStep + steps.length - 1}）:`);

    // 按动作名分组连续相同的动作
    const groups: { name: string; count: number; steps: AgentStep[] }[] = [];
    for (const step of steps) {
      const last = groups[groups.length - 1];
      if (last && last.name === step.action.name) {
        last.count++;
        last.steps.push(step);
      } else {
        groups.push({ name: step.action.name, count: 1, steps: [step] });
      }
    }

    for (const group of groups) {
      const stepNums = group.steps.length === 1
        ? `#${group.steps[0].stepNumber}`
        : `#${group.steps[0].stepNumber}-#${group.steps[group.steps.length - 1].stepNumber}`;

      const allSuccess = group.steps.every(s => s.result.success);
      const icon = allSuccess ? '✅' : '❌';
      const failCount = group.steps.filter(s => !s.result.success).length;

      // 根据动作类型生成不同粒度的摘要
      let desc = this._summarizeActionGroup(group);
      if (group.count > 1 && allSuccess) {
        lines.push(`  ${icon} ${stepNums}: ${desc} (×${group.count})`);
      } else {
        lines.push(`  ${icon} ${stepNums}: ${desc}`);
        if (failCount > 0) {
          for (const s of group.steps.filter(st => !st.result.success)) {
            if (s.result.error) {
              lines.push(`      ⚠️ ${s.result.error.slice(0, 80)}`);
            }
          }
        }
      }
    }

    return lines.join('\n');
  }

  private _summarizeActionGroup(group: { name: string; count: number; steps: AgentStep[] }): string {
    const { name, steps } = group;
    const first = steps[0];

    switch (name) {
      case 'scroll_down':
      case 'scroll_up':
        return '滚动页面';

      case 'wait':
        return '等待页面';

      case 'get_page_text':
      case 'read_text':
      case 'get_dom_state':
        return '读取页面内容';

      case 'navigate':
      case 'go_back':
        return first.action.args?.url
          ? `导航到 ${first.action.args.url.slice(0, 60)}`
          : '页面导航';

      case 'click_element': {
        const idx = first.action.args?.index;
        const goal = first.nextGoal;
        const reason = first.action.reasoning?.slice(0, 40);
        return `点击元素 #${idx ?? '?'}${goal ? ` (${goal})` : reason ? ` (${reason})` : ''}`;
      }

      case 'type_text':
        return `输入 ${JSON.stringify(first.action.args?.text ?? '').slice(0, 50)}`;

      case 'press_enter':
        return '按回车键';

      case 'task_done':
        return '任务完成 ✨';

      default:
        return `${name}(${JSON.stringify(first.action.args ?? {}).slice(0, 40)})`;
    }
  }

  // ── LLM 智能压缩 ──

  private async _llmCompact(steps: AgentStep[], llm: LlmClient): Promise<string> {
    try {
      // 构建步骤文本（简化版）
      const stepTexts = steps.map(s =>
        `[步骤 ${s.stepNumber}] 动作: ${s.action.name}(${JSON.stringify(s.action.args)}) ` +
        `${s.result.success ? '成功' : '失败'} ` +
        `${s.action.reasoning ? '原因: ' + s.action.reasoning.slice(0, 80) : ''}` +
        `${s.nextGoal ? '目标: ' + s.nextGoal.slice(0, 60) : ''}`
      ).join('\n');

      const prompt = `以下是一组浏览器自动化的操作步骤。请将其压缩为一段简洁的摘要（中文，不超过 300 字），保留关键决策和失败信息：

${stepTexts}

压缩摘要：`;

      const response = await llm.chat([
        { role: 'system', content: '你是浏览器自动化操作的摘要生成器。用简洁的中文保留关键决策、失败事件和页面变更。不要添加原始数据中没有的信息。' },
        { role: 'user', content: prompt },
      ], { temperature: 0.1, maxTokens: 500 });

      let summary = response.content.trim();
      if (summary.length > 800) {
        summary = summary.slice(0, 800) + '...';
      }
      return `📋 LLM 摘要: ${summary}`;
    } catch (err: any) {
      // LLM 失败时回退到简单压缩
      console.warn(`[MessageCompactor] LLM 压缩失败，回退到简单模式: ${err.message}`);
      return this._simpleCompact(steps);
    }
  }

  // ── 最近步骤格式化 ──

  private _formatRecentSteps(steps: AgentStep[], totalSteps: number): string {
    if (steps.length === 0) return '';

    const lines: string[] = [];

    // 只显示分组后的摘要
    lines.push(`📋 最近 ${steps.length} 步详情:`);

    for (const step of steps) {
      const icon = step.result.success ? '✅' : '❌';
      const dur = step.durationMs ? ` ${step.durationMs}ms` : '';

      let argsStr: string;
      switch (step.action.name) {
        case 'navigate':
          argsStr = step.action.args?.url ? step.action.args.url.slice(0, 80) : '';
          break;
        case 'type_text':
          argsStr = `"${(step.action.args?.text ?? '').slice(0, 40)}"`;
          break;
        case 'click_element':
          argsStr = `#${step.action.args?.index ?? '?'}`;
          break;
        default:
          argsStr = JSON.stringify(step.action.args ?? {}).slice(0, 60);
      }

      lines.push(`  ${icon} #${step.stepNumber} ${step.action.name}(${argsStr})${dur}`);

      if (!step.result.success && step.result.error) {
        lines.push(`      ⚠️ ${step.result.error.slice(0, 100)}`);
      } else if (step.result.output && step.result.output.length < 200 && step.action.name !== 'get_page_text' && step.action.name !== 'extract_site_content') {
        lines.push(`      → ${step.result.output}`);
      }
    }

    return lines.join('\n');
  }

  /** 获取压缩状态摘要（用于调试） */
  get status(): string {
    return `compactedSteps=${this._lastCompactedStepCount} ` +
      `every=${this._settings.compactEveryNSteps} ` +
      `keep=${this._settings.keepRecentSteps} ` +
      `cacheLen=${this._cachedSummary.length}`;
  }
}
