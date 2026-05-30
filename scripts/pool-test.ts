#!/usr/bin/env npx tsx
/** 连接池压力测试 — 5 并发，池上限 3 */
import { createPool } from './cdp-pool';

async function main() {
  const pool = createPool({ maxPages: 3, verbose: true });

  console.log('📊 初始:', JSON.stringify(pool.status()));

  const tasks = Array.from({ length: 5 }, async (_, i) => {
    return pool.withPage(async (page) => {
      await page.goto(`https://www.baidu.com/s?wd=test${i}`, { timeoutMs: 20000 });
      const title = await page.evaluate('document.title');
      await new Promise(r => setTimeout(r, 300));
      return { i, title };
    });
  });

  const t0 = Date.now();
  const results = await Promise.all(tasks);
  console.log(`\n⏱️ 5 并发耗时: ${Date.now() - t0}ms`);

  for (const r of results) {
    console.log(`   ${r.i}: ${r.title.slice(0, 40)}`);
  }

  console.log('\n📊 最终:', JSON.stringify(pool.status()));
  await pool.close();
  console.log('✅ 测试通过');
}
main().catch(console.error);
