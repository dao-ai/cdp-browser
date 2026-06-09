/**
 * DOM → LLM 接口
 *
 * 把页面真实 DOM 转成带编号的可交互元素列表，让 LLM 能"看懂"页面布局和可操作项。
 * 参考 browser-use 的 dom/service.py 设计思路。
 *
 * 核心产出：
 *   DomState — 当前页面所有可交互元素的摘要（含坐标、标签、属性）
 *
 * 用法:
 *   const dom = new DomService(page);
 *   const state = await dom.capture();
 *   // state → LLM prompt 的一部分
 */

import type { CdpPage } from './cdp-client';

// ─── 类型定义 ──────────────────────────────────────────────

export interface DomElement {
  /** 元素在列表中的编号（LLM 通过此编号引用该元素） */
  index: number;
  /** HTML 标签名 */
  tag: string;
  /** 可见文本 */
  text: string;
  /** 元素类型：可点击、可输入、可提交、可导航等 */
  type: 'clickable' | 'input' | 'submit' | 'nav-link' | 'select' | 'checkbox' | 'text' | 'image' | 'other';
  /** 选择器（发给 CDP 用） */
  selector: string;
  /** 元素在页面上是否可见 */
  visible: boolean;
  /** 边界框（LLM 坐标参考） */
  box?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** href（如果是<a>） */
  href?: string;
  /** aria-label 或 title */
  ariaLabel?: string;
  /** input 类型 text/password/email 等 */
  inputType?: string;
  /** placeholder */
  placeholder?: string;
  /** value */
  value?: string;
  /** disabled */
  disabled?: boolean;
}

export interface DomState {
  /** 页面 URL */
  url: string;
  /** 页面标题 */
  title: string;
  /** 可见可交互元素列表（数量上限可配置） */
  elements: DomElement[];
  /** 页面文本摘要（前 x 字符） */
  textPreview: string;
  /** 框架/iframe 信息 */
  frames: { index: number; url: string; title: string }[];
  /** 捕获时间戳 */
  capturedAt: number;
}

// ─── 配置 ──────────────────────────────────────────────────

export interface DomServiceOptions {
  /** 最大返回元素数（默认 80） */
  maxElements?: number;
  /** 文本预览最大长度（默认 2000） */
  maxTextPreview?: number;
  /** 是否包含隐藏元素（默认 false） */
  includeHidden?: boolean;
  /** **/
  minViewportVisibility?: number; // 最小可见像素数
}

const DEFAULTS: Required<DomServiceOptions> = {
  maxElements: 80,
  maxTextPreview: 2000,
  includeHidden: false,
  minViewportVisibility: 4,
};

// ─── DOM Service ───────────────────────────────────────────

export class DomService {
  private _page: CdpPage;
  private _opts: Required<DomServiceOptions>;

  constructor(page: CdpPage, opts?: DomServiceOptions) {
    this._page = page;
    this._opts = { ...DEFAULTS, ...opts };
  }

  /**
   * 捕获当前页面状态 — 核心方法
   *
   * 1. eval JS 收集所有可交互元素
   * 2. 筛选可见元素
   * 3. 编号 + 按可交互度排序
   * 4. 附加 URL / title / textPreview / frames 信息
   */
  async capture(): Promise<DomState> {
    const [url, title, rawElements, textPreview, frames] = await Promise.all([
      this._page.evaluate('location.href'),
      this._page.evaluate('document.title || ""'),
      this._collectElements(),
      this._page.evaluate('(document.body?.innerText || "").slice(0, 2000)'),
      this._collectFrames(),
    ]);

    // 过滤 + 排序
    const filtered = this._filterElements(rawElements);

    return {
      url,
      title,
      elements: filtered,
      textPreview,
      frames,
      capturedAt: Date.now(),
    };
  }

