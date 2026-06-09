/**
 * Browser Agent — AI 驱动的浏览器操作主循环
 *
 * 核心流程:
 *   1. 用户给任务（自然语言）
 *   2. LLM 分析当前页面状态（文本 + 可选截图）
 *   3. LLM 决定下一步动作
 *   4. 执行动作（点击/输入/滚动等），失败自动重试
 *   5. 记录结果
 *   6. 回到 2，直到任务完成
 *
 * 用法:
 *   const agent = new BrowserAgent(page, { apiKey: 'sk-xxx' });
 *   const result = await agent.run('帮我搜一下减脂餐', {
 *     startUrl: 'https://www.xiaohongshu.com',
 *   });
 *   console.log(result.finalOutput);
 */

import type { CdpPage } from './cdp-client';
import { LlmClient, type LlmClientConfig, type LlmMessage } from './llm-client';
import { DomService, type DomState } from './dom-service';
import { ActionRegistry, type ActionResult } from './action-registry';
import { AgentHistory, MiniAgentHistory } from './agent-history';
import { AgentPrompts } from './agent-prompts';
import { MessageCompactor, type CompactionSettings } from './message-compactor';
import { LoopDetector, type LoopDetectorConfig } from './loop-detector';
import { PlanningSystem, type PlanningConfig } from './planning-system';
import { extractJson, isValidAgentDecision, buildAgentOutputJsonSchema } from './json-extractor';
import type { LlmChatResponseFormat } from './llm-client';
import type { WatchdogSet } from './watchdog/setup';

// ─── 类型定义 ──────────────────────────────────────────────

export interface AgentConfig {
  /** LLM 配置（传给 LlmClient） */
  llm?: LlmClientConfig;
  /** 最大步骤数（默认 30） */
  maxSteps?: number;
  /** 连续失败最大次数后自动终止（默认 5） */
  maxConsecutiveFailures?: number;
  /** 是否输出详细日志到控制台（默认 true） */
  verbose?: boolean;
  /** 页面加载超时 (ms)（默认 30s） */
  pageLoadTimeoutMs?: number;
  /** 每次 LLM 调用后等待 (ms) */
  postActionDelayMs?: number;
  /** 动作失败时自动重试次数（默认 2） */
  actionRetryCount?: number;
  /** 失败时是否截图给 LLM（默认 true） */
  screenshotOnFailure?: boolean;
  /** 是否启用多模态截图（默认 true，传给 LLM 视觉理解） */
  enableVision?: boolean;
  /** 多模态截图间隔（每隔 N 步截图一次，默认 5, 0=禁用） */
  visionCaptureInterval?: number;
}

export interface AgentRunOptions {
  /** 起始 URL（可选，不传则从当前页面开始） */
  startUrl?: string;
  /** 额外的系统级约束 */
  constraints?: string[];
  /** 自定义动作注册表（默认内置所有基础动作） */
  registry?: ActionRegistry;
  /** 任务语言 */
  language?: 'zh' | 'en';
  /** 额外的 LLM 系统提示 */
  extraSystemPrompt?: string;
  /** 使用 API 结构化输出（OpenAI 兼容 API 的 response_format） */
  useStructuredOutput?: boolean;
  /** Watchdog 集合（自动处理弹窗/崩溃/验证码） */
  watchdogs?: WatchdogSet;
}

export interface AgentActionItem {
  name: string;
  args: Record<string, any>;
}

export interface AgentStepDecision {
  reasoning: string;
  /** 单动作（向后兼容） */
  action: AgentActionItem;
  /** 多动作 — 如果提供，会用 multiExecute 依次执行，terminatesSequence 会截断后续 */
  actions?: AgentActionItem[];
  nextGoal: string;
  taskComplete: boolean;
  /** 新计划步骤列表（LLM 输出的 plan_update） */
  planUpdate?: string[];
  /** 当前执行步骤的索引（LLM 输出的 current_plan_item） */
  currentPlanItem?: number;
}

export interface AgentResult {
  /** 是否成功 */
  success: boolean;
  /** 最终输出文本 */
  finalOutput: string;
  /** 总步数 */
  totalSteps: number;
  /** 成功步数 */
  successSteps: number;
  /** 失败步数 */
  failedSteps: number;
  /** 结束原因 */
  endReason: 'completed' | 'max_steps' | 'max_failures' | 'error' | 'cancelled';
  /** 完整操作历史 */
  history: AgentHistory;
  /** 最终页面 URL */
  finalUrl?: string;
  /** 最终页面标题 */
  finalTitle?: string;
}

