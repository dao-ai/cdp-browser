# 🎯 browser-use 借鉴计划 — 全部完成

> 基于 browser-use 源码分析，给咱 cdp-browser 套上 AI Agent 大脑

## ✅ 2026-06-08: 核心 5 个模块 + LLM 客户端完成

### 已创建的文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `scripts/llm-client.ts` | ~200 | 轻量 OpenAI 兼容客户端，零外部依赖，支持流式/多模态 |
| `scripts/dom-service.ts` | ~350 | DOM→LLM 接口，把页面转成带编号的可交互元素列表 |
| `scripts/action-registry.ts` | ~300 | 装饰器式动作注册系统，带参数校验/域名过滤，内置 10 个基础动作 |
| `scripts/agent-history.ts` | ~180 | 结构化操作历史，支持回溯/统计/报告生成 |
| `scripts/agent-prompts.ts` | ~160 | 中文+英文系统提示词模板 |
| `scripts/agent.ts` | ~280 | Agent 主循环：捕获状态→LLM决策→执行→记录→循环 |
| `scripts/index.ts` | 已更新 | 导出所有 Agent API |

### 架构

```
用户一句话（自然语言）
       ↓
┌─────────────────────────────┐
│   Agent Loop (agent.ts)     │
│  ┌───────────────────────┐  │
│  │ LLM (llm-client.ts)   │  │  ← 调用 DeepSeek/OpenAI
│  └───────┬───────────────┘  │
│          ↓                  │
│  ┌───────────────────────┐  │
│  │ Action Registry       │  │  ← 找对应动作并执行
│  └───────┬───────────────┘  │
│          ↓                  │
│  ┌───────────────────────┐  │
│  │ CdpPage API            │  │  ← click/type/scroll/截图等
│  └───────┬───────────────┘  │
│          ↓                  │
│  ┌───────────────────────┐  │
│  │ DomService            │  │  ← 观察新状态
│  └───────────────────────┘  │
└─────────────────────────────┘
       ↓
AgentResult { finalOutput, history, success }
```

### 内置动作 (12 个)

1. `click_element(index)` — 点击元素
2. `type_text(index, text)` — 输入框中打字
3. `press_enter()` — 按回车
4. `scroll_down(amount)` / `scroll_up(amount)` — 滚动
5. `go_back()` — 后退
6. `wait(ms)` — 等待
7. `read_text(index)` — 读元素文本
8. `get_page_text()` — 获取页面全文
9. `get_dom_state()` — 刷新 DOM 状态
10. `task_done(result)` — 标记完成
11. `extract_site_content(url?)` — 专用站点内容提取器
12. `new_tab(url)` — 打开新标签页

### 使用方式

```typescript
import { BrowserAgent, connectBrowser } from '...';

const browser = await connectBrowser();
const page = await browser.newPage();
const agent = new BrowserAgent(page, {
  llm: { apiKey: 'sk-xxx', model: 'deepseek-chat' },
});
const result = await agent.run('帮我搜一下减脂餐', {
  startUrl: 'https://www.xiaohongshu.com',
});
console.log(result.finalOutput);
```

## ✅ 2026-06-09: 全部 P1 待办完成

### 1️⃣ 提取器增强 ✅
- 新增 `extract_site_content` 动作，Agent 可以直接调用专用站点提取器
- 内置通用提取逻辑（Meta/OG 信息 + 站点专用结构化字段）
- 支持参数 `url`（可选，默认当前页 URL）

### 2️⃣ 失败重试 & 自我纠正 ✅
- 动作执行失败自动重试（可配置次数，默认 2 次）
- 自我修正参数策略：元素 index 偏移、输入框 clickFirst、滚动加倍
- 指数退避重试延迟
- 失败自动截图记录
- 连续失败超过阈值自动终止（默认 5 次）

### 3️⃣ 截图支持多模态 LLM ✅
- 每隔 N 步自动截取页面截图传给 LLM（可配置 N，默认 5）
- 截图用 `DomService.captureWithScreenshot()` 实现
- 以 base64 图片格式通过多模态接口传给 LLM
- 适用 DeepSeek V4 等支持 vision 的模型

### 4️⃣ 更智能的 DOM 精简 ✅
- 前端 adElement 检测：class 名/ID/data 属性匹配
- 后端文本关键词过滤（广告/推广/download 等）
- 排除常见广告容器选择器
- 对追踪链接（utm_/spm=）自动降权
- 按交互性 + 位置 + 有文本打分排序

### 5️⃣ 并发页面操作 ✅
- 新增 `new_tab(url)` 动作，Agent 可打开新标签页
- `runAgentMultiPage()` 支持多页面并发执行不同任务
- `terminatesSequence` 标记确保新页面操作不干扰当前页序列

### 细节改进
- 自我修正逻辑回退指数退避 (`1000 × attempt`)
- LLM 回复解析失败时有兜底动作 (`get_dom_state`)
- 截图失败不阻塞 Agent 主循环
- action execution 支持多动作队列执行
- ESModule 兼容，零外部依赖，TypeScript 编译通过 ✅

## 后续 P2
- [ ] 完善测试覆盖
- [ ] 添加更多站点提取器
- [ ] 优化断线重连

---

*2026-06-09 完成，全部 P1 待办实现，编译通过 ✅*
