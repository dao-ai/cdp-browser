/**
 * CDP 连接管理器 — 跨平台支持（Windows / WSL / 纯Linux）
 *
 * 核心理念：connectBrowser() 总是自己启动 Chrome/Chromium，不依赖已有实例。
 * 你不需要手动开 Chrome，程序全自动。
 *
 * 流程：
 *   1. 自动检测平台（Windows / WSL / Linux）
 *   2. 找到 Chrome/Chromium 二进制
 *   3. 自动启动进程（CDP 端口 & 独立数据目录）
 *   4. WSL 下通过 netsh 端口转发 + PowerShell Start-Process
 *   5. 等待 CDP 就绪 → 返回 CdpBrowser
 *
 * 编程用法:
 *   import { connectBrowser } from './cdp-manager';
 *   const browser = await connectBrowser();
 *   // ... 直接用
 *   await browser.close();
 */
import { CdpBrowser, sleep } from './cdp-client';
import { isCliMain } from './sites';
import http from 'http';
import fs from 'fs';
import os from 'os';
import { spawn, spawnSync, execSync } from 'child_process';

// ─── 平台检测 ──────────────────────────────────────────────

let _platform: 'windows' | 'wsl' | 'linux' | null = null;

export function detectPlatform(): 'windows' | 'wsl' | 'linux' {
  if (_platform) return _platform;
  if (process.platform === 'win32') {
    _platform = 'windows';
  } else {
    try {
      if (process.env.WSL_DISTRO_NAME || fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
        _platform = 'wsl';
      } else {
        _platform = 'linux';
      }
    } catch { _platform = 'linux'; }
  }
  return _platform;
}

export function isWindows() { return detectPlatform() === 'windows'; }
export function isWsl() { return detectPlatform() === 'wsl'; }
export function isLinux() { return detectPlatform() === 'linux'; }

// ─── 连接选项 ────────────────────────────────────────────

export interface ConnectOptions {
  proxy?: string;
  proxyBypassList?: string[];
  port?: number;
  dataDir?: string;
}

interface ActiveInstance {
  port: number;
  dataDir: string;
}

let _connectOptions: ConnectOptions = {};
let _activeInstance: ActiveInstance | null = null;

export function setConnectOptions(opts: ConnectOptions) { _connectOptions = opts; }
export function getConnectOptions(): ConnectOptions { return { ..._connectOptions }; }

interface ChromeConfig {
  chromeExe: string;
  chromeHost: string;
  chromePort: number;
  cdpPort: number;
  dataDir: string;
  proxy?: string;
  proxyBypassList?: string[];
}

// ─── WSL 辅助 ──────────────────────────────────────────────

const WSL_CMD = '/mnt/c/Windows/System32/cmd.exe';

function wslExecSync(cmd: string, args: string[], timeout = 5000) {
  if (!isWsl() || !fs.existsSync(WSL_CMD)) {
    return { status: -1, stdout: '', stderr: 'cmd.exe not available' };
  }
  const r = spawnSync(WSL_CMD, ['/c', cmd, ...args], {
    cwd: '/mnt/c', encoding: 'utf-8', timeout,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ─── Chrome 路径查找 ──────────────────────────────────────

const CHROME_PATHS_WIN = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
];

const CHROME_PATHS_LINUX = [
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/snap/bin/chromium', '/snap/bin/chromium-browser',
];

function findChromePath(): string | null {
  if (isWindows()) {
    for (const p of CHROME_PATHS_WIN) {
      try {
        const expanded = p.includes('%LOCALAPPDATA%')
          ? p.replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA || 'C:\\Users\\' + os.userInfo().username + '\\AppData\\Local')
          : p;
        if (fs.existsSync(expanded)) return expanded;
      } catch {}
    }
    try {
      const result = execSync('where chrome', { encoding: 'utf-8', timeout: 3000 }).trim();
      if (result) return result.split('\n')[0].trim();
    } catch {}
  } else if (isWsl()) {
    for (const p of CHROME_PATHS_WIN) {
      try {
        const expanded = p.includes('%LOCALAPPDATA%')
          ? '/mnt/c/Users/' + os.userInfo().username + '/AppData/Local' + p.replace('%LOCALAPPDATA%', '')
          : '/mnt/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');
        if (fs.existsSync(expanded)) return p;
      } catch {}
    }
  } else {
    for (const p of CHROME_PATHS_LINUX) {
      try { if (fs.existsSync(p)) return p; } catch {}
    }
    try {
      const result = execSync('which google-chrome || which chromium || which chromium-browser', { encoding: 'utf-8', timeout: 3000 }).trim();
      if (result) return result.split('\n')[0].trim();
    } catch {}
  }
  return null;
}

