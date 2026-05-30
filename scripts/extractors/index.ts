/**
 * 网站提取器注册表
 *
 * 自动根据 URL 匹配对应的提取器，统一结果格式。
 * 支持重试机制和耗时统计。
 *
 * 用法:
 *   import { extract, batchExtract } from './extractors';
 *   const result = await extract('https://v.douyin.com/xxxx/');
 *   const results = await batchExtract([url1, url2], { retries: 2 });
 */
import type { ExtractorResult } from './types';
import { CdpBrowser } from '../cdp-client';
import { connectBrowser } from '../cdp-manager';

// ─── 类型 ──────────────────────────────────────────────────

export type { ExtractorResult };

export interface ExtractOptions {
  /** Retry count on failure (default: 1) */
  retries?: number;
  /** Delay between retries in ms (default: 2000) */
  retryDelayMs?: number;
}

/** Result with timing metadata */
export interface TimedExtractorResult extends ExtractorResult {
  site: string;
  /** Elapsed time in ms for this extraction */
  elapsedMs: number;
  /** How many retries were attempted (0 = first try succeeded) */
  retries: number;
}

/** Summary after batch extraction */
export interface BatchSummary {
  total: number;
  success: number;
  failed: number;
  totalElapsedMs: number;
  avgElapsedMs: number;
  results: TimedExtractorResult[];
}

export interface ExtractorRule {
  /** URL 匹配模式（站点域名关键词） */
  domain: string;
  /** 站点中文名 */
  name: string;
  /** 提取函数（支持可选 browser 参数以复用连接） */
  extract: (url: string, browser?: CdpBrowser) => Promise<ExtractorResult>;
}

// ─── 注册表 ────────────────────────────────────────────────

import { extract as douyinExtract } from './douyin';
import { extract as kuaishouExtract } from './kuaishou';
import { extract as xiaohongshuExtract } from './xiaohongshu';
import { extract as bilibiliExtract } from './bilibili';
import { extract as weiboExtract } from './weibo';
import { extract as taobaoExtract } from './taobao';
import { extract as jdExtract } from './jd';
import { extract as pddExtract } from './pdd';
import { extract as zhihuExtract } from './zhihu';
import { extract as baiduExtract } from './baidu';

const REGISTRY: ExtractorRule[] = [
  { domain: 'douyin.com', name: '抖音', extract: douyinExtract },
  { domain: 'kuaishou.com', name: '快手', extract: kuaishouExtract },
  { domain: 'xiaohongshu.com', name: '小红书', extract: xiaohongshuExtract },
  { domain: 'xhslink.com', name: '小红书', extract: xiaohongshuExtract },
  { domain: 'bilibili.com', name: 'B站', extract: bilibiliExtract },
  { domain: 'b23.tv', name: 'B站', extract: bilibiliExtract },
  { domain: 'weibo.com', name: '微博', extract: weiboExtract },
  { domain: 'm.weibo.cn', name: '微博', extract: weiboExtract },
  { domain: 'taobao.com', name: '淘宝', extract: taobaoExtract },
  { domain: 'tmall.com', name: '天猫', extract: taobaoExtract },
  { domain: 'jd.com', name: '京东', extract: jdExtract },
  { domain: '3.cn', name: '京东', extract: jdExtract },
  { domain: 'pinduoduo.com', name: '拼多多', extract: pddExtract },
  { domain: 'yangkeduo.com', name: '拼多多', extract: pddExtract },
  { domain: 'zhihu.com', name: '知乎', extract: zhihuExtract },
  { domain: 'baidu.com', name: '百度', extract: baiduExtract },
];

// ─── 自动匹配 ──────────────────────────────────────────────

function matchExtractor(url: string): ExtractorRule | null {
  for (const rule of REGISTRY) {
    if (url.includes(rule.domain)) return rule;
  }
  return null;
}

// ─── 重试工具 ──────────────────────────────────────────────

