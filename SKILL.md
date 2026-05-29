---
name: cdp-browser
description: "Use when a target website detects Playwright, Puppeteer, Selenium, or other automation tools and requires real Chrome CDP with anti-detection injection and humanized interaction."
---

# CDP 反检测浏览器自动化

## 概述

通过 Windows 真 Chrome + **CDP 协议**直连，零第三方自动化库依赖。每次新建页面自动注入 anti-detection 脚本隐藏所有自动化特征（`webdriver`、`__playwright`、`__puppeteer` 等），支持贝塞尔鼠标轨迹、拟真打字、随机视口抖动等人类化操作层，以假乱真地绕过各大网站反检测。

**必备背景：** `browser-automation` skill 定义了 OpenClaw `browser` 工具的通用操作模式。

## 原理

```
AI 代码 → CDP WebSocket → Windows 真 Chrome → 目标网站
                ↓
        注入 anti-detection
        隐藏自动化标记
        模拟真人交互
```

## 何时使用

- 网站弹出验证码 / 滑块 / 真人验证
- 返回 `navigator.webdriver = true` 检测
- 检测到 `window.__playwright` / `__pwInitScripts` / `__puppeteer` / `__nightmare` 等自动化框架标记
- headless 浏览器直接被拒绝
- 需要保持登录态进行多次操作（复用同一个 CDP 连接）

**不适用：**
- 只需简单 GET 请求 → 用 `web_fetch`
- 有公开 API → 优先调 API
- 目标无反检测 → 用 OpenClaw `browser` tool 即可

## 工作流

### 0. 安装依赖

```bash
cd skills/cdp-browser
npm install
```

### 1. 连接 Chrome（自动启停，跨平台）

```typescript
import { connectBrowser } from './scripts/cdp-manager';

const browser = await connectBrowser();
// 自动做：
//   1. 检测平台（Windows / WSL / Linux）
//   2. 检查 CDP 端口是否可达
//   3. 不可达 → 自动启动 Chrome（远程调试模式）
//   4. WSL 下自动创建 netsh 端口转发
//   5. 返回 WebSocket 连接
//
// Windows:  直连 127.0.0.1:9222
// WSL:      通过 netsh → 172.20.48.1:9223 → Windows Chrome:9222
// Linux:    可设 CHROME_DEBUG_HOST 连远程 Chrome
```

### 2. 创建反检测页面

```typescript
const page = await browser.newPage();
// 自动注入（每个新页面执行一次）：
//   - navigator.webdriver → false
//   - 删除 __playwright / __pwInitScripts / __puppeteer / __nightmare / __selenium
//   - 伪造 window.chrome.runtime
//   - 伪造 navigator.plugins（暴露真实插件列表）
//   - 伪造 navigator.languages（根据操作系统设置）

await page.setViewport(1280, 720);
// 自动 ±18px 随机抖动，防分辨率指纹
```

### 3. 导航到目标

```typescript
await page.goto('https://www.douyin.com', { timeoutMs: 35000 });
await page.evaluate('document.title');
```

### 4. 人类化交互

```typescript
// 贝塞尔曲线鼠标点击
await page.click('#search-input');

// 拟真打字（每个字符间隔 28-55ms，偶有 burst pause）
await page.typeText('养生科普');

// 自然滚动（分多小步，每步 80-180px + 微停顿）
await page.scrollBy(0, 1000);

// 等待网络请求
await page.waitForResponse('/api/search');
```

### 5. 清理

```typescript
await page.close();
await browser.close();
```

### 6. 配置行为画像（可选，提升拟真度）

```typescript
// 录制 30 秒真人操作习惯
import { BehaviorProfile } from './scripts/behavior-profile';
const page = await browser.newPage();
const profile = await BehaviorProfile.record(page, 30);

// 保存画像供后续使用
profile.save('my-behavior.json');

// 全局设置行为画像（后续所有页面的人类化操作都模仿你）
CdpPage.setBehaviorProfile(profile);

// 或加载已有画像
CdpPage.setBehaviorProfile(profile);
// 或清除
CdpPage.setBehaviorProfile(null);
```

## 快速参考

