/**
 * Agent Prompts — LLM 系统提示词模板
 *
 * 告诉 LLM 怎么用浏览器、有哪些动作可用、怎么判断任务完成。
 * 参考 browser-use 的 prompts.py 设计，但适配中文场景。
 *
 * 用法:
 *   const prompt = AgentPrompts.build({
 *     task: '搜索减脂餐',
 *     availableActions: registry.describe(),
 *   });
 *   messages.push({ role: 'system', content: prompt.system });
 *   messages.push({ role: 'user', content: prompt.user });
 */

import type { DomState } from './dom-service';
import type { ActionEntry } from './action-registry';

// ─── 提示词构建选项 ────────────────────────────────────────

export interface AgentPromptOptions {
  /** 用户任务描述 */
  task: string;
  /** 可用动作列表 */
  availableActions: ActionEntry[];
  /** 额外的上下文约束 */
  constraints?: string[];
  /** 语言模式（默认中文） */
  language?: 'zh' | 'en';
}

// ─── 提示词构建 ────────────────────────────────────────────

export class AgentPrompts {
  /**
   * 构建完整的提示词消息列表
   * 返回 [system, user] 两条消息
   */
  static build(opts: AgentPromptOptions): { system: string; user: string } {
    return {
      system: AgentPrompts._systemPrompt(opts),
      user: AgentPrompts._userPrompt(opts),
    };
  }

  /**
   * 构建下一步决策的提示词
   * 结合当前状态和历史
   */
  static buildNextStep(
    task: string,
    state: DomState,
    history: string,
    availableActions: ActionEntry[],
    filteredActionCount?: number,
  ): { system: string; user: string } {
    const sys = AgentPrompts._systemPrompt({ task, availableActions });

    const userLines: string[] = [];
    userLines.push(`🎯 当前任务: ${task}`);
    userLines.push('');

    // 当前状态
    userLines.push('📍 当前页面状态:');
    userLines.push(`  URL: ${state.url}`);
    userLines.push(`  标题: ${state.title}`);
    userLines.push('');

    userLines.push('📋 页面元素:');
    for (const el of state.elements.slice(0, 40)) {
      const pos = el.box ? ` [${el.box.x},${el.box.y},${el.box.width}x${el.box.height}]` : '';
      const label = el.text || el.ariaLabel || el.placeholder || '';
      const extra = el.href ? ` → ${el.href}` : '';
      const disabled = el.disabled ? ' [禁用]' : '';
      userLines.push(`  [${el.index}] <${el.tag}>${pos} ${label}${extra}${disabled}`);
    }
    userLines.push('');

    // 历史
    if (history) {
      userLines.push(history);
      userLines.push('');
    }

    userLines.push('请分析当前状态，然后用以下 JSON 格式告知我下一步操作：');
    userLines.push('```json');
    userLines.push('{');
    userLines.push('  "reasoning": "简要说明你想做什么以及为什么",');
    userLines.push('  "action": {"name": "动作名", "args": {...}},  // 单动作模式');
    userLines.push('  // 或者 actions: [{"name":..., "args":...}, {...}]  // 多动作队列');
    userLines.push('  // 注意：标记了 [⛔ 截断后续] 的动作会中断队列，请放在最后');
    userLines.push('  "nextGoal": "下一步的目标",');
    userLines.push('  "taskComplete": false  // 如果任务完成设为 true');
    userLines.push('}');
    userLines.push('```');

    // 提示被过滤的动作（如果有）
    if (filteredActionCount && filteredActionCount > 0) {
      userLines.push('');
      userLines.push(`💡 ${filteredActionCount} 个动作在当前站点不可用（已自动过滤）`);
    }

    return { system: sys, user: userLines.join('\n') };
  }

  // ── 系统提示词 ──

