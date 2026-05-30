<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/dependencies-ws%20only-2ea44f" alt="Minimal Dependencies">
  <img src="https://img.shields.io/badge/chrome-cdp-brightgreen" alt="CDP">
  <img src="https://img.shields.io/badge/platform-Windows%20|%20WSL%20|%20Linux-lightgrey" alt="Cross Platform">
</p>

# CDP Browser — 反检测浏览器自动化

> **Zero Playwright / Puppeteer / Selenium dependency.** Pure Chrome DevTools Protocol over WebSocket, with anti-detection injection, humanized interaction, and cross-platform auto-connect.

通过 Windows 真 Chrome + **CDP 协议**直连，不依赖任何第三方自动化框架库。每次新建页面自动注入 anti-detection 脚本，配合贝塞尔鼠标轨迹、拟真打字、随机视口抖动等人类化操作层，绕过抖音、小红书、快手等主流网站的反爬虫检测。

---

## ✨ 特性

- **零自动化框架依赖** — 不走 Playwright / Puppeteer / Selenium，纯 WebSocket 直连 CDP，API 干净可控
- **反检测注入引擎** — 自动隐藏 `navigator.webdriver`、`__playwright`、`__puppeteer`、`__nightmare`、`__selenium` 等自动化标记；伪造 `window.chrome.runtime`、`navigator.plugins`、`navigator.languages`
- **人类化交互层** — 贝塞尔曲线鼠标移动、逐字拟真键入（字符间隔 28–55ms + 偶发停顿）、多步自然滚动、随机视口抖动（±18px）
- **行为画像系统** — 录制真人操作习惯并复现，进一步提升拟真度
- **跨平台自动连接** — Windows 直连、WSL 通过 `netsh` 端口转发、Linux 可连远程 Chrome，一键启动
- **10 站内容提取器** — 抖音、快手、小红书、B站、微博、淘宝、京东、拼多多、知乎、百度，统一格式一行提取
- **TypeScript 原生** — 全程 TypeScript，完整类型定义

---

## 💬 在对话中使用

在 OpenClaw 对话中直接描述你的需求，Agent 会自动调用 CDP 浏览器。支持自然语言触发。

### 内容提取

```
帮我提取这个抖音视频的信息：https://v.douyin.com/xxxx/

帮我批量提取这些链接：
- https://v.douyin.com/xxx/
- https://www.xiaohongshu.com/explore/yyy

看看这个京东商品的价格和店铺：https://item.jd.com/100038004372.html

知乎这个问题 https://www.zhihu.com/question/xxx 有几条回答？
```

### 网页自动化

```
打开百度，搜索"AI大模型"，截图保存

帮我登录这个网站 https://example.com/login，用户名 admin 密码 123456

打开 B站首页，把所有视频标题抓下来

帮我填这个表单：https://example.com/register
- 姓名: 张三  gender: 男  agree: 勾选
```

### 调试 & 监控

```
打开 https://example.com，帮我看看 console 有没有报错

这个页面 https://example.com/video 有没有视频地址？帮我抓出来

打开页面看看有没有弹 alert，有的话自动点掉
```

### 配置 & 管理

```
帮我用代理 127.0.0.1:7890 打开 https://example.com
启动一个独立 Chrome 实例走代理爬数据

检查一下 Chrome 远程调试状态
现在 Chrome 连着吗？
```

### 编程调用

如果需要在代码中调用而非对话：

```typescript
// 对话中也可以直接贴代码让 Agent 执行
import { extract } from './scripts/extractors';
const info = await extract('https://v.douyin.com/xxxx/');
```

### 触发关键词

自然提到以下任意关键词即可触发 CDP 技能：
- 网站名：抖音、小红书、B站、京东、淘宝、拼多多、知乎、微博、快手、百度
- 操作类：提取、截图、搜索、登录、抓取、打开、填表、视频地址
- 工具类：CDP、Chrome、浏览器自动化、反检测

示例对话：

> 👤 帮我看看这个京东商品多少钱：https://item.jd.com/xxx.html  
> 🤖 `connectBrowser` → 打开京东 → 抓取价格和标题 → 返回结果

> 👤 抖音上"中老年养生"这个关键词能搜到什么？  
> 🤖 CDP 反检测 → 抖音搜索 → 返回搜索结果列表