| 操作 | 方法 | 说明 |
|------|------|------|
| 连接 | `connectBrowser()` | 自动检测/启动 Chrome |
| 新标签 | `browser.newPage()` | 自带 anti-detection 注入 |
| 导航 | `page.goto(url, opts?)` | 自动等待加载 + 站点反检测注入 |
| 刷新 | `page.reload()` | 重新加载当前页 |
| 后退 | `page.goBack()` | 浏览器后退 |
| 前进 | `page.goForward()` | 浏览器前进 |
| 页面 JS | `page.evaluate(fn)` | 支持字符串 / 函数 |
| 点击 | `page.click(selector)` | 贝塞尔鼠标路径 |
| 打字 | `page.typeText(text)` | 逐字符拟真输入 |
| 填值 | `page.fillInput(sel, val)` | 原生 setter + input/change 事件（React/Vue 兼容） |
| 滚动 | `page.scrollBy(dx, dy)` | 多步微滚 |
| 截图 | `page.screenshot(opts?)` | 支持 clip |
| 截图元素 | `page.screenshotElement(sel, path)` | 自动定位 |
| 等待请求 | `page.waitForResponse(pattern)` | URL 关键词匹配 |
| 等待弹窗 | `browser.waitForNewPage()` | 监听 Target.created |
| HTML 全文 | `page.content()` | 获取完整 HTML 源码 |
| 等待元素 | `page.waitForSelector(sel, ms)` | 轮询等 CSS 选择器出现（SPA 友好） |
| 注入脚本 | `page.addInitScript(src)` | 每个页面加载前执行 |
| 读 cookie | `page.getCookies()` | 返回当前页所有 cookie |
| 设 cookie | `page.setCookie({name,value,...})` | 设置单个 cookie |
| 清 cookie | `page.clearCookies()` | 清除当前页所有 cookie |
| 清除数据 | `browser.clearSiteData(origins)` | 清 cookie/storage/cache |
| 闭合 | `page.close()` / `browser.close()` | 清理 session |

## 网站提取器（Extractors）

一套可扩展的「打开页面 → 提取内容 → 输出结果」自动化系统。每个网站一个文件，自动注册，统一结果格式。

### 一键提取

```bash
# 自动识别 URL 的站点，提取内容
npx tsx scripts/extract.ts 'https://v.douyin.com/xxxx/'

# 输出 JSON（含耗时和重试信息）
npx tsx scripts/extract.ts --json 'https://v.douyin.com/xxxx/'

# 失败自动重试
npx tsx scripts/extract.ts --retries 3 'https://v.douyin.com/xxxx/'

# 批量提取（复用浏览器 + 汇总报告）
npx tsx scripts/extract.ts '链接1' '链接2' '链接3'

# 查看已注册站点
npx tsx scripts/extract.ts --list
```

### 编程调用

```typescript
import { extract, batchExtract, listSites } from './scripts/extractors';

// 单条提取（默认重试 1 次，含耗时统计）
const info = await extract('https://v.douyin.com/xxxxx/');
console.log(info.title, info.author, info.elapsedMs);  // TimedExtractorResult

// 自定义重试次数
const info2 = await extract('https://v.douyin.com/yyyy/', { retries: 3 });

// 批量提取（复用同一浏览器 + 汇总报告）
const batch = await batchExtract([
  'https://v.douyin.com/xxxx/',
  'https://v.douyin.com/yyyy/',
  'https://www.xiaohongshu.com/explore/zzzz',
], { retries: 2 });
// batch.summary → { total: 3, success: 3, failed: 0, totalElapsedMs, avgElapsedMs }
// batch.results → TimedExtractorResult[]

// 列出已注册站点
console.log(listSites());
// → [{ domain: 'douyin.com', name: '抖音' }]
```

### 返回类型

```typescript
// 基础字段
interface ExtractorResult {
  id: string;            // 内容 ID
  title: string;         // 标题
  author: string;        // 作者
  url: string;           // 完整 URL
  description?: string;  // 描述/文案
  publishDate?: string;  // YYYY-MM-DD
  likes?: number;        // 点赞数
  comments?: number;     // 评论数
  shares?: number;       // 分享数
  coverUrl?: string;     // 封面图
  raw?: Record<string, any>;  // 站点特定数据
}

// extract() / batchExtract() 返回扩展类型
interface TimedExtractorResult extends ExtractorResult {
  site: string;          // 站点名（'抖音' / '小红书' / ...）
  elapsedMs: number;     // 提取耗时（含重试）
  retries: number;       // 实际重试次数（0 = 一把过）
}

interface BatchSummary {
  total: number;
  success: number;
  failed: number;
  totalElapsedMs: number;
  avgElapsedMs: number;
  results: TimedExtractorResult[];
}
```

