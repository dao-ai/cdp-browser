/**
 * 表单自动化辅助工具
 *
 * 在 CdpPage 基础上提供高层表单操作：
 *   - 下拉选择 selectOption()
 *   - 勾选/取消 check / uncheck
 *   - 批量填表 fillForm()
 *   - 表单提交 submitForm()
 *
 * 用法:
 *   import { formSubmit } from './form-helper';
 *   await formSubmit(page, {
 *     url: 'https://example.com/login',
 *     fields: { username: 'admin', password: 'secret' },
 *     submit: '#login-btn',
 *     successUrl: '/dashboard',
 *   });
 */
import { CdpPage, randomDelay, randomRange } from './cdp-client';

// ─── 类型 ──────────────────────────────────────────────────

export interface FormFieldValue {
  /** 填写值 */
  value: string | number | boolean | string[];
  /** input 类型覆盖（默认自动检测） */
  type?: 'text' | 'select' | 'checkbox' | 'radio' | 'file' | 'textarea';
  /** select/checkbox 用的选项值覆盖 */
  optionValue?: string;
  /**
   * 延时 ms，填完这个字段后等多久（默认 200-600ms 随机）。
   * 设为 0 不额外等待，多个字段之间会用随机间隔。
   */
  delayMs?: number;
}

export interface FormConfig {
  /** 先导航到的 URL（可选） */
  url?: string;
  /** 表单字段映射：selector → 值 */
  fields: Record<string, FormFieldValue | string | number | boolean | string[]>;
  /** 提交按钮 CSS 选择器 */
  submit?: string;
  /**
   * 点击提交后的行为：
   *   - 'timeout': 等 N 秒后继续
   *   - 'url': 等待 URL 变化到含 successUrl 的页面
   *   - 'none': 不等待
   */
  waitType?: 'timeout' | 'url' | 'none';
  /** waitType='timeout' 时的等待 ms（默认 5000） */
  waitMs?: number;
  /** waitType='url' 时的目标 URL 片段 */
  successUrl?: string;
  /** 所有字段填完后的等待 ms（默认 500-1500 随机） */
  preSubmitDelayMs?: number;
  /** 是否启用拟真人机交互（默认 true） */
  humanize?: boolean;
  /** 每次字段填写之间的延迟 ms 范围（默认 [300, 800]） */
  fieldGapMs?: [number, number];
}

// ─── 常量 ──────────────────────────────────────────────────

const NATURAL_GAP: [number, number] = [300, 800];
const PRE_SUBMIT_DELAY: [number, number] = [500, 1500];

// ─── 原生 select 选项选中 ──────────────────────────────────

/**
 * 通过 CDP selectOption 选择下拉框
 * @param selectSelector <select> 元素的 CSS 选择器
 * @param value 要选中的 option value
 */
export async function selectOption(page: CdpPage, selectSelector: string, value: string) {
  const sel = JSON.stringify(selectSelector);
  const val = JSON.stringify(value);

  const found = await page.evaluate(`
    (function() {
      var el = document.querySelector(${sel});
      if (!el || el.tagName !== 'SELECT') return false;
      el.value = ${val};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);

  if (!found) throw new Error(`Select element not found or not a <select>: ${selectSelector}`);
}

// ─── Checkbox / Radio ─────────────────────────────────────

/**
 * 勾选 / 取消勾选 checkbox 或 radio
 * @param selector 元素 CSS 选择器
 * @param checked true=勾选, false=取消
 */
export async function setChecked(page: CdpPage, selector: string, checked: boolean) {
  const sel = JSON.stringify(selector);

  const result = await page.evaluate(`
    (function() {
      var el = document.querySelector(${sel});
      if (!el) return 'not-found';
      if (el.type !== 'checkbox' && el.type !== 'radio') return 'not-checkable';
      if (el.checked === ${checked}) return 'no-change';
      el.checked = ${checked};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()
  `);

  if (result === 'not-found') throw new Error(`Element not found: ${selector}`);
  if (result === 'not-checkable') throw new Error(`Element is not checkbox/radio: ${selector}`);
}

/** 快捷：勾选 */
export async function check(page: CdpPage, selector: string) {
  return setChecked(page, selector, true);
}

/** 快捷：取消勾选 */
export async function uncheck(page: CdpPage, selector: string) {
  return setChecked(page, selector, false);
}

// ─── 批量填表 ──────────────────────────────────────────────

/**
 * 解析字段值为标准 FormFieldValue
 */
function normalizeField(v: FormFieldValue | string | number | boolean | string[]): FormFieldValue {
  if (typeof v === 'object' && !Array.isArray(v) && v !== null) return v as FormFieldValue;
  if (typeof v === 'string') return { value: v };
  if (typeof v === 'number') return { value: String(v) };
  if (typeof v === 'boolean') return { value: v };
  if (Array.isArray(v)) return { value: v };
  return { value: String(v) };
}

/**
 * 在给定 page 上批量填写表单字段
 *
 * 根据字段值的类型自动选择填法：
 *   - string: fillInput
 *   - boolean: check/uncheck
 *   - string[]: selectOption (multi)
 *
 * 选项:
 *   - humanize=true: 字段间随机延时，模拟真人操作
 *   - humanize=false: 批量快速填入
 */
export async function fillForm(
  page: CdpPage,
  config: FormConfig
) {
  const humanize = config.humanize !== false;
  const gap = config.fieldGapMs || NATURAL_GAP;

  // 先导航
  if (config.url) {
    await page.goto(config.url, { timeoutMs: 35000 });
    await randomDelay(1500, 3000);
  }

  const fieldKeys = Object.keys(config.fields);

  for (let i = 0; i < fieldKeys.length; i++) {
    const selector = fieldKeys[i];
    const raw = config.fields[selector];
    const field = normalizeField(raw);
    const val = field.value;
    const overrideType = field.type;

    // 字段间延时
    if (humanize && i > 0) {
      await randomDelay(gap[0], gap[1]);
    }

    // 焦点到字段（拟真操作的前置）
    if (humanize) {
      try {
        await page.click(selector);
        await randomDelay(100, 300);
      } catch { /* 点不上也不影响后续 */ }
    }

    // 自动检测类型
    let detectedType: string;
    if (overrideType) {
      detectedType = overrideType;
    } else if (typeof val === 'boolean') {
      detectedType = 'checkbox';
    } else if (Array.isArray(val)) {
      detectedType = 'select';
    } else {
      detectedType = 'text';
      // 尝试在前端检测元素类型
      try {
        detectedType = await page.evaluate(`
          (function() {
            var el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return 'text';
            var tag = el.tagName.toLowerCase();
            if (tag === 'select') return 'select';
            if (tag === 'textarea') return 'textarea';
            if (el.type === 'checkbox' || el.type === 'radio') return 'checkbox';
            if (el.type === 'file') return 'file';
            return 'text';
          })()
        `);
      } catch { /* fallback to text */ }
    }

    switch (detectedType) {
      case 'select': {
        const values = Array.isArray(val) ? val : [String(val)];
        for (const v of values) {
          await selectOption(page, selector, field.optionValue || String(v));
          if (values.length > 1 && humanize) await randomDelay(100, 300);
        }
        break;
      }
      case 'checkbox':
      case 'radio': {
        await setChecked(page, selector, Boolean(val));
        break;
      }
      case 'file': {
        const files = Array.isArray(val) ? (val as string[]) : [String(val)];
        await page.setInputFiles(selector, files);
        break;
      }
      case 'textarea': {
        // 先清空再用输入
        try {
          await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ''`);
        } catch {}
        await page.typeText(String(val));
        break;
      }
      default: {
        // text / email / password / number / tel / url / search
        await page.fillInput(selector, String(val));
        break;
      }
    }

    // 字段专属延时
    if (field.delayMs && field.delayMs > 0) {
      await new Promise(r => setTimeout(r, field.delayMs));
    }
  }
}