  /**
   * 捕获页面状态 + base64 截图
   */
  async captureWithScreenshot(): Promise<DomState & { screenshot?: string }> {
    const state = await this.capture();
    let screenshot: string | undefined;
    try {
      const result = await this._page.screenshot();
      screenshot = result.data;
    } catch {
      // screenshot 失败不阻塞
    }
    return { ...state, screenshot };
  }

  // ── internal ──

  /**
   * 在浏览器上下文中执行 JS，收集所有可交互元素
   * 使用独立的 DOM 遍历，不依赖 CDP DOM 域
   */
  private async _collectElements(): Promise<any[]> {
    const maxEl = this._opts.maxElements * 2; // 多采集一些用于过滤
    return this._page.evaluate(`
      (function(maxEl) {
        const results = [];
        const seen = new Set();
        const priorityTags = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'IMG', 'VIDEO', 'LABEL', 'SPAN', 'DIV']);

        function getSelector(el, depth) {
          if (depth > 5) return '';
          if (el.id) return '#' + CSS.escape(el.id);
          if (el.className && typeof el.className === 'string') {
            var cls = el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).map(function(c) {
              return '.' + CSS.escape(c);
            }).join('');
            if (cls) return el.tagName.toLowerCase() + cls;
          }
          var parent = el.parentElement;
          if (parent) {
            var idx = Array.from(parent.children).indexOf(el) + 1;
            return getSelector(parent, depth + 1) + ' > ' + el.tagName.toLowerCase() + ':nth-child(' + idx + ')';
          }
          return el.tagName.toLowerCase();
        }

        // 广告/无用元素过滤
        var AD_CLASS_PATTERNS = [
          'advertisement', 'ad-container', 'ad-wrap', 'ad-area', 'adsbygoogle',
          'ad-slot', 'ad-box', 'ad-banner', 'article-ad', 'sidebar-ad',
          'promoted', 'promotion', 'sponsored', 'sponsored-post', 'promo', 'promote',
          'banner-ad', 'banner-ads', 'header-ad', 'footer-ad',
          'float-layer', 'float-bar', 'floating-layer', 'float-window',
          'sticky-toolbar', 'side-float', 'float-right',
          'popup-overlay', 'mask-overlay', 'overlay-bg', 'popup-container',
          'recommend', 'recommend-list', 'related-articles', 'related-goods',
          'share-box', 'share-bar', 'share-container', 'social-share',
          'footer-bar', 'footer-wrap', 'copyright', 'guess', 'guess-like',
        ];
        var AD_ID_PATTERNS = ['ad', 'advert', 'banner', 'popup', 'pop_ad', 'recommend'];

        function isAdElement(el) {
          // 检查 class 名
          var cls = el.className || '';
          if (typeof cls === 'string') {
            for (var i = 0; i < AD_CLASS_PATTERNS.length; i++) {
              if (cls.indexOf(AD_CLASS_PATTERNS[i]) >= 0) return true;
            }
          }
          // 检查 id
          var id = el.id || '';
          for (var j = 0; j < AD_ID_PATTERNS.length; j++) {
            if (id.indexOf(AD_ID_PATTERNS[j]) >= 0) return true;
          }
          // 检查 data 属性
          if (el.getAttribute('data-ad') || el.getAttribute('data-ad-unit')) return true;
          return false;
        }

        function isVisible(el) {
          var rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          if (rect.top > window.innerHeight || rect.bottom < 0) return false;
          if (rect.left > window.innerWidth || rect.right < 0) return false;
          var style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          return true;
        }

        function getElementType(el) {
          var tag = el.tagName.toLowerCase();
          if (tag === 'a' && el.href) return 'nav-link';
          if (tag === 'button') return 'clickable';
          if (tag === 'input') {
            var type = (el.type || 'text').toLowerCase();
            if (type === 'submit' || type === 'button' || type === 'reset') return 'submit';
            if (type === 'checkbox' || type === 'radio') return 'checkbox';
            if (type === 'file') return 'input';
            return 'input';
          }
          if (tag === 'textarea' || tag === 'select') return 'input';
          if (tag === 'img') return 'image';
          if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') return 'clickable';
          if (el.onclick || el.getAttribute('ng-click') || el.getAttribute('@click')) return 'clickable';
          if (el.tabIndex >= 0 && priorityTags.has(tag.toUpperCase())) return 'clickable';
          return 'text';
        }

        // Walk the DOM tree, depth-first
        var walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_ELEMENT,
          null,
          false
        );
        var node;
        while ((node = walker.nextNode()) && results.length < maxEl) {
          var el = /** @type {Element} */ (node);
          var tag = el.tagName.toLowerCase();

          // 只处理我们关心的标签类型
          if (!['a','button','input','textarea','select','img','video','label','span','div','nav','section','article','li','h1','h2','h3','h4','h5','h6','p','iframe'].includes(tag)) continue;

          // 跳过太小的元素
          var rect = el.getBoundingClientRect();
          if (rect.width < 8 && rect.height < 8) continue;

          var visible = isVisible(el);
          var text = (el.textContent || el.innerText || '').trim().slice(0, 80) || (tag === 'img' ? (el.alt || '') : '') || el.title || '';
          var key = tag + '::' + text.slice(0, 40) + '::' + Math.round(rect.left) + ',' + Math.round(rect.top);
          if (seen.has(key)) continue;
          seen.add(key);

          // 只保留有意义文本或可交互的
          if (!text && tag !== 'img' && tag !== 'input' && tag !== 'textarea' && tag !== 'button' && tag !== 'a') {
            // 空 DIV/SECTION 跳过，除非它包含可交互子元素
            continue;
          }

          var type = getElementType(el);
          var href = el.tagName === 'A' ? (el.href || '') : (el.getAttribute('data-href') || el.getAttribute('router-link') || '');
          var inputType = el.tagName === 'INPUT' ? (el.type || 'text') : undefined;

          results.push({
            tag: tag,
            text: text,
            type: type,
            selector: getSelector(el, 0),
            visible: visible,
            box: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
            href: href || undefined,
            ariaLabel: el.getAttribute('aria-label') || el.title || undefined,
            inputType: inputType,
            placeholder: el.getAttribute('placeholder') || undefined,
            value: el.value !== undefined && el.value !== '' && typeof el.value === 'string' ? el.value.slice(0, 40) : undefined,
            disabled: el.disabled || undefined,
          });
        }

        return results;
      })(${this._opts.maxElements * 2})
    `);
  }

