/**
 * B站视频提取器
 *
 * 从 B站 分享链接提取视频信息：
 *   - www.bilibili.com/video/BVxxxxxxxxxx
 *   - b23.tv/xxx 短链接
 *
 * 核心从 meta 标签和 window.__INITIAL_STATE__ 提取。
 */
import { randomDelay, CdpBrowser } from '../cdp-client';
import { connectBrowser } from '../cdp-manager';
import type { ExtractorResult } from './types';

function parseNum(s: string): number {
  const clean = s.replace(/,/g, '');
  if (clean.endsWith('万')) return parseFloat(clean) * 10000;
  if (clean.endsWith('亿')) return parseFloat(clean) * 100000000;
  const n = parseFloat(clean);
  return isNaN(n) ? 0 : n;
}

export async function extract(shareUrl: string, browser?: CdpBrowser): Promise<ExtractorResult> {
  const ownBrowser = !browser;
  if (!browser) browser = await connectBrowser();
  let page: any = null;

  try {
    page = await browser.newPage();
    await page.setViewport(1440, 900);

    await page.goto(shareUrl, { timeoutMs: 35000 });
    await randomDelay(4000, 7000);

    const title = await page.evaluate('document.title || ""');
    const currentUrl = await page.evaluate('location.href');

    const metaDesc = await page.evaluate(
      `document.querySelector('meta[name="description"]')?.getAttribute('content') || ''`
    );
    const ogImage = await page.evaluate(
      `document.querySelector('meta[property="og:image"]')?.getAttribute('content') || document.querySelector('meta[itemprop="image"]')?.getAttribute('content') || ''`
    );

    const bvid = (currentUrl.match(/video\/(BV[a-zA-Z0-9]+)/) || [])[1] || '';

    // 尝试从 __INITIAL_STATE__ 提取详细数据
    let initState: any = null;
    try {
      const raw = await page.evaluate(
        `(function(){try{var s=document.getElementById('__INITIAL_STATE__');return s?s.textContent:''}catch(e){return ''}})()`
      );
      if (raw) initState = JSON.parse(raw);
    } catch {}

    let author = 'N/A';
    let likes: number | undefined;
    let comments: number | undefined;
    let publishDate: string | undefined;
    let description: string | undefined;
    let shares: number | undefined;
    let views: number | undefined;

    if (initState?.videoData) {
      const v = initState.videoData;
      author = v.owner?.name || v.author || author;
      likes = v.stat?.like || v.stat?.likes || undefined;
      comments = v.stat?.reply || v.stat?.replyCount || undefined;
      shares = v.stat?.share || v.stat?.shareCount || undefined;
      views = v.stat?.view || undefined;
      description = v.desc || undefined;
      if (v.pubdate) {
        const d = new Date(v.pubdate * 1000);
        publishDate = d.toISOString().split('T')[0];
      }
      if (!ogImage && v.pic) {
        // 有 pic 字段
      }
    }

    // meta 标签回退
    if (!author || author === 'N/A') {
      const authorRe = /作者[：:]\s*([^\s,，]+)/;
      const authorMatch = metaDesc.match(authorRe);
      if (authorMatch) author = authorMatch[1].trim();
    }

    const cleanTitle = title
      .replace(/_哔哩哔哩_bilibili$/, '')
      .replace(/- bilibili$/, '')
      .trim() || title;

    let coverUrl: string | undefined;
    if (initState?.videoData?.pic) {
      coverUrl = initState.videoData.pic;
    } else if (ogImage) {
      coverUrl = ogImage;
    } else {
      try {
        coverUrl = await page.evaluate(
          `document.querySelector('video[poster]')?.getAttribute('poster') || document.querySelector('meta[property="og:image"]')?.getAttribute('content') || ''`
        );
      } catch {}
    }

    return {
      id: bvid,
      title: cleanTitle,
      author,
      url: currentUrl,
      description: description || metaDesc,
      publishDate,
      likes,
      comments,
      shares,
      coverUrl: coverUrl || undefined,
      raw: views != null ? { views } : undefined,
    };
  } finally {
    if (page) try { await page.close(); } catch {}
    if (ownBrowser) await browser.close();
  }
}
