/**
 * 淘宝商品提取器
 *
 * 从淘宝/天猫商品链接提取商品信息：
 *   - item.taobao.com/xxx.htm
 *   - detail.tmall.com/xxx.htm
 *   - detail.tmall.hk/xxx.htm
 *   - m.intl.taobao.com/xxx
 *
 * 核心从 meta 标签和页面 JSON 数据提取。
 * 淘宝反爬较严，依赖登录态复用 + canvas 噪声注入。
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
      `document.querySelector('meta[property="og:image"]')?.getAttribute('content') || document.querySelector('meta[name="og:image"]')?.getAttribute('content') || ''`
    );

    // 商品 ID
    const itemId = (currentUrl.match(/id=(\d+)/) ||
                    currentUrl.match(/item\/(\d+)/) ||
                    currentUrl.match(/detail\.tmall\.com\/item\/(\d+)/) ||
                    [])[1] || '';

    // 尝试从页面 JSON 数据提取
    let pageData: any = null;
    try {
      const raw = await page.evaluate(
        `(function(){try{var s=document.getElementById('page-settings')||document.getElementById('data')||document.querySelector('script[type="application/ld+json"]');return s?s.textContent:''}catch(e){return ''}})()`
      );
      if (raw && raw.startsWith('{')) pageData = JSON.parse(raw);
    } catch {}

    let author = 'N/A';
    let price: string | undefined;
    let sales: number | undefined;

    if (pageData) {
      if (pageData.shopName || pageData.shop?.name) {
        author = pageData.shopName || pageData.shop?.name || 'N/A';
      }
      if (pageData.price || pageData.item?.price) {
        price = String(pageData.price || pageData.item?.price);
      }
    }

    // 直接从 DOM 提取店铺名
    if (author === 'N/A') {
      try {
        author = await page.evaluate(
          `document.querySelector('.J_TGoldShop, .shop-name, .slogo-shopname, [class*="shop"] a')?.innerText?.trim() || 'N/A'`
        );
      } catch {}
    }

    // 尝试提取价格
    if (!price) {
      try {
        const rawPrice = await page.evaluate(
          `document.querySelector('.tm-price, .tb-rmb-num, .price, [class*="price"]')?.innerText?.trim() || ''`
        );
        if (rawPrice) price = rawPrice;
      } catch {}
    }

    // 从 meta 提取描述
    const description = metaDesc;

    const cleanTitle = title
      .replace(/\[淘宝网\]$/, '')
      .replace(/\[天猫\]$/, '')
      .trim() || title;

    return {
      id: itemId,
      title: cleanTitle,
      author,
      url: currentUrl,
      description: description?.slice(0, 500),
      coverUrl: ogImage || undefined,
      raw: price ? { price, sales } : undefined,
    };
  } finally {
    if (page) try { await page.close(); } catch {}
    if (ownBrowser) await browser.close();
  }
}
