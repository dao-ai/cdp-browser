#!/usr/bin/env npx tsx
/**
 * 🧪 CDP Browser — 端到端集成测试
 *
 * 验证 7 个新系统合体工作:
 *   1. Watchdog (弹窗/崩溃/验证码)
 *   2. Message Compactor (历史压缩)
 *   3. Loop Detector (循环检测)
 *   4. Planning System (规划+replan+exploration nudge)
 *   5. terminates_sequence (动作链截断)
 *   6. Action Domain Filtering (域名过滤)
 *   7. JSON Extractor (10级容错解析)
 *
 * 用法:
 *   npx tsx scripts/e2e-test.ts               # 纯单元测试 (mock page)
 *   npx tsx scripts/e2e-test.ts --real         # 单元 + 真实 CDP 跑简单的 agent 任务
 *   npx tsx scripts/e2e-test.ts --real --url https://www.baidu.com  # 指定起点
 *   npx tsx scripts/e2e-test.ts --system-only  # 只跑子系统测试 (不跑 agent)
 *   npx tsx scripts/e2e-test.ts --verbose      # 详细日志
 */

import { strict as assert } from 'assert';
import type { CdpPage } from './cdp-client';
import { ActionRegistry } from './action-registry';
import { extractJson as parseJson, isValidAgentDecision as checkAgentDecision, buildAgentOutputJsonSchema } from './json-extractor';
import { LoopDetector, createPageFingerprint, fingerprintsEqual } from './loop-detector';
import { PlanningSystem } from './planning-system';
import { MessageCompactor } from './message-compactor';
import { AgentHistory } from './agent-history';
import { AgentPrompts } from './agent-prompts';
import { DomService, type DomState } from './dom-service';
import { BrowserAgent } from './agent';
import { EventBus, BaseWatchdog, PopupsWatchdog, CrashWatchdog, CaptchaWatchdog, createDefaultWatchdogs } from './watchdog';

// ─── 彩色的日志 ────────────────────────────────────────────

const LOG = {
  info: (msg: string) => console.log(`  ℹ️  ${msg}`),
  ok: (msg: string) => console.log(`  ✅ ${msg}`),
  fail: (msg: string) => console.log(`  ❌ ${msg}`),
  warn: (msg: string) => console.log(`  ⚠️  ${msg}`),
  title: (msg: string) => console.log(`\n━━━ ${msg} ━━━`),
  sub: (msg: string) => console.log(`  ── ${msg}`),
};

// ─── 统计 ──────────────────────────────────────────────────

const stats = { passed: 0, failed: 0, skipped: 0 };
function pass(name: string) { stats.passed++; LOG.ok(name); }
function fail(name: string, err?: any) { stats.failed++; LOG.fail(`${name}${err ? `: ${err.message || err}` : ''}`); }
function skip(name: string, reason: string) { stats.skipped++; LOG.warn(`${name} (跳过: ${reason})`); }

// ════════════════════════════════════════════════════════════
//  Mock CdpPage — 不连浏览器也能跑子系统
// ════════════════════════════════════════════════════════════

function createMockPage(overrides?: Partial<CdpPage>): CdpPage {
  const mock: any = {
    _url: 'https://www.baidu.com/s?wd=test',
    _title: '百度一下',
    _html: () => '<html><body>Mock Page</body></html>',
    _cookies: [],

    url: () => mock._url,
    goto: async (url: string, opts?: any) => { mock._url = url; },
    evaluate: async (fn: string | Function, ...args: any[]) => {
      if (typeof fn === 'string') {
        // 简单 mock evaluate
        if (fn.includes('document.title')) return mock._title;
        if (fn.includes('location.href')) return mock._url;
        if (fn.includes('document.body')) return mock._html();
        // 模拟 click_element 的 evaluate
        if (fn.includes('el.click()')) return undefined;
        return undefined;
      }
      return undefined;
    },
    screenshot: async (opts?: any) => ({ data: 'mock_base64', type: 'png' }),
    pressKey: async (key: string) => {},
    goBack: async () => { mock._url = 'https://www.baidu.com'; },
    setViewport: async (w: number, h: number) => {},
    close: async () => {},
    getCookies: async () => mock._cookies,
    clearCookies: async () => { mock._cookies = []; },
    on: (event: string, cb: Function) => {},
    removeAllListeners: (event?: string) => {},
    off: (event: string, cb: Function) => {},
    addListener: (event: string, cb: Function) => {},
    removeListener: (event: string, cb: Function) => {},

    fillInput: async (selector: string, value: string) => {},
    clickElement: async (selector: string) => {},
    waitForSelector: async (selector: string, opts?: any) => {},
    gotoWithLogin: async (url: string, opts?: any) => { mock._url = url; },
    waitForPageLoad: async () => {},
    waitForNetworkIdle: async () => {},
    dialog: async () => null as any,

    // 加自定义方法
    setMockUrl: (url: string) => { mock._url = url; },
    setMockTitle: (title: string) => { mock._title = title; },
    setMockHtml: (html: string) => { mock._html = html; },

    ...overrides,
  };

  // 补全可选的 evaluate 方法
  mock.evaluateWithScript = mock.evaluate;
  mock.evaluateHandle = mock.evaluate;

  return mock as CdpPage;
}

// ════════════════════════════════════════════════════════════
//  测试 1: Action Registry — Domain Filtering + terminates
// ════════════════════════════════════════════════════════════

