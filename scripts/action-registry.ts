/**
 * Action Registry — 可插拔动作注册系统
 *
 * 参考 browser-use 的 controller/registry 设计：
 * - 装饰器式注册，动作带描述、参数定义、域名过滤
 * - 支持运行时查询（LLM 通过 describe() 知道有哪些动作）
 * - 支持域名约束 — 某些动作只在指定站点可用
 * - 所有动作接受 (page, args) 签名，page 是 CdpPage 实例
 *
 * 用法:
 *   const registry = new ActionRegistry();
 *   registry.register({
 *     name: 'click_element',
 *     description: '点击指定编号的元素',
 *     parameters: [{ name: 'index', type: 'number', description: '元素编号' }],
 *     handler: async (page, args) => { ... },
 *   });
 *
 *   // LLM 查询可用动作
 *   const actions = registry.describe();
 *
 *   // 执行动作
 *   await registry.execute('click_element', { index: 3 }, pageInstance);
 */

import type { CdpPage } from './cdp-client';

// ─── 工具 ──────────────────────────────────────────────────

/**
 * 域名通配符匹配
 * 支持: *.google.com, www.baidu.com, douyin.*, *
 */
function _matchDomain(domain: string, pattern: string): boolean {
  if (pattern === '*') return true;

  const d = domain.toLowerCase();
  const p = pattern.toLowerCase();

  // 精确匹配: "www.google.com" == "www.google.com"
  if (d === p) return true;

  // 前缀通配: "*.google.com" 匹配 "www.google.com", "mail.google.com"
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".google.com"
    return d.endsWith(suffix);
  }

  // 后缀通配: "douyin.*" 匹配 "douyin.com", "douyin.cn"
  if (p.endsWith('.*')) {
    const prefix = p.slice(0, -2); // "douyin"
    return d === prefix || d.startsWith(prefix + '.');
  }

  // 包含通配: "*.baidu.*" — 两边都通配
  if (p.startsWith('*.') && p.endsWith('.*')) {
    const middle = p.slice(2, -2); // "baidu"
    return d.includes(middle);
  }

  return false;
}

// ─── 类型定义 ──────────────────────────────────────────────

export interface ActionParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  default?: any;
  /** 枚举值 */
  enum?: string[];
}

export interface ActionDefinition {
  /** 动作名称（LLM 将通过此名称引用） */
  name: string;
  /** 人类可读描述 */
  description: string;
  /** 参数定义 */
  parameters?: ActionParameter[];
  /** 仅在这些域名下可用（留空表示任何站点） */
  domains?: string[];
  /** 处理函数 */
  handler: (page: CdpPage, args: Record<string, any>) => Promise<any>;
  /** 优先级（越高越优先显示给 LLM，默认 0） */
  priority?: number;
  /**
   * 是否终止后续动作序列。
   * 设为 true 表示此动作执行后页面状态将根本改变（导航、后退、task_done），
   * multiExecute() 会截断队列中的后续动作。
   * 默认 false。
   */
  terminatesSequence?: boolean;
}

export interface ActionEntry {
  name: string;
  description: string;
  parameters?: ActionParameter[];
  domains?: string[];
  priority?: number;
  terminatesSequence?: boolean;
}

export interface ActionResult {
  success: boolean;
  message: string;
  data?: any;
  error?: string;
  /** 动作执行后是否可能改变页面状态 */
  changedState?: boolean;
}

// ─── Action Registry ───────────────────────────────────────

export class ActionRegistry {
  private _actions: Map<string, ActionDefinition> = new Map();
  private _builtinRegistered = false;

  constructor() {
    this._registerBuiltins();
  }

  /** 注册一个动作 */
  register(def: ActionDefinition): this {
    if (this._actions.has(def.name)) {
      console.warn(`[action-registry] 覆盖已注册动作: ${def.name}`);
    }
    this._actions.set(def.name, def);
    return this;
  }

  /** 移除一个动作 */
  unregister(name: string): boolean {
    return this._actions.delete(name);
  }

  /** 获取某个动作的定义 */
  get(name: string): ActionDefinition | undefined {
    return this._actions.get(name);
  }

