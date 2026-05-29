#!/usr/bin/env npx tsx
/**
 * 统一网站提取器 CLI
 *
 * 自动识别 URL 的站点，调用对应提取器，输出结构化结果。
 * 支持重试和耗时统计。
 *
 * 用法:
 *   npx tsx scripts/extract.ts 'https://v.douyin.com/xxxx/'
 *   npx tsx scripts/extract.ts --json 'https://v.douyin.com/xxxx/'
 *   npx tsx scripts/extract.ts --retries 2 'https://v.douyin.com/xxxx/'
 *   npx tsx scripts/extract.ts '链接1' '链接2' --retries 3     # 批量
 *   npx tsx scripts/extract.ts --list
 */
import { extract, batchExtract, listSites } from './extractors';
import type { TimedExtractorResult, BatchSummary } from './extractors';

function parseArgs(raw: string[]) {
  const flags: Record<string, string> = {};
  const urls: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--list') { flags.list = 'true'; continue; }
    if (raw[i] === '--json') { flags.json = 'true'; continue; }
    if (raw[i] === '--batch') { flags.batch = 'true'; continue; }
    if (raw[i] === '--retries' && i + 1 < raw.length) { flags.retries = raw[++i]; continue; }
    if (!raw[i].startsWith('--')) { urls.push(raw[i]); }
  }

  return { flags, urls };
}

function formatResult(data: TimedExtractorResult) {
  const site = data.site || '';
  const time = data.elapsedMs ? ` (${data.elapsedMs}ms${data.retries > 0 ? `, ${data.retries} 重试` : ''})` : '';
  return [
    `━━━━━ 📄 ${site} 内容信息${time} ━━━━━`,
    `📌 标题:     ${data.title || 'N/A'}`,
    `👤 作者:     ${data.author || 'N/A'}`,
    `🆔 ID:       ${data.id || 'N/A'}`,
    data.publishDate ? `📅 发布时间: ${data.publishDate}` : null,
    data.likes != null ? `👍 点赞:     ${formatNum(data.likes)}` : null,
    data.comments != null ? `💬 评论:     ${formatNum(data.comments)}` : null,
    data.shares != null ? `🔁 分享:     ${formatNum(data.shares)}` : null,
    data.description ? `📝 描述:     ${(data.description + '').slice(0, 200)}` : null,
    data.coverUrl ? `🖼️ 封面:     ${data.coverUrl}` : null,
    `🔗 链接:     ${data.url || 'N/A'}`,
    `━━━━━━━━━━━━━━━━━━━━━`,
  ].filter(Boolean).join('\n');
}

function formatBatchSummary(s: BatchSummary) {
  return [
    `\n📊 批量汇总`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    `  总计: ${s.total}  成功: ${s.success}  失败: ${s.failed}`,
    `  总耗时: ${(s.totalElapsedMs / 1000).toFixed(1)}s  平均: ${s.avgElapsedMs}ms/条`,
    s.failed > 0 ? `\n  失败列表:` : null,
    ...s.results
      .filter(r => !r.id)
      .map(r => `    ❌ ${r.site}: ${r.url}`),
  ].filter(Boolean).join('\n');
}

function formatNum(n: number) {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  return n.toLocaleString();
}

async function main() {
  const { flags, urls } = parseArgs(process.argv.slice(2));

  if (flags.list) {
    const sites = listSites();
    console.log('📋 已注册的提取器:');
    for (const s of sites) console.log(`   ${s.domain}  → ${s.name}`);
    process.exit(0);
  }

  if (urls.length === 0) {
    console.log(`
用法: npx tsx scripts/extract.ts [选项] <URL...>

选项:
  --list              列出已注册的站点
  --json              输出 JSON
  --batch             强制批量模式（多 URL 自动启用）
  --retries <n>       失败重试次数（默认 1）

示例:
  npx tsx scripts/extract.ts 'https://v.douyin.com/xxxx/'
  npx tsx scripts/extract.ts --json 'https://v.douyin.com/xxxx/'
  npx tsx scripts/extract.ts --retries 3 'https://v.douyin.com/xxxx/'
  npx tsx scripts/extract.ts '链接1' '链接2' '链接3'
`);
    process.exit(1);
  }

  const jsonMode = !!flags.json;
  const batchMode = flags.batch || urls.length > 1;
  const retries = flags.retries ? parseInt(flags.retries) : 1;

  if (batchMode) {
    const summary = await batchExtract(urls, { retries, retryDelayMs: 1500 });
    if (jsonMode) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      for (const r of summary.results) {
        console.log(formatResult(r));
        if (summary.results.indexOf(r) < summary.results.length - 1) console.log('');
      }
      console.log(formatBatchSummary(summary));
    }
    process.exit(summary.failed > 0 ? 1 : 0);
  }

  // 单条模式
  try {
    const result = await extract(urls[0], { retries, retryDelayMs: 1500 });
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatResult(result));
    }
  } catch (e: any) {
    console.error(`❌ 提取失败: ${e.message}`);
    process.exit(1);
  }
}

const isCli = typeof process !== 'undefined' && process.argv[1] && (
  process.argv[1].endsWith('extract.ts') || process.argv[1].endsWith('extract')
);
if (isCli) main().catch(console.error);