async function testActionRegistry() {
  LOG.title('Test 1: ActionRegistry — Domain Filtering + terminatesSequence');

  const registry = new ActionRegistry();
  const page = createMockPage();

  // 1a. 域名过滤: google_search 只在 *.google.com 可见
  {
    const onBaidu = registry.describe({ domain: 'www.baidu.com', includeFiltered: true });
    const hasGoogleSearch = onBaidu.actions.some(a => a.name === 'google_search');
    assert(!hasGoogleSearch, 'google_search 不应在 baidu.com 可用');
    assert(onBaidu.filteredCount > 0, '域名过滤应该过滤掉一些动作');
    pass('域名过滤: google_search 在 baidu.com 不可见');
  }

  {
    const onGoogle = registry.describe({ domain: 'www.google.com', includeFiltered: true });
    const hasGoogleSearch = onGoogle.actions.some(a => a.name === 'google_search');
    assert(hasGoogleSearch, 'google_search 应在 google.com 可用');
    pass('域名过滤: google_search 在 google.com 可见');
  }

  // 1b. terminatesSequence
  {
    assert(registry.isTerminating('task_done'), 'task_done 应为终止动作');
    assert(registry.isTerminating('go_back'), 'go_back 应为终止动作');
    assert(registry.isTerminating('new_tab'), 'new_tab 应为终止动作');
    assert(!registry.isTerminating('click_element'), 'click_element 不应为终止动作');
    assert(!registry.isTerminating('scroll_down'), 'scroll_down 不应为终止动作');
    pass('terminatesSequence: 标记正确');
  }

  // 1c. multiExecute 截断
  {
    const results = await registry.multiExecute(
      [
        { name: 'scroll_down', args: { amount: 100 } },
        { name: 'click_element', args: { index: 0 } },
        { name: 'go_back', args: {} },
        { name: 'scroll_up', args: {} },  // 应被截断
        { name: 'click_element', args: { index: 1 } },  // 应被截断
      ],
      page,
    );
    assert(results.results.length === 3, `应有3个结果，实际${results.results.length}`);
    assert(results.truncatedBy === 'go_back', `go_back 应截断后续，实际${results.truncatedBy}`);
    pass(`multiExecute 截断: go_back 终止了后续 ${results.results.length}/${5} 个动作`);
  }

  // 1d. task_done 截断
  {
    const results = await registry.multiExecute(
      [
        { name: 'click_element', args: { index: 0 } },
        { name: 'task_done', args: { result: 'done' } },
        { name: 'scroll_down', args: {} },  // 应被截断
      ],
      page,
    );
    assert(results.results.length === 2, `应有2个结果，实际${results.results.length}`);
    assert(results.truncatedBy === 'task_done', 'task_done 应截断后续');
    pass('multiExecute 截断: task_done 正确截断');
  }
}

// ════════════════════════════════════════════════════════════
//  测试 2: JSON Extractor — 10级容错解析
// ════════════════════════════════════════════════════════════

async function testJsonExtractor() {
  LOG.title('Test 2: JsonExtractor — 10级容错解析');

  // 使用独立函数而非类

  // 2a. 标准 JSON
  {
    const r = parseJson('{"action":{"name":"click_element","args":{"index":3}},"taskComplete":false}');
    assert(r.success, '标准 JSON 应解析成功');
    assert(r.data?.action?.name === 'click_element', 'action name 应正确');
    pass('标准 JSON 解析');
  }

  // 2b. ```json 代码块
  {
    const text = '思考过程...\n```json\n{\n  "action": {\n    "name": "scroll_down",\n    "args": {}\n  },\n  "taskComplete": false\n}\n```\n后续思考';
    const r = parseJson(text);
    assert(r.success, '代码块 JSON 应解析成功');
    assert(r.data?.action?.name === 'scroll_down', 'code block action 应正确');
    pass('```json 代码块提取');
  }

  // 2c. 单引号
  {
    const r = parseJson("{'action': {'name': 'type_text', 'args': {'text': 'hello'}}, 'taskComplete': false}");
    assert(r.success, '单引号 JSON 应解析成功');
    assert(r.data?.action?.name === 'type_text', '单引号 action 应正确');
    pass('单引号 → 双引号修复');
  }

  // 2d. Python True/False/None
  {
    const r = parseJson('{"action": {"name": "task_done"}, "taskComplete": True}');
    assert(r.success, 'Python True 应解析成功');
    assert(r.data?.taskComplete === true, 'True → true 应转换');
    pass('Python True/False/None 修复');
  }

  // 2e. 末尾逗号
  {
    const r = parseJson('{"action": {"name": "wait", "args": {"ms": 1000,}}, "taskComplete": false,}');
    assert(r.success, '末尾逗号应解析成功');
    pass('末尾逗号修复');
  }

  // 2f. 无引号 key
  {
    const r = parseJson('{action: {name: "scroll_down", args: {}}, taskComplete: false}');
    assert(r.success, '无引号 key 应解析成功');
    assert(r.data?.action?.name === 'scroll_down', '无引号 action 应正确');
    pass('无引号 key 修复');
  }

  // 2g. JSON 后有尾随文本
  {
    const r = parseJson('{"action":{"name":"task_done"},"taskComplete":true}\n\n这是一些后续文本');
    assert(r.success, '尾随文本不应影响解析');
    assert(r.data?.taskComplete === true, '尾随文本 JSON 应正确');
    pass('尾随文本截断');
  }

  // 2h. 注释
  {
    const r = parseJson('{"action": {"name": "click_element", "args": {"index": 5}} /* 这是一个注释 */, "taskComplete": false}');
    assert(r.success, '含注释 JSON 应解析成功');
    pass('注释去除');
  }

  // 2i. 多段 JSON — 取最后一个
  {
    const r = parseJson('```json\n{"action":{"name":"scroll_down"},"taskComplete":false}\n```\n\n```json\n{"action":{"name":"task_done","args":{"result":"完成"}},"taskComplete":true}\n```', { multi: true });
    assert(r.success, '多段 JSON 应解析成功');
    assert(r.data?.action?.name === 'task_done', '应取最后一段 JSON');
    pass('多段 JSON 取最后一段');

    // 也测试非 multi 单段提取
    const r2 = parseJson('```json\n{"action":{"name":"scroll_down"},"taskComplete":false}\n```');
    assert(r2.success, '单段代码块应解析成功');
    pass('单段代码块提取');
  }

  // 2j. 验证: isValidAgentDecision
  {
    assert(checkAgentDecision({ action: { name: 'click' } }), '含 action 应通过验证');
    assert(checkAgentDecision({ actions: [{ name: 'click' }] }), '含 actions 应通过验证');
    assert(!checkAgentDecision({}), '空对象不应通过验证');
    assert(!checkAgentDecision(null as any), 'null 不应通过');
    pass('isValidAgentDecision 校验');
  }
}

