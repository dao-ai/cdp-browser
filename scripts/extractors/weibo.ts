/**
 * 微博内容提取器
 *
 * 从微博分享链接提取博文信息：
 *   - weibo.com/xxx/xxxxxxxxx
 *   - m.weibo.cn/detail/xxxxxxxxx
 *   - weibo.com/ttarticle/p/show?id=xxx
 *
 * 核心从 meta[name="description"] 和 JSON-LD 数据提取。
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

    await page.goto(shareUrl, { timeoutMs: 40000 });
    await randomDelay(5000, 8000);

    const currentUrl = await page.evaluate('location.href');
    const title = await page.evaluate('document.title || ""');

    const metaDesc = await page.evaluate(
      `document.querySelector('meta[name="description"]')?.getAttribute('content') || ''`
    );
    const ogImage = await page.evaluate(
      `document.querySelector('meta[property="og:image"]')?.getAttribute('content') || ''`
    );

    // 博文 ID
    const weiboId = (currentUrl.match(/weibo\.com\/\d+\/([a-zA-Z0-9]+)/) ||
                     currentUrl.match(/m\.weibo\.cn\/detail\/([a-zA-Z0-9]+)/) ||
                     [])[1] || '';

    // 作者
    let author = 'N/A';
    const authorRe = /作者[：:]\s*([^\s,，；;】]+)/;
    const authorMatch = metaDesc.match(authorRe);
    if (authorMatch) author = authorMatch[1].trim();

    // 没找到就尝试从 URL 拿
    if (author === 'N/A') {
      const urlAuthor = currentUrl.match(/weibo\.com\/([^/?]+)/);
      if (urlAuthor && urlAuthor[1] && !urlAuthor[1].match(/^\d+$/)) {
        author = urlAuthor[1];
      }
    }

    // 描述：用 title 或 meta description
    const description = metaDesc || title;

    // 互动数据（微博 meta description 里可能有）
    let likes: number | undefined;
    let comments: number | undefined;
    let shares: number | undefined;

    const likeRe = /(\d[\d.]*[万亿]?)个?赞/;
    const commentRe = /(\d[\d.]*[万亿]?)条?评论/;
    const shareRe = /(\d[\d.]*[万亿]?)次?转发/;

    const likeMatch = description.match(likeRe);
    if (likeMatch) likes = parseNum(likeMatch[1]);

    const commentMatch = description.match(commentRe);
    if (commentMatch) comments = parseNum(commentMatch[1]);

    const shareMatch = description.match(shareRe);
    if (shareMatch) shares = parseNum(shareMatch[1]);

    // 尝试从 JSON-LD 提取
    let jsonld: any = null;
    try {
      const raw = await page.evaluate(
        `(function(){try{var s=document.querySelector('script[type="application/ld+json"]');return s?s.textContent:''}catch(e){return ''}})()`
      );
      if (raw) jsonld = JSON.parse(raw);
    } catch {}

    if (jsonld) {
      if (jsonld.author?.name) author = jsonld.author.name;
      if (jsonld.datePublished) {
        const d = new Date(jsonld.datePublished);
        if (!isNaN(d.getTime())) {
          // 有 publishDate 就设置
        }
      }
    }

    const cleanTitle = title
      .replace(/ - 微博$/, '')
      .replace(/ - 新浪微博$/, '')
      .replace(/ - 微博视频$/, '')
      .trim() || title;

    // 发布时间
    let publishDate: string | undefined;
    if (jsonld?.datePublished) {
      const d = new Date(jsonld.datePublished);
      if (!isNaN(d.getTime())) publishDate = d.toISOString().split('T')[0];
    } else {
      // 从 meta 或 URL 提取
      const dateRe = /(\d{4})年(\d{1,2})月(\d{1,2})日/;
      const dateMatch = description.match(dateRe);
      if (dateMatch) {
        publishDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
      }
    }

    return {
      id: weiboId,
      title: cleanTitle,
      author,
      url: currentUrl,
      description: description.slice(0, 500),
      publishDate,
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
