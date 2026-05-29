/**
 * 小红书笔记提取器
 *
 * 从小红书分享链接提取笔记信息：
 *   - www.xiaohongshu.com/explore/xxx
 *   - www.xiaohongshu.com/discovery/item/xxx
 *   - xhslink.com/xxx 短链接
 *
 * 核心从 meta[name="description"] 及 og 标签解析。
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

// ─── 提取函数 ──────────────────────────────────────────────

export async function extract(shareUrl: string, browser?: CdpBrowser): Promise<ExtractorResult> {
  const ownBrowser = !browser;
  if (!browser) browser = await connectBrowser();
  let page: any = null;

  try {
    page = await browser.newPage();
    await page.setViewport(1440, 900);

    // 导航到笔记页
    await page.goto(shareUrl, { timeoutMs: 40000 });
    await randomDelay(5000, 8000);

    // 提取各项数据（字符串表达式，不用箭头函数）
    const meta = await page.evaluate(
      `document.querySelector('meta[name="description"]')?.getAttribute('content') || ''`
    );
    const title = await page.evaluate('document.title || ""');
    const currentUrl = await page.evaluate('location.href');

    // og 标签提取
    const ogTitle = await page.evaluate(
      `document.querySelector('meta[property="og:title"]')?.getAttribute('content') || ''`
    );
    const ogImage = await page.evaluate(
      `document.querySelector('meta[property="og:image"]')?.getAttribute('content') || ''`
    );
    const ogDescription = await page.evaluate(
      `document.querySelector('meta[property="og:description"]')?.getAttribute('content') || ''`
    );

    // 笔记 ID
    const noteId = (currentUrl.match(/\/explore\/([a-f0-9]+)/) || currentUrl.match(/\/discovery\/item\/([a-f0-9]+)/) || [])[1] || '';

    // 标题：优先 og:title，次选 document.title
    const cleanTitle = ogTitle || title.split(' - ')[0] || title;

    // 作者：小红书 meta description 格式为 "作者：xxx，xxxx"
    let author = 'N/A';
    const authorRe = /作者[：:]\s*([^\s,，]+)/;
    const authorMatch = (meta + ogDescription).match(authorRe);
    if (authorMatch) author = authorMatch[1].trim();

    // 描述
    const description = ogDescription || meta.slice(0, 500);

    // 互动数据
    let likes: number | undefined;
    let comments: number | undefined;
    let shares: number | undefined;
    try {
      const initState = await page.evaluate(
        `(function() {
          try {
            var script = document.querySelector('script#__NEXT_DATA__');
            if (script) return JSON.parse(script.textContent);
          } catch(e) {}
          return null;
        })()`
      );
      if (initState) {
        const props = initState.props?.pageProps || initState.props || {};
        const note = props.note || props.initialNote || props.initialState?.note || {};
        likes = note.likedCount || note.interactInfo?.likedCount || undefined;
        comments = note.commentCount || note.interactInfo?.commentCount || undefined;
        shares = note.shareCount || note.interactInfo?.shareCount || undefined;
      }
    } catch {}

    if (!likes) {
      const titleLikeRe = /(\d[\d.]*[万亿]?)个?赞/;
      const tl = title.match(titleLikeRe);
      if (tl) likes = parseNum(tl[1]);
    }

    return {
      id: noteId,
      title: cleanTitle,
      author,
      url: currentUrl,
      description,
      likes,
      comments,
      shares,
      coverUrl: ogImage || undefined,
    };
  } finally {
    if (page) try { await page.close(); } catch {}
    if (ownBrowser) await browser.close();
  }
}
