#!/usr/bin/env npx tsx
/**
 * 登录门 — 自动检测登录态，未登录弹二维码等扫码，登录后继续
 *
 * 用法:
 *   npx tsx scripts/login-gate.ts <URL>                    # 正常检测
 *   npx tsx scripts/login-gate.ts --clear-cookies <URL>    # 清空 cookie 后检测
 *   npx tsx scripts/login-gate.ts --cookie <site> <URL>    # 用保存的 cookie 检测（TODO）
 */
import * as path from 'path';
import * as os from 'os';
import { connectBrowser } from './cdp-manager';
import { TIMEOUTS } from './constants';

// ─── 登录墙标题检测 ────────────────────────────────────────
// 与 cdp-client.ts 中的 _detectLoginWall / _quickTitleCheck 共享逻辑

const BARE_SITE_TITLES = [
  '小红书', '抖音精选电脑版', '拼多多商城',
  '微博正文', '出错啦! - bilibili.com', '知乎',
];

const LOGIN_TITLES = ['登录', '请登录', 'login', 'sign in'];

function detectLoginWall(title: string, url: string, bodyLen: number): string | null {
  const t = title.toLowerCase();
  const u = url.toLowerCase();

  // URL 模式
  const loginUrlPatterns = ['login', 'passport', 'signin', 'sign_in', 'sign-in',
    'accounts.google.com', 'verify', 'captcha', 'auth'];
  for (const p of loginUrlPatterns) {
    if (u.includes(p)) return `URL 包含「${p}」`;
  }

  // 精确登录标题
  if (LOGIN_TITLES.includes(title)) return `标题为「${title}」`;

  // 裸站名
  if (BARE_SITE_TITLES.includes(title)) return `标题为站点首页「${title}」`;

  // 404
  if (t === '页面不存在' || t === 'not found' || t.includes('找不到') || t.includes('不存在')
    || t.includes('页面不见') || t.includes('访问的页面')
    || t === '404' || t.includes(' 404 ')) return `页面不存在——${title}`;

  // 内容缺失
  if (title.length > 0 && title.length < 8 && bodyLen < 200) {
    return `内容缺失（标题「${title}」, body ${bodyLen} 字符）`;
  }

  return null;
}

// ─── 主逻辑 ────────────────────────────────────────────────

async function loginGate(targetUrl: string, clearCookies = false) {
  const browser = await connectBrowser();
  console.log('🔍 检测登录态...');

  const page = await browser.newPage();
  await page.setViewport(1440, 900);

  // ① 测试用：清空 cookie（强制进入未登录态）
  if (clearCookies) {
    const before = await page.getCookies().catch(() => []);
    await page.clearCookies().catch(() => {});
    console.log(`🧹 已清除 ${before.length} 个 cookie（测试模式）`);
  }

  // ② 首次导航
  await page.goto(targetUrl, { timeoutMs: 25000 });
  await new Promise(r => setTimeout(r, 2500));

  // ② 综合检测
  const title = await page.evaluate('document.title || ""').catch(() => '');
  const currentUrl = await page.url();
  const bodyLenString = await page.evaluate('(document.body?.innerText?.length || 0).toString()').catch(() => '0');
  const bodyLen = parseInt(bodyLenString) || 0;

  const reason = detectLoginWall(title, currentUrl, bodyLen);

  if (!reason) {
    console.log(`✅ 无需登录: ${title.slice(0, 80)}`);
    await page.close();
    await browser.close();
    return true;
  }

  // ④ 需要登录：等待登录弹窗出现
  console.log(`🔐 检测到登录墙：${reason}`);
  console.log(`   目标: ${targetUrl.slice(0, 100)}`);
  console.log(`   当前: ${currentUrl}`);
  console.log(`   🔍 等待登录弹窗...`);
  try {
    await page.waitForSelector(
      '.login-dialog, .login-modal, .login-container, .login-box, .login-wrapper,'
      + '[class*=login], [id*=login],'
      + '.qrcode, .qr-code, [class*=qrcode], [class*=qr],'
      + '[class*=popup], [class*=modal],'
      + 'iframe[src*=login], iframe[src*=passport]',
      10000
    );
    console.log(`   ✅ 检测到登录弹窗`);
  } catch {
    console.log(`   ℹ️  未检测到登录弹窗选择器，沿用当前页面截图`);
  }
  await new Promise(r => setTimeout(r, 1000));
  const screenshotPath = path.join(os.tmpdir(), 'cdp-login-snapshot.png');
  await page.screenshot({ path: screenshotPath });
  console.log(`   📸 截图保存: ${screenshotPath}`);
  console.log(`   ⏳ 请在 Chrome 窗口中手动登录（最多 ${Math.round(TIMEOUTS.LOGIN / 1000)} 秒）...\n`);

  // ⑤ 等登录 — 定期重导航检测
  const deadline = Date.now() + TIMEOUTS.LOGIN;
  let lastReNav = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, TIMEOUTS.LOGIN_POLL));
    const u = await page.url().catch(() => '');

    // 检查标题是否有改善
    try {
      const checkTitle = await page.evaluate('document.title || ""').catch(() => '');
      const checkBody = await page.evaluate('(document.body?.innerText?.length || 0).toString()').catch(() => '0');
      const checkBodyLen = parseInt(checkBody) || 0;
      const wallReason = detectLoginWall(checkTitle, u, checkBodyLen);

      if (!wallReason) {
        console.log(`✅ 登录成功: ${checkTitle.slice(0, 80)}`);
        await page.close();
        await browser.close();
        return true;
      }

      // 每 15 秒重导航一次
      if (Date.now() - lastReNav > 15000) {
        lastReNav = Date.now();
        try {
          await page.goto(targetUrl, { timeoutMs: 15000 });
          await new Promise(r => setTimeout(r, 1500));
        } catch { /* 网络波动，继续等 */ }
      }
    } catch { /* 继续等 */ }

    const remaining = Math.round((deadline - Date.now()) / 1000);
    if (remaining % 15 === 0) {
      console.log(`   ⏳ 等待扫码... 剩余 ${remaining}s`);
    }
  }

  console.log('⏰ 登录超时');
  await page.close();
  await browser.close();
  return false;
}

// ─── CLI ────────────────────────────────────────────────────

function isMain() {
  try { return import.meta.url?.endsWith(process.argv[1]?.replace(/^.*[\\/]/, '')); } catch { return false; }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const clearIdx = args.indexOf('--clear-cookies');
  const clearCookies = clearIdx >= 0;
  const url = clearCookies
    ? args.find((a, i) => i !== clearIdx && !a.startsWith('--'))
    : args.find(a => !a.startsWith('--'));

  if (!url) {
    console.log('用法: npx tsx scripts/login-gate.ts [--clear-cookies] <URL>');
    console.log('');
    console.log('选项:');
    console.log('  --clear-cookies    清空 cookie（测试用，强制进入未登录态）');
    console.log('');
    console.log('示例:');
    console.log('  npx tsx scripts/login-gate.ts https://www.xiaohongshu.com/explore/xxx');
    console.log('  npx tsx scripts/login-gate.ts --clear-cookies https://www.xiaohongshu.com/explore/xxx');
    console.log('  npx tsx scripts/login-gate.ts --clear-cookies https://v.douyin.com/xxxx/');
    process.exit(1);
  }

  loginGate(url, clearCookies).then(ok => process.exit(ok ? 0 : 1)).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
