/**
 * CaptchaWatchdog — 验证码检测与等待
 *
 * 监听页面是否出现验证码元素（通过 DOM 特征检测），
 * 如果检测到，暂停 Agent 执行等待人工解决，超时后继续。
 *
 * 检测策略（中国站常见验证码）:
 * - iframe detection: #captcha, .geetest, .nc_container (极验/网易)
 * - text detection: "请完成验证", "请拖动滑块", "请点击..."
 * - URL detection: /captcha/, /verify/, /slide/
 */

import { BaseWatchdog, type WatchdogOptions } from './base-watchdog';
import type { WatchdogEventName } from './event-bus';

export interface CaptchaWatchdogOptions extends WatchdogOptions {
  /** 等待人工解验证码的超时时间 ms（默认 120s） */
  captchaTimeoutMs?: number;
  /** 轮询间隔 ms（默认 2000） */
  pollIntervalMs?: number;
  /** 自定义检测函数（返回 true 表示页面有验证码） */
  detectFn?: (pageUrl: string, pageText: string) => boolean;
}

export interface CaptchaDetectResult {
  detected: boolean;
  vendor?: string; // 'geetest' | 'netease' | 'hcaptcha' | 'recaptcha' | 'unknown'
  confidence: number; // 0-1
}

// 常见的验证码元素选择器（按优先级排序）
const CAPTCHA_SELECTORS = [
  // 极验
  '.geetest_captcha',
  '.geetest_holder',
  '.geetest_radar_tip',
  // 网易易盾
  '.nc_container',
  '.yidun_popup',
  '.yidun--head',
  // hCaptcha
  '.h-captcha',
  'iframe[src*="hcaptcha.com"]',
  // reCAPTCHA
  '.g-recaptcha',
  'iframe[src*="recaptcha"]',
  // 通用
  '#captcha',
  '.captcha',
  '[class*="captcha"]',
  '[id*="captcha"]',
  // 滑块验证
  '.slider-container',
  '.slide-verify',
  '.drag-verify',
];

const CAPTCHA_VENDOR_MAP: { selector: string; vendor: string }[] = [
  { selector: '.geetest', vendor: 'geetest' },
  { selector: 'geetest', vendor: 'geetest' },
  { selector: '.nc_', vendor: 'netease' },
  { selector: 'yidun', vendor: 'netease' },
  { selector: 'h-captcha', vendor: 'hcaptcha' },
  { selector: 'hcaptcha.com', vendor: 'hcaptcha' },
  { selector: 'recaptcha', vendor: 'recaptcha' },
  { selector: 'g-recaptcha', vendor: 'recaptcha' },
  { selector: 'slider', vendor: 'slide' },
  { selector: 'slide-verify', vendor: 'slide' },
  { selector: 'drag-verify', vendor: 'slide' },
];

const CAPTCHA_KEYWORDS = [
  '请完成验证',
  '请拖动滑块',
  '请点击按钮进行验证',
  '请按顺序点击',
  '请在下图中点击',
  '验证码',
  '安全验证',
  '人机验证',
  '身份验证',
  'slide to verify',
  'complete the security check',
  'verify you are human',
  '请点击',
  '请按住',
];

/** 通过 evaluate 检测验证码 */
const DETECT_SCRIPT = `
() => {
  const docText = document.body?.innerText || '';
  const html = document.documentElement?.innerHTML || '';
  const selectors = ${JSON.stringify(CAPTCHA_SELECTORS)};
  const keywords = ${JSON.stringify(CAPTCHA_KEYWORDS)};
  
  let detected = false;
  let vendor = 'unknown';
  let confidence = 0;
  
  // 1. 选择器检测
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        detected = true;
        confidence = 0.8;
        // 检测是 visible 的
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) confidence = 0.95;
        break;
      }
    } catch {}
  }
  
  // 2. iframe 检测
  if (!detected) {
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      const src = iframe.src || '';
      if (src.includes('captcha') || src.includes('geetest') || src.includes('recaptcha') || src.includes('hcaptcha')) {
        detected = true;
        confidence = 0.9;
        break;
      }
    }
  }
  
  // 3. 关键词检测
  if (!detected) {
    const textMatch = keywords.some(k => docText.includes(k) || html.includes(k));
    if (textMatch) {
      detected = true;
      confidence = 0.7;
    }
  }
  
  // 识别供应商
  if (detected) {
    const vendorMap = ${JSON.stringify(CAPTCHA_VENDOR_MAP)};
    for (const { selector, vendor: v } of vendorMap) {
      if (html.includes(selector) || docText.includes(selector.replace('.', ''))) {
        vendor = v;
        break;
      }
    }
    if (vendor === 'unknown' && html.includes('hcaptcha')) vendor = 'hcaptcha';
    if (vendor === 'unknown' && html.includes('recaptcha')) vendor = 'recaptcha';
  }
  
  return { detected, vendor, confidence };
}`;