  /**
   * 过滤 + 排序元素
   * - 保留可见元素优先
   * - 可交互元素优先
   * - 限制数量
   */
  private _filterElements(raw: any[]): DomElement[] {
    // 广告/无用元素文本关键词过滤
    const AD_TEXT_PATTERNS = ['广告', '推广', 'ad', 'sponsored', '了解更多', '下载APP', '立即下载', '打开APP', '查看详情'];

    const filtered = raw.filter((e: any) => {
      // 按文本关键词再过滤一道（JS 侧可能漏掉的一些动态广告）
      const text = (e.text || '').toLowerCase();
      for (let i = 0; i < AD_TEXT_PATTERNS.length; i++) {
        if (text.indexOf(AD_TEXT_PATTERNS[i]) >= 0) return false;
      }
      return true;
    });

    const visible = filtered.filter((e: any) => e.visible !== false);
    const hidden = filtered.filter((e: any) => e.visible === false);

    // 排序：可交互 > 可见 > 有文本 > 位置靠上
    const score = (e: any) => {
      let s = 0;
      if (e.visible) s += 100;
      if (['clickable', 'input', 'submit', 'nav-link', 'select', 'checkbox'].includes(e.type)) s += 50;
      if (e.text && e.text.length > 2) s += 10;
      // 减分：常见底部栏/推荐区
      if (e.box && e.box.y > 5000) s -= 20; // 长页面底部
      if ((e.href || '').includes('utm_') || (e.href || '').includes('spm=')) s -= 30;
      s -= (e.box?.y || 0) / 100; // 越靠上权重越高
      return s;
    };

    const sorted = [...visible, ...hidden].sort((a, b) => score(b) - score(a));

    return sorted.slice(0, this._opts.maxElements).map((e: any, i: number) => ({
      index: i,
      tag: e.tag,
      text: e.text || '',
      type: e.type || 'text',
      selector: e.selector,
      visible: e.visible !== false,
      box: e.box,
      href: e.href,
      ariaLabel: e.ariaLabel,
      inputType: e.inputType,
      placeholder: e.placeholder,
      value: e.value,
      disabled: e.disabled,
    }));
  }