// ─── 默认配置 ──────────────────────────────────────────────

const DEFAULTS = {
  maxSteps: 30,
  maxConsecutiveFailures: 5,
  verbose: true,
  pageLoadTimeoutMs: 30_000,
  postActionDelayMs: 500,
  actionRetryCount: 2,
  screenshotOnFailure: true,
  enableVision: true,
  visionCaptureInterval: 5,
};

// ─── Agent ─────────────────────────────────────────────────

export class BrowserAgent {
  private _page: CdpPage;
  private _llm: LlmClient;
  private _history: AgentHistory;
  private _config: Required<AgentConfig>;
  private _domService: DomService;
  private _watchdogs?: WatchdogSet;
  private _planner: PlanningSystem | null = null;
  private _loopDetector: LoopDetector | null = null;
  private _compactor: MessageCompactor | null = null;

  constructor(page: CdpPage, config?: AgentConfig) {
    this._page = page;
    this._llm = new LlmClient(config?.llm);
    this._history = new AgentHistory();
    this._domService = new DomService(page, { maxTextPreview: 2000, maxElements: 80 });

    // 规划系统（默认启用）
    this._planner = new PlanningSystem({ replanOnStall: 3, explorationLimit: 5 });

    // 循环检测（默认启用）
    this._loopDetector = new LoopDetector({ windowSize: 20 });

    // 消息压缩（默认启用，每 15 步压缩一次）
    this._compactor = new MessageCompactor({ compactEveryNSteps: 15, keepRecentSteps: 8 });

    this._config = {
      llm: config?.llm ?? {},
      maxSteps: config?.maxSteps ?? DEFAULTS.maxSteps,
      maxConsecutiveFailures: config?.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures,
      verbose: config?.verbose ?? DEFAULTS.verbose,
      pageLoadTimeoutMs: config?.pageLoadTimeoutMs ?? DEFAULTS.pageLoadTimeoutMs,
      postActionDelayMs: config?.postActionDelayMs ?? DEFAULTS.postActionDelayMs,
      actionRetryCount: config?.actionRetryCount ?? DEFAULTS.actionRetryCount,
      screenshotOnFailure: config?.screenshotOnFailure ?? DEFAULTS.screenshotOnFailure,
      enableVision: config?.enableVision ?? DEFAULTS.enableVision,
      visionCaptureInterval: config?.visionCaptureInterval ?? DEFAULTS.visionCaptureInterval,
    };
  }

  /** 获取操作历史 */
  get history(): AgentHistory { return this._history; }

  /** 获取 LLM 客户端（可用于测试连接） */
  get llm(): LlmClient { return this._llm; }

  /** 获取 Watchdog 集合 */
  get watchdogs(): WatchdogSet | undefined { return this._watchdogs; }

  /** 获取消息压缩器 */
  get compactor(): MessageCompactor | null { return this._compactor; }

  /** 获取循环检测器 */
  get loopDetector(): LoopDetector | null { return this._loopDetector; }

  /** 获取规划系统 */
  get planner(): PlanningSystem | null { return this._planner; }

  /** 运行时调整压缩设置（传 false 禁用，传对象更新配置） */
  setCompaction(settings: CompactionSettings | false): void {
    if (settings === false) {
      this._compactor = null;
    } else if (this._compactor) {
      this._compactor.updateSettings(settings);
    } else {
      this._compactor = new MessageCompactor(settings);
    }
  }