export class CaptchaWatchdog extends BaseWatchdog {
  static override LISTENS_TO: readonly WatchdogEventName[] = ['NavigationCompleted', 'PageLoaded'];
  static override EMITS: readonly WatchdogEventName[] = ['CaptchaDetected', 'CaptchaResolved'];

  private _captchaTimeoutMs: number;
  private _pollIntervalMs: number;
  private _detectFn?: (pageUrl: string, pageText: string) => boolean;
  private _currentUrl = '';
  private _evaluateFn: ((script: string) => Promise<any>) | null = null;
  private _pendingCaptcha = false;

  constructor(opts: CaptchaWatchdogOptions) {
    super(opts);
    this._captchaTimeoutMs = opts.captchaTimeoutMs ?? 120_000;
    this._pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this._detectFn = opts.detectFn;
  }

  /**
   * 绑定页面 evaluate 函数（由外部注入）
   */
  setEvaluateFn(fn: (script: string) => Promise<any>): void {
    this._evaluateFn = fn;
  }

  /** 导航完成时自动检测 */
  async on_NavigationCompleted(event: { url: string; success: boolean }): Promise<void> {
    this._currentUrl = event.url;
    if (event.success) {
      // 页面加载完成后等一会再检测（验证码经常是延迟加载的）
      await new Promise((r) => setTimeout(r, 1500));
      await this._checkCaptcha();
    }
  }

  /** 页面加载完成时检测 */
  async on_PageLoaded(event: { url: string }): Promise<void> {
    this._currentUrl = event.url;
    await new Promise((r) => setTimeout(r, 1000));
    await this._checkCaptcha();
  }

  /** 显式触发验证码检测（外部调用，比如 Agent 步循环里） */
  async checkNow(): Promise<CaptchaDetectResult> {
    return this._detectCaptcha();
  }

  /** 是否有待处理的验证码 */
  get hasPendingCaptcha(): boolean {
    return this._pendingCaptcha;
  }

  /**
   * 等待验证码被解决（阻塞，直到超时或验证码消失）
   * 返回 true=已解，false=超时
   */
  async waitForResolution(timeoutMs?: number): Promise<boolean> {
    if (!this._pendingCaptcha) return true;

    const timeout = timeoutMs ?? this._captchaTimeoutMs;
    const deadline = Date.now() + timeout;

    this.logger.info(
      `[CaptchaWatchdog] 🔒 等待人工解验证码 (${Math.round(timeout / 1000)}s)...`
    );

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this._pollIntervalMs));

      const result = await this._detectCaptcha();
      if (!result.detected) {
        this._pendingCaptcha = false;
        this.logger.info(`[CaptchaWatchdog] ✅ 验证码已解除`);
        this.emit('CaptchaResolved', { result: 'success' });
        return true;
      }
    }

    // 超时
    this._pendingCaptcha = false;
    this.logger.warn(`[CaptchaWatchdog] ⏰ 验证码等待超时`);
    this.emit('CaptchaResolved', { result: 'timeout' });
    return false;
  }

  private async _checkCaptcha(): Promise<void> {
    const result = await this._detectCaptcha();
    if (result.detected && !this._pendingCaptcha) {
      this._pendingCaptcha = true;
      this.logger.warn(
        `[CaptchaWatchdog] 🔒 检测到验证码 vendor=${result.vendor} confidence=${result.confidence}`
      );
      this.emit('CaptchaDetected', { vendor: result.vendor, url: this._currentUrl });
    } else if (!result.detected && this._pendingCaptcha) {
      this._pendingCaptcha = false;
      this.logger.info(`[CaptchaWatchdog] ✅ 验证码已解除（自动检测）`);
      this.emit('CaptchaResolved', { result: 'success' });
    }
  }

  private async _detectCaptcha(): Promise<CaptchaDetectResult> {
    // 如果有自定义检测函数，优先使用
    if (this._detectFn) {
      try {
        const detected = this._detectFn(this._currentUrl, '');
        if (detected) return { detected: true, vendor: 'custom', confidence: 1 };
      } catch {}
    }

    // 用 evaluate 检测
    if (this._evaluateFn) {
      try {
        return await this._evaluateFn(DETECT_SCRIPT);
      } catch (err: any) {
        this.logger.debug(`[CaptchaWatchdog] 检测失败: ${err.message}`);
      }
    }

    return { detected: false, vendor: undefined, confidence: 0 };
  }
}
