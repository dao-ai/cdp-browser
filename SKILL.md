---
name: "cdp-browser"
description: "Trigger when user shares Douyin/Kuaishou/XHS/Bilibili video or shopping link — auto extract via Chrome CDP with anti-detection. Rules for when to use it."
---

# CDP 反检测浏览器

Windows 真 Chrome + CDP 协议直连，零第三方依赖。自动 anti-detection、人类化交互、跨平台自适应。

## 🔥 什么时候用它

| 场景 | 触发条件 |
|------|---------|
| 分享短视频 | 抖音/快手/B站/小红书 链接发过来时，自动提取标题/作者/描述/数据 |
| 分享电商链接 | 淘宝/京东/拼多多 链接，提取商品信息 |
| 需要爬内容 | 目标站反自动化检测，用真 Chrome 绕过 |
| 需要填表/登录 | 复杂表单提交或手动登录场景 |
| 🆕 自然语言操控 | 用 AI Agent 自动完成多步浏览器操作（搜索、浏览、提取） |

> 规则：**看到分享链接 → 优先用 cdp-browser extract 提取内容**，别问我能不能爬。
> **也可以自然语言描述任务 → AI Agent 自动执行**，见下方 🤖 AI Agent 章节。

## 安装 & 连接

```bash
cd skills/cdp-browser && npm install
npx tsx scripts/cdp-manager.ts --test   # 测试连接
```

```typescript
import { connectBrowser } from './scripts/cdp-manager';
const browser = await connectBrowser();              // 日常 Chrome
const browser2 = await connectBrowser({              // 独立实例 + 代理
  launchNew: true, proxy: 'http://127.0.0.1:7897',
});
const page = await browser.newPage();                // 自带反检测注入
await page.goto('https://example.com', { timeoutMs: 30000 });
```

## 场景指南

### 🕸️ 内容提取（最常用）

```bash
npx tsx scripts/extract.ts 'https://v.douyin.com/xxxx/'
npx tsx scripts/extract.ts --json 'url1' 'url2' --retries 2
```

```typescript
import { extract, batchExtract } from './scripts/extractors';
const info = await extract('https://v.douyin.com/xxxx/');
```

**已注册站点：** 抖音 / 快手 / 小红书 / B站 / 微博 / 淘宝 / 天猫 / 京东 / 拼多多 / 知乎 / 百度

### 🚀 加速加载
```typescript
await page.blockResources(['Image', 'Font', 'Media']);
await page.goto('https://example.com');
```

### 🔍 嗅探视频
```bash
npx tsx scripts/media-sniff.ts 'https://example.com/video'
```

### 📋 填表提交
```bash
npx tsx scripts/form-submit.ts --url 'https://example.com/login' --field 'input[name="username"]=admin' --submit 'button[type="submit"]'
```

### 🤖 AI Agent — 自然语言操控浏览器

```bash
# 需要 DEEPSEEK_API_KEY 环境变量
export DEEPSEEK_API_KEY="sk-xxx"

npx tsx scripts/agent-demo.ts "小红书搜索减脂餐，把前3条结果告诉我"
npx tsx scripts/agent-demo.ts "打开京东看看iPhone价格" --url https://www.jd.com
npx tsx scripts/agent-demo.ts "帮我豆瓣登录一下" --url https://www.douban.com --login
```

**对话中触发示例：**

> 👤 帮我用 AI 搜一下小红书里减脂餐的做法
> 🤖 Agent 自动打开小红书 → 搜索 → 提取结果 → 总结汇报

```typescript
import { connectBrowser } from './scripts/cdp-manager';
import { BrowserAgent } from './scripts/agent';

const browser = await connectBrowser();
const page = await browser.newPage();

const agent = new BrowserAgent(page, {
  llm: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: process.env.LLM_MODEL || 'deepseek-v4-flash',
  },
  maxSteps: 30,
});

const result = await agent.run('小红书搜索减脂餐', {
  startUrl: 'https://www.xiaohongshu.com',
});

console.log(result.finalOutput);
```

**LLM 环境变量：**

| 变量 | 默认值 |
|------|--------|
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `AI_API_KEY` | API Key（必填） |
| `OPENAI_BASE_URL` / `AI_BASE_URL` | `https://api.deepseek.com` |
| `AI_MODEL` / `LLM_MODEL` | `deepseek-v4-flash` |

## 核心 API

**页面操作：** `page.goto()` / `page.click()` / `page.typeText()` / `page.fillInput()` / `page.scrollBy()` / `page.evaluate()` / `page.screenshot()` / `page.saveAsPDF()`

**Cookie & 数据：** `page.getCookies()` / `page.setCookie()` / `page.clearCookies()` / `browser.clearSiteData()`

**抗检测：** `page.addInitScript()` / `BehaviorProfile.record()` / `CdpPage.setBehaviorProfile()`

**网络控制：** `page.blockResources()` / `page.enableRequestInterception()` / `page.setExtraHTTPHeaders()` / `page.enableMediaSniffing()`

**表单：** `fillForm()` / `formSubmit()` / `selectOption()` / `check()` / `uncheck()`

**稳定性：** `page.enableAutoDialog()` / `page.enableConsoleCapture()` / `page.enableCrashAutoRestore()`

**连接池：** `createPool()` / `pool.withPage()` / `pool.acquire()` / `pool.release()`

## 跨平台配置

| 环境变量 | 默认值 |
|---------|--------|
| `CHROME_DEBUG_HOST` | Win:`127.0.0.1` WSL:`172.20.48.1` |
| `CHROME_DEBUG_PORT` | Win:`9222` WSL:`9223` |
| `CHROME_PORT` | `9222` |
| `CHROME_DATA_DIR` | `C:\temp\chrome-debug` |

## 常见问题

| 问题 | 解决 |
|------|------|
| `evaluate()` 报错 | 传字符串表达式，不用箭头函数 |
| 连接断开 | 自动重连或重新 `connectBrowser()` |
| 滑块验证码 | 注入更多指纹 + 行为画像 |
| CDP 正则匹配失败 | 字符串中写 `\\d` |
