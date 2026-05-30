#!/usr/bin/env npx tsx
/**
 * 登录门 — 自动检测登录态，未登录弹二维码等扫码，登录后继续
 *
 * 用法:
 *   npx tsx scripts/login-gate.ts 'https://detail.tmall.com/item.htm?id=xxx'
 */
import { connectBrowser } from './cdp-manager';

async function loginGate(targetUrl: string) {
  const browser = await connectBrowser();
  console.log('🔍 检测登录态...');

  // ① 用新页面打开目标 URL（CDP 新页面共享 Chrome 登录态）
  const page = await browser.newPage();
  await page.setViewport(1440, 900);
  await page.goto(targetUrl, { timeoutMs: 25000 });
  await new Promise(r => setTimeout(r, 2000));

  // ② 检查当前页是否已经是目标内容（非登录页）
  const checkLoggedIn = async () => {
    const title = await page.evaluate('document.title').catch(() => '');
    const url = await page.evaluate('location.href').catch(() => '');
    const isLogin = title === '登录' || title === '请登录'
      || url.includes('/login.') || url.includes('/passport')
      || title === '淘宝' || title === '小红书' || title === '拼多多商城';
    return !isLogin;
  };

  if (await checkLoggedIn()) {
    const title = await page.evaluate('document.title');
    console.log(`✅ 已登录: ${title.slice(0, 80)}`);
    await page.close();
    await browser.close();
    return true;
  }

  // ③ 未登录：截图
  console.log('🔐 需要登录，扫码后自动继续...');
  await page.screenshot({ path: '/home/wohugb/.openclaw/workspace/taobao-login.png' });

  // ④ 等登录 — 用标题而非 URL 检测，避免中间跳转误判
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    // 重新导航检测（比监控当前页 URL 更可靠）
    try {
      await page.goto(targetUrl, { timeoutMs: 15000 });
      await new Promise(r => setTimeout(r, 1500));

      // 简单判断：标题不是"登录"且不是站名
      const title = await page.evaluate('document.title').catch(() => '');
      if (title && title !== '登录' && title !== '请登录'
        && title !== '淘宝' && title !== '小红书' && title !== '拼多多商城'
        && title !== '微博正文' && title !== '抖音精选电脑版') {
        console.log(`✅ 登录成功: ${title.slice(0, 80)}`);
        await page.close();
        await browser.close();
        return true;
      }

      const remaining = Math.round((deadline - Date.now()) / 1000);
      if (remaining % 15 === 0) console.log(`   ⏳ 等待扫码... 剩余 ${remaining}s`);
    } catch { /* 网络波动，继续等 */ }
  }

  console.log('⏰ 超时');
  await page.close();
  await browser.close();
  return false;
}

// CLI
const url = process.argv[2];
if (!url) {
  console.log('用法: npx tsx scripts/login-gate.ts <URL>');
  process.exit(1);
}

loginGate(url).then(ok => process.exit(ok ? 0 : 1)).catch(e => {
  console.error(e.message);
  process.exit(1);
});