  /**
   * 收集页面中的 iframe/框架信息
   */
  private async _collectFrames(): Promise<{ index: number; url: string; title: string }[]> {
    try {
      return await this._page.evaluate(`
        (function() {
          var frames = document.querySelectorAll('iframe, frame');
          var results = [];
          for (var i = 0; i < frames.length; i++) {
            try {
              var f = frames[i];
              results.push({
                index: i,
                url: f.src || '',
                title: f.title || f.getAttribute('aria-label') || '',
              });
            } catch(e) {}
          }
          return results;
        })()
      `);
    } catch {
      return [];
    }
  }

  /** 格式化 DOM 状态为 LLM 可读的文本描述 */
  static formatForPrompt(state: DomState): string {
    const lines: string[] = [];
    lines.push(`📍 当前页面: ${state.url}`);
    lines.push(`📌 标题: ${state.title}`);
    lines.push('');

    if (state.elements.length === 0) {
      lines.push('ℹ️ 页面上没有检测到可交互元素');
      lines.push('');
    } else {
      lines.push(`📋 可交互元素（${state.elements.length} 个）:`);
      lines.push('');
      for (const el of state.elements) {
        const icon = el.visible ? '' : ' (隐藏)';
        const disabled = el.disabled ? ' [禁用]' : '';
        const inputInfo = el.inputType ? ` type=${el.inputType}` : '';
        const pos = el.box ? ` [${el.box.x},${el.box.y}]` : '';
        const val = el.value ? ` value="${el.value}"` : '';
        const plc = el.placeholder ? ` placeholder="${el.placeholder}"` : '';

        switch (el.type) {
          case 'clickable':
            lines.push(`  [${el.index}] 🖱️ <${el.tag}>${disabled}${pos} ${el.text || el.ariaLabel || ''}`);
            break;
          case 'nav-link':
            lines.push(`  [${el.index}] 🔗 <${el.tag}>${pos} ${el.text || el.ariaLabel || ''} → ${el.href || ''}`);
            break;
          case 'input':
          case 'submit':
            lines.push(`  [${el.index}] ⌨️ <${el.tag}>${inputInfo}${pos}${val}${plc} ${el.text}`);
            break;
          case 'checkbox':
            lines.push(`  [${el.index}] ☑️ <${el.tag}>${pos} ${el.text}${val ? ' (' + val + ')' : ''}`);
            break;
          case 'image':
            lines.push(`  [${el.index}] 🖼️ <${el.tag}>${pos} ${el.text || el.ariaLabel || ''}`);
            break;
          default:
            lines.push(`  [${el.index}] 📄 <${el.tag}>${disabled}${icon}${pos} ${el.text.slice(0, 60)}`);
        }
      }
    }

    lines.push('');
    lines.push('📝 页面文本摘要:');
    lines.push(state.textPreview.slice(0, 1500));
    lines.push('');

    if (state.frames.length > 0) {
      lines.push('📦 iframe 列表:');
      for (const f of state.frames) {
        lines.push(`  [${f.index}] ${f.title || '(无标题)'} → ${f.url}`);
      }
    }

    return lines.join('\n');
  }
}