  /**
   * 执行任务 — 主入口
   */
  async run(task: string, opts: AgentRunOptions = {}): Promise<AgentResult> {
    const registry = opts.registry || new ActionRegistry();
    this._watchdogs = opts.watchdogs;

    // 新任务重置压缩器
    if (this._compactor) {
      this._compactor.reset();
    }

    const startTime = Date.now();
    let lastScreenshotStep = 0; // 上次截图步骤

    this._log(`🤖 开始执行任务: ${task}`);

    // 1. 导航到起始页
    if (opts.startUrl) {
      try {
        await this._page.goto(opts.startUrl, { timeoutMs: this._config.pageLoadTimeoutMs });
        this._log(`  📍 已导航到: ${opts.startUrl}`);
        await this._delay(1000);
      } catch (err: any) {
        this._log(`  ⚠️ 导航失败: ${err.message}`);
      }
    }

    // 2. 主循环
    let consecutiveFailures = 0;
    let llmCallCount = 0;

    // 新任务重置规划 + 循环检测
    if (this._planner) this._planner.reset();
    if (this._loopDetector) this._loopDetector.reset();

    for (let step = 1; step <= this._config.maxSteps; step++) {
      this._log(`\n─── 步骤 ${step}/${this._config.maxSteps} ───`);

      // 0. Watchdog: 检查验证码
      if (this._watchdogs?.captcha?.hasPendingCaptcha) {
        this._log('  🔒 检测到验证码，等待人工解决...');
        const resolved = await this._watchdogs.captcha.waitForResolution();
        if (!resolved) {
          this._log('  ⏰ 验证码等待超时，继续执行');
        }
      }

      // 2a. 捕获当前页面状态
      //   enableVision 开启时，每隔 visionCaptureInterval 步传截图给 LLM
      const shouldScreenshot = this._config.enableVision &&
        this._config.visionCaptureInterval > 0 &&
        (step - lastScreenshotStep >= this._config.visionCaptureInterval || step === 1);

      let state: DomState & { screenshot?: string };
      if (shouldScreenshot) {
        state = await this._captureScreenshotState();
        lastScreenshotStep = step;
        this._log(`  📸 带截图的状态捕获`);
      } else {
        state = await this._captureState();
      }

      // 2b. 如果动作执行后页面 URL/标题有变化，给等待时间
      if (step > 1) {
        await this._delay(this._config.postActionDelayMs);
      }

      // 2c. 检查消息压缩
      if (this._compactor && step > 2) {
        const shouldCompact = this._compactor.needsCompaction(this._history.totalSteps);
        if (shouldCompact) {
          this._log(`  📦 触发消息压缩 (${this._compactor.status})`);
        }
      }

      // 2d. 规划 + 页面状态记录
      if (this._planner) this._planner.tick();
      if (this._loopDetector && state.textPreview) {
        this._loopDetector.recordPageState(state.url, state.textPreview, state.elements.length);
      }

      // 2e. 检查 replan / exploration nudge
      let extraNudge = '';
      if (this._planner) {
        const replan = this._planner.getReplanNudge();
        if (replan) {
          extraNudge = replan;
          this._log(`  📋 触发 replan nudge (连续失败 ${this._planner.consecutiveFailures} 次)`);
        } else {
          const explore = this._planner.getExplorationNudge();
          if (explore) {
            extraNudge = explore;
            this._log(`  📋 触发 exploration nudge (已 ${this._planner.totalAgentSteps} 步无计划)`);
          }
        }
      }

      // 2f. 构建提示词并调用 LLM
      llmCallCount++;
      const decision = await this._getDecision(task, state, registry, opts, extraNudge);

      // 2g. 执行动作（支持多动作队列 + 自动重试）
      const actionStartTime = Date.now();
      const actionsToExecute = decision.actions && decision.actions.length > 0
        ? decision.actions
        : [decision.action];

      let multiResults: { result: ActionResult; action: AgentActionItem }[] = [];
      let truncatedBy: string | null = null;

      for (let ai = 0; ai < actionsToExecute.length; ai++) {
        const act = actionsToExecute[ai];
        const actResult = await this._executeWithRetry(registry, act.name, act.args, act);
        multiResults.push({ result: actResult, action: act });

        // 检查 terminatesSequence
        if (registry.isTerminating(act.name)) {
          if (ai < actionsToExecute.length - 1) {
            truncatedBy = act.name;
            this._log(`  ⛔ ${act.name} 终止了后续 ${actionsToExecute.length - ai - 1} 个动作`);
          }
          break;
        }
      }

      const actionDurationMs = Date.now() - actionStartTime;

      // 使用最后一个动作的结果为主结果（向后兼容）
      const lastResult = multiResults[multiResults.length - 1];
      const actionResult = lastResult.result;
      const executedAction = lastResult.action;

      // 2h. 记录历史（用实际执行的首个动作）
      const firstExecuted = multiResults[0]?.action || executedAction;
      this._history.recordStep({
        action: {
          name: firstExecuted.name,
          args: firstExecuted.args,
          reasoning: decision.reasoning,
        },
        result: {
          success: actionResult.success,
          error: actionResult.error,
          output: actionResult.message || actionResult.data,
        },
        stateBefore: state,
        nextGoal: decision.nextGoal,
        taskComplete: decision.taskComplete,
        durationMs: actionDurationMs,
      });

      // 2i. 应用 LLM 的计划更新 + 记录成功/失败
      if (this._planner) {
        if (decision.planUpdate) {
          this._planner.applyPlanUpdate(decision.planUpdate);
          this._log(`  📋 新计划: ${decision.planUpdate.join(' → ')}`);
        } else if (decision.currentPlanItem !== undefined && this._planner.hasPlan) {
          this._planner.advancePlan(decision.currentPlanItem);
        }
        if (actionResult.success) {
          this._planner.recordSuccess();
        } else {
          this._planner.recordFailure();
        }
      }

      // 2j. 记录每个已执行动作到循环检测器
      if (this._loopDetector) {
        for (const { action: act } of multiResults) {
          this._loopDetector.recordAction(act.name, act.args);
        }
      }

      // 2k. 统计失败（含重试后的最终结果）
      if (actionResult.success) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        this._log(`  ❌ 动作失败: ${actionResult.error}`);
      }

      // 2l. 检查终止条件
      // 任务完成
      if (decision.taskComplete || decision.action.name === 'task_done') {
        const finalOutput = actionResult.message || actionResult.data || '任务完成';
        this._log(`  ✅ 任务完成! ${finalOutput}`);
        return this._buildResult(true, finalOutput, 'completed', step);
      }

      // 连续失败过多
      if (consecutiveFailures >= this._config.maxConsecutiveFailures) {
        const msg = `连续 ${consecutiveFailures} 次失败，自动终止`;
        this._log(`  ⛔ ${msg}`);
        return this._buildResult(false, msg, 'max_failures', step);
      }

      // 循环检测 nudge（注入到下次 LLM 调用前，不阻塞）
      const nudge = this._loopDetector?.getNudgeMessage();
      if (nudge) {
        const shortNudge = nudge.replace('\n', ' ').slice(0, 120);
        this._log(`  🔁 ${shortNudge}...`);
      }
    }