  private static _systemPrompt(opts: AgentPromptOptions): string {
    const isZh = opts.language !== 'en';
    const lines: string[] = [];

    if (isZh) {
      lines.push('# 角色');
      lines.push('你是一个浏览器操作 AI 助手。你可以通过一系列动作来操控浏览器，完成用户交给你的任务。');
      lines.push('');
      lines.push('# 能力');
      lines.push('- 你可以看到当前页面的所有可交互元素（按钮、链接、输入框、图片等）');
      lines.push('- 你可以执行点击、输入文字、滚动、导航等操作');
      lines.push('- 你可以读取页面文本内容');
      lines.push('- 你可以等待页面加载完成');
      lines.push('');
      lines.push('# 可用动作');
      lines.push(this._formatActions(opts.availableActions));
      lines.push('');
      lines.push('# 规则');
      lines.push('1. 每一步可以执行一个或多个动作（通过 actions 数组）');
      lines.push('2. 标有 [⛔ 截断后续] 的动作会中断后续队列，请放最后');
      lines.push('3. 如果点击后页面发生变化，先观察新状态');
      lines.push('4. 如果重复同一动作 3 次仍未成功，尝试换一种方法');
      lines.push('5. 任务完成时设置 taskComplete: true');
      lines.push('6. extract_site_content 或 get_page_text 成功获取数据后，' +
        '立即调用 task_done 汇报结果。不要继续滚动或重复提取。');
      lines.push('7. 如果页面状态与上一步相同且你已读过内容，' +
        '说明操作没有产生新信息，应立即 task_done 而不是继续无效操作。');
      lines.push('');
      lines.push('💡 部分动作只在特定站点可用（如 google_search 仅在 Google），其他站点自动隐藏。');
      if (opts.constraints?.length) {
        lines.push('');
        lines.push('# 额外约束');
        for (const c of opts.constraints) lines.push(`- ${c}`);
      }
    } else {
      lines.push('# Role');
      lines.push('You are a browser automation AI agent. You control the browser through actions.');
      lines.push('');
      lines.push('# Available Actions');
      lines.push(this._formatActions(opts.availableActions));
      lines.push('');
      lines.push('# Rules');
      lines.push('1. You can execute multiple actions per step via `actions` array');
      lines.push('2. Actions marked [⛔ terminates] will truncate the queue — put them last');
      lines.push('3. Wait for page changes before deciding next action');
      lines.push('4. If same action fails 3 times, try a different approach');
      lines.push('5. Set taskComplete: true when done');
      lines.push('6. Once extract_site_content or get_page_text returns data, ' +
        'call task_done immediately. Do NOT keep scrolling or re-extracting.');
      lines.push('7. If the page state is identical to the previous step and you already read the content, ' +
        'stop wasting steps — call task_done now.');
      lines.push('');
      lines.push('💡 Some actions are domain-filtered (e.g. google_search only shows on Google).');
    }

    return lines.join('\n');
  }

  // ── 用户提示词 ──

  private static _userPrompt(opts: AgentPromptOptions): string {
    const isZh = opts.language !== 'en';
    const lines: string[] = [];

    if (isZh) {
      lines.push(`🎯 任务: ${opts.task}`);
      lines.push('');
      lines.push('请开始执行。每一步分析当前页面状态后，用以下 JSON 格式告诉我下一步操作：');
      lines.push('');
      lines.push('```json');
      lines.push('{');
      lines.push('  "reasoning": "你观察到了什么？为什么执行这个动作？",');
      lines.push('  "action": {"name": "动作名", "args": {...}},');
      lines.push('  "nextGoal": "下一步目标是什么",');
      lines.push('  "taskComplete": false');
      lines.push('}');
      lines.push('```');
    } else {
      lines.push(`Task: ${opts.task}`);
      lines.push('');
      lines.push('Analyze the page and respond with JSON:');
      lines.push('{ "reasoning": "...", "action": {"name": "...", "args": {...}}, "nextGoal": "...", "taskComplete": false }');
    }

    return lines.join('\n');
  }

  // ── 格式化动作列表 ──

  private static _formatActions(actions: ActionEntry[]): string {
    if (!actions.length) return '  （暂无可用动作）';
    return actions.map(a => {
      const desc = a.description ? ` — ${a.description}` : '';
      const params = a.parameters?.length
        ? `\n    参数: ${a.parameters.map(p => `${p.name} (${p.type})`).join(', ')}`
        : '';
      const domain = a.domains?.length
        ? `\n    可用站点: ${a.domains.join(', ')}`
        : '';
      const terminating = a.terminatesSequence ? ` [⛔ 截断后续]` : '';
      return `  - ${a.name}${terminating}${desc}${params}${domain}`;
    }).join('\n');
  }
}