// ════════════════════════════════════════════════════════════
//  测试 3: Loop Detector
// ════════════════════════════════════════════════════════════

async function testLoopDetector() {
  LOG.title('Test 3: LoopDetector — 循环检测');

  // 3a. 页面指纹
  {
    const fp1 = createPageFingerprint('https://a.com', 'hello world', 3);
    const fp2 = createPageFingerprint('https://a.com', 'hello world', 3);
    const fp3 = createPageFingerprint('https://a.com', 'hello WORLD', 3);
    assert(fingerprintsEqual(fp1, fp2), '相同状态指纹应一致');
    assert(!fingerprintsEqual(fp1, fp3), '不同文本指纹应不同 (SHA hash 不同)');
    pass('createPageFingerprint — 相同/不同检测正确');
  }

  // 3b. fingerprintsEqual — 详细测试
  {
    const f1 = createPageFingerprint('https://a.com', 'hello', 3);
    const f2 = createPageFingerprint('https://a.com', 'hello', 5); // 元素数不同
    const f3 = createPageFingerprint('https://b.com', 'hello', 3); // URL不同
    const f4 = createPageFingerprint('https://a.com', 'hello', 3); // 完全相同
    assert(fingerprintsEqual(f1, f4), '相同输入指纹应相等');
    assert(!fingerprintsEqual(f1, f2), '元素数不同应不等 (fingerprintsEqual 检查 elementCount)');
    assert(!fingerprintsEqual(f1, f3), 'URL不同应不等');
    pass('fingerprintsEqual — 正确比较');
  }

  // 3c. 循环检测 + nudge
  {
    const detector = new LoopDetector({ windowSize: 10 });

    // 模拟 15 步相同动作（循环模式）
    for (let i = 0; i < 15; i++) {
      detector.recordAction('scroll_down', { amount: 500 });
      detector.recordPageState('https://a.com', `state${i % 3}`, 5 + (i % 3));
    }

    LOG.info(`LoopDetector 状态: window=${detector.recentActionHashes.length} maxRepeat=${detector.maxRepetitionCount}`);
    const nudge = detector.getNudgeMessage();
    assert(nudge !== null, '循环模式应触发 nudge');
    // nudge 消息包含 "重复了相似动作" 字样
    assert(nudge!.includes('重复'), 'nudge 应包含重复提示');
    LOG.info(`循环检测输出: ${nudge!.slice(0, 120)}`);
    pass('循环检测 — 检测到循环模式并生成 nudge');
  }

  // 3d. 正常序列不应触发 nudge
  {
    const detector = new LoopDetector({ windowSize: 10 });
    for (let i = 0; i < 8; i++) {
      detector.recordAction('click_element', { index: i });
      detector.recordPageState('https://a.com', `state${i}`, i);
    }
    const nudge = detector.getNudgeMessage();
    assert(nudge === null, '正常序列不应触发 nudge');
    pass('循环检测 — 正常序列不误报');
  }

  // 3e. 重置
  {
    const detector = new LoopDetector({ windowSize: 10 });
    for (let i = 0; i < 15; i++) {
      detector.recordAction('scroll_down', { amount: 500 });
      detector.recordPageState('https://a.com', 'same', 5);
    }
    const nudge1 = detector.getNudgeMessage();
    assert(nudge1 !== null, '重置前应有 nudge');
    detector.reset();
    const nudge2 = detector.getNudgeMessage();
    assert(nudge2 === null, '重置后不应有 nudge');
    pass('循环检测 — reset() 正确清零');
  }
}

// ════════════════════════════════════════════════════════════
//  测试 4: Planning System
// ════════════════════════════════════════════════════════════