/** 带重试的提取包装 */
async function retryExtract(
  rule: ExtractorRule,
  url: string,
  browser: CdpBrowser,
  opts: { retries: number; retryDelayMs: number }
): Promise<{ result: ExtractorResult; retries: number; elapsedMs: number }> {
  const t0 = Date.now();
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const result = await rule.extract(url, browser);
      return {
        result,
        retries: attempt,
        elapsedMs: Date.now() - t0,
      };
    } catch (err: any) {
      lastErr = err;
      if (attempt < opts.retries) {
        const delay = opts.retryDelayMs + Math.floor(Math.random() * 1000);
        console.warn(`  🔄 重试 ${attempt + 1}/${opts.retries} (${delay}ms) — ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastErr || new Error('Extraction failed');
}

// ─── Public API ─────────────────────────────────────────────

/**
 * 自动识别 URL 并提取内容（单条）
 *
 * @param url 目标链接
 * @param opts 可选：retries（重试次数，默认 1），retryDelayMs（重试间隔 ms，默认 2000）
 */
export async function extract(
  url: string,
  opts?: ExtractOptions
): Promise<TimedExtractorResult> {
  const rule = matchExtractor(url);
  if (!rule) throw new Error(`不支持的站点: ${url}。已注册: ${REGISTRY.map(r => r.domain).join(', ')}`);

  const browser = await connectBrowser();
  try {
    const retries = opts?.retries ?? 1;
    const retryDelayMs = opts?.retryDelayMs ?? 2000;

    const { result, retries: actualRetries, elapsedMs } = await retryExtract(
      rule, url, browser, { retries, retryDelayMs }
    );

    const timed: TimedExtractorResult = { ...result, site: rule.name, elapsedMs, retries: actualRetries };

    if (actualRetries > 0) {
      console.log(`✅ ${rule.name}: ${result.title || url} (${elapsedMs}ms, ${actualRetries} 次重试)`);
    } else {
      console.log(`✅ ${rule.name}: ${result.title || url} (${elapsedMs}ms)`);
    }

    return timed;
  } finally {
    await browser.close();
  }
}

/**
 * 批量提取 — 复用同一个浏览器实例，支持重试和耗时统计
 *
 * @param urls 需要提取的 URL 列表（支持多个站点混合）
 * @param opts 可选：retries（重试次数，默认 1）
 * @returns 批量结果 + 汇总信息
 */
export async function batchExtract(
  urls: string[],
  opts?: ExtractOptions
): Promise<BatchSummary> {
  if (urls.length === 0) {
    return { total: 0, success: 0, failed: 0, totalElapsedMs: 0, avgElapsedMs: 0, results: [] };
  }

  const retries = opts?.retries ?? 1;
  const retryDelayMs = opts?.retryDelayMs ?? 2000;
  const batchT0 = Date.now();
  const results: TimedExtractorResult[] = [];
  let success = 0;
  let failed = 0;

  console.log(`🚀 批量提取 ${urls.length} 条 (最多重试 ${retries} 次)`);
  const browser = await connectBrowser();

  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const rule = matchExtractor(url);

      if (!rule) {
        console.warn(`⚠️  [${i + 1}/${urls.length}] 不支持的站点: ${url}`);
        results.push({
          id: '', title: '', author: '', url,
          site: 'unknown', elapsedMs: 0, retries: 0,
        });
        failed++;
        continue;
      }

      try {
        const { result, retries: actualRetries, elapsedMs } = await retryExtract(
          rule, url, browser, { retries, retryDelayMs }
        );
        const retryTag = actualRetries > 0 ? ` (${actualRetries} 次重试)` : '';
        console.log(`✅ [${i + 1}/${urls.length}] ${rule.name}: ${result.title || url} (${elapsedMs}ms${retryTag})`);
        results.push({ ...result, site: rule.name, elapsedMs, retries: actualRetries });
        success++;
      } catch (err: any) {
        console.warn(`❌ [${i + 1}/${urls.length}] ${rule.name} 失败 (${retries} 次重试后): ${err.message}`);
        results.push({
          id: '', title: err.message, author: '', url,
          site: rule.name, elapsedMs: 0, retries: retries,
        });
        failed++;
      }
    }
  } finally {
    await browser.close();
  }

  const totalElapsedMs = Date.now() - batchT0;
  const summary: BatchSummary = {
    total: urls.length,
    success,
    failed,
    totalElapsedMs,
    avgElapsedMs: results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.elapsedMs, 0) / results.length)
      : 0,
    results,
  };

  console.log([
    `\n📊 批量提取完成`,
    `   成功: ${success}  失败: ${failed}  总耗时: ${(totalElapsedMs / 1000).toFixed(1)}s`,
    `   平均: ${summary.avgElapsedMs}ms/条`,
  ].join('\n'));

  return summary;
}

/** 获取已注册的站点列表 */
export function listSites() {
  return REGISTRY.map(r => ({ domain: r.domain, name: r.name }));
}