---

## 🚀 快速开始

### 安装

```bash
cd <your-project>
git clone https://github.com/dao-ai/cdp-browser.git
cd cdp-browser
npm install
```

或者直接安装依赖并复制脚本：

```bash
npm install ws
# 将 scripts/ 目录复制到你的项目中
```

### 环境要求

- Chrome / Edge / Chromium 浏览器（推荐正式版 Chrome）
- Node.js >= 18
- 操作系统：Windows / WSL2 / Linux

### 测试连接

确保 Chrome 已经关闭或没有占用调试端口，然后运行：

```bash
npx tsx scripts/cdp-manager.ts --test
```

成功输出：

```json
{ "ok": true, "host": "127.0.0.1", "port": 9222 }
```

### 检查状态

```bash
npx tsx scripts/cdp-manager.ts --status
```

---

## 📖 使用示例

### 基础自动化

```typescript
import { connectBrowser } from './scripts/cdp-manager';

async function main() {
  // 1. 自动连接 Chrome（Windows/WSL/Linux）
  const browser = await connectBrowser();

  // 2. 创建新页面（自动注入 anti-detection 脚本）
  const page = await browser.newPage();
  await page.setViewport(1280, 720); // 视口随机抖动 ±18px

  // 3. 导航
  await page.goto('https://example.com');

  // 4. 人类化交互
  await page.click('#search-input');          // 贝塞尔鼠标轨迹
  await page.typeText('关键词');               // 逐字拟真输入
  await page.scrollBy(0, 1000);               // 多步自然滚动

  // 5. 获取内容
  const html = await page.content();
  const title = await page.evaluate('document.title');
  console.log(title);

  // 6. 截图
  await page.screenshot({ path: 'screenshot.png' });

  // 7. 清理
  await page.close();
  await browser.close();
}
```

### 一键提取内容

```bash
# 提取抖音视频（含 JSON 输出 / 批量 / 查看站点）
npx tsx scripts/extract.ts 'https://v.douyin.com/xxxx/'
npx tsx scripts/extract.ts --json 'https://v.douyin.com/xxxx/'
npx tsx scripts/extract.ts --retries 3 'https://v.douyin.com/xxxx/'
npx tsx scripts/extract.ts --list
```

### 手动登录

```bash
# 打开抖音等登录，登录态自动保存到 Chrome profile
npx tsx scripts/cdp-manager.ts --login https://www.douyin.com
# 登录完后续提取无需重复登
npx tsx scripts/extract.ts 'https://v.douyin.com/xxxx/'
```

```typescript
// 编程调用
await page.gotoWithLogin('https://www.douyin.com', {
  loginPatterns: ['login', 'passport'],   // 登录页 URL 特征
  timeoutMs: 300_000,                      // 等人登录，最多等 5 分钟
});
```

### Cookie 持久化（一次登录，永久复用）

**解决淘宝/小红书/微博等需要登录的问题。** 登录一次存 Cookie，后续自动恢复。

```bash
# 登录并保存
npx tsx scripts/cookie-manager.ts --save taobao --login
npx tsx scripts/cookie-manager.ts --save xiaohongshu --login

# 查看已保存的登录态
npx tsx scripts/cookie-manager.ts --list

# 带登录态提取（自动恢复 cookie）
npx tsx scripts/cookie-manager.ts --extract 'https://item.taobao.com/...'
```

```typescript
// 编程方式
await page.loadCookies('data/cookies/taobao.json');  // 恢复登录态
await page.goto('https://item.taobao.com/...');       // 直接已登录！
await page.saveCookies('data/cookies/taobao.json');   // 保存最新
```

### 编程调用提取器

```typescript
import { extract, batchExtract } from './scripts/extractors';

// 单条提取（默认重试 1 次）
const info = await extract('https://v.douyin.com/xxxxx/');
console.log(info.title, info.author, info.elapsedMs);

// 批量提取（复用浏览器 + 汇总报告）
const batch = await batchExtract([
  'https://v.douyin.com/xxxx/',
  'https://www.xiaohongshu.com/explore/zzzz',
], { retries: 2 });
// batch.summary → { total: 2, success: 2, failed: 0, totalElapsedMs, avgElapsedMs }
```