// ─── 表单提交 ──────────────────────────────────────────────

/**
 * 点击提交按钮并等待结果
 *
 * @param page CdpPage 实例
 * @param submitSelector 提交按钮 CSS 选择器（默认 'button[type="submit"], input[type="submit"]'）
 * @param waitType 等待方式（默认 'timeout', 5s）
 * @returns 提交后的页面 URL
 */
export async function submitForm(
  page: CdpPage,
  config: Pick<FormConfig, 'submit' | 'waitType' | 'waitMs' | 'successUrl'> = {}
) {
  const submitBtn = config.submit || 'button[type="submit"], input[type="submit"]';
  const waitType = config.waitType || 'timeout';
  const waitMs = config.waitMs || 5000;

  // 点击提交
  // 优先用 click 然后 fallback 到 Enter 键
  let clicked = false;
  try {
    await page.click(submitBtn);
    clicked = true;
  } catch {
    try {
      await page.pressKey('Enter');
      clicked = true;
    } catch {}
  }

  if (!clicked) {
    console.warn('  ⚠️ 未找到提交按钮，已尝试 Enter 键');
  }

  // 等待结果
  switch (waitType) {
    case 'url': {
      if (!config.successUrl) {
        throw new Error('waitType=url 需提供 successUrl 参数');
      }
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const currentUrl = await page.evaluate('location.href');
        if (currentUrl.includes(config.successUrl)) return currentUrl;
        await new Promise(r => setTimeout(r, 300));
      }
      throw new Error(`提交后未跳转到 ${config.successUrl}（超时 ${waitMs}ms）`);
    }
    case 'timeout': {
      await new Promise(r => setTimeout(r, waitMs));
      return page.evaluate('location.href');
    }
    case 'none':
    default: {
      return page.evaluate('location.href');
    }
  }
}

// ─── 一站式提交 ────────────────────────────────────────────

/**
 * 一站式表单提交：导航 → 填表 → 提交 → 等待结果
 *
 * @returns 提交后的页面 URL 和可选结果
 */
export async function formSubmit(
  page: CdpPage,
  config: FormConfig
): Promise<{ url: string; submitted: boolean; submitUrl?: string }> {
  // 填表
  await fillForm(page, config);

  // 提交前随机停顿
  const preDelay = config.preSubmitDelayMs ?? randomRange(PRE_SUBMIT_DELAY[0], PRE_SUBMIT_DELAY[1]);
  if (preDelay > 0) {
    await new Promise(r => setTimeout(r, preDelay));
  }

  // 有 submit 才提交
  if (config.submit) {
    const submitUrl = await submitForm(page, {
      submit: config.submit,
      waitType: config.waitType,
      waitMs: config.waitMs,
      successUrl: config.successUrl,
    });
    return { url: submitUrl, submitted: true, submitUrl };
  }

  return { url: await page.evaluate('location.href'), submitted: false };
}

// ─── 等待元素出现并填入 ────────────────────────────────────

/**
 * 等待元素出现后填入（适合 SPA 里动态加载的表单）
 *
 * @param selector 要等待的 CSS 选择器
 * @param timeoutMs 超时 ms
 * @param fn 元素出现后的回调（通常在这里做填入）
 */
export async function waitAndFill(
  page: CdpPage,
  selector: string,
  value: string,
  timeoutMs = 10000
) {
  const found = await page.waitForSelector(selector, timeoutMs);
  if (!found) throw new Error(`等待超时：${selector} 未出现（${timeoutMs}ms）`);
  await randomDelay(200, 600);
  await page.fillInput(selector, value);
}