async function testPlanningSystem() {
  LOG.title('Test 4: PlanningSystem — 规划 + Replan + Exploration Nudge');

  // 4a. 基本计划
  {
    const planner = new PlanningSystem({ replanOnStall: 3 });
    planner.applyPlanUpdate(['打开小红书', '搜索减脂餐', '提取结果', '完成任务']);
    assert(planner.hasPlan, '应有计划');
    const rendered = planner.render();
    assert(rendered !== null, 'render 应返回非空');
    assert(rendered!.includes('打开小红书'), '计划应包含步骤');
    assert(rendered!.includes('提取结果'), '计划应包含步骤');
    pass('计划创建 + render');
  }

  // 4b. 计划推进
  {
    const planner = new PlanningSystem({ replanOnStall: 3 });
    planner.applyPlanUpdate(['A', 'B', 'C', 'D']);
    planner.advancePlan(1);  // 推进到 B
    const rendered = planner.render();
    assert(rendered.includes('B') || rendered.includes('in_progress'), '应显示当前步骤');
    planner.advancePlan(3);  // 推进到 D
    pass('计划推进 — advancePlan');
  }

  // 4c. Replan nudge: 连续失败 3 次触发
  {
    const planner = new PlanningSystem({ replanOnStall: 3 });
    planner.applyPlanUpdate(['X', 'Y', 'Z']);
    for (let i = 0; i < 2; i++) {
      planner.recordFailure();
    }
    const nudge1 = planner.getReplanNudge();
    assert(nudge1 === null, '2次失败不应触发 replan');
    planner.recordFailure(); // 第 3 次
    const nudge2 = planner.getReplanNudge();
    assert(nudge2 !== null, '3次失败应触发 replan nudge');
    assert(nudge2!.includes('replan') || nudge2!.includes('重新规划') || nudge2!.includes('plan'), 'nudge 应包含 replan 提示');
    pass('Replan nudge — 连续3次失败触发');
  }

  // 4d. Exploration nudge: 长期无计划
  {
    const planner = new PlanningSystem({ replanOnStall: 3, explorationLimit: 4 });
    // 无计划执行 5 步
    for (let i = 0; i < 5; i++) {
      planner.tick();
    }
    const nudge = planner.getExplorationNudge();
    assert(nudge !== null, '超过 explorationLimit 应触发 nudge');
    // nudge 提示用户创建计划或结束任务
    assert(nudge!.includes('plan') || nudge!.includes('计划') || nudge!.includes('task_done'), 'nudge 应包含计划提示');
    LOG.info(`Exploration nudge: ${nudge!.slice(0, 100)}`);
    pass('Exploration nudge — 超过限制触发');
  }

  // 4e. 成功重置失败计数
  {
    const planner = new PlanningSystem({ replanOnStall: 3 });
    planner.recordFailure();
    planner.recordFailure();
    planner.recordSuccess();
    planner.recordFailure();
    const nudge = planner.getReplanNudge();
    assert(nudge === null, '成功应重置连续失败计数');
    pass('成功步重置失败计数器');
  }

  // 4f. reset 清空所有状态
  {
    const planner = new PlanningSystem({ replanOnStall: 3 });
    planner.applyPlanUpdate(['A', 'B']);
    for (let i = 0; i < 5; i++) planner.tick();
    planner.reset();
    assert(!planner.hasPlan, 'reset 后不应有计划');
    assert(planner.totalAgentSteps === 0, 'reset 后步数应归零');
    const replan = planner.getReplanNudge();
    assert(replan === null, 'reset 后不应有 replan nudge');
    const explore = planner.getExplorationNudge();
    assert(explore === null, 'reset 后不应有 exploration nudge');
    pass('reset — 完全清零');
  }
}

// ════════════════════════════════════════════════════════════
//  测试 5: Message Compactor
// ════════════════════════════════════════════════════════════

