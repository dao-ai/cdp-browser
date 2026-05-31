/**
 * 站点统一注册表
 *
 * 所有站点域名、名称、Cookie key 的唯一数据源。
 * anti-detection.ts、cookie-manager.ts、extractors/index.ts 都从此导入。
 *
 * 新增站点时：只需在这里加一条，无需改 3 个文件。
 */

export interface SiteInfo {
  /** 匹配域名列表（URL 包含任一域名即匹配） */
  domains: string[];
  /** 站点中文名 */
  name: string;
  /** Cookie 文件命名 key（用于 cookie-manager） */
  cookieKey: string;
}

export const SITE_REGISTRY: SiteInfo[] = [
  { domains: ['douyin.com'],           name: '抖音',   cookieKey: 'douyin' },
  { domains: ['kuaishou.com'],         name: '快手',   cookieKey: 'kuaishou' },
  { domains: ['xiaohongshu.com', 'xhslink.com'], name: '小红书', cookieKey: 'xiaohongshu' },
  { domains: ['bilibili.com', 'b23.tv'], name: 'B站',  cookieKey: 'bilibili' },
  { domains: ['weibo.com', 'm.weibo.cn'], name: '微博', cookieKey: 'weibo' },
  { domains: ['taobao.com', 'tmall.com'], name: '淘宝', cookieKey: 'taobao' },
  { domains: ['jd.com', '3.cn'],        name: '京东',   cookieKey: 'jd' },
  { domains: ['pinduoduo.com', 'yangkeduo.com'], name: '拼多多', cookieKey: 'pdd' },
  { domains: ['zhihu.com', 'zhuanlan.zhihu.com'], name: '知乎', cookieKey: 'zhihu' },
  { domains: ['baidu.com'],             name: '百度',   cookieKey: 'baidu' },
  { domains: ['weixin.qq.com', 'mp.weixin.qq.com'], name: '微信', cookieKey: 'weixin' },
];

/**
 * 根据 URL 匹配站点
 */
export function matchSite(url: string): SiteInfo | undefined {
  return SITE_REGISTRY.find(s => s.domains.some(d => url.includes(d)));
}

/**
 * 获取所有域名列表（用于注册表的 index 展示）
 */
export function listAllDomains(): string[] {
  return SITE_REGISTRY.flatMap(s => s.domains);
}

/**
 * 判断当前文件是否作为 CLI 入口直接运行
 * @param importMetaUrl import.meta.url 的值
 * @example
 *   if (isCliMain(import.meta.url)) { main(); }
 */
export function isCliMain(importMetaUrl: string): boolean {
  try {
    const currentFile = importMetaUrl.replace(/^.*[\\/]/, '');
    const argFile = process.argv[1]?.replace(/^.*[\\/]/, '');
    return currentFile === argFile;
  } catch {
    return false;
  }
}
