/**
 * Anti-detection 注入脚本工厂
 *
 * 为不同网站类型提供针对性 anti-detection 脚本组合。
 * 每个脚本是 `Page.addScriptToEvaluateOnNewDocument` 的 source 字符串。
 */
import { CdpPage } from './cdp-client';

// ─── 基础 anti-detection（所有网站通用） ─────────────────

function baseScripts(): string[] {
  return [
    `Object.defineProperty(navigator, 'webdriver', { get: () => false })`,
    `delete window.__playwright`,
    `delete window.__pwInitScripts`,
    `delete window.__pwScriptsToEvaluateOnNewDocument`,
    `delete window.__nightmare`,
    `delete window.__selenium`,
    `delete window.__puppeteer`,
    `delete window.__katalon`,
    `delete window.__CEDAR`,
    `delete window.__driver_evaluate`,
    `delete window.__webdriver_evaluate`,
    `if (!window.chrome) window.chrome = {}`,
    `if (!window.chrome.runtime) window.chrome.runtime = {}`,
    `window.chrome.runtime.id = 'cdp-browser'`,
  ];
}

// ─── 各站特定脚本 ───────────────────────────────────────

function douyinScripts(): string[] {
  return [
    ...baseScripts(),
    // 抖音检测 navigator.plugins.length
    `if (navigator.plugins && navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] })
    }`,
    // 抖音检测 languages
    `if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
    }`,
    // 伪造性能指标
    `try {
      const navEntry = performance.getEntriesByType('navigation')[0];
      if (navEntry && navEntry.type !== 'navigate') {
        Object.defineProperty(navEntry, 'type', { get: () => 'navigate' });
      }
    } catch(e){}`,
  ];
}

function xiaohongshuScripts(): string[] {
  return [
    ...baseScripts(),
    `Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] })`,
    `Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })`,
  ];
}

function taobaoScripts(): string[] {
  return [
    ...baseScripts(),
    // 淘宝检测 canvas fingerprint
    `(() => {
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        const ctx = origGetContext.call(this, type, ...args);
        if (type === '2d' && ctx) {
          const origFillText = ctx.fillText;
          ctx.fillText = function(...args) {
            // Add subtle noise (1px offset) to canvas fingerprint
            origFillText.call(this, ...args);
            origFillText.call(this, ...args.map((a, i) => i === 0 ? a + String.fromCharCode(0) : a));
          };
        }
        return ctx;
      };
    })()`,
  ];
}

function weixinScripts(): string[] {
  return [
    ...baseScripts(),
    `Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })`,
    `Object.defineProperty(navigator, 'userAgent', { get: () => navigator.userAgent.replace(/Headless|ChromeHeadless/g, '') })`,
  ];
}

function bilibiliScripts(): string[] {
  return [
    ...baseScripts(),
    // B站检测较少，基础 anti-detection 足够
    `Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })`,
  ];
}

function weiboScripts(): string[] {
  return [
    ...baseScripts(),
    `Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] })`,
    `Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })`,
  ];
}

function zhihuScripts(): string[] {
  return [
    ...baseScripts(),
    // 知乎行为分析严格，额外伪造一些特征
    `Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })`,
    `Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 })`,
    `Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 })`,
  ];
}

function baiduScripts(): string[] {
  return [
    ...baseScripts(),
    // 百度反爬主要靠频率，single page 无需特殊处理
    `Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })`,
  ];
}

// ─── 按域名自动选择 ───────────────────────────────────────

const SITE_STRATEGIES: Record<string, () => string[]> = {
  'douyin.com': douyinScripts,
  'xiaohongshu.com': xiaohongshuScripts,
  'xhslink.com': xiaohongshuScripts,
  'taobao.com': taobaoScripts,
  'tmall.com': taobaoScripts,
  'jd.com': taobaoScripts,
  'weixin.qq.com': weixinScripts,
  'mp.weixin.qq.com': weixinScripts,
  'bilibili.com': bilibiliScripts,
  'b23.tv': bilibiliScripts,
  'weibo.com': weiboScripts,
  'm.weibo.cn': weiboScripts,
  'zhihu.com': zhihuScripts,
  'zhuanlan.zhihu.com': zhihuScripts,
  'baidu.com': baiduScripts,
};

function detectSite(url: string): string {
  for (const [domain] of Object.entries(SITE_STRATEGIES)) {
    if (url.includes(domain)) return domain;
  }
  return '';
}

/**
 * 为指定 URL 获取 anti-detection 脚本列表
 */
export function getScriptsForUrl(url: string): string[] {
  const site = detectSite(url);
  const strategy = SITE_STRATEGIES[site];
  if (strategy) return strategy();
  return baseScripts();
}

/**
 * 在 CdpPage 上部署针对 URL 的 anti-detection
 * 如果 page.buildScripts 方法存在则优先使用，否则 fallback 到逐个注入
 */
export async function deployAntiDetection(page: CdpPage, url: string) {
  const scripts = getScriptsForUrl(url);
  // Skip base scripts (already deployed in CdpPage constructor)
  const extra = scripts.slice(baseScripts().length);
  for (const script of extra) {
    try {
      await page.addInitScript(script);
    } catch (e) {
      console.warn(`[anti-detection] 注入失败 [${url}]:`, e);
    }
  }
}

export { baseScripts, douyinScripts, xiaohongshuScripts, taobaoScripts, weixinScripts, bilibiliScripts, weiboScripts, zhihuScripts, baiduScripts };