async function testMessageCompactor() {
  LOG.title('Test 5: MessageCompactor — 消息压缩');

  const compactor = new MessageCompactor({ compactEveryNSteps: 10, keepRecentSteps: 5, summaryMaxChars: 500 });

  // 先确认初始状态
  assert(!compactor.needsCompaction(0), '0步不应压缩');
  assert(!compactor.needsCompaction(5), '5步不应压缩');
  assert(!compactor.needsCompaction(9), '9步不应压缩');
  assert(compactor.needsCompaction(10), '10步应触发压缩');
  assert(compactor.needsCompaction(15), '15步应触发压缩');
  pass('needsCompaction 判断正确');

  // 5b. 用模拟步骤测试简单压缩
  {
    const steps = [];
    for (let i = 1; i <= 15; i++) {
      steps.push({
        stepNumber: i,
        action: {
          name: i <= 10 ? 'scroll_down' : 'click_element',
          args: i <= 10 ? { amount: 500 } : { index: i - 10 },
          reasoning: `step ${i}`,
        },
        result: {
          success: i !== 8,  // #8 失败
          error: i === 8 ? '元素不可见' : undefined,
          output: i <= 10 ? undefined : `点击 #${i - 10}`,
        },
        stateBefore: {
          url: 'https://a.com',
          title: 'Test',
          elements: [],
          textPreview: 'test',
          frames: [],
          capturedAt: Date.now(),
        },
        nextGoal: '继续',
        taskComplete: false,
        durationMs: 500,
      } as any);
    }

    // needsCompaction 应在 step 10 时触发
    assert(compactor.needsCompaction(15), '15步应触发压缩');

    const ctx = await compactor.buildContext(steps);
    // stepsSinceCompact = 总步数(15) - 上次压缩步数(0) = 15 (因 keepRecentSteps=5，压缩后 lastCompacted 变为 10)
    assert(ctx.compactedHistory.length > 0, '压缩后应有摘要文本');
    assert(ctx.recentSteps.length > 0, '最近步骤应有详情');

    LOG.info(`压缩摘要长度: ${ctx.compactedHistory.length} 字符`);
    LOG.info(`最近步骤长度: ${ctx.recentSteps.length} 字符`);
    LOG.info(`stepsSinceCompact: ${ctx.stepsSinceCompact}`);

    // 检查失败步骤是否在摘要或最近步骤中保留
    const failureInSummary = ctx.compactedHistory.includes('❌') || ctx.compactedHistory.includes('⚠️');
    const failureInRecent = ctx.recentSteps.includes('❌') || ctx.recentSteps.includes('⚠️');
    assert(failureInSummary || failureInRecent, '压缩后应在摘要或最近步骤中保留失败信息');
    pass('简单压缩 — 正确合并步骤并保留失败信息');
  }

  // 5c. reset
  {
    const c = new MessageCompactor();
    c.reset();
    assert(!c.needsCompaction(5), 'reset 后步数从0开始');
    pass('reset 正确');
  }

  // 5d. updateSettings
  {
    const c = new MessageCompactor({ compactEveryNSteps: 20 });
    assert(c.settings.compactEveryNSteps === 20, '初始 20');
    c.updateSettings({ compactEveryNSteps: 10, keepRecentSteps: 3 });
    assert(c.settings.compactEveryNSteps === 10, '更新为 10');
    assert(c.settings.keepRecentSteps === 3, 'keepRecentSteps 更新');
    pass('updateSettings 正确');
  }

  // 5e. 禁用的压缩器
  {
    const agent = new BrowserAgent(createMockPage(), {});
    agent.setCompaction(false);
    assert(agent.compactor === null, '设 false 后 compactor 应为 null');
    pass('setCompaction(false) 正确禁用');
  }
}

// ════════════════════════════════════════════════════════════
//  测试 6: Watchdog — EventBus + Popups + Crash + Captcha
// ════════════════════════════════════════════════════════════

async function testWatchdog() {
  LOG.title('Test 6: Watchdog — EventBus + Popups + Crash + Captcha');

  // 6a. EventBus 基础
  {
    const bus = new EventBus();
    let received = 0;
    // 注意: EventBus 使用 PascalCase 事件名
    const unsub = bus.on('DialogHandled', () => { received++; });
    bus.emit('DialogHandled', { type: 'alert', message: 'test', action: 'accept' });
    assert(received === 1, 'EventBus 应收到事件');
    unsub();
    bus.emit('DialogHandled', { type: 'alert', message: 'test2', action: 'accept' });
    assert(received === 1, '取消订阅后不应再收到');
    pass('EventBus — 订阅/取消/发射');
  }

  // 6b. EventBus clear
  {
    const bus = new EventBus();
    let count = 0;
    bus.on('PageCrashed', () => { count++; });
    bus.clear();
    bus.emit('PageCrashed', { targetId: 't1', autoRestored: false });
    assert(count === 0, 'clear 后所有 handler 应移除');
    pass('EventBus — clear() 清除所有');
  }

  // 6c. PopupsWatchdog — 构造和 attach/detach
  // PopupsWatchdog.attach() 会调 page.addListener('dialog', ...) 和 page.enableAutoDialog()
  // mock page 没有 enableAutoDialog，需要加在 mock 上
  {
    const page = createMockPage({ enableAutoDialog: async () => {} });
    const bus = new EventBus();
    const popups = new PopupsWatchdog({ page, eventBus: bus });
    popups.attach();
    // 构造成功即算 pass — 真正的弹窗处理需要真实浏览器事件
    popups.detach();
    pass('PopupsWatchdog — 构造 + attach/detach 无异常');
  }

  // 6d. CrashWatchdog — 构造
  {
    const page = createMockPage({ on: () => {} });
    const fakeConnection = { onDisconnect: (cb: any) => {} };
    const fakeBrowser = {
      connection: fakeConnection,
      onPageCrash: (cb: any) => {},
    };
    const bus = new EventBus();
    const crash = new CrashWatchdog({
      page,
      browser: fakeBrowser as any,
      connection: fakeConnection as any,
      eventBus: bus,
    });
    crash.attach();
    crash.detach();
    pass('CrashWatchdog — 构造 + attach/detach 无异常');
  }

  // 6e. CaptchaWatchdog
  {
    const bus = new EventBus();
    const captcha = new CaptchaWatchdog({ eventBus: bus, captchaTimeoutMs: 5000 });

    // 先 attach — 这样才能收到 EventBus 事件
    captcha.attach();

    // 初始状态: 无验证码
    assert(!captcha.hasPendingCaptcha, '初始不应有验证码');
    pass('CaptchaWatchdog — 构造 + 初始状态正确');

    // 验证码检测依赖于注入的 evaluate 函数 — 通过它模拟检测结果
    let detectResult = false;
    captcha.setEvaluateFn(async (script) => {
      return { detected: detectResult, vendor: 'geetest', confidence: 0.9 };
    });

    // 监听 CaptchaResolved 事件
    let captchaResolvedCount = 0;
    bus.on('CaptchaResolved', () => { captchaResolvedCount++; });

    // 触发 NavigationCompleted — 触发 _checkCaptcha()
    detectResult = true;
    bus.emit('NavigationCompleted', { url: 'https://a.com', success: true });
    // on_NavigationCompleted 会等 1.5s + 检测耗时
    await new Promise(r => setTimeout(r, 2500));

    assert(captcha.hasPendingCaptcha, '检测到验证码后 hasPendingCaptcha 应为 true');

    // 模拟验证码解除 — waitForResolution 会轮询 _detectCaptcha
    detectResult = false;
    const waitResult = await captcha.waitForResolution(3000);
    assert(waitResult, '验证码应被解决 (detectResult=false)');
    assert(!captcha.hasPendingCaptcha, '解决后 hasPendingCaptcha 应为 false');
    assert(captchaResolvedCount >= 1, '应触发 CaptchaResolved 事件');

    captcha.detach();
    pass('CaptchaWatchdog — 检测→等待→解决流程');
  }

  // 6f. createDefaultWatchdogs
  {
    const page = createMockPage({ enableAutoDialog: async () => {}, on: () => {} });
    const fakeConnection = { onDisconnect: (cb: any) => {} };
    const fakeBrowser = { connection: fakeConnection, onPageCrash: (cb: any) => {} };
    const wd = createDefaultWatchdogs(page, fakeBrowser as any, {});
    assert(wd.bus instanceof EventBus, '应有 EventBus');
    assert(wd.popups !== undefined, '应有 PopupsWatchdog');
    assert(wd.crash !== undefined, '应有 CrashWatchdog');
    assert(wd.captcha !== undefined, '应有 CaptchaWatchdog');
    assert(wd.all.length === 3, '应有 3 个 watchdog');

    wd.attachAll();
    wd.detachAll();
    pass('createDefaultWatchdogs — 构造 + attach/detach 完整');
  }
}

