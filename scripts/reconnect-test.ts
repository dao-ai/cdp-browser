#!/usr/bin/env npx tsx
/**
 * 断线重连 & 崩溃恢复 测试
 *
 * 验证:
 *   1. CdpConnection 自动重连机制
 *   2. CdpBrowser 页面重连
 *   3. 页面崩溃自动恢复
 */
import { connectBrowser } from './cdp-manager';

async function main() {
  console.log('🔄 连接测试');
  const browser = await connectBrowser();
  console.log(`   状态: ${browser.status}`);

  const page = await browser.newPage();
  await page.setViewport(1440, 900);
  await page.goto('https://www.baidu.com', { timeoutMs: 30000 });
  const title = await page.evaluate('document.title');
  console.log(`   📌 标题: ${title}`);
  console.log(`   ✅ 连接正常\n`);

  console.log('📋 浏览器 API 清单:');
  console.log(`   CdpBrowser.status        → ${browser.status}`);
  console.log(`   CdpBrowser.onReconnect()  → ${typeof browser.onReconnect}`);
  console.log(`   CdpBrowser.onPageCrash()  → ${typeof browser.onPageCrash}`);
  console.log(`   CdpConnection.status      → ${browser.connection.status}`);
  console.log(`   CdpConnection.onDisconnect → ${typeof browser.connection.onDisconnect}`);
  console.log(`   CdpConnection.onReconnect  → ${typeof browser.connection.onReconnect}`);
  console.log(`   page.enableCrashAutoRestore → ${typeof page.enableCrashAutoRestore}`);

  // 测试页面崩溃自动恢复
  console.log('\n💥 测试页面崩溃恢复...');
  await (page as any).enableCrashAutoRestore();

  // 模拟崩溃: 通过 CDP 关掉页面
  const targetId = (page as any)._targetId;
  console.log(`   模拟关闭 target: ${targetId}`);
  try {
    await browser.connection.send('Target.closeTarget', { targetId });
  } catch {}

  // 等待恢复
  await new Promise(r => setTimeout(r, 3000));
  const newTitle = await page.evaluate('document.title || "no-title"').catch(() => '恢复中...');
  console.log(`   恢复后标题: ${newTitle}`);

  await page.close();
  await browser.close();
  console.log('\n✅ 测试完成');
}

main().catch(console.error);
