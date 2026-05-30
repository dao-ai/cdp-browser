---
name: cdp-browser
description: "Use when a target website detects Playwright, Puppeteer, Selenium, or other automation tools and requires real Chrome CDP with anti-detection injection and humanized interaction."
---

# CDP 反检测浏览器

Windows 真 Chrome + CDP 协议直连，零第三方依赖。自动 anti-detection、人类化交互、跨平台自适应。

```
AI 代码 → CDP WebSocket → Windows 真 Chrome → 目标网站
```

## 安装 & 连接

```bash
cd skills/cdp-browser && npm install
npx tsx scripts/cdp-manager.ts --test   # 测试连接
```

```typescript
import { connectBrowser } from './scripts/cdp-manager';
const browser = await connectBrowser();              // 日常 Chrome
const browser2 = await connectBrowser({              // 独立实例 + 代理
  launchNew: true, proxy: 'http://127.0.0.1:7890',
});
const page = await browser.newPage();                // 自带反检测注入
await page.goto('https://example.com', { timeoutMs: 30000 });
```

## API 速查

### 页面操作
| 方法 | 说明 |
|------|------|
| `page.goto(url)` / `page.reload()` / `page.goBack()` / `page.goForward()` | 导航 |
| `page.evaluate('document.title')` | 页面 JS 执行（注意用字符串，不用箭头函数） |
| `page.content()` / `page.innerText()` / `page.url()` | 获取内容 |
| `page.click(selector)` / `page.typeText(text)` | 贝塞尔鼠标 + 拟真打字 |
| `page.fillInput(sel, val)` | 填值（React/Vue 兼容） |
| `page.scrollBy(0, 1000)` / `page.scrollByJs(0, 500)` | 分步微滚 |
| `page.waitForSelector(sel, ms)` / `page.waitForResponse(pattern)` | 等待元素/请求 |
| `page.screenshot({ path: '/tmp/p.png' })` / `page.screenshotElement(sel, path)` | 截图 |
| `page.saveAsPDF('/tmp/p.pdf', { landscape, printBackground, ... })` | 导出 PDF |

### Cookie & 数据
| 方法 | 说明 |
|------|------|
| `page.getCookies()` / `page.setCookie({...})` / `page.clearCookies()` | Cookie 操作 |
| `page.setCookie({name, value, domain, ...})` / `page.setCookies([...])` | 批量设 Cookie |
| `browser.clearSiteData(['https://example.com'])` | 清整站数据 |

### 抗检测 & 人类化
| 方法 | 说明 |
|------|------|
| `page.setViewport(w, h)` | 设置视口（自动 ±18px 抖动） |
| `page.gotoWithLogin(url, { loginPatterns, successPatterns })` | 导航并等待手动登录 |
| `page.addInitScript(src)` | 注入脚本（每页加载前执行） |
| `BehaviorProfile.record(page, 30)` | 录制 30 秒真人操作习惯 |
| `CdpPage.setBehaviorProfile(profile)` | 全局启用画像 |

### 网络控制
| 方法 | 说明 |
|------|------|
| `page.blockResources(['Image', 'Font'])` | 屏蔽资源类型加速 |
| `page.enableRequestInterception({ handler, blockUrls, ... })` | 精细拦截 |
| `page.setExtraHTTPHeaders({ 'X-Custom': 'v' })` | 自定义请求头 |
| `page.enableMediaSniffing({ verbose })` | 嗅探视频/音频 |
| `page.getDetectedMedia({ sortBy: 'size' })` / `page.getMediaSummary()` | 获取嗅探结果 |
| `page.setPageProxy('http://proxy:port')` | 页面级代理（实验性） |

### 表单 & 弹框
| 方法 | 说明 |
|------|------|
| `fillForm(page, { fields, submit })` | 批量填表 |
| `formSubmit(page, { url, fields, submit, successUrl })` | 一站式提交 |
| `selectOption(page, sel, val)` / `check(page, sel)` / `uncheck(page, sel)` | 表单控件 |
| `page.enableAutoDialog('accept')` / `page.enableAutoDialog('dismiss')` | 自动处理弹框 |
| `page.enableAutoDialog('accept', '', callback)` | 自定义弹框逻辑 |

### 稳定性 & 调试
| 方法 | 说明 |
|------|------|
| `page.enableConsoleCapture({ verbose, filter })` / `page.getConsoleLogs({ level })` | 控制台捕获 |
| `page.enableCrashAutoRestore()` | 页面崩溃自动恢复 |
| `browser.status` / `browser.onReconnect(cb)` / `browser.onPageCrash(cb)` | 连接状态 & 事件 |
| `browser.connection.onDisconnect(cb)` / `browser.connection.onReconnect(cb)` | 断线重连 |
| `page.onConsoleEntry(cb)` / `page.onDialog(cb)` | 监听回调 |

### 连接池
| 方法 | 说明 |
|------|------|
| `createPool({ maxPages: 4 })` | 创建连接池 |
| `pool.withPage(async (page) => { ... })` | 获取页 → 使用 → 归还 |
| `pool.acquire()` / `pool.release(page)` | 手动管理 |
| `pool.close()` / `pool.status()` | 关闭 / 查看状态 |

## 场景指南

### 🕸️ 内容提取

```bash
# CLI
npx tsx scripts/extract.ts 'https://v.douyin.com/xxxx/'
npx tsx scripts/extract.ts --json 'url1' 'url2' --retries 2
npx tsx scripts/extract.ts --list                    # 已注册站点
```

```typescript
import { extract, batchExtract } from './scripts/extractors';
const info = await extract('https://v.douyin.com/xxxx/');
const batch = await batchExtract([url1, url2], { retries: 2 });
// info → { id, title, author, url, description, publishDate, likes, ... }
// batch → { total, success, failed, results, summary }
```