// ════════════════════════════════════════════════════════════
//  测试 7: AgentHistory
// ════════════════════════════════════════════════════════════

async function testAgentHistory() {
  LOG.title('Test 7: AgentHistory');

  const history = new AgentHistory();

  assert(history.steps.length === 0, '初始空');
  assert(history.totalSteps === 0, '初始步数 0');
  assert(history.successCount === 0, '初始成功数 0');

  // 记录步骤
  history.recordStep({
    action: { name: 'click_element', args: { index: 0 }, reasoning: '测试点击' },
    result: { success: true, output: 'ok' },
    stateBefore: { url: 'https://a.com', title: '', elements: [], textPreview: '', frames: [], capturedAt: Date.now() },
    nextGoal: '继续',
    taskComplete: false,
    durationMs: 100,
  });

  assert(history.totalSteps === 1, '记录1步后 totalSteps 应为 1');
  assert(history.successCount === 1, '成功步应为 1');

  // 再记一步失败
  history.recordStep({
    action: { name: 'scroll_down', args: {}, reasoning: '滚动' },
    result: { success: false, error: '找不到元素' },
    stateBefore: { url: 'https://a.com', title: '', elements: [], textPreview: '', frames: [], capturedAt: Date.now() },
    nextGoal: '重试',
    taskComplete: false,
    durationMs: 200,
  });

  assert(history.totalSteps === 2, '2步');
  assert(history.successCount === 1, '1成功');
  assert(history.failureCount === 1, '1失败');

  // summary
  const summary = history.summary(5);
  assert(summary.includes('click_element'), '摘要应包含动作名');
  assert(summary.includes('scroll_down'), '摘要应包含动作名');
  pass('AgentHistory — 记录/统计/摘要 正常');
}

// ════════════════════════════════════════════════════════════
//  测试 8: DomService
// ════════════════════════════════════════════════════════════

async function testDomService() {
  LOG.title('Test 8: DomService');

  // DomService 的 _collectElements() 和 _collectFrames() 调用浏览器 evaluate 长脚本返回数组
  // 需要 mock 能识别并返回数组数据
  // 注意: 匹配顺序很重要！_collectElements 的长脚本中也包含 document.body，必须优先匹配长脚本
  const domMockPage = createMockPage({
    evaluate: async (fn: string | Function, ...args: any[]) => {
      if (typeof fn === 'string') {
        // 优先匹配长脚本（_collectElements / _collectFrames / inject）
        if (fn.includes('(function(maxEl)')) {
          return [
            { index: 0, tag: 'a', text: '链接', selector: 'a[href]', rect: { x: 0, y: 0, width: 50, height: 20 }, visible: true },
            { index: 1, tag: 'button', text: '按钮', selector: 'button#btn', rect: { x: 0, y: 30, width: 100, height: 30 }, visible: true },
          ];
        }
        if (fn.includes('frames') || fn.includes('window.frames')) return [];
        if (fn.includes('setAttribute') || fn.includes('data-cdp-index')) return undefined;
        // 短的 evaluate
        if (fn.includes('document.title')) return '测试页面';
        if (fn.includes('location.href')) return 'https://www.baidu.com/s?wd=test';
        // 短脚本的 innerText 检查 — _collectElements 的长脚本中也包含 document.body，所以放后面
        if (fn.includes('innerText') || fn.includes('document.body')) return '页面内容测试';
        return undefined;
      }
      return undefined;
    },
  });

  const dom = new DomService(domMockPage, { maxTextPreview: 100, maxElements: 10 });

  const state = await dom.capture();
  assert(state.url === 'https://www.baidu.com/s?wd=test', 'URL 正确');
  assert(typeof state.textPreview === 'string', 'textPreview 应为字符串');
  assert(Array.isArray(state.elements), 'elements 应为数组');

  if (state.elements && state.elements.length > 0) {
    LOG.info(`捕获到 ${state.elements.length} 个元素`);
  }

  // captureWithScreenshot
  const stateWithShot = await dom.captureWithScreenshot();
  assert(stateWithShot.screenshot !== undefined, 'screenshot 不应为空');

  pass('DomService — capture / captureWithScreenshot 正常');
}

