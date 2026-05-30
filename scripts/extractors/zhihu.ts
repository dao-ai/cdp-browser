/**
 * 知乎内容提取器
 *
 * 从知乎链接提取问题和回答信息：
 *   - www.zhihu.com/question/xxx
 *   - www.zhihu.com/question/xxx/answer/xxx
 *   - zhuanlan.zhihu.com/p/xxx
 *
 * 核心从 meta 标签和页面 JSON 数据提取。
 * 知乎对行为分析较严，使用贝塞尔鼠标 + 自然延时。
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
      `document.querySelector('meta[property="og:image"]')?.getAttribute('content') || ''`
    );

    // 内容 ID
    const contentId = (currentUrl.match(/question\/(\d+)/) ||
                       currentUrl.match(/answer\/(\d+)/) ||
                       currentUrl.match(/zhuanlan\.zhihu\.com\/p\/(\d+)/) ||
                       [])[1] || '';

    // 内容类型
    const isQuestion = currentUrl.includes('/question/') && !currentUrl.includes('/answer/');
    const isAnswer = currentUrl.includes('/answer/');
    const isArticle = currentUrl.includes('zhuanlan.zhihu.com/p/');

    // 尝试从页面 JSON 数据提取
    let initData: any = null;
    try {
      const raw = await page.evaluate(
        `(function(){try{var s=document.querySelector('script#__NEXT_DATA_INIT__')||document.querySelector('script#__NEXT_DATA__')||document.querySelector('script[data-initial-state]');return s?s.textContent:''}catch(e){return ''}})()`
      );
      if (raw && raw.startsWith('{')) initData = JSON.parse(raw);
    } catch {}

    let author = 'N/A';
    let likes: number | undefined;
    let comments: number | undefined;
    let description: string | undefined;

    if (initData) {
      const props = initData.props?.pageProps || initData.props || {};
      const question = props.question || props.initialQuestion || {};
      const answer = props.answer || props.initialAnswer || {};
      const article = props.article || props.initialArticle || {};

      if (isArticle) {
        author = article.author?.name || article.author || author;
        likes = article.voteupCount || article.likes || undefined;
        comments = article.commentCount || undefined;
        description = article.excerpt || article.content?.slice(0, 500) || undefined;
      } else if (isAnswer) {
        author = answer.author?.name || answer.author || question.author?.name || author;
        likes = answer.voteupCount || answer.likes || undefined;
        comments = answer.commentCount || undefined;
        description = answer.excerpt || answer.content?.slice(0, 500) || undefined;
      } else if (isQuestion) {
        author = question.author?.name || question.author || author;
        likes = question.followCount || undefined;
        comments = question.answerCount || undefined;
        description = question.excerpt || question.detail?.slice(0, 500) || undefined;
      }
    }

    // meta 回退提取作者
    if (author === 'N/A') {
      const authorRe = /作者[：:]\s*([^\s,，]+)/;
      const authorMatch = metaDesc.match(authorRe);
      if (authorMatch) author = authorMatch[1].trim();
    }

    const cleanTitle = title
      .replace(/ - 知乎$/, '')
      .replace(/ - 知乎专栏$/, '')
      .trim() || title;

    return {
      id: contentId,
      title: cleanTitle,
      author,
      url: currentUrl,
      description: description || metaDesc?.slice(0, 500),
      likes,
      comments,
      coverUrl: ogImage || undefined,
      raw: isAnswer ? { type: 'answer' } : isArticle ? { type: 'article' } : { type: 'question' },
    };
  } finally {
    if (page) try { await page.close(); } catch {}
    if (ownBrowser) await browser.close();
  }
}