**已注册站点：** 抖音 / 快手 / 小红书 / B站 / 微博 / 淘宝 / 天猫 / 京东 / 拼多多 / 知乎 / 百度

> ⚠️ 淘宝/小红书/微博/拼多多 需要登录态才能稳定提取。

### 🚀 加速加载

```typescript
await page.blockResources(['Image', 'Font', 'Media']);  // 实测百度提速 30%
await page.goto('https://example.com');
```
可拦截 13 种资源类型，按 MIME 或 URL 过滤，支持自定义回调。

### 🔍 嗅探视频

```bash
npx tsx scripts/media-sniff.ts 'https://example.com/video'
npx tsx scripts/media-sniff.ts --fast --types mp4,hls '...'
```
自动检测 MP4 / HLS (.m3u8) / DASH / FLV / MP3 等。MIME + URL 双路识别。

### 📋 填表提交

```bash
npx tsx scripts/form-submit.ts \
  --url 'https://example.com/login' \
  --field 'input[name="username"]=admin' \
  --field 'input[name="password"]=secret' \
  --submit 'button[type="submit"]'
```
支持 text / select / checkbox / file upload。自动检测字段类型。

### 🛡️ 断线 & 崩溃保护

```typescript
await page.enableCrashAutoRestore();   // 页面崩了自动重建
await page.enableAutoDialog();         // 弹框自动点掉
// 自动重连：WebSocket 断开 → 指数退避（最多 10 次）→ 自动重附加所有页面
```

### 📡 代理 & 独立实例

```typescript
const browser = await connectBrowser({
  launchNew: true,                      // 独立 Chrome，不碰日常用的
  proxy: 'http://127.0.0.1:7890',      // 走代理
});
```

或者手动启动：
```bash
chrome.exe --remote-debugging-port=9222 --proxy-server=http://127.0.0.1:7890
```

### 🧪 调试 & 测试

```bash
npx tsx scripts/cdp-manager.ts --status            # 查看 Chrome 状态
npx tsx scripts/cdp-manager.ts --open-url <url>    # 打开页面
npx tsx scripts/cdp-manager.ts --login <url>       # 手动登录
npx tsx scripts/behavior-profile.ts --record 30    # 录制行为画像
npx tsx scripts/pool-test.ts                       # 连接池测试
npx tsx scripts/extractors/test-all.ts             # 提取器全站实测
```

## 跨平台配置

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `CHROME_DEBUG_HOST` | CDP 主机 | Win:`127.0.0.1` WSL:`172.20.48.1` |
| `CHROME_DEBUG_PORT` | 对外端口 | Win:`9222` WSL:`9223` |
| `CHROME_PORT` | Chrome 监听端口（WSL） | `9222` |
| `CHROME_DATA_DIR` | Chrome 数据目录 | `C:\temp\chrome-debug` |

平台自动检测：`win32` → Windows 直连 / 有 WSLInterop → WSL netsh 转发 / 其他 → 纯 Linux

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| `evaluate()` 报 `__name is not defined` | tsx 注入 helper | 传**字符串表达式**，不用箭头函数 |
| 连接断开 / 超时 | Chrome 关闭或端口转发失效 | 重连自动恢复，或重新 `connectBrowser()` |
| 滑块验证码 | 反检测不够 | 注入更多指纹 + 行为画像 |
| 页面跳登录 | 需要登录态 | 先用 `--login` 手动登录一次 |
| CDP 正则匹配失败 | `\d` 转义问题 | 字符串中写 `\\d` |
| 代理不生效 | Chrome 已运行 | 关掉 Chrome 重连，或用 `launchNew: true` |

## 添加新提取器

1. `scripts/extractors/` 下新建 `<site>.ts`，导出 `extract(url): Promise<ExtractorResult>`
2. `scripts/extractors/index.ts` 的 `REGISTRY` 加一行
3. `scripts/anti-detection.ts` 补充 site strategy（可选）

```typescript
// scripts/extractors/example.ts
export async function extract(url: string, browser?: CdpBrowser): Promise<ExtractorResult> {
  const ownBrowser = !browser;
  if (!browser) browser = await connectBrowser();
  let page = null;
  try {
    page = await browser.newPage();
    await page.goto(url, { timeoutMs: 30000 });
    const title = await page.evaluate('document.title');
    return { id: '', title, author: '', url };
  } finally {
    if (page) try { await page.close(); } catch {}
    if (ownBrowser) await browser.close();
  }
}
```

## 目录结构

```
scripts/
  cdp-client.ts          # 核心 CDP 类（CdpConnection / CdpBrowser / CdpPage）
  cdp-manager.ts         # 连接管理器（跨平台 + 代理 + 独立实例）
  anti-detection.ts      # 反检测脚本工厂（11 站策略）
  behavior-profile.ts    # 行为画像录制
  cdp-pool.ts            # 页面连接池
  form-helper.ts         # 表单自动化
  form-submit.ts         # 表单 CLI
  extract.ts             # 提取器 CLI
  media-sniff.ts         # 媒体嗅探 CLI
  reconnect-test.ts      # 断线重连测试
  pool-test.ts           # 连接池测试
  resource-block-test.ts # 资源拦截测试
  extractors/
    index.ts             # 提取器注册表
    types.ts             # 返回类型
    douyin.ts            # 抖音
    kuaishou.ts          # 快手
    xiaohongshu.ts       # 小红书
    bilibili.ts          # B站
    weibo.ts             # 微博
    taobao.ts            # 淘宝/天猫
    jd.ts                # 京东
    pdd.ts               # 拼多多
    zhihu.ts             # 知乎
    baidu.ts             # 百度
    test-all.ts          # 全站实测脚本
```
