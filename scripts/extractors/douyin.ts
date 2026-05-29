/**
 * 抖音视频提取器
 *
 * 从抖音分享链接提取视频信息：
 *   - v.douyin.com/xxx 短链接
 *   - douyin.com/video/xxx 长链接
 *   - 分享文本自动提取短链接
 */
import { randomDelay, CdpBrowser } from '../cdp-client';
import { connectBrowser } from '../cdp-manager';
import type { ExtractorResult } from './types';

// ─── 工具 ──────────────────────────────────────────────────

function parseNum(s: string): number {
  const clean = s.replace(/,/g, '');
  if (clean.endsWith('万')) return parseFloat(clean) * 10000;
  if (clean.endsWith('亿')) return parseFloat(clean) * 100000000;
  return parseFloat(clean) || 0;
}

/** 从分享文本中提取短链接 */
function extractShortUrl(text: string): string {
  const m = text.match(/https?:\/\/v\.douyin\.com\/[a-zA-Z0-9]+\//);
  return m ? m[0] : text;
}

// ─── 提取函数 ──────────────────────────────────────────────

/**
 * 从抖音视频页提取信息
 *
 * 核心思路是从 `meta[name="description"]` 解析，
 * 该标签不受登录态影响，稳定可用。
 *
 * meta 格式示例:
 *   "ECC 火了：这套给 AI Agent 上"工程纪律"的开源系统 - 作者于20260528发布在抖音，已经收获了1.6万个喜欢，来抖音，记录美好生活！"
 *
 * @param shareUrl 抖音分享链接
 * @param browser 可选，复用已有浏览器实例（批量提取用）
 */
export async function extract(shareUrl: string, browser?: CdpBrowser): Promise<ExtractorResult> {
  const url = extractShortUrl(shareUrl);
  const ownBrowser = !browser;
  if (!browser) browser = await connectBrowser();
  let page: any = null;

  try {
    page = await browser.newPage();
    await page.setViewport(1280, 720);

    // 导航到视频页
    await page.goto(url, { timeoutMs: 35000 });
    await randomDelay(7000, 10000);

    // 用字符串表达式，不用箭头函数（防 tsx 注入 __name）
    const meta = await page.evaluate(
      `document.querySelector('meta[name="description"]')?.getAttribute('content') || ''`
    );
    const title = await page.evaluate('document.title || ""');
    const currentUrl = await page.evaluate('location.href');

    // 解析
    const videoId = (currentUrl.match(/video\/(\d+)/) || [])[1] || '';

    // 作者："- 作者名称于20260528发布"
    const authorRe = /- ([^\d]+?)于\d{8}发布/;
    const authorMatch = meta.match(authorRe);
    const author = authorMatch ? authorMatch[1].trim() : 'N/A';

    // 标题：取 title 中第一个 " - " 之前的部分
    const cleanTitle = title.split(' - ')[0] || title;

    // 点赞数
    const likeRe = /已经收获了([\d.]+[万亿]?)个喜欢/;
    const likeMatch = meta.match(likeRe);
    const likes = likeMatch ? parseNum(likeMatch[1]) : 0;

    // 发布时间
    const dateRe = /于(\d{8})发布/;
    const dateMatch = meta.match(dateRe);
    const publishDate = dateMatch
      ? `${dateMatch[1].slice(0, 4)}-${dateMatch[1].slice(4, 6)}-${dateMatch[1].slice(6, 8)}`
      : undefined;

    // 封面图
    let coverUrl: string | undefined;
    try {
      coverUrl = await page.evaluate(
        `document.querySelector('video[poster]')?.getAttribute('poster') || document.querySelector('meta[property="og:image"]')?.getAttribute('content') || ''`
      );
    } catch {}

    return {
      id: videoId,
      title: cleanTitle,
      author,
      url: currentUrl,
      description: meta,
      publishDate,
      likes,
      coverUrl: coverUrl || undefined,
    };
  } finally {
    if (page) try { await page.close(); } catch {}
    if (ownBrowser) await browser.close();
  }
}
