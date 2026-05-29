# 编写提取器指南

提取器（Extractor）是从网站提取结构化数据的模块。每个网站一个文件，遵循统一接口，自动注册到 `extractors/index.ts`。

## 接口

```typescript
// 导出函数签名必须一致
// browser 参数可选，传了则复用已有浏览器实例（批量提取用）
export async function extract(url: string, browser?: CdpBrowser): Promise<ExtractorResult>
```

`ExtractorResult` 定义在 `extractors/types.ts`，参见 SKILL.md 的「统一返回格式」。

## 提取器模板

```typescript
// scripts/extractors/xxx.ts
import { randomDelay, CdpBrowser } from '../cdp-client';
import { connectBrowser } from '../cdp-manager';
import type { ExtractorResult } from './types';

export async function extract(url: string, browser?: CdpBrowser): Promise<ExtractorResult> {
  const ownBrowser = !browser;
  if (!browser) browser = await connectBrowser();
  let page: any = null;

  try {
    page = await browser.newPage();         // 自动 anti-detection
    await page.setViewport(1280, 720);

    await page.goto(url, { timeoutMs: 35000 });
    await randomDelay(3000, 6000);           // 等 SPA 渲染

    // ⚠️ 用字符串表达式，不用箭头函数
    const title = await page.evaluate('document.title || ""');

    return {
      id: '',
      title,
      author: '',
      url: await page.evaluate('location.href'),
    };
  } finally {
    if (page) try { await page.close(); } catch {}
    if (ownBrowser) await browser.close();  // 只关闭自己创建的浏览器
  }
}
```

## 注册到系统

```typescript
// scripts/extractors/index.ts

// 1. 导入
import { extract as xxxExtract } from './xxx';

// 2. 加到 REGISTRY 数组
const REGISTRY: ExtractorRule[] = [
  { domain: 'douyin.com', name: '抖音', extract: douyinExtract },
  { domain: 'xxx.com', name: '站点名', extract: xxxExtract },   // ← 新加的
];
```

## 最佳实践

### CDP 连接管理
- 提取函数接受可选 `browser` 参数，支持单条调用（自建自关）和批量复用
- 用 `ownBrowser` 标记判断是否是自己创建的浏览器，只在 `ownBrowser=true` 时 `browser.close()`
- 每条提取仍创建独立 `page`（防指纹泄露），但复用同一个 `browser`（省 Chrome 启动时间）
- 用 `try/finally` 保证 `page.close()` 一定执行

### 数据提取
- 优先从 `meta[name="description"]` 等 meta 标签提取（登录无关、稳定）
- 次选 `document.title`、`og:image` 等公开属性
- 尽量少用复杂 DOM 查询（结构变化会断）
- evaluate 内**永远传字符串表达式**，防止 tsx 注入 helper

### 正则注意事项
在 TypeScript 的 `//` 字面量中：
```typescript
// 在 ts 层执行：使用单反斜杠
const re = /- ([^\d]+?)于\d{8}发布/;
```

在传给浏览器 evaluate 的**字符串**中：
```typescript
// 在浏览器执行：字符串里 \\ → \，浏览器收到 \d
await page.evaluate(`body.innerText.match(/\\d{4}/)`);
//                                     ↑↑ 双反斜杠
```

### 超时处理
- 页面加载视网站复杂度给 25-40s timeout
- SPA 页面加载后额外等 3-8s 等待异步渲染
- 不要依赖 `DOMContentLoaded`，很多 SPA 会之后再渲染

### 稳定性
- 页面结构可能随时变化，**定期验证**（每 2-4 周跑一次）
- 对提取不到的数据用 `undefined` 而非 `''`（调用方好区分「没提取到」vs「空字符串」）
- 重要字段（id、title）如果提取不到，考虑主动抛错误而非返回空数据

## 测试

```bash
# 跑单个 URL
npx tsx scripts/extract.ts 'https://目标站链接'

# JSON 输出便于程序判断
npx tsx scripts/extract.ts --json 'https://目标站链接'

# 批量提取（自动复用浏览器）
npx tsx scripts/extract.ts 'https://链接1' 'https://链接2' 'https://链接3'

# 强制 JSON 批量
npx tsx scripts/extract.ts --json 'https://链接1' 'https://链接2'
```

对于新建提取器，建议先用 `cdp-client` 手动调通提取逻辑，确认数据能稳定拿到后，再包装成 `extract()` 函数，最后注册到 registry。
