#!/usr/bin/env npx tsx
/**
 * 表单自动提交 CLI
 *
 * 通过命令行配置表单操作，一键导航 → 填表 → 提交 → 等待。
 *
 * 用法:
 *   # 直接填表提交
 *   npx tsx scripts/form-submit.ts \
 *     --url 'https://example.com/login' \
 *     --field 'input[name="username"]=admin' \
 *     --field 'input[name="password"]=123456' \
 *     --submit 'button[type="submit"]'
 *
 *   # JSON 配置模式
 *   npx tsx scripts/form-submit.ts --config form.json
 *
 *   # 带 checkbox 和 select
 *   npx tsx scripts/form-submit.ts \
 *     --url 'https://example.com/register' \
 *     --field '#name=张三' \
 *     --field '#gender=select:male' \
 *     --field '#agree=check:true' \
 *     --submit '#register-btn'
 *
 *   # 只填表不提交
 *   npx tsx scripts/form-submit.ts \
 *     --url 'https://example.com/form' \
 *     --field '#field1=hello'
 *
 * JSON 配置格式 (form.json):
 *   {
 *     "url": "https://example.com/login",
 *     "fields": {
 *       "input[name='username']": "admin",
 *       "input[name='password']": "secret",
 *       "#remember": true,
 *       "#gender": { "value": "male" }
 *     },
 *     "submit": "button[type='submit']",
 *     "waitType": "url",
 *     "successUrl": "/dashboard"
 *   }
 */
import { connectBrowser } from './cdp-manager';
import { formSubmit, fillForm, FormConfig, FormFieldValue } from './form-helper';
import fs from 'fs';

// ─── 参数解析 ──────────────────────────────────────────────

function parseFields(fieldArgs: string[]): Record<string, FormFieldValue | string | number | boolean | string[]> {
  const fields: Record<string, FormFieldValue | string | number | boolean | string[]> = {};

  for (const arg of fieldArgs) {
    // field syntax: selector=value
    // value variants:
    //   select:value        → select dropdown
    //   check:true/false    → checkbox
    //   file:/path/to/file  → file upload
    const eqIdx = arg.indexOf('=');
    if (eqIdx === -1) {
      console.warn(`  ⚠️ 跳过无效字段格式: ${arg}（应为 selector=value）`);
      continue;
    }

    const selector = arg.slice(0, eqIdx);
    const rawValue = arg.slice(eqIdx + 1);

    if (rawValue.startsWith('select:')) {
      fields[selector] = { value: rawValue.slice(7), type: 'select' } as FormFieldValue;
    } else if (rawValue.startsWith('check:')) {
      fields[selector] = rawValue.slice(6) === 'true' as any;
    } else if (rawValue.startsWith('file:')) {
      fields[selector] = { value: rawValue.slice(5), type: 'file' } as FormFieldValue;
    } else if (rawValue === 'true' || rawValue === 'false') {
      fields[selector] = rawValue === 'true';
    } else {
      fields[selector] = rawValue;
    }
  }

  return fields;
}

function parseArgs(args: string[]) {
  const config: Partial<FormConfig> & { configFile?: string; showFields?: boolean } = {};
  const fieldArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--url':
        config.url = args[++i];
        break;
      case '--submit':
        config.submit = args[++i];
        break;
      case '--field':
        fieldArgs.push(args[++i]);
        break;
      case '--config':
        config.configFile = args[++i];
        break;
      case '--wait-type':
        config.waitType = args[++i] as 'timeout' | 'url' | 'none';
        break;
      case '--wait':
        config.waitMs = parseInt(args[++i]);
        break;
      case '--success-url':
        config.successUrl = args[++i];
        break;
      case '--pre-submit-delay':
        config.preSubmitDelayMs = parseInt(args[++i]);
        break;
      case '--no-humanize':
        config.humanize = false;
        break;
      case '--show-fields':
        config.showFields = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  // 解析 --field 参数
  if (fieldArgs.length > 0) {
    config.fields = parseFields(fieldArgs);
  }

  return config;
}

function printHelp() {
  console.log(`
表单自动提交 CLI

用法:
  npx tsx scripts/form-submit.ts [选项]

选项:
  --url <URL>            目标页面 URL
  --field '<sel>=<val>'  表单字段（可多次使用）
                         值语法:
                           text       → 文本输入
                           check:true  → 勾选
                           check:false → 取消勾选
                           select:val  → 下拉选择
                           file:/path  → 文件上传
  --submit '<sel>'       提交按钮 CSS 选择器
  --config <file>        使用 JSON 配置文件
  --wait-type <type>     提交后等待方式: timeout / url / none
  --wait <ms>            等待时长（默认 5000）
  --success-url <str>    wait-type=url 时的成功 URL 片段
  --pre-submit-delay <ms> 填完后提交前等待 ms
  --no-humanize          关闭拟真人机交互
  --show-fields          列出表单字段（调试用）

示例:
  npx tsx scripts/form-submit.ts \\
    --url 'https://example.com/login' \\
    --field 'input[name="username"]=admin' \\
    --field 'input[name="password"]=secret' \\
    --submit 'button[type="submit"]' \\
    --wait-type url --success-url /dashboard

  npx tsx scripts/form-submit.ts --config my-login.json
`);
}