  /** 获取所有已注册的动作（用于 LLM 提示词） */
  /**
   * 获取当前域可用的动作列表
   * @param options.domain 当前域名（如 "www.baidu.com"），用于过滤
   * @param options.includeFiltered 是否包含被过滤掉的动作数（默认 false）
   */
  describe(options?: { domain?: string; includeFiltered?: boolean }): {
    actions: ActionEntry[];
    /** 被域名过滤掉的动作（信息性提示） */
    filteredCount: number;
  } {
    const entries: ActionEntry[] = [];
    let filteredCount = 0;
    const domain = options?.domain;

    for (const def of this._actions.values()) {
      // 域名过滤
      if (domain && def.domains?.length) {
        if (!def.domains.some(p => _matchDomain(domain, p))) {
          filteredCount++;
          continue;
        }
      }
      entries.push({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
        domains: def.domains,
        priority: def.priority,
        terminatesSequence: def.terminatesSequence,
      });
    }
    // 按优先级排序
    entries.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    if (options?.includeFiltered) {
      return { actions: entries, filteredCount };
    }
    return { actions: entries, filteredCount: 0 };
  }

  /**
   * 获取动作定义（含 terminatesSequence）
   */
  getDef(name: string): ActionDefinition | undefined {
    return this._actions.get(name);
  }

  /**
   * 检查动作是否会终止后续动作序列
   */
  isTerminating(name: string): boolean {
    const def = this._actions.get(name);
    return def?.terminatesSequence === true;
  }

  /**
   * 批量执行多个动作（支持 terminatesSequence 截断）
   * 按序执行，如果某个动作标记了 terminatesSequence=true，
   * 执行后立即停止并返回（页面状态已变，后续动作不可靠）
   *
   * @returns 所有已执行动作的结果列表
   */
  async multiExecute(
    actions: { name: string; args: Record<string, any> }[],
    page: CdpPage
  ): Promise<{ results: ActionResult[]; truncatedBy: string | null }> {
    const results: ActionResult[] = [];
    let truncatedBy: string | null = null;

    for (const { name, args } of actions) {
      const result = await this.execute(name, args, page);
      results.push(result);

      // 检查 terminatesSequence
      if (this.isTerminating(name)) {
        truncatedBy = name;
        break; // 截断后续动作
      }
    }

    return { results, truncatedBy };
  }

  /**
   * 执行一个动作
   */
  async execute(name: string, args: Record<string, any>, page: CdpPage): Promise<ActionResult> {
    const def = this._actions.get(name);
    if (!def) {
      return { success: false, message: `未知动作: ${name}`, error: `Action '${name}' not registered` };
    }

    try {
      // 参数校验
      this._validateParams(def, args);

      // 执行
      const result = await def.handler(page, args);

      if (result === undefined || result === null) {
        return { success: true, message: `${name} 执行完毕`, changedState: true };
      }

      if (typeof result === 'object' && 'success' in result) {
        return result as ActionResult;
      }

      return {
        success: true,
        message: `${name} 执行完毕`,
        data: result,
        changedState: true,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `${name} 执行失败: ${err.message}`,
        error: err.message,
        changedState: false,
      };
    }
  }

  /** 获取所有动作名 */
  get names(): string[] {
    return Array.from(this._actions.keys());
  }

  /** 清除所有动作 */
  clear() {
    this._actions.clear();
  }

  // ── 参数校验 ──

  private _validateParams(def: ActionDefinition, args: Record<string, any>) {
    if (!def.parameters) return;
    for (const param of def.parameters) {
      if (param.required && (args[param.name] === undefined || args[param.name] === null)) {
        throw new Error(`缺少必填参数: ${param.name}`);
      }
      if (args[param.name] !== undefined && param.type === 'number' && typeof args[param.name] !== 'number') {
        const val = Number(args[param.name]);
        if (isNaN(val)) throw new Error(`参数 ${param.name} 应为 number，但收到 ${typeof args[param.name]}`);
        args[param.name] = val;
      }
      if (args[param.name] !== undefined && param.enum && !param.enum.includes(args[param.name])) {
        throw new Error(`参数 ${param.name} 取值必须为 [${param.enum.join(', ')}]，但收到 "${args[param.name]}"`);
      }
    }
  }

    // ── 内置动作注册 ──

