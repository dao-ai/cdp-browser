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
 * 端口说明：
 *   Windows: Chrome 监听 127.0.0.1:9222，直接 localhost 连接
 *   WSL:     Chrome 监听 0.0.0.0:9222（Windows 端），WSL 通过 netsh 转发的 9223 连接
 */
import { CdpBrowser, sleep } from './cdp-client';
import http from 'http';
import fs from 'fs';
import os from 'os';
import { execSync, spawn } from 'child_process';

// ─── 平台检测 ──────────────────────────────────────────────

let _platform: 'windows' | 'wsl' | 'linux' | null = null;

export function detectPlatform(): 'windows' | 'wsl' | 'linux' {
  if (_platform) return _platform;

  if (process.platform === 'win32') {
    _platform = 'windows';
  } else {
    // Check for WSL
    try {
      if (process.env.WSL_DISTRO_NAME || fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
        _platform = 'wsl';
      } else {
        _platform = 'linux';
      }
    } catch {
      _platform = 'linux';
    }
  }

  return _platform;
}

export function isWindows() { return detectPlatform() === 'windows'; }
export function isWsl() { return detectPlatform() === 'wsl'; }
export function isLinux() { return detectPlatform() === 'linux'; }

// ─── 配置 — 按平台动态 ─────────────────────────────────────

function getConfig() {
  const plat = detectPlatform();

  if (plat === 'windows') {
    return {
      chromeHost: process.env.CHROME_DEBUG_HOST || '127.0.0.1',
      cdpPort: parseInt(process.env.CHROME_DEBUG_PORT || '9222'),
      chromeListenPort: parseInt(process.env.CHROME_DEBUG_PORT || '9222'),
      chromeListenAddr: '127.0.0.1',
      dataDir: process.env.CHROME_DATA_DIR || 'C:\\temp\\chrome-debug',
      usePortForward: false,
    };
  }

  return {
    // WSL or Linux (for Linux, set CHROME_DEBUG_HOST to remote Windows IP)
    chromeHost: process.env.CHROME_DEBUG_HOST || '172.20.48.1',
    cdpPort: parseInt(process.env.CHROME_DEBUG_PORT || '9223'),
    chromeListenPort: parseInt(process.env.CHROME_PORT || '9222'),
    chromeListenAddr: '0.0.0.0',
    dataDir: process.env.CHROME_DATA_DIR || 'C:\\temp\\chrome-debug',
    usePortForward: plat === 'wsl',
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

// ─── Bridge info ────────────────────────────────────────────

function windowsLocalAppDataWsl() {
  if (!isWsl()) return null;
  try {
    const localAppData = execSync('cmd.exe /c echo %LOCALAPPDATA%', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (localAppData && !localAppData.startsWith('%')) {
      return '/mnt/' + localAppData[0].toLowerCase() + localAppData.slice(2).replace(/\\/g, '/');
    }
  } catch {}
  return null;
}

function readBridgeInfo(): any {
  const paths = [
    process.env.CDP_BRIDGE_INFO,
  ];

  if (isWsl()) {
    const b = windowsLocalAppDataWsl();
    if (b) paths.push(`${b}/Google/ChromeProfile/cdp-bridge.json`);
    paths.push('/mnt/c/temp/wellness-cdp/cdp-bridge.json');
  } else if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA || 'C:\\Users\\' + os.userInfo().username + '\\AppData\\Local';
    paths.push(localAppData + '\\Google\\ChromeProfile\\cdp-bridge.json');
    paths.push('C:\\temp\\wellness-cdp\\cdp-bridge.json');
  }

  for (const p of paths) {
    if (!p) continue;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {}
  }
  return null;
}

// ─── Chrome path detection ──────────────────────────────────

function findChromePath(): string | null {
  const cfg = getConfig();

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
    // WSL: check Windows paths via cmd.exe
    for (const p of CHROME_PATHS_WIN) {
      try {
        const check = execSync(`cmd.exe /c "if exist "${p}" echo YES"`, { encoding: 'utf-8', timeout: 3000 }).trim();
        if (check.includes('YES')) return p;
      } catch {}
    }
    try {
      const result = execSync('cmd.exe /c where chrome', { encoding: 'utf-8', timeout: 3000 }).trim();
      if (result) return result.split('\n')[0].trim();
    } catch {}
  } else {
    // Pure Linux
    for (const p of CHROME_PATHS_LINUX) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {}
    }
    try {
      const result = execSync('which google-chrome || which chromium || which chromium-browser', { encoding: 'utf-8', timeout: 3000 }).trim();
      if (result) return result.split('\n')[0].trim();
    } catch {}
  }

  return null;
}

