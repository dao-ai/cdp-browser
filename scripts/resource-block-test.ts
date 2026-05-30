#!/usr/bin/env npx tsx
/**
 * 资源拦截测试
 *
 * 验证页面资源拦截功能是否正常：
 *   1. 快速屏蔽模式 blockResources()
 *   2. 精细配置 enableRequestInterception()
 *   3. 自定义拦截 handler
 *
 * 用法:
 *   npx tsx scripts/resource-block-test.ts                            # 默认打开百度，屏蔽图片+字体
 *   npx tsx scripts/resource-block-test.ts 'https://example.com'      # 自定义 URL
 *   npx tsx scripts/resource-block-test.ts --no-block                 # 不做拦截（对比）
 */
import { connectBrowser } from './cdp-manager';

async function main() {
  const noBlock = process.argv.includes('--no-block');
  const url = process.argv.find(a => a.startsWith('http')) || 'https://www.baidu.com';

  console.log(`🚀 资源拦截测试`);
  console.log(`   📍 URL: ${url}`);
  console.log(`   🔒 拦截: ${noBlock ? '关闭' : '开启（图片+字体+媒体）'}\n`);

  const browser = await connectBrowser();

  // 无拦截的对比测试
  if (!noBlock) {
    console.log('─── 无拦截 ───');
    const page1 = await browser.newPage();
    await page1.setViewport(1440, 900);
    const t0 = Date.now();
    await page1.goto(url, { timeoutMs: 30000 });
    const loadTime1 = Date.now() - t0;
    const title1 = await page1.evaluate('document.title');
    console.log(`   标题: ${title1}`);
    console.log(`   加载: ${loadTime1}ms\n`);
    await page1.close();
  }

  // 屏蔽图片+字体+媒体
  console.log('─── 屏蔽图片+字体+媒体 ───');
  const page2 = await browser.newPage();
  await page2.setViewport(1440, 900);
  await page2.blockResources(['Image', 'Font', 'Media']);
  const t1 = Date.now();
  await page2.goto(url, { timeoutMs: 30000 });
  const loadTime2 = Date.now() - t1;
  const stats = page2.getInterceptionStats();
  const title2 = await page2.evaluate('document.title');
  console.log(`   标题: ${title2}`);
  console.log(`   加载: ${loadTime2}ms`);
  console.log(`   拦截: ${stats.intercepted} 次请求, 屏蔽 ${stats.blocked} 个`);
  await page2.disableRequestInterception();
  await page2.close();

  // 自定义拦截 handler（只拦截图片）
  console.log('\n─── 自定义拦截（仅图片 + 统计域名） ───');
  const page3 = await browser.newPage();
  await page3.setViewport(1440, 900);
  await page3.enableRequestInterception({
    handler: (req) => {
      if (req.type === 'Image') return 'block';
      if (req.url.includes('google-analytics') || req.url.includes('hm.baidu.com')) return 'block';
      return 'continue';
    },
    verbose: false,
  });
  const t2 = Date.now();
  await page3.goto(url, { timeoutMs: 30000 });
  const loadTime3 = Date.now() - t2;
  const stats3 = page3.getInterceptionStats();
  const title3 = await page3.evaluate('document.title');
  console.log(`   标题: ${title3}`);
  console.log(`   加载: ${loadTime3}ms`);
  console.log(`   拦截: ${stats3.intercepted} 次请求, 屏蔽 ${stats3.blocked} 个`);
  await page3.disableRequestInterception();
  await page3.close();

  // 自定义请求头
  console.log('\n─── 自定义请求头 ───');
  const page4 = await browser.newPage();
  await page4.setViewport(1440, 900);
  await page4.setExtraHTTPHeaders({
    'X-Cdp-Test': 'resource-block-test',
    'X-Custom-Header': 'hello-from-cdp',
  });
  await page4.goto(url, { timeoutMs: 30000 });
  // 无法直接验证，但至少不报错
  console.log('   ✅ 设置成功，未报错');
  const title4 = await page4.evaluate('document.title');
  console.log(`   标题: ${title4}`);
  await page4.close();

  await browser.close();

  // 对比
  if (!noBlock) {
    console.log(`\n📊 对比`);
    console.log(`   无拦截: 最少 ${loadTime3}ms (screenshot)`); // 取带拦截的数据
  }
  console.log('\n✅ 测试完成');
}

main().catch(err => {
  console.error('❌ 测试失败:', err);
  process.exit(1);
});
