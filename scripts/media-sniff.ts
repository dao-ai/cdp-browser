#!/usr/bin/env npx tsx
/**
 * 媒体流嗅探器 — 从页面中检测视频/音频资源
 *
 * 用法:
 *   # 嗅探指定页面中的媒体资源
 *   npx tsx scripts/media-sniff.ts 'https://www.douyin.com/video/xxxx'
 *
 *   # 输出 JSON
 *   npx tsx scripts/media-sniff.ts --json 'https://v.douyin.com/xxxx/'
 *
 *   # 只嗅探 MP4 和 HLS
 *   npx tsx scripts/media-sniff.ts --types mp4,hls 'https://example.com/video'
 *
 *   # 屏蔽图片+字体加速加载（推荐用于视频站）
 *   npx tsx scripts/media-sniff.ts --fast 'https://example.com/video'
 *
 *   # 显示所有 TS 分片（默认隐藏）
 *   npx tsx scripts/media-sniff.ts --segments 'https://example.com/live'
 */
import { connectBrowser } from './cdp-manager';
import { MediaEntry, MediaType } from './cdp-client';

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return bytes + 'B';
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function formatResult(media: MediaEntry[], json: boolean, summary: any) {
  if (json) {
    console.log(JSON.stringify({ media, summary }, null, 2));
    return;
  }

  if (media.length === 0) {
    console.log('\n📭 未检测到媒体资源');
    return;
  }

  console.log(`\n📋 共检测到 ${media.length} 个媒体资源 (${formatSize(summary.totalSize)}):`);
  console.log('  ' + '─'.repeat(80));

  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    const typeIcons: Record<string, string> = {
      hls: '📺', mp4: '🎬', webm: '🎞️', flv: '📹',
      mp3: '🎵', aac: '🎶', wav: '🎼', ts: '🧩',
      m4s: '🧩', m4a: '🎵', ogg: '🎧', dash: '📡',
      stream: '📊',
    };
    const icon = typeIcons[m.type] || '📄';
    const size = m.size > 0 ? formatSize(m.size) : '?';
    const truncated = m.url.length > 100 ? m.url.slice(0, 97) + '...' : m.url;

    console.log(`  ${icon} [${i + 1}/${media.length}] ${'[' + m.type.toUpperCase() + ']'.padEnd(6)} ${size.padStart(9)}  ${m.method}`);
    console.log(`      ${truncated}`);
    if (i < media.length - 1) console.log('');
  }

  console.log('  ' + '─'.repeat(80));

  // 按类型统计
  console.log('\n📊 类型分布:');
  const byType = summary.byType as Record<string, number>;
  for (const [type, count] of Object.entries(byType)) {
    console.log(`   ${type}: ${count}`);
  }
  console.log(`   总计: ${media.length} 个文件, ${formatSize(summary.totalSize)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const fastMode = args.includes('--fast');
  const showSegments = args.includes('--segments');
  let types: string[] | undefined;

  const typesIdx = args.indexOf('--types');
  if (typesIdx >= 0 && typesIdx + 1 < args.length) {
    types = args[typesIdx + 1].split(',').map(s => s.trim().toLowerCase());
  }

  const urls = args.filter(a => !a.startsWith('--') && a.startsWith('http'));
  if (urls.length === 0) {
    console.log(`
用法: npx tsx scripts/media-sniff.ts [选项] <URL>

选项:
  --json              输出 JSON
  --types <type,...>  只嗅探指定类型 (mp4,hls,mp3,aac,flv,webm,dash,stream)
  --fast              屏蔽图片+字体加速加载
  --segments          显示 TS/M4S 分片（默认隐藏）
  --verbose           打印每个发现的日志

示例:
  npx tsx scripts/media-sniff.ts 'https://www.douyin.com/video/xxxx'
  npx tsx scripts/media-sniff.ts --json 'https://v.douyin.com/xxxx/'
  npx tsx scripts/media-sniff.ts --fast 'https://example.com/video'
  npx tsx scripts/media-sniff.ts --types mp4,hls 'https://example.com'
`);
    process.exit(1);
  }

  const url = urls[0];
  console.log(`🎬 媒体嗅探器`);
  console.log(`   📍 ${url}`);
  if (types) console.log(`   🔍 类型: ${types.join(', ')}`);
  if (fastMode) console.log(`   ⚡ 加速模式开`);
  if (!showSegments) console.log(`   🧩 TS/M4S 分片: 隐藏（--segments 显示）`);

  const browser = await connectBrowser();
  const page = await browser.newPage();
  await page.setViewport(1440, 900);

  try {
    // 加速模式：拦截图片和字体
    if (fastMode) {
      console.log('\n⏳ 开启资源拦截加速...');
      await page.blockResources(['Image', 'Font']);
    }

    // 开启嗅探
    await page.enableMediaSniffing({
      types: types || undefined,
      includeSegments: showSegments,
      verbose: args.includes('--verbose'),
    });

    console.log('\n⏳ 加载页面并嗅探...');
    await page.goto(url, { timeoutMs: 60000 });

    // 等一会儿，让异步加载的媒体也抓到
    if (url.includes('douyin') || url.includes('bilibili')) {
      console.log('   ⏳ 等待额外 5 秒抓取延迟加载...');
      await new Promise(r => setTimeout(r, 5000));
    }

    const media = page.getDetectedMedia({ sortBy: 'size' });
    const summary = page.getMediaSummary();
    const mediaList = page.getDetectedMedia({ sortBy: 'size' }) as MediaEntry[];
    const summary2 = page.getMediaSummary();

    // 关闭嗅探和拦截
    await page.disableMediaSniffing();
    if (fastMode) await page.blockResources([]);

    formatResult(mediaList, jsonMode, summary2);

    await page.close();
    await browser.close();

    process.exit(0);
  } catch (err: any) {
    console.error(`\n❌ 嗅探失败: ${err.message}`);
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

const isCli = typeof process !== 'undefined' && process.argv[1] && (
  process.argv[1].endsWith('media-sniff.ts') || process.argv[1].endsWith('media-sniff')
);
if (isCli) main().catch(console.error);