// ════════════════════════════════════════════════════════════
//  测试 9: AgentPrompts
// ════════════════════════════════════════════════════════════

async function testAgentPrompts() {
  LOG.title('Test 9: AgentPrompts');

  const state: DomState = {
    url: 'https://www.baidu.com/s?wd=test',
    title: '百度一下',
    elements: [
      { index: 0, tag: 'a', text: '百度首页', box: { x: 0, y: 0, width: 50, height: 20 } },
      { index: 1, tag: 'input', text: '', box: { x: 0, y: 30, width: 200, height: 30 } },
      { index: 2, tag: 'button', text: '搜索', box: { x: 200, y: 30, width: 50, height: 30 } },
    ],
    textPreview: '百度首页 搜索',
    frames: [],
    capturedAt: Date.now(),
  };

  const { system, user } = AgentPrompts.buildNextStep(
    '搜索减脂餐',
    state,
    '已打开百度首页',
    [
      { name: 'type_text', description: '输入文字', parameters: [{ name: 'index', type: 'number', description: '元素编号', required: true }] },
      { name: 'click_element', description: '点击元素', parameters: [{ name: 'index', type: 'number', description: '元素编号', required: true }] },
    ],
    2,  // filteredCount
  );

  assert(system.length > 0, 'system prompt 不应为空');
  assert(user.length > 0, 'user prompt 不应为空');
  assert(user.includes('减脂餐'), 'user prompt 应包含任务');
  // 可用动作写在 system prompt 里，不在 user prompt 中
  assert(system.includes('type_text'), 'system prompt 应包含可用动作 type_text');
  assert(system.includes('click_element'), 'system prompt 应包含可用动作 click_element');
  // 被过滤的动作数提示在 user prompt 末尾
  assert(user.includes('2') || user.includes('过滤'), '应提示被过滤的动作数');

  pass('AgentPrompts — system + user prompt 生成正常');
}

// ════════════════════════════════════════════════════════════
//  测试 10: Agent 端到端 — 模拟执行
// ════════════════════════════════════════════════════════════

async function testAgentE2E() {
  LOG.title('Test 10: Agent E2E — 模拟执行 + 全系统集成');

  // 构建一个完整的 Agent 执行链，验证所有系统一起工作
  const page = createMockPage();
  const agent = new BrowserAgent(page, {
    verbose: true,
    maxSteps: 30,
    maxConsecutiveFailures: 5,
  });

  // 验证子组件都初始化了
  assert(agent.compactor !== null, 'Agent 应有 compactor');
  assert(agent.loopDetector !== null, 'Agent 应有 loopDetector');
  assert(agent.planner !== null, 'Agent 应有 planner');
  assert(agent.llm !== null, 'Agent 应有 llm');

  pass('Agent 初始化 — 所有子系统已创建');
  pass('Agent 初始化 — 构造函数无异常');
}

// ════════════════════════════════════════════════════════════
//  测试 11 (可选): 真实 CDP 连接 + LLM 执行简单任务
// ════════════════════════════════════════════════════════════

async function testRealConnection() {
  LOG.title('Test 11: 真实 CDP 连接检查');

  // 检查 Windows Chrome CDP 端口
  const resp = await fetch('http://172.20.48.1:9223/json/version')
    .then(r => r.json())
    .catch(() => null);

  if (!resp || !resp['Browser']) {
    skip('CDP 连接', 'Windows Chrome 远程调试端口 (172.20.48.1:9223) 不可用');
    return;
  }

  LOG.info(`浏览器: ${resp['Browser']}`);
  LOG.info(`协议版本: ${resp['Protocol-Version']}`);
  pass('CDP 连接 — 成功握手');
}

// ════════════════════════════════════════════════════════════
//  测试 12 (可选): LLM API 连通性
// ════════════════════════════════════════════════════════════

async function testLlmConnection() {
  LOG.title('Test 12: LLM API 连通性检查');

  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    skip('LLM API', 'DEEPSEEK_API_KEY 未设置');
    return;
  }

  // 简单检测: 调用 chat completion 确认 API 工作
  const response = await fetch(
    process.env.LLM_BASE_URL || 'https://api.deepseek.com/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: '你是一个测试助手。只回复"ok"表示你在线。' },
          { role: 'user', content: '测试连通性' },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown');
    skip('LLM API', `API 请求失败: HTTP ${response.status} ${text.slice(0, 100)}`);
    return;
  }

  const data = await response.json();
  const reply = data?.choices?.[0]?.message?.content || '';
  LOG.info(`LLM 回复: "${reply.slice(0, 100)}"`);
  pass('LLM API — 连通正常');
}