### 行为画像

```typescript
import { BehaviorProfile } from './scripts/behavior-profile';

const page = await browser.newPage();

// 录制 30 秒操作习惯
const profile = await BehaviorProfile.record(page, 30);
profile.save('my-behavior.json');

// 全局设置（后续页面操作都模仿你）
CdpPage.setBehaviorProfile(profile);
// 清除
CdpPage.setBehaviorProfile(null);
```

---

## 📋 API 参考

| 操作 | 方法 | 说明 |
|------|------|------|
| 连接 | `connectBrowser(opts?)` | 自动检测/启动 Chrome，支持代理和独立实例 |
| 新页面 | `browser.newPage()` | 自带 anti-detection 注入 |
| 导航 | `page.goto(url)` | 自动等待加载 + 站点反检测 |
| 执行 JS | `page.evaluate(expr)` | ⚠️ 必须用字符串！ |
| 内容 | `page.content()` / `page.innerText()` | 获取 HTML / 纯文本 |
| 点击 | `page.click(sel)` | 贝塞尔鼠标轨迹 |
| 打字 | `page.typeText(text)` | 逐字符拟真输入 |
| 填值 | `page.fillInput(sel, val)` | React/Vue 兼容 |
| 滚动 | `page.scrollBy(dx, dy)` | 多步微滚 |
| 截图 | `page.screenshot({ path })` | 全页/元素截图 |
| PDF | `page.saveAsPDF(path, opts?)` | Chrome 打印引擎渲染 |
| 弹框 | `page.enableAutoDialog()` | alert/confirm/prompt 自动点掉 |
| 崩溃 | `page.enableCrashAutoRestore()` | 页面崩了自动恢复 |
| 控制台 | `page.enableConsoleCapture({ verbose })` | 抓 console.log 输出 |
| 拦截 | `page.blockResources(['Image'])` | 屏蔽图片/字体加速 |
| 嗅探 | `page.enableMediaSniffing({ verbose })` | 检测视频/音频流 |
| Cookie | `getCookies()` / `setCookie()` / `clearCookies()` | 管理 cookie |
| 登录 | `page.gotoWithLogin(url)` | 检测登录墙等人登录 |
| 连接池 | `createPool({ maxPages: 4 })` | 页面复用，并发安全 |
| 闭合 | `page.close()` / `browser.close()` | 清理 session |

### 提取器返回类型

```typescript
interface ExtractorResult {
  id: string; title: string; author: string; url: string;
  description?: string; publishDate?: string;
  likes?: number; comments?: number; shares?: number;
  coverUrl?: string; raw?: Record<string, any>;
}

interface TimedExtractorResult extends ExtractorResult {
  site: string;      // '抖音' / '小红书' 等
  elapsedMs: number; // 提取耗时
  retries: number;   // 实际重试次数
}
```

---

## 🔧 配置

通过环境变量配置，自动适配 Windows / WSL / Linux。

| 变量 | Windows 默认 | WSL 默认 | 说明 |
|------|-------------|----------|------|
| `CHROME_DEBUG_HOST` | `127.0.0.1` | `172.20.48.1` | CDP 主机地址 |
| `CHROME_DEBUG_PORT` | `9222` | `9223` | 对外连接端口 |
| `CHROME_PORT` | — | `9222` | Chrome 实际监听端口（WSL 用） |
| `CHROME_DATA_DIR` | `C:\temp\chrome-debug` | 同左 | 用户数据目录 |

平台自动检测：`win32` → 直连；`WSL_DISTRO_NAME` → `netsh` 转发；其他 → Linux 模式连远程

---

## 🛡️ 反检测策略

| 网站 | 检测特征 | 应对策略 |
|------|---------|---------|
| 抖音 | `webdriver` / 自动化框架 / 无痕浏览器 | CDP 直连 + anti-detection 注入 + 登录态复用 |
| 小红书 | `__playwright` / `__puppeteer` | CDP 页面清理 + 真实 UA + 随机延时 |
| 淘宝/京东 | canvas 指纹 / 分辨率检测 | 视口抖动 + canvas 噪声注入 |
| 知乎 | 行为分析 / 鼠标轨迹 | 贝塞尔鼠标 + 拟真滚动 |
| 微信公众号 | cookie / 登录态 | 复用已有浏览器 profile |

