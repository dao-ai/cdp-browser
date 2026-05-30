/**
 * 拼多多商品提取器
 *
 * 从拼多多商品链接提取商品信息：
 *   - mobile.yangkeduo.com/xxx.html
 *   - pinduoduo.com/xxx
 *   - yangkeduo.com/xxx
 *
 * 注意：拼多多反爬极严，大量使用前端加密和反自动化手段。
 * 提取主要依赖 meta 标签，内部 JSON 数据可能被加密。
 * 建议复用已登录的 Chrome profile。
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

    // 导航前先设置一个高延时等待
    await page.goto(shareUrl, { timeoutMs: 45000 });
    await randomDelay(6000, 10000);

    const title = await page.evaluate('document.title || ""');
    const currentUrl = await page.evaluate('location.href');

    const metaDesc = await page.evaluate(
      `document.querySelector('meta[name="description"]')?.getAttribute('content') || ''`
    );
    const ogImage = await page.evaluate(
      `document.querySelector('meta[property="og:image"]')?.getAttribute('content') || ''`
    );
    const ogTitle = await page.evaluate(
      `document.querySelector('meta[property="og:title"]')?.getAttribute('content') || ''`
    );

    // 商品 ID
    const goodsId = (currentUrl.match(/goods_id=(\d+)/) ||
                     currentUrl.match(/product\/(\d+)/) ||
                     [])[1] || '';

    // 作者（拼多多没有店铺名，取商家名）
    let author = 'N/A';
    const authorRe = /商家[：:]\s*([^\s,，]+)/;
    const authorMatch = metaDesc.match(authorRe);
    if (authorMatch) author = authorMatch[1].trim();

    // 价格
    let price: string | undefined;
    const priceRe = /[¥￥]?([\d.]+)[-~]?[\d.]*/;
    const ogPriceRe = /[¥￥]?([\d.]+)/;
    const priceMatch = metaDesc.match(priceRe) || ogTitle.match(ogPriceRe);
    if (priceMatch) price = priceMatch[0];

    const cleanTitle = ogTitle || title.split(' - ')[0] || title;

    // 销量
    let sales: number | undefined;
    const salesRe = /已售(\d[\d.]*[万亿]?)/;
    const salesMatch = metaDesc.match(salesRe);
    if (salesMatch) sales = parseNum(salesMatch[1]);

    return {
      id: goodsId,
      title: cleanTitle,
      author,
      url: currentUrl,
      description: metaDesc?.slice(0, 500),
      coverUrl: ogImage || undefined,
      raw: price ? { price, sales } : undefined,
    };
  } finally {
    if (page) try { await page.close(); } catch {}
    if (ownBrowser) await browser.close();
  }
}