// ─── 表单字段检测 ──────────────────────────────────────────

/**
 * 列出页面上的表单字段（调试用）
 */
async function listFormFields(page: any) {
  const fields = await page.evaluate(`
    (function() {
      var forms = document.querySelectorAll('form');
      var out = [];
      forms.forEach(function(form) {
        var els = form.querySelectorAll('input, select, textarea, button');
        els.forEach(function(el) {
          out.push({
            tag: el.tagName.toLowerCase(),
            type: el.type || (el.tagName === 'SELECT' ? 'select' : ''),
            name: el.name || '',
            id: el.id || '',
            placeholder: el.placeholder || '',
            className: (el.className || '').slice(0, 60),
            required: el.required || false,
          });
        });
      });
      return out;
    })()
  `);

  if (fields.length === 0) {
    console.log('  ℹ️ 未发现表单或表单字段');
    return;
  }

  console.log(`\n📋 发现 ${fields.length} 个表单字段:`);
  console.log('  ' + '-'.repeat(80));
  console.log('  ' + ['标签', '类型', 'name/id', '占位', '必填'].map(s => s.padEnd(16)).join(''));
  console.log('  ' + '-'.repeat(80));
  for (const f of fields) {
    const label = `${f.tag}${f.type ? '/' + f.type : ''}`;
    const nameId = f.name || f.id || '';
    console.log('  ' + [label, '', nameId, f.placeholder || '', f.required ? '✅' : '']
      .map((s, i) => i === 0 ? s.padEnd(16) : s.padEnd(16)).join(''));
  }
}

// ─── 主函数 ────────────────────────────────────────────────

async function main() {
  const rawConfig = parseArgs(process.argv.slice(2));

  // 加载 JSON 配置文件
  let config: FormConfig;
  if (rawConfig.configFile) {
    const content = fs.readFileSync(rawConfig.configFile, 'utf-8');
    config = JSON.parse(content);
    console.log(`📋 从配置文件加载: ${rawConfig.configFile}`);
  } else if (rawConfig.fields && Object.keys(rawConfig.fields).length > 0) {
    config = {
      url: rawConfig.url,
      fields: rawConfig.fields,
      submit: rawConfig.submit,
      waitType: rawConfig.waitType || 'timeout',
      waitMs: rawConfig.waitMs || 5000,
      successUrl: rawConfig.successUrl,
      preSubmitDelayMs: rawConfig.preSubmitDelayMs,
      humanize: rawConfig.humanize !== false,
    };
  } else {
    printHelp();
    process.exit(1);
  }

  const fieldCount = Object.keys(config.fields || {}).length;
  if (fieldCount === 0) {
    console.error('❌ 未指定表单字段（--field 或 --config）');
    process.exit(1);
  }

  console.log(`🚀 表单自动提交`);
  if (config.url) console.log(`   📍 URL: ${config.url}`);
  console.log(`   📝 字段: ${fieldCount} 个`);
  if (config.submit) console.log(`   🔘 提交: ${config.submit}`);
  console.log(`   👤 拟真交互: ${config.humanize !== false ? '开' : '关'}`);

  // 连接浏览器
  console.log('\n🔗 正在连接 Chrome...');
  const browser = await connectBrowser();
  const page = await browser.newPage();
  await page.setViewport(1440, 900);

  try {
    // 调试模式：只显示字段
    if (rawConfig.showFields) {
      if (config.url) {
        await page.goto(config.url, { timeoutMs: 35000 });
        await new Promise(r => setTimeout(r, 2000));
      }
      await listFormFields(page);
      return;
    }

    // 正常提交
    const result = await formSubmit(page, config);

    console.log(`\n✅ 完成`);
    console.log(`   📍 当前 URL: ${result.url}`);
    console.log(`   ✅ 已提交: ${result.submitted ? '是' : '否（只填未提交）'}`);

    // 提交后再等 5 秒让用户看到结果
    if (result.submitted) {
      console.log('\n⏳ 保持页面 5 秒供浏览...');
      await new Promise(r => setTimeout(r, 5000));
    }

    await page.close();
    await browser.close();
  } catch (err: any) {
    console.error(`\n❌ 表单提交失败: ${err.message}`);
    // 保留页面供调试
    console.log('   💡 页面保留在 Chrome 中，可手动查看');
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(1);
  }
}

const isCli = typeof process !== 'undefined' && process.argv[1] && (
  process.argv[1].endsWith('form-submit.ts') || process.argv[1].endsWith('form-submit')
);
if (isCli) main().catch(console.error);
