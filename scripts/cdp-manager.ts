/**
 * CDP 连接管理器 — 跨平台支持（Windows / WSL / 纯Linux）
 *
 * 核心流程：
 *   1. 自动检测平台（Windows / WSL / Linux）
 *   2. 检查 Chrome CDP 端口是否可达
 *   3. 不可达 → 自动启动 Chrome（远程调试模式）
 *   4. WSL 下自动创建 netsh 端口转发
 *   5. 返回 CdpBrowser 实例
 *
 * 独立实例模式：
 *   connectBrowser({ launchNew: true, proxy: '...' })
 *   → 启动一个完全独立的 Chrome（新端口/新数据目录/新代理）
 *   → 不碰你日常用的 Chrome
 */
import { CdpBrowser, sleep } from './cdp-client';
import http from 'http';
import fs from 'fs';
import os from 'os';
import { execSync, spawn, spawnSync } from 'child_process';

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
  /** HTTP 代理地址，如 'http://127.0.0.1:7890' */
  proxy?: string;
  /** 绕过代理的域名列表 */
  proxyBypassList?: string[];
  /**
   * 启动独立 Chrome 实例，不碰已经运行的 Chrome。
   * 有自己的端口、数据目录、代理，互不干扰。
   */
  launchNew?: boolean;
  /** 独立实例的 CDP 端口（默认 9244，WSL 自动 +1 做转发） */
  instancePort?: number;
  /** 独立实例的数据目录 */
  dataDir?: string;
}

let _connectOptions: ConnectOptions = {};
let _activeInstance: { pid?: number; port: number; dataDir: string } | null = null;

export function setConnectOptions(opts: ConnectOptions) { _connectOptions = opts; }
export function getConnectOptions(): ConnectOptions { return { ..._connectOptions }; }

export interface ChromeConfig {
  chromeHost: string;
  cdpPort: number;
  chromeListenPort: number;
  chromeListenAddr: string;
  dataDir: string;
  usePortForward: boolean;
  isInstance: boolean;
  proxy?: string;
  proxyBypassList?: string[];
}

// ─── WSL Windows 命令辅助 ──────────────────────────────

/** WSL 下 cmd.exe 的路径 */
const WSL_CMD = '/mnt/c/Windows/System32/cmd.exe';

/**
 * WSL 下执行 Windows 命令（用 spawnSync 带 cwd 避免 UNC 路径问题）
 */
