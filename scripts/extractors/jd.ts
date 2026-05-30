/**
 * 京东商品提取器
 *
 * 从京东商品链接提取商品信息：
 *   - item.jd.com/xxx.html
 *   - item.m.jd.com/product/xxx.html
 *   - 3.cn/xxx 短链接
 *
 * 核心从 meta 标签和页面 JSON 数据提取。
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
    await page.setViewport(1920, 1080);

    await page.goto(shareUrl, { timeoutMs: 40000 });
    await randomDelay(5000, 9000);

    const title = await page.evaluate('document.title || ""');
    const currentUrl = await page.evaluate('location.href');

    const metaDesc = await page.evaluate(
      `document.querySelector('meta[name="description"]')?.getAttribute('content') || ''`
    );
    const ogImage = await page.evaluate(
      `document.querySelector('meta[property="og:image"]')?.getAttribute('content') || ''`
    );

    // 商品 ID
    const skuId = (currentUrl.match(/(\d+)\.html/) ||
                   currentUrl.match(/product\/(\d+)/) ||
                   [])[1] || '';

    // 尝试从页面 JSON 数据提取
    let pageConfig: any = null;
    try {
      const raw = await page.evaluate(
        `(function(){try{var s=document.querySelector('script#__pageConfig')||document.querySelector('script[type="application/ld+json"]');return s?s.textContent:''}catch(e){return ''}})()`
      );
      if (raw && raw.startsWith('{')) pageConfig = JSON.parse(raw);
    } catch {}

    let author = 'N/A';
    let price: string | undefined;

    if (pageConfig) {
      if (pageConfig.shop?.shopName || pageConfig.shopName) {
        author = pageConfig.shop?.shopName || pageConfig.shopName || 'N/A';
      }
      if (pageConfig.product?.jdPrice || pageConfig.price) {
        price = String(pageConfig.product?.jdPrice || pageConfig.price);
      }
    }

    // DOM 回退提取店铺和价格
    if (author === 'N/A') {
      try {
        author = await page.evaluate(
          `document.querySelector('.J-hove-wrap-shop a, .shopName a, .J-shop-name')?.innerText?.trim() || document.querySelector('[clstag*="shop"]')?.innerText?.trim() || 'N/A'`
        );
      } catch {}
    }

    if (!price) {
      try {
        price = await page.evaluate(
          `document.querySelector('.p-price, .J-p-price, .price')?.innerText?.trim() || ''`
        );
      } catch {}
    }

    const cleanTitle = title
      .replace(/\[京东\]$/, '')
      .replace(/- 京东$/, '')
      .trim() || title;

    return {
      id: skuId,
      title: cleanTitle,
      author,
      url: currentUrl,
      description: metaDesc?.slice(0, 500),
      coverUrl: ogImage || undefined,
      raw: price ? { price } : undefined,
    };
  } finally {
    if (page) try { await page.close(); } catch {}
    if (ownBrowser) await browser.close();
  }
}