// ─── Chrome launch ──────────────────────────────────────────

function launchChrome(): void {
  const cfg = getConfig();
  const chromeExe = findChromePath();
  if (!chromeExe) throw new Error('找不到 Chrome/Chromium，请确保已安装');

  const args = [
    `--remote-debugging-port=${cfg.chromeListenPort}`,
    `--remote-debugging-address=${cfg.chromeListenAddr}`,
    `--user-data-dir="${cfg.dataDir}"`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  console.log(`🔧 正在启动 Chrome (${detectPlatform()}, 端口 ${cfg.chromeListenPort})...`);

  if (isWindows()) {
    // Windows: spawn directly (no cmd.exe wrapper)
    const proc = spawn(chromeExe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    proc.unref();
  } else if (isWsl()) {
    // WSL: launch Chrome on Windows side via cmd.exe
    const cmd = `"${chromeExe}" ${args.join(' ')}`;
    execSync(`cmd.exe /c start "" ${cmd}`, { timeout: 5000 });
  } else {
    // Pure Linux: spawn directly
    const proc = spawn(chromeExe, args, {
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
  }
}

// ─── Port forwarding (WSL only) ─────────────────────────────

function ensurePortForward(): boolean {
  if (!isWsl()) return true; // No port forwarding needed on Windows/Linux

  const cfg = getConfig();
  try {
    const result = execSync(
      `powershell.exe -Command "netsh interface portproxy show v4tov4 | findstr ${cfg.chromeListenPort}"`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    if (result.includes(String(cfg.chromeListenPort))) return true;
  } catch {}

  try {
    execSync(
      `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${cfg.cdpPort} connectaddress=127.0.0.1 connectport=${cfg.chromeListenPort}`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    try {
      execSync(
        `netsh advfirewall firewall add rule name="WSL Bridge" dir=in action=allow protocol=TCP localport=${cfg.cdpPort}`,
        { encoding: 'utf-8', timeout: 5000 }
      );
    } catch {}
    return true;
  } catch {
    return false;
  }
}

// ─── Ensure Chrome is available ─────────────────────────────

/**
 * Ensure Chrome remote debugging is available.
 * Auto-launches Chrome if not running.
 */
async function ensureChrome(retries = 15): Promise<boolean> {
  const cfg = getConfig();
  const checkUrl = `http://${cfg.chromeHost}:${cfg.cdpPort}/json/version`;

  // Check if already reachable
  try {
    await fetchJson(checkUrl);
    return true;
  } catch {}

  console.log(`🔧 Chrome 远程调试未连接，尝试自动启动 (${detectPlatform()})...`);

  try {
    launchChrome();
  } catch (e: any) {
    console.log(`  ⚠️  自动启动失败: ${e.message}`);
    console.log('  💡 请手动启动 Chrome:');
    if (isWindows()) {
      console.log(`     "${findChromePath() || 'chrome.exe'}" --remote-debugging-port=${cfg.chromeListenPort}`);
    } else if (isWsl()) {
      console.log(`     "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"`);
      console.log(`     --remote-debugging-port=${cfg.chromeListenPort} --remote-debugging-address=0.0.0.0 --user-data-dir="${cfg.dataDir}"`);
    } else {
      console.log(`     google-chrome --remote-debugging-port=${cfg.chromeListenPort} --user-data-dir="${cfg.dataDir}"`);
    }
    return false;
  }

  console.log('  ⏳ 等待 Chrome 启动...');
  await sleep(5000);

  if (isWsl()) {
    try { ensurePortForward(); } catch (e) { console.warn('  ⚠️  端口转发创建失败:', e); }
  }

  for (let i = 0; i < retries; i++) {
    try {
      await fetchJson(checkUrl);
      console.log('  ✅ Chrome 远程调试已就绪');
      return true;
    } catch {
      await sleep(2000);
    }
  }

  console.log('  ⚠️  等待超时，Chrome 未能自动就绪');
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
 * Connect to Chrome remote debugging.
 * Auto-detects platform and launches Chrome if needed.
 * Returns a CdpBrowser instance ready to create pages.
 */
export async function connectBrowser() {
  await ensureChrome();
  const ws = await getWsEndpoint();
  const browser = new CdpBrowser(ws);
  await browser.connect();
  return browser;
}

/**
 * Test CDP connection without creating a page
 */
export async function testConnection() {
  const cfg = getConfig();
  const info = readBridgeInfo();
  const mode = info ? 'bridge' : (isWsl() ? 'wsl-tcp' : 'direct');

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
      browser: info
        ? `Chrome PID ${info.pid} (bridge, Chrome port ${info.chromePort})`
        : version.Browser,
      mode,
    };
  } catch (err: any) {
    return { ok: false, host: cfg.chromeHost, port: cfg.cdpPort, platform: detectPlatform(), error: err.message, mode };
  }
}

/**
 * Get CDP connection info (JSON version endpoint).
 */
export async function getConnectionInfo() {
  const cfg = getConfig();
  return fetchJson(`http://${cfg.chromeHost}:${cfg.cdpPort}/json/version`);
}

export { ensureChrome };

// ─── CLI entry ──────────────────────────────────────────────

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
      console.log(`   Protocol: ${info.protocolVersion}`);
      console.log(`   User Agent: ${info.userAgent}`);
      console.log(`   WS Endpoint: ${info.webSocketDebuggerUrl}`);
      process.exit(0);
    } catch (e: any) {
      console.log(`❌ Chrome 远程调试未连接 (${detectPlatform()})`);
      console.log(`   错误: ${e.message}`);
      process.exit(1);
    }
  }

  if (args.includes('--login')) {
    const loginIdx = args.indexOf('--login') + 1;
    const url = loginIdx < args.length ? args[loginIdx] : 'https://www.douyin.com';
    console.log(`🔐 等待手动登录: ${url}`);
    console.log('   💡 在 Chrome 窗口中完成登录后，按 Ctrl+C 退出');
    console.log('   登录态会保留在 Chrome profile 中，后续提取无需重复登录\n');
    const browser = await connectBrowser();
    const page = await browser.newPage();
    await page.setViewport(1280, 720);
    await page.gotoWithLogin(url, { timeoutMs: 300_000 });
    const loggedInUrl = await page.url();
    console.log(`✅ 已登录: ${loggedInUrl}`);
    await page.close();
    await browser.close();
    console.log('💾 登录态已保存到 Chrome profile');
    process.exit(0);
  }

  if (args.includes('--open-url')) {
    const urlIndex = args.indexOf('--open-url') + 1;
    const url = urlIndex < args.length ? args[urlIndex] : 'https://example.com';
    console.log(`🌐 打开: ${url}`);
    const browser = await connectBrowser();
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
  --test          测试 CDP 连接（含平台检测）
  --status        查看 Chrome 远程调试状态
  --login [url]   打开 URL 并等待手动登录（默认抖音）
  --open-url <url> 打开 URL 并打印标题
`);
}

function isMain() {
  try { return import.meta.url?.endsWith(process.argv[1]?.replace(/^.*[\\/]/, '')); } catch { return false; }
}
if (isMain()) {
  main().catch(console.error);
}
