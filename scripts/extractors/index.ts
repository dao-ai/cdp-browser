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
import { matchSite, SITE_REGISTRY } from '../sites';
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
  /** Max concurrent pages (default: 3, for batchExtract) */
  concurrency?: number;
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

// ─── 提取器映射 ────────────────────────────────────────────
// cookieKey → extract 函数，域名匹配统一走 sites.ts

const EXTRACTORS: Record<string, (url: string, browser?: CdpBrowser) => Promise<ExtractorResult>> = {
  'douyin': douyinExtract,
  'kuaishou': kuaishouExtract,
  'xiaohongshu': xiaohongshuExtract,
  'bilibili': bilibiliExtract,
  'weibo': weiboExtract,
  'taobao': taobaoExtract,
  'jd': jdExtract,
  'pdd': pddExtract,
  'zhihu': zhihuExtract,
  'baidu': baiduExtract,
};

// ─── 登录墙检测 ───────────────────────────────────────────

/** 检测提取结果是否遇到了登录墙 */
function isLoginWall(result: ExtractorResult): string | null {
  const t = (result.title || '').toLowerCase();
  const d = (result.description || '').toLowerCase();
  const u = (result.url || '').toLowerCase();

  // 标题直接是"登录"
  if (t === '登录' || t === '请登录' || t === 'login' || t === 'sign in') return '需要登录';
  // URL 跳到了登录页或验证码
  if (u.includes('/login') || u.includes('/passport') || u.includes('/signin') || u.includes('/auth')) return '跳转到登录页';
  if (u.includes('captcha') || u.includes('verify') || u.includes('geetest')) return '遇到验证码';
  // 标题是泛化的域名/站名（说明没拿到具体内容）
  if (t === '小红书' || t === '拼多多商城' || t === '微博正文' || t === '抖音精选电脑版' || t === '出错啦! - bilibili.com') return '需要登录或内容不可访问';
  // 描述或标题提到"请登录"
  if (d.includes('请登录') || t.includes('请先登录') || d.includes('请先登录')) return '需要登录';
  // 空标题/description 说明没拿到内容
  if (!t || t === '页面不存在' || t === 'not found' || t === '404' || t.includes('找不到') || t.includes('不存在')) return '内容不存在或无法访问';
  // 标题或描述提到验证/安全验证
  if (t.includes('验证') || d.includes('安全验证') || d.includes('人机验证')) return '遇到安全验证';

  return null;
}

// ─── 注册表（从统一站点注册表展开）────────────────────────

const REGISTRY: ExtractorRule[] = SITE_REGISTRY.flatMap(site => {
  const extract = EXTRACTORS[site.cookieKey];
  if (!extract) return [];
  return site.domains.map(domain => ({ domain, name: site.name, extract }));
});

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

    const loginIssue = isLoginWall(result);
    if (loginIssue) {
      timed.loginRequired = true;
      console.log(`🔐 ${rule.name}: ${loginIssue} → ${result.title || url} (${elapsedMs}ms)`);
    } else if (actualRetries > 0) {
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
  const concurrency = Math.min(opts?.concurrency ?? 3, urls.length);
  const batchT0 = Date.now();

  // 按原始顺序占位，worker 完成后填入对应位置
  const results: (TimedExtractorResult | null)[] = new Array(urls.length).fill(null);
  let success = 0;
  let failed = 0;

  // worker 共享的待处理索引队列
  const queue = urls.map((_, i) => i);

  console.log(`🚀 批量提取 ${urls.length} 条 (并发 ${concurrency}, 最多重试 ${retries} 次)`);
  const browser = await connectBrowser();

  const processOne = async (idx: number) => {
    const url = urls[idx];
    const rule = matchExtractor(url);

    if (!rule) {
      console.warn(`⚠️  [${idx + 1}/${urls.length}] 不支持的站点: ${url}`);
      results[idx] = {
        id: '', title: '', author: '', url,
        site: 'unknown', elapsedMs: 0, retries: 0,
      };
      failed++;
      return;
    }

    try {
      const { result, retries: actualRetries, elapsedMs } = await retryExtract(
        rule, url, browser, { retries, retryDelayMs }
      );

      const loginIssue = isLoginWall(result);
      if (loginIssue) {
        result.loginRequired = true;
        console.log(`🔐 [${idx + 1}/${urls.length}] ${rule.name}: ${loginIssue} → ${result.title || url} (${elapsedMs}ms)`);
      } else {
        const retryTag = actualRetries > 0 ? ` (${actualRetries} 次重试)` : '';
        console.log(`✅ [${idx + 1}/${urls.length}] ${rule.name}: ${result.title || url} (${elapsedMs}ms${retryTag})`);
      }
      results[idx] = { ...result, site: rule.name, elapsedMs, retries: actualRetries };
      success++;
    } catch (err: any) {
      console.warn(`❌ [${idx + 1}/${urls.length}] ${rule.name} 失败 (${retries} 次重试后): ${err.message}`);
      results[idx] = {
        id: '', title: err.message, author: '', url,
        site: rule.name, elapsedMs: 0, retries: retries,
      };
      failed++;
    }
  };

  try {
    // Worker 池：每个 worker 从共享队列取下一个索引处理
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const idx = queue.shift()!;
        await processOne(idx);
      }
    });
    await Promise.all(workers);
  } finally {
    await browser.close();
  }

  const totalElapsedMs = Date.now() - batchT0;
  const completedResults = results.filter((r): r is TimedExtractorResult => r !== null);
  const summary: BatchSummary = {
    total: urls.length,
    success,
    failed,
    totalElapsedMs,
    avgElapsedMs: completedResults.length > 0
      ? Math.round(completedResults.reduce((s, r) => s + r.elapsedMs, 0) / completedResults.length)
      : 0,
    results: completedResults,
  };

  const loginCount = completedResults.filter(r => r.loginRequired).length;

  const lines = [
    `\n📊 批量提取完成`,
    `   成功: ${success}  失败: ${failed}  总耗时: ${(totalElapsedMs / 1000).toFixed(1)}s`,
    `   平均: ${summary.avgElapsedMs}ms/条`,
  ];
  if (loginCount > 0) {
    lines.push(`   🔐 需登录: ${loginCount} 条 → 用 cookie-manager.ts 保存登录态后重试`);
  }
  console.log(lines.join('\n'));

  return summary;
}

/** 获取已注册的站点列表（所有域名 × 站点名） */
export function listSites() {
  return SITE_REGISTRY.flatMap(s => s.domains.map(d => ({ domain: d, name: s.name })));
}