集成方式示例：

```typescript
import { getScriptsForUrl } from './scripts/anti-detection';
const scripts = getScriptsForUrl('https://www.douyin.com');
```

---

## 📁 项目结构

```
cdp-browser/
├── scripts/
│   ├── cdp-client.ts          # 核心类（CdpConnection/CdpBrowser/CdpPage）
│   ├── cdp-manager.ts         # 连接管理（跨平台/代理/独立实例）
│   ├── cdp-pool.ts            # 页面连接池
│   ├── anti-detection.ts      # 反检测脚本工厂（11 站策略）
│   ├── behavior-profile.ts    # 行为画像录制
│   ├── form-helper.ts         # 表单自动化
│   ├── form-submit.ts         # 表单 CLI
│   ├── extract.ts             # 提取器 CLI
│   ├── media-sniff.ts         # 媒体嗅探 CLI
│   ├── reconnect-test.ts      # 断线重连测试
│   ├── pool-test.ts           # 连接池测试
│   ├── resource-block-test.ts # 资源拦截测试
│   └── extractors/
│       ├── index.ts           # 提取器注册表 + extract/batchExtract
│       ├── types.ts           # 统一返回类型
│       ├── test-all.ts        # 全站实测脚本
│       ├── douyin.ts / kuaishou.ts / xiaohongshu.ts
│       ├── bilibili.ts / weibo.ts
│       ├── taobao.ts / jd.ts / pdd.ts
│       └── zhihu.ts / baidu.ts
├── references/
│   ├── extractors.md          # 提取器开发指南
│   └── site-strategies.md     # 各站反检测策略详解
├── SKILL.md                   # OpenClaw 技能文档
├── package.json
└── README.md
```

---

## ➕ 添加新站点提取器

1. 在 `scripts/extractors/` 下新建 `<site>.ts`，导出 `extract(url, browser?)` 函数
2. 在 `scripts/extractors/index.ts` 的 `REGISTRY` 数组注册一条规则
3. 完成

```typescript
// scripts/extractors/weibo.ts
import { CdpBrowser } from '../cdp-client';
import type { ExtractorResult } from './types';

export async function extract(url: string, browser?: CdpBrowser): Promise<ExtractorResult> {
  // ... 你的提取逻辑
}
```

```typescript
// scripts/extractors/index.ts
import { extract as weiboExtract } from './weibo';
// 加一行：
{ domain: 'weibo.com', name: '微博', extract: weiboExtract },
```

详见 [`references/extractors.md`](./references/extractors.md)。

---

## ⚠️ 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `evaluate()` 箭头函数报错 | tsx 编译注入 `__name` helper | 传**字符串表达式**而非箭头函数 |
| Page 连接断开 | Chrome 被关闭或端口转发失效 | 重新执行 `connectBrowser()` |
| 滑块验证码 | 反检测脚本不够充分 | 注入更多指纹伪造 + 增加操作延时 |
| `netsh：需要管理员权限` | 端口转发首次需要管理员权限 | 手动以管理员身份执行一次 |
| 浏览器没打开 | Chrome 路径或启动参数错误 | 检查 `findChromePath()` 配置 |
| 超时 | 页面加载慢 / 被滑块拦截 | 增加 `timeoutMs` 参数 |
| CDP 字符串正则报错 | `\d` 在 JS 字符串中需转义 | 传 `\\d` 给 `page.evaluate()` |

---

## 🤖 开发方式

本项目 **100% 由 AI Agent 编写**，无人工手写代码。

| 角色 | 工具/模型 |
|------|----------|
| AI 框架 | [OpenClaw](https://openclaw.ai) |
| 主模型 | DeepSeek V4 Pro |
| 子代理 | DeepSeek V4 Flash |
| 代码分析 | CodeGraph |
| 调试测试 | OpenClaw Browser (CDP 直连 Windows Chrome) |
| 开发环境 | WSL2 (Ubuntu) on Windows 11 |
| 总轮次 | 5 轮迭代，0 行人类代码 |

---

## 📄 License

[MIT](./LICENSE) © 2026 dao-ai
