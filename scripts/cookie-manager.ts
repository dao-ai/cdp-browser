#!/usr/bin/env npx tsx
/**
 * Cookie 管理 CLI — 一次登录，永久复用
 *
 * 用法:
 *   # 登录 + 保存
 *   npx tsx scripts/cookie-manager.ts --save taobao --login
 *   npx tsx scripts/cookie-manager.ts --save xiaohongshu --login
 *
 *   # 列出已保存的
 *   npx tsx scripts/cookie-manager.ts --list
 *
 *   # 提取（自动恢复 cookie）
 *   npx tsx scripts/cookie-manager.ts --extract 'https://item.taobao.com/...'
 */
import { connectBrowser } from './cdp-manager';
import { extract, batchExtract } from './extractors';
import fs from 'fs';
import path from 'path';

const COOKIE_DIR = path.join(process.cwd(), 'data', 'cookies');

function cookiePath(name: string) {
  return path.join(COOKIE_DIR, `${name}.json`);
}

async function saveCookies(site: string, loginUrl?: string) {
  const url = loginUrl || LOGIN_URLS[site] || `https://www.${site}.com`;
  console.log(`🔐 登录并保存 Cookie: ${site}`);
  console.log(`   📍 ${url}`);
  console.log('   💡 在弹出的 Chrome 窗口中完成登录后，按 Ctrl+C 退出\n');

  const browser = await connectBrowser();
  const page = await browser.newPage();
  await page.setViewport(1440, 900);

  try {
    await page.gotoWithLogin(url, { timeoutMs: 300_000 });
    await new Promise(r => setTimeout(r, 2000));

    await page.saveCookies(cookiePath(site));
  } finally {
    await page.close();
    await browser.close();
  }
}

async function extractWithCookies(targetUrl: string) {
  // 检测站点，自动找对应 cookie
  const site = detectSite(targetUrl);
  const cp = cookiePath(site);
  if (fs.existsSync(cp)) {
    console.log(`🍪 找到已保存的 Cookie: ${site}`);
    const browser = await connectBrowser();
    const page = await browser.newPage();
    try {
      await page.loadCookies(cp);
      await page.close();
    } finally {
      await browser.close();
    }
  } else {
    console.log(`⚠️ 未找到 ${site} 的 Cookie，将以未登录状态提取`);
  }

  const result = await extract(targetUrl);
  console.log(JSON.stringify(result, null, 2));
}

function detectSite(url: string): string {
  const m = url.match(/douyin\.com|kuaishou\.com|xiaohongshu\.com|bilibili\.com|weibo\.com|taobao\.com|tmall\.com|jd\.com|pinduoduo\.com|yangkeduo\.com|zhihu\.com|baidu\.com/);
  if (m) {
    const map: Record<string, string> = {
      'xiaohongshu.com': 'xiaohongshu',
      'taobao.com': 'taobao', 'tmall.com': 'taobao',
      'jd.com': 'jd', 'pinduoduo.com': 'pdd', 'yangkeduo.com': 'pdd',
      'bilibili.com': 'bilibili', 'weibo.com': 'weibo',
      'zhihu.com': 'zhihu', 'baidu.com': 'baidu',
      'douyin.com': 'douyin', 'kuaishou.com': 'kuaishou',
    };
    return map[m[0]] || m[0];
  }
  return 'unknown';
}

const LOGIN_URLS: Record<string, string> = {
  taobao: 'https://login.taobao.com/',
  xiaohongshu: 'https://www.xiaohongshu.com/explore',
  weibo: 'https://weibo.com/login.php',
  pdd: 'https://mobile.yangkeduo.com/',
  douyin: 'https://www.douyin.com/',
};

function listCookies() {
  if (!fs.existsSync(COOKIE_DIR)) {
    console.log('📭 无已保存的 Cookie');
    return;
  }
  const files = fs.readdirSync(COOKIE_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('📭 无已保存的 Cookie');
    return;
  }
  console.log('📋 已保存的登录态:');
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(COOKIE_DIR, f), 'utf-8'));
    console.log(`   ${f.replace('.json', '')}: ${data.count} 个 cookie (${data.savedAt?.slice(0, 16) || 'unknown'})`);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    listCookies();
    process.exit(0);
  }

  if (args.includes('--save')) {
    const idx = args.indexOf('--save') + 1;
    const site = args[idx] || '';
    if (!site) { console.log('❌ 请指定站点名'); process.exit(1); }
    const login = args.includes('--login');
    await saveCookies(site, login ? undefined : undefined);
    process.exit(0);
  }

  if (args.includes('--extract')) {
    const idx = args.indexOf('--extract') + 1;
    const url = args[idx] || '';
    if (!url) { console.log('❌ 请指定 URL'); process.exit(1); }
    await extractWithCookies(url);
    process.exit(0);
  }

  console.log(`
用法: npx tsx scripts/cookie-manager.ts [选项]

选项:
  --list                    列出已保存的 Cookie
  --save <site> --login     打开登录页等人登录，完成后保存 Cookie
  --extract <url>           提取内容（自动恢复对应站点的 Cookie）

示例:
  # 登录淘宝
  npx tsx scripts/cookie-manager.ts --save taobao --login
  # 登录小红书
  npx tsx scripts/cookie-manager.ts --save xiaohongshu --login
  # 查看已保存
  npx tsx scripts/cookie-manager.ts --list
  # 带 Cookie 提取
  npx tsx scripts/cookie-manager.ts --extract 'https://item.taobao.com/...'

编程用法:
  const page = await browser.newPage();
  await page.loadCookies('data/cookies/taobao.json');
  await page.goto('https://item.taobao.com/...');      // 已登录！
  // ... 提取完 ...
  await page.saveCookies('data/cookies/taobao.json');    // 保存最新
`);
  process.exit(1);
}

const isCli = typeof process !== 'undefined' && process.argv[1]?.endsWith('cookie-manager.ts');
if (isCli) main().catch(console.error);