    // 超过最大步数
    const msg = `达到最大步骤数 (${this._config.maxSteps})`;
    this._log(`  ⏰ ${msg}`);
    return this._buildResult(false, msg, 'max_steps', this._config.maxSteps);
  }

  /**
   * 执行动作并自动重试
   * 失败后截图 + 重试 + 自我修正
   */
  private async _executeWithRetry(
    registry: ActionRegistry,
    actionName: string,
    actionArgs: Record<string, any>,
    originalAction: AgentActionItem,
  ): Promise<ActionResult> {
    const maxRetries = this._config.actionRetryCount;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 重试时在参数中加入修正粒度
      let argsToUse = actionArgs;
      if (attempt > 0) {
        // 自我修正策略
        argsToUse = await this._selfCorrectArgs(actionName, actionArgs, lastError, attempt);
      }

      try {
        const result = await registry.execute(actionName, argsToUse, this._page);
        if (result.success) {
          if (attempt > 0) {
            this._log(`  🔄 重试 ${attempt}/${maxRetries} 成功: ${actionName}`);
          }
          return result;
        }
        lastError = result.error || '动作执行返回失败';
      } catch (err: any) {
        lastError = err.message;
      }

      // 失败重试
      if (attempt < maxRetries) {
        this._log(`  🔄 ${actionName} 失败（${attempt + 1}/${maxRetries} 重试）: ${lastError?.slice(0, 80)}`);

        // 截图记录失败状态（供后续步 LLM 参考）
        if (this._config.screenshotOnFailure) {
          try {
            const shot = await this._page.screenshot({});
            if (shot && shot.data) {
              this._log(`  📸 失败截图记录`);
            }
          } catch { /* 截图失败不阻塞 */ }
        }

        // 回退延时（指数退避）
        await this._delay(1000 * (attempt + 1));
      }
    }

    return {
      success: false,
      error: lastError || '所有重试均失败',
      message: `动作 ${actionName} 在 ${maxRetries} 次重试后仍然失败`,
    };
  }

  /**
   * 自我修正参数
   * 根据上一次失败的反馈调整动作参数
   */
  private async _selfCorrectArgs(
    actionName: string,
    originalArgs: Record<string, any>,
    lastError: string | undefined,
    attempt: number,
  ): Promise<Record<string, any>> {
    const args = { ...originalArgs };

    switch (actionName) {
      case 'click_element': {
        // index 不可用时尝试相邻 index
        if (lastError?.includes('not found') || lastError?.includes('index')) {
          const idx = typeof args.index === 'number' ? args.index : 0;
          // 尝试附近的元素（左右各偏移 1-3）
          const offset = attempt * 2 - 1; // 1, 3, 5
          if (offset > 0 && idx + offset < 100) args.index = idx + offset;
          else if (idx - Math.abs(offset) >= 0) args.index = idx - Math.abs(offset);
          this._log(`  🔧 自我修正: click_element #${originalArgs.index} → #${args.index}`);
        }
        break;
      }

      case 'type_text': {
        // 输入框找不到时，尝试先用 click 聚焦
        if (lastError?.includes('not found') || lastError?.includes('selector')) {
          args.clickFirst = true;
          this._log(`  🔧 自我修正: type_text 添加 clickFirst`);
        }
        break;
      }

      case 'scroll_down':
      case 'scroll_up': {
        // 滚动不动时加大滚动量
        const currentAmount = typeof args.amount === 'number' ? args.amount : 500;
        args.amount = currentAmount * 2; // 加倍
        this._log(`  🔧 自我修正: ${actionName} ${currentAmount} → ${args.amount}`);
        break;
      }

      default:
        break;
    }

    return args;
  }

  // ── 内部方法 ──

  /** 捕获当前页面状态 */
  private async _captureState(): Promise<DomState> {
    try {
      return await this._domService.capture();
    } catch (err: any) {
      this._log(`  ⚠️ DOM 捕获失败: ${err.message}`);
      return {
        url: await this._page.url().catch(() => ''),
        title: '',
        elements: [],
        textPreview: '',
        frames: [],
        capturedAt: Date.now(),
      };
    }
  }

  /** 捕获页面状态 + 截图（多模态 LLM 用） */
  private async _captureScreenshotState(): Promise<DomState & { screenshot?: string }> {
    try {
      return await this._domService.captureWithScreenshot();
    } catch (err: any) {
      this._log(`  ⚠️ 带截图的状态捕获失败: ${err.message}`);
      const state = await this._captureState();
      return { ...state, screenshot: undefined };
    }
  }

  /** 调用 LLM 获取下一步决策 */
  private async _getDecision(
    task: string,
    state: DomState & { screenshot?: string },
    registry: ActionRegistry,
    opts: AgentRunOptions,
    extraNudge: string = '',
  ): Promise<AgentStepDecision> {
    const hostname = state.url ? new URL(state.url).hostname : undefined;
    const { actions: availableActions, filteredCount } = registry.describe({
      domain: hostname,
      includeFiltered: true,
    });

    // 构建历史 — 优先用压缩器，否则用简单摘要
    let historyStr: string;
    if (this._compactor) {
      historyStr = await this._compactor.getContextText(this._history.steps, this._llm);
      if (this._compactor.needsCompaction(this._history.totalSteps)) {
        this._log(`  📦 距上次压缩 ${this._history.totalSteps - (this._compactor as any)._lastCompactedStepCount} 步`);
      }
    } else {
      historyStr = this._history.summary(8);
    }

    // 循环检测 + 规划 nudge — 注入到 user message 末尾
    let nudgeMsg = '';
    if (this._loopDetector) {
      const nudge = this._loopDetector.getNudgeMessage();
      if (nudge) {
        nudgeMsg = '\n\n[系统提示] ' + nudge;
        this._log(`  🔁 注入循环检测提示`);
      }
    }
    if (extraNudge) {
      nudgeMsg = nudgeMsg + '\n\n' + extraNudge;
    }

    // 规划系统：当前计划显示
    let planText = '';
    if (this._planner && this._planner.hasPlan) {
      const rendered = this._planner.render();
      if (rendered) {
        planText = '\n\n' + rendered;
      }
    }

    const { system, user } = AgentPrompts.buildNextStep(task, state, historyStr, availableActions, filteredCount);

    // 拼进 extra system prompt + 计划 + nudge
    let extraContent = opts.extraSystemPrompt ? '\n' + opts.extraSystemPrompt : '';

    // 告诉 LLM 支持多动作、plan_update 和 terminatesSequence
    extraContent += '\n\n[输出格式说明] 你可以在 JSON 中输出 `actions`（动作数组）来一次执行多个动作，' +
      '动作将按顺序执行。像 navigate 和 task_done 这样的动作会中断后续动作（页面状态已变），' +
      '所以把它们放在队列末尾。也可以只输出单个 `action`（向后兼容）。' +
      '支持 `planUpdate`（字符串数组）创建/更新计划，`currentPlanItem`（数字）指示当前计划步骤。';

    const userContent = user + planText + nudgeMsg;
    const messages: LlmMessage[] = [
      { role: 'system', content: system + extraContent },
      { role: 'user', content: userContent },
    ];

    // 调用 LLM（带截图）
    const chatOpts: Record<string, any> = { temperature: 0.1 };
    if (opts.useStructuredOutput) {
      chatOpts.responseFormat = { type: 'json_object' };
    }
    // 如果有多模态截图，传给 LLM
    if (state.screenshot) {
      chatOpts.images = [state.screenshot];
      this._log(`  📸 附带截图（${Math.round(state.screenshot.length / 1024)}KB）给 LLM`);
    }

    const response = await this._llm.chat(messages, chatOpts);

    this._log(`  🤔 LLM 回复: ${response.content.slice(0, 200)}...`);

    if (response.usage) {
      this._log(`  📊 Tokens: ${response.usage.promptTokens} prompt + ${response.usage.completionTokens} completion`);
    }

    // 解析 JSON
    return this._parseDecision(response.content);
  }

  /** 从 LLM 回复中提取 JSON 决策（使用 JsonExtractor） */
  private _parseDecision(content: string): AgentStepDecision {
    const result = extractJson(content);
    if (result.success && result.data) {
      this._log(`  ✅ 提取方式: ${result.method || 'exact'}`);
      return this._normalizeDecision(result.data);
    }
    this._log(`  ⚠️ 无法解析 LLM 回复，使用回退动作 (${result.error})`);
    return {
      reasoning: '解析失败: ' + (result.error || 'unknown'),
      action: { name: 'get_dom_state', args: {} },
      nextGoal: '等待并重新获取页面状态',
      taskComplete: false,
    };
  }

  /** 规范化为标准格式 */
  private _normalizeDecision(parsed: any): AgentStepDecision {
    // 兼容不同格式
    const actionName = parsed.action?.name || parsed.action || 'get_dom_state';
    const actionArgs = parsed.action?.args || (typeof parsed.action === 'string' ? {} : parsed.action || {});
    // 如果 action.args 里包含 index 等的对象，但 action.name 是字符串，正确提取
    const args: Record<string, any> = {};
    if (typeof actionArgs === 'object' && !Array.isArray(actionArgs)) {
      Object.assign(args, actionArgs);
    }

    return {
      reasoning: parsed.reasoning || parsed.reason || '',
      action: { name: actionName, args },
      nextGoal: parsed.nextGoal || parsed.next_goal || '',
      taskComplete: !!parsed.taskComplete || !!parsed.task_complete || !!parsed.done,
      planUpdate: parsed.planUpdate || parsed.plan_update || undefined,
      currentPlanItem: parsed.currentPlanItem ?? parsed.current_plan_item ?? undefined,
    };
  }

  /** 构建最终结果 */
  private async _buildResult(
    success: boolean,
    finalOutput: string,
    endReason: AgentResult['endReason'],
    totalSteps: number,
  ): Promise<AgentResult> {
    let finalUrl: string | undefined;
    let finalTitle: string | undefined;
    try {
      finalUrl = await this._page.url();
      finalTitle = await this._page.evaluate('document.title || ""');
    } catch {}

    return {
      success,
      finalOutput,
      totalSteps,
      successSteps: this._history.successCount,
      failedSteps: this._history.failureCount,
      endReason,
      history: this._history,
      finalUrl,
      finalTitle,
    };
  }

  /** 日志 */
  private _log(msg: string) {
    if (this._config.verbose) {
      console.log(msg);
    }
  }

  /** 延时 */
  private _delay(ms: number) {
    return new Promise(r => setTimeout(r, ms));
  }
}

/** 快速创建并运行 Agent */
export async function runAgent(
  page: CdpPage,
  task: string,
  opts: AgentRunOptions & AgentConfig = {},
): Promise<AgentResult> {
  const agent = new BrowserAgent(page, opts);
  return agent.run(task, opts);
}

/** 并发多 Agent — 每个页面一个 Agent，总共一个任务 */
export async function runAgentMultiPage(
  pages: CdpPage[],
  taskConfigs: { page: CdpPage; task: string; opts?: AgentRunOptions & AgentConfig }[],
): Promise<AgentResult[]> {
  if (pages.length === 0 || taskConfigs.length === 0) return [];

  return Promise.all(taskConfigs.map(async config => {
    const agent = new BrowserAgent(config.page, config.opts);
    return agent.run(config.task, config.opts);
  }));
}
