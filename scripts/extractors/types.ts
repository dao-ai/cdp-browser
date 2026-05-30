/**
 * 提取器统一返回格式
 * 所有网站提取器返回此类型
 */
export interface ExtractorResult {
  /** 视频/文章 ID */
  id: string;
  /** 标题 */
  title: string;
  /** 作者 */
  author: string;
  /** 完整 URL */
  url: string;
  /** 描述/文案 */
  description?: string;
  /** 发布时间（YYYY-MM-DD） */
  publishDate?: string;
  /** 点赞数 */
  likes?: number;
  /** 评论数 */
  comments?: number;
  /** 分享数 */
  shares?: number;
  /** 封面图 URL */
  coverUrl?: string;
  /** 站点特定原始数据 */
  raw?: Record<string, any>;
  /** 是否需要登录才能提取（页面跳到了登录页） */
  loginRequired?: boolean;
}