  private _registerBuiltins() {
    if (this._builtinRegistered) return;

    this.register({
      name: 'click_element',
      description: '点击页面上指定编号的元素（按钮、链接、图片等）',
      parameters: [
        { name: 'index', type: 'number', description: '元素编号（见元素列表中的 [N]）', required: true },
      ],
      priority: 100,
      handler: async (page, args) => {
        const idx = args.index;
        // 优先用 data-cdp-index 精确定位
        await page.evaluate(`(function(idx) {
          // 方法1: data-cdp-index 精确定位
          var el = document.querySelector('[data-cdp-index="' + idx + '"]');
          if (!el) {
            // 方法2: fallback — 在所有可交互元素中取索引
            var els = document.querySelectorAll('a, button, input[type=submit], [role=button], [role=link], [onclick]');
            el = els[idx];
          }
          if (!el) throw new Error('元素 ' + idx + ' 不存在');
          el.click();
        })(${idx})`);
        return { success: true, message: '已点击元素 ' + idx, changedState: true };
      },
    });

    this.register({
      name: 'type_text',
      description: '在输入框中输入文字（先在元素列表中定位到输入框的编号）',
      parameters: [
        { name: 'index', type: 'number', description: '输入框元素编号', required: true },
        { name: 'text', type: 'string', description: '要输入的文字内容', required: true },
      ],
      priority: 90,
      handler: async (page, args) => {
        const idx = args.index;
        // 优先用 data-cdp-index 精确定位（解决独立查询导致索引漂移）
        const found = await page.evaluate(`(function(idx) {
          // 方法1: data-cdp-index 精确定位
          var el = document.querySelector('[data-cdp-index="' + idx + '"]');
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
            el.focus(); el.value = ''; return 'ok';
          }
          // 方法2: fallback 到旧的索引方式（仅输入框列表）
          var els = document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea');
          if (els[idx]) { els[idx].focus(); els[idx].value = ''; return 'ok'; }
          return null;
        })(${idx})`);
        if (found !== 'ok') throw new Error(`输入框 #${idx} 不存在`);
        await page.typeText(String(args.text));
        return { success: true, message: `已输入 "${args.text}"`, changedState: true };
      },
    });

    this.register({
      name: 'press_enter',
      description: '按下回车键（常用于确认搜索框输入）',
      priority: 80,
      handler: async (page) => {
        await page.pressKey('Enter');
        await new Promise(r => setTimeout(r, 1000));
        return { success: true, message: '已按回车', changedState: true };
      },
    });

    this.register({
      name: 'press_escape',
      description: '按下 Escape 键（常用于关闭弹窗、模态框、取消操作）',
      priority: 90,
      handler: async (page) => {
        await page.pressKey('Escape');
        await new Promise(r => setTimeout(r, 800));
        return { success: true, message: '已按 Escape', changedState: true };
      },
    });

    this.register({
      name: 'scroll_down',
      description: '向下滚动页面',
      parameters: [
        { name: 'amount', type: 'number', description: '滚动像素数（默认 500）', required: false, default: 500 },
      ],
      priority: 70,
      handler: async (page, args) => {
        const px = args.amount || 500;
        await page.evaluate(`window.scrollBy(0, ${px})`);
        await new Promise(r => setTimeout(r, 300));
        return { success: true, message: `已向下滚动 ${px}px`, changedState: true };
      },
    });

    this.register({
      name: 'scroll_up',
      description: '向上滚动页面',
      parameters: [
        { name: 'amount', type: 'number', description: '滚动像素数（默认 500）', required: false, default: 500 },
      ],
      priority: 70,
      handler: async (page, args) => {
        const px = args.amount || 500;
        await page.evaluate(`window.scrollBy(0, -${px})`);
        await new Promise(r => setTimeout(r, 300));
        return { success: true, message: `已向上滚动 ${px}px`, changedState: true };
      },
    });

    this.register({
      name: 'go_back',
      description: '浏览器后退',
      priority: 80,
      terminatesSequence: true,
      handler: async (page) => {
        await page.goBack();
        return { success: true, message: '已后退', changedState: true };
      },
    });

    this.register({
      name: 'wait',
      description: '等待页面加载或指定时间（页面有变化时用）',
      parameters: [
        { name: 'ms', type: 'number', description: '等待毫秒数（默认 2000）', required: false, default: 2000 },
      ],
      priority: 90,
      handler: async (page, args) => {
        const ms = args.ms || 2000;
        await new Promise(r => setTimeout(r, ms));
        return { success: true, message: `已等待 ${ms}ms`, changedState: true };
      },
    });

    this.register({
      name: 'read_text',
      description: '读取页面上指定元素的文本内容',
      parameters: [
        { name: 'index', type: 'number', description: '元素编号', required: true },
      ],
      priority: 80,
      handler: async (page, args) => {
        const text = await page.evaluate(`(function(idx) {
          var all = document.querySelectorAll('*');
          var count = 0;
          for (var el of all) {
            if (el.children.length === 0 && (el.textContent || '').trim()) {
              if (count === idx) return (el.textContent || '').trim().slice(0, 500);
              count++;
            }
          }
          return '';
        })(${args.index})`);
        return { success: true, message: '已读取文本', data: text, changedState: false };
      },
    });

    this.register({
      name: 'get_page_text',
      description: '获取当前页面所有可见文本内容',
      priority: 80,
      handler: async (page) => {
        const text = await page.evaluate('document.body?.innerText || ""');
        return { success: true, message: '已获取页面文本', data: text.slice(0, 3000), changedState: false };
      },
    });

    this.register({
      name: 'get_dom_state',
      description: '重新获取当前页面的 DOM 状态（元素列表和截图），动作执行后应调用此动作获取新状态',
      priority: 95,
      handler: async (_page) => {
        // 这个动作由 Agent Loop 内部处理，只是占位
        return { success: true, message: 'DOM 状态已刷新', changedState: false };
      },
    });

    this.register({
      name: 'task_done',
      description: '任务已完成，返回最终结果给用户',
      parameters: [
        { name: 'result', type: 'string', description: '任务完成的结果摘要', required: true },
      ],
      priority: 200,
      terminatesSequence: true,
      handler: async (_page, args) => {
        return { success: true, message: args.result || '任务完成', changedState: false };
      },
    });

    // ── 站点专用动作 ──

    this.register({
      name: 'extract_media_all',
      description: '提取当前页面所有可下载的图片/视频/文件链接',
      priority: 85,
      handler: async (page) => {
        const urls = await page.evaluate(`(function() {
          const urls = [];
          for (const v of document.querySelectorAll('video source, video[src]')) {
            const src = v.src || v.getAttribute('src');
            if (src) urls.push({ type: 'video', url: src });
          }
          for (const i of document.querySelectorAll('img[src]')) {
            const src = i.getAttribute('src') || i.src;
            if (src && src !== 'data:') urls.push({ type: 'image', url: src });
          }
          return urls;
        })()`);
        return { success: true, message: `找到 ${urls?.length || 0} 个媒体文件`, data: urls };
      },
    });

    this.register({
      name: 'scroll_to_bottom',
      description: '直接滚动到页面底部（懒加载加载完后用）',
      priority: 70,
      handler: async (page) => {
        await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
        await new Promise(r => setTimeout(r, 1000));
        return { success: true, message: '已滚动到底部', changedState: true };
      },
    });

    // ── 域名专用动作 ──

    // ── 多标签页动作 ──

    this.register({
      name: 'new_tab',
      description: '导航到指定 URL（会改变当前页面）。如果需要在多个页面间切换，使用此动作打开新页面。',
      parameters: [
        { name: 'url', type: 'string', description: '要导航到的 URL', required: true },
      ],
      priority: 95,
      terminatesSequence: true,
      handler: async (page, args) => {
        const url = args.url;
        if (!url) return { success: false, error: '缺少 url 参数' };
        await page.goto(url, { timeoutMs: 30000 });
        await new Promise(r => setTimeout(r, 1500));
        return { success: true, message: '已导航到: ' + url, data: { url }, changedState: true };
      },
    });

    // ── 站点内容提取动作 ──

    this.register({
      name: 'extract_site_content',
      description: '提取当前页面的结构化内容。自动检测页面类型（列表页/详情页），提取标题、链接、作者、互动数据等。支持 B站/知乎/小红书/抖音/百度/京东 等站点。结果以 JSON 返回。',
      parameters: [
        { name: 'url', type: 'string', description: '要提取的URL（可选，默认当前页面URL）', required: false },
      ],
      priority: 90,
      handler: async (page, args) => {
        const targetUrl = args.url || await page.evaluate('location.href');
        const hostname = new URL(targetUrl).hostname.replace(/^www\./, '');

        const extracted = await page.evaluate(`(function() {
          const host = location.hostname;
          const data = {
            url: location.href,
            hostname: host,
            title: document.title || '',
            pageType: 'unknown',
            description: '',
            ogImage: '',
            author: '',
            publishedDate: '',
            content: (document.body?.innerText || '').slice(0, 2000),
            items: [],
            stats: {},
          };

          // ── Meta 信息 ──
          const meta = document.querySelectorAll('meta');
          for (const m of meta) {
            const n = (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase();
            const c = m.getAttribute('content') || '';
            if (n === 'description') data.description = c;
            if (n === 'author' || n === 'article:author') data.author = c;
            if (n === 'article:published_time') data.publishedDate = c.slice(0, 10);
            if (n === 'og:image') data.ogImage = c;
          }

          // ── 辅助函数 ──
          function getText(el) { return (el?.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 200); }
          function getLink(el) {
            const a = el.tagName === 'A' ? el : el.querySelector('a');
            if (!a) return '';
            return a.href || '';
          }
          function getImg(el) {
            const img = el.tagName === 'IMG' ? el : el.querySelector('img');
            const src = img?.src || img?.getAttribute('data-src') || img?.getAttribute('data-original') || '';
            return src.startsWith('http') ? src : '';
          }

          // ── 站点专用: 列表页选择器 ──
          const SITE_LIST_SELECTORS = {
            'bilibili.com': ['.bili-video-card', '.video-card', '.card-pc', '.video-list-item', '.rank-item'],
            'zhihu.com': ['.HotItem', '.List-item', '.ContentItem', '.TopstoryItem'],
            'xiaohongshu.com': ['.note-item', '.feeds-page .note-item', '.explore-card'],
            'douyin.com': ['.video-card', '.feed-item', '.aweme-item'],
            'taobao.com': ['.J_ItemList .item', '.grid-item', '.card-item'],
            'jd.com': ['.gl-item', '.goods-list-v2 .item', '.goods-item'],
            'github.com': ['.Box-row', '.col-12.d-block', 'article.Box-row'],
          };

          // ── 通用卡片选择器 ──
          const GENERIC_CARD_SELECTORS = [
            'article', '[class*=card]', '[class*=item]', 'li[class]',
            '.list-item', '.feed-item', '.result-item',
          ];

          // ── 获取站点专用选择器 ──
          function getSelectors() {
            for (const [domain, selectors] of Object.entries(SITE_LIST_SELECTORS)) {
              if (host.includes(domain)) return selectors;
            }
            return GENERIC_CARD_SELECTORS;
          }

          // ── 尝试提取列表项 ──
          function tryExtractItems(selectors) {
            let bestItems = [];
            let bestLen = 0;

            for (const sel of selectors) {
              try {
                const els = document.querySelectorAll(sel);
                if (els.length >= 3 && els.length > bestLen) {
                  const items = [];
                  for (const el of els) {
                    try {
                    // 跳过不可见的、太小的
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 50 || rect.height < 20) continue;
                    const link = getLink(el);
                    // 注意: querySelector 按 DOM 顺序返回，a 标签常包图片无文本，不应排前面
                    let title = getText(el.querySelector('.video-name,.bili-video-card__info--tit,h1,h2,h3,h4,.title,.name,.headline,[class*=title],[class*=headline],a[title]'));
                    // B站等站点标题在 a 标签的 title 属性中，不在 textContent
                    if (!title) {
                      const titleA = el.querySelector('a[title]');
                      if (titleA) title = (titleA.getAttribute('title') || '').trim().slice(0, 200);
                    }
                    // 最终 fallback: 卡片的 aria-label
                    if (!title) title = (el.getAttribute('aria-label') || el.getAttribute('data-title') || '').trim().slice(0, 200);
                    const img = getImg(el);
                    const desc = getText(el.querySelector('.desc,.description,.summary,.intro,.abstract,p,.bili-video-card__info--desc'));
                    const tag = getText(el.querySelector('.tag,.label,.category,.type,.badge,.bili-video-card__info--duration'));
                    // 互动数据
                    const like = getText(el.querySelector('[class*=like],[class*=vote],[class*=up]'));
                    let view = getText(el.querySelector('[class*=view],[class*=play],[class*=watch]'));
                    // B站播放量在 .bili-video-card__stats 里
                    if (!view) {
                      const biliStats = el.querySelector('.bili-video-card__stats');
                      if (biliStats) {
                        const biliView = biliStats.querySelector('[class*=play],[class*=view],span');
                        if (biliView) view = getText(biliView);
                      }
                    }
                    if (title || link) {
                      items.push({ title, link, img, desc, tag, like, view });
                      if (items.length >= 40) break; // 最多 40 条
                    }
                    } catch (e) {} // 单卡容错
                  }
                  if (items.length >= bestLen) {
                    bestItems = items;
                    bestLen = items.length;
                  }
                }
              } catch (e) {}
            }
            return bestItems;
          }

          // ── 主提取流程 ──
          const selectors = getSelectors();
          const items = tryExtractItems(selectors);

          if (items.length >= 3) {
            data.pageType = 'list';
            data.items = items.slice(0, 30);
            data.stats = { itemCount: items.length, selector: selectors[0] };
          } else {
            // 可能是详情页，尝试提取单页元数据
            data.pageType = 'detail';

            // 站点专用互动数据
            if (host.includes('bilibili')) {
              const like = document.querySelector('.video-like-info,.like span,.video-toolbar-left .like,[class*=like] span');
              const coin = document.querySelector('.coin-info span,.coin span');
              const fav = document.querySelector('.collect-info span,.collect span');
              const dm = document.querySelector('.dm,.danmu,.danmaku');
              if (like) data.stats.likes = like.textContent?.trim();
              if (coin) data.stats.coins = coin.textContent?.trim();
              if (fav) data.stats.favorites = fav.textContent?.trim();
              if (dm) data.stats.danmaku = dm.textContent?.trim();
            }
            if (host.includes('zhihu')) {
              const vote = document.querySelector('.VoteButton--up,.Button.VoteButton,[class*=VoteButton]');
              const cmt = document.querySelector('.CommentsCount,[class*=comments]');
              if (vote) data.stats.likes = vote.textContent?.trim();
              if (cmt) data.stats.comments = cmt.textContent?.trim();
            }
            if (host.includes('xiaohongshu')) {
              const like = document.querySelector('.like-wrapper .count,.like-btn .count,[class*=likes]');
              const coll = document.querySelector('.collect-wrapper .count,.collect-btn .count');
              if (like) data.stats.likes = like.textContent?.trim();
              if (coll) data.stats.favorites = coll.textContent?.trim();
            }
          }

          return data;
        })()`);

        // 把提取结果格式化为紧凑文本，写入 message 供 Agent 历史直接展示
        let summary = `${extracted.pageType === 'list' ? '📋' : '📄'} ${extracted.title}`;
        if (extracted.description) summary += ` | ${extracted.description.slice(0, 80)}`;

        if (extracted.pageType === 'list' && extracted.items && extracted.items.length > 0) {
          const limit = Math.min(extracted.items.length, 15);
          summary += `\n共 ${extracted.items.length} 条，显示前 ${limit}:`;
          for (let i = 0; i < limit; i++) {
            const it = extracted.items[i];
            const stats = [it.view, it.like].filter(Boolean).join(' ');
            summary += `\n${i + 1}. ${it.title || '(无标题)'}${stats ? ' [' + stats + ']' : ''}${it.link ? ' ' + it.link : ''}`;
          }
        } else if (extracted.pageType === 'detail') {
          const st = extracted.stats || {};
          const statParts = [];
          if (st.likes) statParts.push(`👍${st.likes}`);
          if (st.comments) statParts.push(`💬${st.comments}`);
          if (st.coins) statParts.push(`🪙${st.coins}`);
          if (st.favorites) statParts.push(`⭐${st.favorites}`);
          if (st.danmaku) statParts.push(`📺${st.danmaku}`);
          if (statParts.length > 0) summary += `\n互动: ${statParts.join(' ')}`;
        }

        return { success: true, message: summary, data: extracted };
      },
    });

    this.register({
      name: 'google_search',
      description: '在 Google 搜索框中输入关键词并搜索',
      parameters: [
        { name: 'query', type: 'string', description: '搜索关键词', required: true },
      ],
      domains: ['*.google.com'],
      priority: 95,
      handler: async (page, args) => {
        const q = String(args.query).replace(/[`$\\]/g, '');
        await page.evaluate(`(function(q) {
          var input = document.querySelector('input[name=q], textarea[name=q], input.gLFyf');
          if (!input) throw new Error('找不到 Google 搜索框');
          input.focus();
          input.value = q;
          var form = input.closest('form');
          if (form) form.submit();
        })('${q}')`);
        await new Promise(r => setTimeout(r, 2000));
        return { success: true, message: '已搜索: ' + args.query, changedState: true };
      },
    });

    this._builtinRegistered = true;
  }
}

/** 快速创建 ActionRegistry（含所有内置动作） */
export function createActionRegistry(): ActionRegistry {
  return new ActionRegistry();
}