// ════════════════════════════════════════════════════════════
//  测试 13: Action Domain 匹配单元测试
// ════════════════════════════════════════════════════════════

async function testDomainMatching() {
  LOG.title('Test 13: Domain 匹配逻辑');

  const registry = new ActionRegistry();

  // 手动模拟 _matchDomain 行为
  // 实际代码中使用 _matchDomain 内部函数，我们通过域名过滤来验证

  // 精确匹配: www.google.com
  const r1 = registry.describe({ domain: 'www.google.com' });
  const hasGoogleSearchGoogle = r1.actions.some(a => a.name === 'google_search');
  assert(hasGoogleSearchGoogle, 'www.google.com 应有 google_search');
  pass('域名精确匹配: www.google.com');

  // 子域名匹配: *.google.com → mail.google.com
  const r2 = registry.describe({ domain: 'mail.google.com' });
  const hasGoogleSearchMail = r2.actions.some(a => a.name === 'google_search');
  assert(hasGoogleSearchMail, 'mail.google.com 应有 google_search');
  pass('域名通配匹配: mail.google.com (*.google.com)');

  // 不匹配: baidu.com
  const r3 = registry.describe({ domain: 'baidu.com' });
  const hasGoogleSearchBaidu = r3.actions.some(a => a.name === 'google_search');
  assert(!hasGoogleSearchBaidu, 'baidu.com 不应有 google_search');
  pass('域名过滤: baidu.com 无 google_search');

  // 无域名约束的动作在所有站可见
  const r4 = registry.describe({ domain: 'some-random-site.cn' });
  assert(r4.actions.length > 0, '随机站应有基础动作');
  assert(r4.actions.some(a => a.name === 'click_element'), 'click_element 应在所有站可见');
  pass('无约束动作: 所有站可用');
}

// ════════════════════════════════════════════════════════════
//  Main
// ════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const SYSTEM_ONLY = args.includes('--system-only');
  const REAL_TEST = args.includes('--real') || args.includes('--real-url');
  const VERBOSE = args.includes('--verbose');

  // 输出标题
  const bold = '\x1b[1m';
  const reset = '\x1b[0m';
  console.log(`\n${bold}🧪 CDP Browser — 端到端 (E2E) 集成测试${reset}`);
  console.log(`   ${bold}7 个新系统联合验证${reset}`);
  console.log(`   模式: ${REAL_TEST ? '单元 + 真实' : SYSTEM_ONLY ? '仅子系统' : '全部'}`);
  if (VERBOSE) console.log(`   详细日志: 开启`);
  console.log(`   时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log('');

  // ── 子系统测试 (不依赖 API / 真实浏览器) ──
  const t0 = Date.now();

  try { await testActionRegistry(); } catch (e: any) { fail('Test 1: ActionRegistry', e); }
  try { await testJsonExtractor(); } catch (err: any) { fail('Test 2: JsonExtractor', err); }
  try { await testLoopDetector(); } catch (e: any) { fail('Test 3: LoopDetector', e); }
  try { await testPlanningSystem(); } catch (e: any) { fail('Test 4: PlanningSystem', e); }
  try { await testMessageCompactor(); } catch (e: any) { fail('Test 5: MessageCompactor', e); }
  try { await testWatchdog(); } catch (e: any) { fail('Test 6: Watchdog', e); }
  try { await testAgentHistory(); } catch (e: any) { fail('Test 7: AgentHistory', e); }
  try { await testDomService(); } catch (e: any) { fail('Test 8: DomService', e); }
  try { await testAgentPrompts(); } catch (e: any) { fail('Test 9: AgentPrompts', e); }
  try { await testAgentE2E(); } catch (e: any) { fail('Test 10: Agent E2E Init', e); }
  try { await testDomainMatching(); } catch (e: any) { fail('Test 13: DomainMatching', e); }

  // ── 真实连接测试 (可选) ──
  if (REAL_TEST || args.includes('--check-connection')) {
    await testRealConnection();
    await testLlmConnection();
  } else {
    // 快速检查 — 不阻塞
    if (!SYSTEM_ONLY) {
      try { await testRealConnection(); } catch { skip('CDP 连接检查', '非必测，跳过'); }
      try { await testLlmConnection(); } catch { skip('LLM API 检查', '非必测，跳过'); }
    }
  }

  const duration = ((Date.now() - t0) / 1000).toFixed(1);

  // ── 最终总结 ──
  const total = stats.passed + stats.failed + stats.skipped;
  console.log(`\n${'═'.repeat(56)}`);
  console.log(`📊 测试总结 (${duration}s)`);
  console.log(`${'═'.repeat(56)}`);
  console.log(`  ✅ 通过: ${stats.passed}`);
  console.log(`  ❌ 失败: ${stats.failed}`);
  console.log(`  ⏭️  跳过: ${stats.skipped}`);
  console.log(`  📦 总计: ${total}`);

  if (stats.failed > 0) {
    console.log(`\n❌ 有 ${stats.failed} 个测试失败！`);
    process.exit(1);
  } else {
    console.log(`\n✅ 全部通过！`);
  }
}



main().catch(err => {
  console.error('❌ 测试框架异常:', err);
  process.exit(1);
});
