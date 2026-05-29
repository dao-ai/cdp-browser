/**
 * 快手视频提取器
 *
 * 从快手分享链接提取视频信息：
 *   - v.kuaishou.com/xxx 短链接
 *   - kuaishou.com/short-video/xxx 长链接
 *
 * 与抖音提取器类似，核心从 meta[name="description"] 解析，
 * 该标签不受登录态影响。
 */
import { randomDelay, CdpBrowser } from '../cdp-client';
import { connectBrowser } from '../cdp-manager';
import type { ExtractorResult } from './types';

// ─── 工具 ──────────────────────────────────────────────────

function parseNum(s: string): number {
  const clean = s.replace(/,/g, '');
  if (clean.endsWith('万')) return parseFloat(clean) * 10000;
  if (clean.endsWith('亿')) return parseFloat(clean) * 100000000;
  if (clean.endsWith('w')) return parseFloat(clean) * 10000;
  return parseFloat(clean) || 0;
}

/** 提取短链接 */
function extractShortUrl(text: string): string {
  const m = text.match(/https?:\/\/v\.kuaishou\.com\/[a-zA-Z0-9]+/);
  return m ? m[0] : text;
}

// ─── 提取函数 ──────────────────────────────────────────────

export async function extract(shareUrl: string, browser?: CdpBrowser): Promise<ExtractorResult> {
  const url = extractShortUrl(shareUrl);
  const ownBrowser = !browser;
  if (!browser) browser = await connectBrowser();
  let page: any = null;

  try {
    page = await browser.newPage();
    await page.setViewport(1280, 720);

    // 导航到视频页
    await page.goto(url, { timeoutMs: 40000 });
    await randomDelay(6000, 10000);

    // 用字符串表达式提取
    const meta = await page.evaluate(
      `document.querySelector('meta[name="description"]')?.getAttribute('content') || ''`
    );
    const title = await page.evaluate('document.title || ""');
    const currentUrl = await page.evaluate('location.href');

    // 视频 ID
    const videoId = (currentUrl.match(/short-video\/([a-zA-Z0-9]+)/) || currentUrl.match(/v\.kuaishou\.com\/([a-zA-Z0-9]+)/) || [])[1] || '';

    // 快手 meta 格式类似抖音：
    // "视频标题 #话题 #快手 作者名于20260529发布..."
    let author = 'N/A';
    const authorRe = /位于?(\d{8})发布/;
    const authorMatch = meta.match(authorRe);
    if (authorMatch) {
      const idx = meta.indexOf(authorMatch[0]);
      // 作者通常在发布日期标记之前，以空格分隔
      const before = meta.slice(0, idx).trim();
      const parts = before.split(/[#\s]+/).filter(Boolean);
      if (parts.length > 0) author = parts[parts.length - 1];
    }

    // 标题：取 title 简化
    const cleanTitle = title.split(' - ')[0] || title;

    // 点赞数（快手 meta 中可能有）
    let likes = 0;
    const likeRe = /([\d.]+[万亿w]?)次?播放|([\d.]+[万亿w]?)个?赞/;
    const likeMatch = meta.match(likeRe);
    if (likeMatch) likes = parseNum(likeMatch[1] || likeMatch[2] || '0');

    // 发布时间
    const dateRe = /于?(\d{8})发布/;
    const dateMatch = meta.match(dateRe);
    const publishDate = dateMatch
      ? `${dateMatch[1].slice(0, 4)}-${dateMatch[1].slice(4, 6)}-${dateMatch[1].slice(6, 8)}`
      : undefined;

    // 封面图
    let coverUrl: string | undefined;
    try {
      coverUrl = await page.evaluate(
        `document.querySelector('video[poster]')?.getAttribute('poster') || document.querySelector('meta[property="og:image"]')?.getAttribute('content') || document.querySelector('meta[itemprop="image"]')?.getAttribute('content') || ''`
      );
    } catch {}

    return {
      id: videoId,
      title: cleanTitle,
      author,
      url: currentUrl,
      description: meta,
      publishDate,
      likes: likes || undefined,
      coverUrl: coverUrl || undefined,
    };
  } finally {
    if (page) try { await page.close(); } catch {}
    if (ownBrowser) await browser.close();
  }
}