function wslExecSync(cmd: string, args: string[], timeout = 5000): { status: number | null; stdout: string; stderr: string } {
  if (!isWsl() || !fs.existsSync(WSL_CMD)) {
    return { status: -1, stdout: '', stderr: 'cmd.exe not available' };
  }
  const r = spawnSync(WSL_CMD, ['/c', cmd, ...args], {
    cwd: '/mnt/c',
    encoding: 'utf-8',
    timeout,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ─── 配置生成 ─────────────────────────────────────────────

const DEFAULT_INSTANCE_PORT = 9244;

function getConfig(): ChromeConfig {
  const opts = getConnectOptions();
  const plat = detectPlatform();

  // ── 独立实例模式 ──
  if (opts.launchNew) {
    const instancePort = opts.instancePort || DEFAULT_INSTANCE_PORT;
    const cdpPort = plat === 'wsl' ? instancePort + 1 : instancePort;
    const dataDir = opts.dataDir || (
      plat === 'windows'
        ? 'C:\\temp\\chrome-cdp'
        : (plat === 'wsl')
          ? 'C:\\temp\\chrome-cdp'
          : (os.homedir() + '/.chrome-cdp')
    );
    return {
      chromeHost: plat === 'linux' ? '127.0.0.1' : (process.env.CHROME_DEBUG_HOST || '172.20.48.1'),
      cdpPort,
      chromeListenPort: instancePort,
      chromeListenAddr: '0.0.0.0',
      dataDir,
      usePortForward: plat === 'wsl',
      isInstance: true,
      proxy: opts.proxy,
      proxyBypassList: opts.proxyBypassList,
    };
  }

  // ── 连接已有 Chrome（默认） ──
  if (plat === 'windows') {
    return {
      chromeHost: process.env.CHROME_DEBUG_HOST || '127.0.0.1',
      cdpPort: parseInt(process.env.CHROME_DEBUG_PORT || '9222'),
      chromeListenPort: parseInt(process.env.CHROME_DEBUG_PORT || '9222'),
      chromeListenAddr: '127.0.0.1',
      dataDir: process.env.CHROME_DATA_DIR || 'C:\\temp\\chrome-debug',
      usePortForward: false,
      isInstance: false,
    };
  }
  return {
    chromeHost: process.env.CHROME_DEBUG_HOST || '172.20.48.1',
    cdpPort: parseInt(process.env.CHROME_DEBUG_PORT || '9223'),
    chromeListenPort: parseInt(process.env.CHROME_PORT || '9222'),
    chromeListenAddr: '0.0.0.0',
    dataDir: process.env.CHROME_DATA_DIR || 'C:\\temp\\chrome-debug',
    usePortForward: plat === 'wsl',
    isInstance: false,
  };
}

const CHROME_PATHS_WIN = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
];

const CHROME_PATHS_LINUX = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

// ─── helpers ────────────────────────────────────────────────

function fetchJson(url: string) {
  return new Promise<any>((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ─── Chrome path detection ──────────────────────────────────

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
    // 直接文件系统查找
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

// ─── Chrome launch ──────────────────────────────────────────

function buildChromeArgs(cfg: ChromeConfig): string[] {
  const args = [
    `--remote-debugging-port=${cfg.chromeListenPort}`,
    `--remote-debugging-address=${cfg.chromeListenAddr}`,
    `--user-data-dir=${cfg.dataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (cfg.proxy) {
    args.push(`--proxy-server=${cfg.proxy}`);
    if (cfg.proxyBypassList && cfg.proxyBypassList.length > 0) {
      args.push(`--proxy-bypass-list=${cfg.proxyBypassList.join(';')}`);
    }
  }
  return args;
}

function launchChrome(cfg: ChromeConfig): void {
  const chromeExe = findChromePath();
  if (!chromeExe) throw new Error('找不到 Chrome/Chromium，请确保已安装');

  const args = buildChromeArgs(cfg);

  if (cfg.proxy) {
    console.log(`🔧 启动 Chrome，代理: ${cfg.proxy} (端口 ${cfg.chromeListenPort})`);
  } else {
    console.log(`🔧 启动 Chrome (${detectPlatform()}, 端口 ${cfg.chromeListenPort})`);
  }
  if (cfg.isInstance) console.log(`   📁 数据目录: ${cfg.dataDir}`);

  if (isWindows()) {
    const proc = spawn(chromeExe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    proc.unref();
  } else if (isWsl()) {
    // WSL: 用 cmd.exe 启动（参数用数组传，cwd 设到 /mnt/c 避免 UNC 问题）
    if (!fs.existsSync(WSL_CMD)) throw new Error('WSL 中找不到 cmd.exe');
    // WSL 下 spawnSync 起 Chrome 再超时是可靠的方案
    // spawn + detached 在 WSL 下对 Windows exe 可能不生效
    spawnSync(WSL_CMD, [
      '/c', 'start', '/B', chromeExe,
      ...args,
    ], {
      cwd: '/mnt/c',
      timeout: 1500,
      stdio: 'ignore',
    });
  } else {
    const proc = spawn(chromeExe, args, { detached: true, stdio: 'ignore' });
    proc.unref();
  }
}

// ─── Port forwarding (WSL only) ─────────────────────────────

function ensurePortForward(port: number, listenPort: number): boolean {
  if (!isWsl()) return true;
  // WSL 下可能没有 netsh 权限，静默处理
  return false;
}

function removePortForward(listenPort: number) {
  // WSL 下不做清理
}

// ─── Ensure Chrome ──────────────────────────────────────────

async function ensureChrome(retries = 15): Promise<boolean> {
  const cfg = getConfig();
  const opts = getConnectOptions();
  const checkUrl = `http://${cfg.chromeHost}:${cfg.cdpPort}/json/version`;

  // 独立实例模式：直接启动
  if (cfg.isInstance) {
    console.log(`🔧 启动独立 Chrome 实例 (端口 ${cfg.chromeListenPort})...`);
    try {
      launchChrome(cfg);
    } catch (e: any) {
      console.log(`  ⚠️  自动启动失败: ${e.message}`);
      return false;
    }
    console.log('  ⏳ 等待 Chrome 实例启动...');
    await sleep(5000);

    // 尝试多个 CDP 端点
    const checkUrls = [
      checkUrl,
      `http://${cfg.chromeHost}:${cfg.chromeListenPort}/json/version`,
      `http://127.0.0.1:${cfg.chromeListenPort}/json/version`,
    ];

    for (let i = 0; i < retries; i++) {
      for (const url of checkUrls) {
        try {
          await fetchJson(url);
          console.log(`  ✅ Chrome 实例就绪 (端口 ${cfg.chromeListenPort})`);
          _activeInstance = { port: cfg.chromeListenPort, dataDir: cfg.dataDir };
          return true;
        } catch {}
      }
      await sleep(2000);
    }
    console.log('  ⚠️  等待超时');
    return false;
  }

  // 默认模式：连接已有 Chrome
  const alreadyRunning = await (async () => {
    try { await fetchJson(checkUrl); return true; } catch { return false; }
  })();

  if (alreadyRunning) {
    if (opts.proxy) {
      console.log(`  ℹ️  代理已配置: ${opts.proxy}`);
      console.log('  ⚠️  Chrome 已运行，代理需重启才能生效');
      console.log('  💡 改用独立实例: connectBrowser({ launchNew: true, proxy: "..." })');
    }
    return true;
  }

  console.log(`🔧 Chrome 远程调试未连接，尝试自动启动...`);
  try { launchChrome(cfg); } catch (e: any) {
    console.log(`  ⚠️  自动启动失败: ${e.message}`);
    const proxyExtra = opts.proxy ? ` --proxy-server=${opts.proxy}` : '';
    if (isWindows()) {
      console.log(`     "${findChromePath() || 'chrome.exe'}" --remote-debugging-port=${cfg.chromeListenPort}${proxyExtra}`);
    } else if (isWsl()) {
      console.log(`     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`);
      console.log(`     --remote-debugging-port=${cfg.chromeListenPort} --remote-debugging-address=0.0.0.0 --user-data-dir="${cfg.dataDir}"${proxyExtra}`);
    } else {
      console.log(`     google-chrome --remote-debugging-port=${cfg.chromeListenPort}${proxyExtra}`);
    }
    return false;
  }

  console.log('  ⏳ 等待 Chrome 启动...');
  await sleep(5000);

  for (let i = 0; i < retries; i++) {
    try { await fetchJson(checkUrl); console.log('  ✅ Chrome 就绪'); return true; }
    catch { await sleep(2000); }
  }
  console.log('  ⚠️  等待超时');
  return false;
}

// ─── WebSocket endpoint ─────────────────────────────────────

async function getWsEndpoint() {
  const cfg = getConfig();
  const version = await fetchJson(`http://${cfg.chromeHost}:${cfg.cdpPort}/json/version`);
  const ws = version.webSocketDebuggerUrl;
  if (!ws) throw new Error('Chrome 未返回 webSocketDebuggerUrl');
  const url = new URL(ws);
  url.hostname = cfg.chromeHost;
  url.port = String(cfg.cdpPort);
  return url.toString();
}

// ─── Public API ─────────────────────────────────────────────

/**
 * 连接 Chrome。
 *
 * 默认连你日常的 Chrome。
 * 传 `{ launchNew: true }` 启动独立实例，不碰日常的 Chrome。
 */
export async function connectBrowser(opts?: ConnectOptions) {
  if (opts) setConnectOptions(opts);
  await ensureChrome();
  const ws = await getWsEndpoint();
  const browser = new CdpBrowser(ws);
  await browser.connect();
  return browser;
}

/**
 * 关闭独立 Chrome 实例（如果存在）。
 */
export async function killInstance() {
  if (!_activeInstance) {
    console.log('  ℹ️  没有活动的独立实例');
    return;
  }
  const { port } = _activeInstance;
  try {
    const wsUrl = `http://127.0.0.1:${port}/json/version`;
    const info = await fetchJson(wsUrl).catch(() => null);
    if (info?.webSocketDebuggerUrl) {
      const url = new URL(info.webSocketDebuggerUrl);
      const browser = new CdpBrowser(url.toString());
      await browser.connect();
      await browser.connection.send('Browser.close');
      console.log(`  ✅ 已关闭实例 (端口 ${port})`);
    }
  } catch {
    console.log(`  ⚠️  无法自动关闭实例 (端口 ${port})，请手动关闭 Chrome 窗口`);
  }
  _activeInstance = null;
}

// ─── Test connection ─────────────────────────────────────

export async function testConnection() {
  const cfg = getConfig();
  try {
    const version = await fetchJson(`http://${cfg.chromeHost}:${cfg.cdpPort}/json/version`);
    const ws = version.webSocketDebuggerUrl;
    if (!ws) throw new Error('No webSocketDebuggerUrl');
    const wsUrl = new URL(ws);
    wsUrl.hostname = cfg.chromeHost;
    wsUrl.port = String(cfg.cdpPort);
    const browser = new CdpBrowser(wsUrl.toString());
    await browser.connect();
    await browser.close();
    return {
      ok: true,
      host: cfg.chromeHost,
      port: cfg.cdpPort,
      platform: detectPlatform(),
      browser: version.Browser,
      mode: cfg.isInstance ? 'instance' : 'existing',
    };
  } catch (err: any) {
    return { ok: false, host: cfg.chromeHost, port: cfg.cdpPort, platform: detectPlatform(), error: err.message };
  }
}

export async function getConnectionInfo() {
  const cfg = getConfig();
  return fetchJson(`http://${cfg.chromeHost}:${cfg.cdpPort}/json/version`);
}

export { ensureChrome };

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
      console.log(`✅ Chrome 远程调试运行中 (${detectPlatform()})`);
      console.log(`   Browser: ${info.Browser}`);
      console.log(`   WS Endpoint: ${info.webSocketDebuggerUrl}`);
      process.exit(0);
    } catch (e: any) {
      console.log(`❌ Chrome 未连接 (${detectPlatform()}): ${e.message}`);
      process.exit(1);
    }
  }

  if (args.includes('--kill')) {
    await killInstance();
    process.exit(0);
  }

  if (args.includes('--login')) {
    const loginIdx = args.indexOf('--login') + 1;
    const url = loginIdx < args.length ? args[loginIdx] : 'https://www.douyin.com';
    const useInstance = args.includes('--instance');
    console.log(`🔐 等待手动登录: ${url}`);
    const browser = await connectBrowser(useInstance ? { launchNew: true } : undefined);
    const page = await browser.newPage();
    await page.setViewport(1280, 720);
    await page.gotoWithLogin(url, { timeoutMs: 300_000 });
    const loggedInUrl = await page.url();
    console.log(`✅ 已登录: ${loggedInUrl}`);
    await page.close();
    await browser.close();
    console.log('💾 登录态已保存');
    process.exit(0);
  }

  if (args.includes('--open-url') || args.includes('--instance')) {
    const useInstance = args.includes('--instance');
    const urlIndex = args.indexOf('--open-url');
    const url = urlIndex >= 0 && urlIndex + 1 < args.length
      ? args[urlIndex + 1]
      : 'https://example.com';
    const proxyIdx = args.indexOf('--proxy');
    const proxy = proxyIdx >= 0 && proxyIdx + 1 < args.length ? args[proxyIdx + 1] : undefined;
    const opts: ConnectOptions = useInstance ? { launchNew: true, proxy } : { proxy };
    console.log(`🌐 ${useInstance ? '独立实例' : '默认 Chrome'} → ${url}`);
    if (proxy) console.log(`   📡 代理: ${proxy}`);
    const browser = await connectBrowser(opts);
    const page = await browser.newPage();
    await page.setViewport(1280, 720);
    await page.goto(url);
    const title = await page.evaluate('document.title');
    console.log(`📌 标题: ${title}`);
    await sleep(3000);
    await page.close();
    await browser.close();
    process.exit(0);
  }

  console.log(`
用法: npx tsx scripts/cdp-manager.ts [选项]

选项:
  --test                   测试 CDP 连接
  --status                 查看 Chrome 状态
  --login [url]            等待手动登录
  --open-url <url>         打开页面测试
  --proxy <addr>           设置代理（配合 --instance 使用）
  --instance               使用独立 Chrome 实例（不碰日常 Chrome）
  --kill                   关闭独立实例

示例:
  # 独立实例 + 代理（完美分离方案）
  npx tsx scripts/cdp-manager.ts --instance --proxy http://127.0.0.1:7890 --open-url https://example.com

  # 独立实例登录
  npx tsx scripts/cdp-manager.ts --instance --login https://www.douyin.com

  # 关掉独立实例
  npx tsx scripts/cdp-manager.ts --kill

编程用法:
  import { connectBrowser, killInstance } from './cdp-manager';

  // 独立实例走代理，不碰日常 Chrome
  const browser = await connectBrowser({
    launchNew: true,
    proxy: 'http://127.0.0.1:7890',
  });
  await browser.close();
  await killInstance();
`);
}

function isMain() {
  try { return import.meta.url?.endsWith(process.argv[1]?.replace(/^.*[\\/]/, '')); } catch { return false; }
}
if (isMain()) { main().catch(console.error); }
