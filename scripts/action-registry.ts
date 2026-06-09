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
        // 通过 evaluate 找到元素并点击 — 这样不需要依赖 DOM service
        await page.evaluate(`(function(idx) {
          var els = document.querySelectorAll('a, button, input[type=submit], [role=button], [role=link]');
          var el = els[idx];
          if (!el) throw new Error('元素 ' + idx + ' 不存在');
          el.click();
        })(${args.index})`);
        return { success: true, message: '已点击元素 ' + args.index, changedState: true };
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
        // 先点击输入框
        const inputs = await page.evaluate(`(function() {
          var els = document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea');
          var el = els[${args.index}];
          if (!el) return null;
          el.focus();
          el.value = '';
          return true;
        })()`);
        if (inputs === null) throw new Error(`输入框 #${args.index} 不存在`);
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
      description: '提取当前页面的结构化内容（标题、作者、描述、点赞数、评论数等）。有效站点：B站、知乎、百度、京东等自动匹配。提取结果以 JSON 形式返回。',
      parameters: [
        { name: 'url', type: 'string', description: '要提取的URL（可选，默认当前页面URL）', required: false },
      ],
      priority: 90,
      handler: async (page, args) => {
        const targetUrl = args.url || await page.evaluate('location.href');
        const hostname = new URL(targetUrl).hostname.replace(/^www\./, '');
        
        // 用 evaluate 提取页面关键结构化数据（兼容所有站点）
        const extracted = await page.evaluate(`(function() {
          const data = {
            url: location.href,
            hostname: location.hostname,
            title: document.title || '',
            description: '',
            keywords: '',
            ogTitle: '',
            ogDescription: '',
            ogImage: '',
            author: '',
            publishDate: '',
            content: (document.body?.innerText || '').slice(0, 3000),
          };
          const meta = document.querySelectorAll('meta');
          for (const m of meta) {
            const name = (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase();
            const content = m.getAttribute('content') || '';
            if (name === 'description') data.description = content;
            if (name === 'keywords') data.keywords = content;
            if (name === 'author' || name === 'article:author') data.author = content;
            if (name === 'article:published_time') data.publishDate = content.slice(0, 10);
            if (name === 'og:title') data.ogTitle = content;
            if (name === 'og:description') data.ogDescription = content;
            if (name === 'og:image') data.ogImage = content;
          }
          // 站点专用逻辑：提取互动数据
          if (location.hostname.includes('bilibili')) {
            const v = document.querySelector('.video-data .view, .dm, .video-info-detail');
            // 赞
            const like = document.querySelector('.video-like-info, .like span, .video-toolbar-left .like');
            if (like) data.likes = like.textContent?.trim();
            // 评论
            const cmt = document.querySelector('.comment, .reply span');
            if (cmt) data.comments = cmt.textContent?.trim();
          }
          if (location.hostname.includes('zhihu')) {
            const vote = document.querySelector('.VoteButton--up, .Button.VoteButton');
            if (vote) data.likes = vote.textContent?.trim();
          }
          return data;
        })()`);
        
        return { success: true, message: '已提取页面内容', data: extracted };
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