// ─── CDP 工具（带超时）──────────────────────────────────

function fetchJson(url: string, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let data = '';
      res.on('data', (chunk: Buffer | string) => { data += typeof chunk === 'string' ? chunk : chunk.toString('utf-8'); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`超时 (${timeoutMs}ms)`));
    });
  });
}

// ─── 配置生成 ─────────────────────────────────────────────

function getWindowsHostIp(): string {
  try {
    const gw = execSync('ip route | grep default | awk \'{print $3}\'', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (gw) return gw;
  } catch {}
  return '172.20.48.1';
}

function getConfig(): ChromeConfig {
  const opts = _connectOptions;
  const plat = detectPlatform();
  const chromePort = opts.port || 9222;
  const cdpPort = plat === 'wsl' ? chromePort + 1 : chromePort;
  const defaultDataDir = plat === 'linux'
    ? os.homedir() + '/.chrome-cdp'
    : 'C:\\temp\\chrome-cdp';
  const chromeExe = findChromePath() || '';
  const chromeHost = plat === 'wsl' ? getWindowsHostIp() : '127.0.0.1';
  return { chromeExe, chromeHost, chromePort, cdpPort, dataDir: opts.dataDir || defaultDataDir, proxy: opts.proxy, proxyBypassList: opts.proxyBypassList };
}

// ─── Chrome 启动 ──────────────────────────────────────────

function launchChrome(cfg: ChromeConfig): void {
  if (!cfg.chromeExe) throw new Error('找不到 Chrome/Chromium，请确保已安装 Chrome');

  const args = [
    `--remote-debugging-port=${cfg.chromePort}`,
    `--user-data-dir=${cfg.dataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (cfg.proxy) {
    args.push(`--proxy-server=${cfg.proxy}`);
    if (cfg.proxyBypassList?.length) args.push(`--proxy-bypass-list=${cfg.proxyBypassList.join(';')}`);
  }

  const label = cfg.proxy ? `代理: ${cfg.proxy} ` : '';
  console.log(`🔧 启动 Chrome (端口 ${cfg.chromePort}) ${label}`);
  console.log(`   📁 ${cfg.dataDir}`);

  if (isWindows()) {
    const proc = spawn(cfg.chromeExe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    proc.unref();
  } else if (isWsl()) {
    // WSL → PowerShell Start-Process（fire-and-forget，不阻塞）
    const PS = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    if (!fs.existsSync(PS)) throw new Error('WSL 中找不到 PowerShell');
    const psFilePath = JSON.stringify(cfg.chromeExe);
    const psArgList = args.map(a => JSON.stringify(a)).join(',');
    const psCmd = 'Start-Process -WindowStyle Hidden -FilePath ' + psFilePath + ' -ArgumentList ' + psArgList;
    spawn(PS, ['-NoProfile', '-Command', psCmd], {
      detached: true, stdio: 'ignore',
    }).unref();
  } else {
    const proc = spawn(cfg.chromeExe, args, { detached: true, stdio: 'ignore' });
    proc.unref();
  }
}

// ─── 端口转发 (WSL) ────────────────────────────────────────

function ensurePortForward(cfg: ChromeConfig): boolean {
  if (!isWsl()) return true;
  const existing = wslExecSync('netsh', ['interface', 'portproxy', 'show', 'v4tov4'], 3000);
  if (existing.stdout?.includes(`${cfg.cdpPort}`)) return true;

  console.log(`   🌉 添加端口转发 ${cfg.cdpPort} → ${cfg.chromePort}...`);
  const r = wslExecSync('netsh', [
    'interface', 'portproxy', 'add', 'v4tov4',
    'listenaddress=0.0.0.0', `listenport=${cfg.cdpPort}`,
    'connectaddress=127.0.0.1', `connectport=${cfg.chromePort}`,
  ], 5000);
  if (r.status === 0) { console.log('   ✅ 端口转发就绪'); return true; }

  console.log('   ⚠️  需管理员权限：添加端口转发 (netsh)');
  console.log(`      netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${cfg.cdpPort} connectaddress=127.0.0.1 connectport=${cfg.chromePort}`);
  return false;
}

// ─── 确保 Chrome 运行 ──────────────────────────────────────

async function ensureChrome(cfg: ChromeConfig, retries = 20): Promise<void> {
  // 1. 已有 CDP？直接复用
  try {
    const info = await fetchJson(`http://${cfg.chromeHost}:${cfg.cdpPort}/json/version`, 2000);
    if (info?.webSocketDebuggerUrl) {
      console.log('   ✅ 已有 Chrome CDP 运行中');
      _activeInstance = { port: cfg.cdpPort, dataDir: cfg.dataDir };
      return;
    }
  } catch {}

  // 2. WSL: 先试直连，不行走端口转发
  if (isWsl()) {
    try {
      await fetchJson(`http://${cfg.chromeHost}:${cfg.chromePort}/json/version`, 2000);
      console.log(`   ✅ 直连 Chrome 端口 ${cfg.chromePort}`);
      _activeInstance = { port: cfg.chromePort, dataDir: cfg.dataDir };
      return;
    } catch {}
    ensurePortForward(cfg);
  }

  // 3. 启动 Chrome
  launchChrome(cfg);
  console.log('  ⏳ 等待 Chrome 启动...');

  // 4. 轮询等待 CDP
  for (let i = 0; i < retries; i++) {
    await sleep(2000);
    try {
      const info = await fetchJson(`http://${cfg.chromeHost}:${cfg.cdpPort}/json/version`, 2000);
      if (info?.webSocketDebuggerUrl) {
        console.log(`   ✅ Chrome 就绪 (端口 ${cfg.cdpPort})`);
        _activeInstance = { port: cfg.cdpPort, dataDir: cfg.dataDir };
        return;
      }
    } catch {}
  }

  throw new Error(`Chrome 启动超时（${cfg.cdpPort}），请检查日志`);
}

// ─── WebSocket endpoint ─────────────────────────────────────

async function getWsEndpoint(cfg: ChromeConfig): Promise<string> {
  const version = await fetchJson(`http://${cfg.chromeHost}:${cfg.cdpPort}/json/version`, 5000);
  const ws = version.webSocketDebuggerUrl;
  if (!ws) throw new Error('Chrome 未返回 webSocketDebuggerUrl');
  const url = new URL(ws);
  url.hostname = cfg.chromeHost;
  url.port = String(cfg.cdpPort);
  return url.toString();
}

// ─── Public API ─────────────────────────────────────────────

/**
 * 连接 Chrome — 自己启动实例，不依赖已有 Chrome。
 * 什么都不传就能用。代理走 { proxy }。
 */
export async function connectBrowser(opts?: ConnectOptions) {
  _connectOptions = opts || {};
  const cfg = getConfig();
  await ensureChrome(cfg);
  const ws = await getWsEndpoint(cfg);
  const browser = new CdpBrowser(ws);
  await browser.connect();
  return browser;
}

export async function killInstance() {
  if (!_activeInstance) { console.log('  ℹ️  没有活动的实例'); return; }
  const { port } = _activeInstance;
  const killHost = isWsl() ? getWindowsHostIp() : '127.0.0.1';
  try {
    const info = await fetchJson(`http://${killHost}:${port}/json/version`, 3000).catch(() => null);
    if (info?.webSocketDebuggerUrl) {
      const url = new URL(info.webSocketDebuggerUrl);
      url.hostname = killHost;
      url.port = String(port);
      const browser = new CdpBrowser(url.toString());
      await browser.connect();
      await browser.connection.send('Browser.close');
      console.log(`  ✅ 已关闭实例 (端口 ${port})`);
    } else {
      throw new Error('CDP 不可用');
    }
  } catch {
    console.log(`  ⚠️  无法自动关闭实例 (端口 ${port})`);
  }
  _activeInstance = null;
}

// ─── 测试 & 状态 ──────────────────────────────────────────

export async function testConnection() {
  try {
    const browser = await connectBrowser();
    await browser.close();
    await killInstance();
    return { ok: true, platform: detectPlatform() };
  } catch (err: any) {
    return { ok: false, platform: detectPlatform(), error: err.message };
  }
}

export async function getConnectionInfo() {
  const cfg = getConfig();
  return fetchJson(`http://${cfg.chromeHost}:${cfg.cdpPort}/json/version`, 5000);
}

// ─── CLI ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    const result = await testConnection();
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (args.includes('--status')) {
    try {
      const info = await getConnectionInfo();
      console.log(`✅ Chrome CDP 运行中 (${detectPlatform()})`);
      console.log(`   Browser: ${info.Browser}`);
      console.log(`   WS: ${info.webSocketDebuggerUrl}`);
      process.exit(0);
    } catch (e: any) {
      console.log(`❌ Chrome CDP 不可用: ${e.message}`);
      process.exit(1);
    }
  }

  if (args.includes('--kill')) {
    await killInstance();
    process.exit(0);
  }

  if (args.includes('--login')) {
    const idx = args.indexOf('--login') + 1;
    const url = idx < args.length ? args[idx] : 'https://www.douyin.com';
    const proxyIdx = args.indexOf('--proxy');
    const proxy = proxyIdx >= 0 ? args[proxyIdx + 1] : undefined;
    console.log(`🔐 等待手动登录: ${url}`);
    const browser = await connectBrowser(proxy ? { proxy } : undefined);
    const page = await browser.newPage();
    await page.setViewport(1280, 720);
    await page.gotoWithLogin(url, { timeoutMs: 300_000 });
    console.log(`✅ 已登录: ${await page.url()}`);
    await page.close();
    await browser.close();
    await killInstance();
    process.exit(0);
  }

  if (args.includes('--open-url')) {
    const urlIdx = args.indexOf('--open-url') + 1;
    const url = urlIdx < args.length ? args[urlIdx] : 'https://example.com';
    const proxyIdx = args.indexOf('--proxy');
    const proxy = proxyIdx >= 0 ? args[proxyIdx + 1] : undefined;
    console.log(`🌐 ${url}`);
    const browser = await connectBrowser(proxy ? { proxy } : undefined);
    const page = await browser.newPage();
    await page.setViewport(1280, 720);
    await page.goto(url);
    console.log(`📌 标题: ${await page.evaluate('document.title')}`);
    await sleep(3000);
    await page.close();
    await browser.close();
    await killInstance();
    process.exit(0);
  }

  // --instance 兼容旧用法
  if (args.includes('--instance')) {
    console.log('ℹ️  现在默认就是独立实例模式，--instance 已不需要');
    process.exit(0);
  }

  console.log(`
用法: npx tsx scripts/cdp-manager.ts [选项]
  --test          测试 CDP 连接（自动启动 Chrome）
  --status        查看 CDP 状态
  --login [url]   等待手动登录
  --open-url <u>  打开页面测试
  --proxy <addr>  设置代理
  --kill          关闭实例
`);
}

function isMain() {
  try { return import.meta.url?.endsWith(process.argv[1]?.replace(/^.*[\\/]/, '')); } catch { return false; }
}
if (isMain()) { main().catch(console.error); }
