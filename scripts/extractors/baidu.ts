/**
 * 百度搜索提取器
 *
 * 从百度搜索结果页提取搜索条目信息：
 *   - www.baidu.com/s?wd=xxx
 *   - www.baidu.com/s?word=xxx
 *
 * 提取搜索结果列表：标题、摘要、链接。
 * 百度对 CDP 友好，通常不需要额外 anti-detection。
 */
import { randomDelay, CdpBrowser } from '../cdp-client';
import { connectBrowser } from '../cdp-manager';
import type { ExtractorResult } from './types';

export async function extract(searchUrl: string, browser?: CdpBrowser): Promise<ExtractorResult> {
  const ownBrowser = !browser;
  if (!browser) browser = await connectBrowser();
  let page: any = null;

  try {
    page = await browser.newPage();
    await page.setViewport(1440, 900);

    await page.goto(searchUrl, { timeoutMs: 25000 });
    await randomDelay(2000, 4000);

    const title = await page.evaluate('document.title || ""');
    const currentUrl = await page.evaluate('location.href');

    // 搜索关键词
    const keyword = (currentUrl.match(/[?&]wd=([^&]+)/) || currentUrl.match(/[?&]word=([^&]+)/) || [])[1] || '';

    // 提取搜索结果
    const results = await page.evaluate(`
      (function() {
        var items = document.querySelectorAll('.result, .result-op, .c-container, [class*="result"]');
        var out = [];
        items.forEach(function(item) {
          var titleEl = item.querySelector('h3 a, a[href*="baiducontent"]');
          var abstractEl = item.querySelector('.c-abstract, .content-right_8Zs40, .c-span-last, [class*="abstract"]');
          var urlEl = item.querySelector('.c-showurl, [class*="url"]');
          if (titleEl) {
            out.push({
              title: titleEl.innerText.trim(),
              url: titleEl.getAttribute('href') || '',
              abstract: abstractEl ? abstractEl.innerText.trim() : '',
            });
          }
        });
        return out.slice(0, 10);
      })()
    `);

    // 构建结构化的描述
    const description = results.length > 0
      ? results.slice(0, 5).map((r: any, i: number) =>
          `${i + 1}. ${r.title}${r.abstract ? ' — ' + r.abstract.slice(0, 100) : ''}`
        ).join('\n')
      : title;

    const decodedKeyword = keyword ? decodeURIComponent(keyword) : '';

    return {
      id: keyword,
      title: decodedKeyword || title,
      author: '百度搜索',
      url: currentUrl,
      description: description.slice(0, 1000),
      raw: {
        totalResults: results.length,
        results: results.map((r: any) => ({
          title: r.title,
          url: r.url,
          abstract: r.abstract,
        })),
      },
    };
  } finally {
    if (page) try { await page.close(); } catch {}
    if (ownBrowser) await browser.close();
  }
}