### 添加新站点

1. 在 `scripts/extractors/` 下新建 `<site>.ts`，导出 `extract(url): Promise<ExtractorResult>`
2. 在 `scripts/extractors/index.ts` 的 `REGISTRY` 数组加一行
3. 完工

```typescript
// scripts/extractors/xiaohongshu.ts
import { connectBrowser, randomDelay } from '../cdp-client';
import type { ExtractorResult } from './types';

export async function extract(url: string): Promise<ExtractorResult> {
  // ... 你的提取逻辑
}
```

```typescript
// scripts/extractors/index.ts → REGISTRY
import { extract as xhsExtract } from './xiaohongshu';
// 加一行：
{ domain: 'xiaohongshu.com', name: '小红书', extract: xhsExtract },
```

详细指南 → `references/extractors.md`

## 跨平台配置

| 环境变量 | Windows 默认 | WSL 默认 | 说明 |
|---------|-------------|----------|------|
| `CHROME_DEBUG_HOST` | `127.0.0.1` | `172.20.48.1` | CDP 主机地址 |
| `CHROME_DEBUG_PORT` | `9222` | `9223` | 对外连接端口 |
| `CHROME_PORT` | — | `9222` | WSL 下 Chrome 实际监听端口 |
| `CHROME_DATA_DIR` | `C:\temp\chrome-debug` | `C:\temp\chrome-debug` | Chrome 用户数据目录 |
| `CDP_BRIDGE_INFO` | 自动检测 | 自动检测 | Bridge mode info file 路径 |

平台自动检测逻辑：
- `process.platform === 'win32'` → Windows 模式（直连 localhost）
- 有 `WSL_DISTRO_NAME` 或 `/proc/sys/fs/binfmt_misc/WSLInterop` → WSL 模式（netsh 端口转发）
- 其他 → 纯 Linux 模式（可设 `CHROME_DEBUG_HOST` 连远程）

## 各站策略要点

| 网站 | 检测特征 | 应对策略 |
|------|---------|---------|
| 抖音 | `webdriver` / 自动化框架 / 无痕浏览器 | CDP 直连 + anti-detection 注入 + 登录态复用 |
| 小红书 | `__playwright` / `__puppeteer` | CDP 页面清理 + 真实 UA + 随机延时 |
| 淘宝/京东 | canvas 指纹 / 分辨率检测 | 视口抖动 + canvas 噪声注入 |
| 知乎 | 行为分析 / 鼠标轨迹 | 贝塞尔鼠标 + 拟真滚动 |
| 微信公众号 | cookie / 登录态 | 复用已有浏览器 profile |

## 常见错误

| 错误 | 原因 | 解决 |
|------|------|------|
| `evaluate()` 箭头函数报 `__name is not defined` | tsx 编译注入 `__name` helper | 传**字符串表达式**而非箭头函数 |
| Page 连接断开 | Chrome 被关闭或端口转发失效 | 重新 `connectBrowser()` |
| 滑块验证码 | 反检测脚本不够 | 注入更多浏览器指纹伪造 + 真人操作延时 |
| `netsh：需要管理员权限` | 端口转发首次需管理员 | 手动以管理员身份执行一次 |
| 浏览器没打开 | Chrome 路径或启动参数问题 | 检查 `findChromePath()` 配置 |
| 超时 | 页面加载慢 / 滑块拦截 | 增加 `timeoutMs` |
| CDP 字符串中正则匹配失败 | `\d` 在字符串中需转义为 `\\d` | 传 `\\d` 给浏览器执行 |

## 测试连接

```bash
npx tsx skills/cdp-browser/scripts/cdp-manager.ts --test
# 输出：{ ok: true, host: '172.20.48.1', port: 9223 }
```

## 调试

```bash
# 查看 Chrome 远程调试状态
npx tsx skills/cdp-browser/scripts/cdp-manager.ts --status

# 测试打开页面
npx tsx skills/cdp-browser/scripts/cdp-manager.ts --open-url "https://example.com"

# 录制行为画像
npx tsx skills/cdp-browser/scripts/behavior-profile.ts --record 30
```
