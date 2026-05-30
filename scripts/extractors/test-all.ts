#!/usr/bin/env npx tsx
/**
 * 提取器真链接实测
 * 每个站点用真实 URL，验证提取器功能
 */
import { batchExtract } from './index';

const TEST_URLS: Record<string, string> = {
  'B站 ✓':     'https://www.bilibili.com/video/BV1GJ411x7f',
  '知乎 ✓':    'https://www.zhihu.com/question/19656753',
  '百度 ✓':    'https://www.baidu.com/s?wd=AI大模型',
  '抖音 ⚡':   'https://v.douyin.com/iFmBd8k/',  // 可能需要登录
  '快手 ⚡':   'https://v.kuaishou.com/xVs3gK',
  '小红书 ⚡': 'https://www.xiaohongshu.com/explore/64e5b84f000000002600a15f',
  '微博 ⚡':   'https://weibo.com/2803301701/N8ez9jVFb',
  '淘宝 ⚡':   'https://item.taobao.com/item.htm?id=725735561605',
  '京东 ⚡':   'https://item.jd.com/100038004372.html',
  '拼多多 ⚡': 'https://mobile.yangkeduo.com/goods.html?goods_id=364633284046',
};

async function main() {
  const urls: string[] = [];
  const labels: string[] = [];

  for (const [label, url] of Object.entries(TEST_URLS)) {
    labels.push(label);
    urls.push(url);
  }

  console.log('🧪 提取器真链接实测\n');

  const summary = await batchExtract(urls, { retries: 2, retryDelayMs: 2000 });

  console.log('\n' + '='.repeat(60));
  console.log('📊 实测结果汇总');
  console.log('='.repeat(60));

  for (let i = 0; i < summary.results.length; i++) {
    const r = summary.results[i];
    const label = labels[i];
    const ok = r.id && r.title && r.title !== 'Error' && !r.title.startsWith('Error');
    const icon = ok ? '✅' : '❌';
    console.log(`\n${icon} ${label}`);
    console.log(`   标题: ${r.title?.slice(0, 60) || 'N/A'}`);
    console.log(`   作者: ${r.author || 'N/A'}`);
    if (r.id) console.log(`   ID:   ${r.id.slice(0, 30)}`);
    if (r.likes != null) console.log(`   点赞: ${r.likes}`);
    if (r.description) console.log(`   描述: ${r.description?.slice(0, 80)}`);
    if (r.elapsedMs) console.log(`   耗时: ${r.elapsedMs}ms`);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`总计: ${summary.total} | 成功: ${summary.success} | 失败: ${summary.failed}`);
  console.log(`总耗时: ${(summary.totalElapsedMs / 1000).toFixed(1)}s`);
}

main().catch(console.error);
