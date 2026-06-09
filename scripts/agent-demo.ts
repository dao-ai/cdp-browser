#!/usr/bin/env npx tsx
/**
 * 🤖 Browser Agent Demo — 用自然语言指挥浏览器干活
 *
 * 用法:
 *   export DEEPSEEK_API_KEY="sk-..."
 *   npx tsx scripts/agent-demo.ts "帮我搜一下减脂餐"
 *
 * 或指定起始页面:
 *   npx tsx scripts/agent-demo.ts "小红书搜索减脂餐" --url https://www.xiaohongshu.com
 *
 * 环境变量:
 *   DEEPSEEK_API_KEY  — DeepSeek API key（必填）
 *   LLM_BASE_URL      — API 地址（默认 https://api.deepseek.com）
 *   LLM_MODEL         — 模型名（默认 deepseek-chat）
 */

import { connectBrowser } from './cdp-manager';
import { BrowserAgent } from './agent';

async function main() {
  const args = process.argv.slice(2);

  // 解析参数
  let task = args.find(a => !a.startsWith('--')) || '打开小红书首页，告诉我上面有什么内容';
  const urlIdx = args.indexOf('--url');
  const startUrl = urlIdx >= 0 ? args[urlIdx + 1] : undefined;
  const maxSteps = args.includes('--max-steps') ? parseInt(args[args.indexOf('--max-steps') + 1]) || 20 : 20;
  const verbose = !args.includes('--quiet');
  const proxyIdx = args.indexOf('--proxy');
  const proxy = proxyIdx >= 0 ? args[proxyIdx + 1] : undefined;
  const login = args.includes('--login');

  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    console.error('❌ 请设置 DEEPSEEK_API_KEY 环境变量');
    console.error('    export DEEPSEEK_API_KEY="sk-..."');
    process.exit(1);
  }

  console.log(`\n🤖 Browser Agent Demo`);
  console.log(`   任务: ${task}`);
  if (startUrl) console.log(`   起始: ${startUrl}`);
  console.log(`   最大步骤: ${maxSteps}`);
  console.log(`   模型: ${process.env.LLM_MODEL || 'deepseek-chat'}`);
  console.log('');

  // 连接浏览器
  console.log('🔧 连接浏览器...');
  const browser = await connectBrowser(proxy ? { proxy } : undefined);
  const page = await browser.newPage();
  await page.setViewport(1280, 800);

  // 如果指定了 --login，先手动登录
  if (login && startUrl) {
    console.log('🔐 等待手动登录...');
    await page.gotoWithLogin(startUrl, { timeoutMs: 300_000 });
  }

  // 创建 Agent
  const agent = new BrowserAgent(page, {
    llm: {
      apiKey,
      baseUrl: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
      model: process.env.LLM_MODEL || 'deepseek-chat',
    },
    maxSteps,
    verbose,
  });

  // 执行任务
  console.log('🚀 开始执行任务...');
  const result = await agent.run(task, { startUrl });

  // 输出结果
  console.log('\n' + '═'.repeat(60));
  console.log('📋 执行报告');
  console.log('═'.repeat(60));
  console.log(`  状态: ${result.success ? '✅ 成功' : '❌ 失败'}`);
  console.log(`  结束原因: ${result.endReason}`);
  console.log(`  总步数: ${result.totalSteps} (成功 ${result.successSteps}, 失败 ${result.failedSteps})`);
  console.log(`  最终 URL: ${result.finalUrl || 'N/A'}`);
  console.log(`  最终标题: ${result.finalTitle || 'N/A'}`);
  console.log('');
  console.log(`📄 最终输出:`);
  console.log(result.finalOutput);
  console.log('');
  console.log('📋 操作详情:');
  console.log(result.history.summary(30));

  // 清理
  await page.close();
  await browser.close();
  console.log('\n✅ Demo 结束');
}

main().catch(err => {
  console.error('❌ Demo 出错:', err.message);
  process.exit(1);
});
