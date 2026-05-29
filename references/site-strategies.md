# 各站反检测策略

各大主流网站的反爬/反自动化手段不同，需针对性处理。

## 抖音 (douyin.com)

**检测手段：**
- `navigator.webdriver`
- 自动化框架标记（Playwright / Puppeteer）
- 无痕浏览器 / headless 特征
- 浏览器指纹

**应对策略：**
```typescript
// 1. 用 CDP 直连 + anti-detection 注入
const browser = await connectBrowser();
const page = await browser.newPage(); // 自动注入 anti-detection

// 2. 设置合理视口
await page.setViewport(1440, 900);

// 3. 导航到搜索页
await page.goto('https://www.douyin.com/search/养生?type=general', { timeoutMs: 35000 });
await randomDelay(3000, 5000); // 等 SPA 渲染

// 4. 提取数据（一直用字符串表达式，不用箭头函数）
const meta = await page.evaluate(
  `document.querySelector('meta[name="description"]')?.getAttribute('content') || ''`
);

// 5. 正则提取
// ⚠️ 注意：在字符串表达式中 `\\d` 才是 digit 匹配
const authorMatch = meta.match(/- ([^\d]+?)于\\d{8}发布/);
```

**关键：复用登录态（提前在 Windows Chrome 登录好），否则跳登录页。**

## 小红书 (xiaohongshu.com)

**检测手段：**
- `window.__playwright` / `window.__puppeteer`
- `navigator.webdriver`
- 鼠标轨迹异常
- 访问频率

**应对策略：**
- CDP 页面必备 anti-detection 注入（删除所有自动化框架标记）
- 每次操作间加随机延时（2-5秒）
- 拟真滚动（分多步微滚，不要一次跳转）
- 行为画像辅助（录制真人操作习惯）
- 频率控制：每分钟不超过 3-5 次页面访问

```typescript
// 人类化搜索
await page.goto('https://www.xiaohongshu.com/search_result?keyword=养生', { timeoutMs: 35000 });
await randomDelay(2000, 4000);
await page.scrollBy(0, 800); // 分步滚动
await randomDelay(1000, 2000);
await page.scrollBy(0, 600);
```

## 淘宝 (taobao.com) / 京东 (jd.com)

**检测手段：**
- canvas 指纹
- WebGL 指纹
- 分辨率检测
- 自动化工具检测
- cookie 验证

**应对策略：**
- 视口抖动抗分辨率指纹
- 注入 canvas 噪声（轻微，防 canvas fingerprinting）
- 真实 UA 覆盖
- 需要登录态（cookie 复用）

```typescript
await page.setViewport(1920, 1080); // 自动 ±18px 抖动
// 对于淘宝搜索类场景，建议用 URL 参数直连
await page.goto('https://s.taobao.com/search?q=血压仪', { timeoutMs: 40000 });
```

## 知乎 (zhihu.com)

**检测手段：**
- 鼠标行为分析
- 阅读时长
- 操作模式检测

**应对策略：**
- 贝塞尔鼠标点击（不直接跳转）
- 操作间加自然停顿（500-2000ms）
- 随机阅读延时（模拟真人阅读）

```typescript
// 搜索
await page.goto('https://www.zhihu.com/search?type=content&q=睡眠健康', { timeoutMs: 35000 });
await randomDelay(2000, 4000);

// 用贝塞尔点击结果
await page.click('.SearchResult-item'); // 拟真点击
await randomDelay(3000, 8000); // 模拟阅读
```

## 微信公众号 / 文章

**检测手段：**
- cookie 验证
- referer 检查
- 登录态校验

**应对策略：**
- 复用 Windows Chrome 已有登录态（微信已登录）
- 通过已有浏览器 profile 启动（`--user-data-dir`）
- 从搜索入口进入而非直链

```typescript
// 微信文章需要通过搜索入口
// 直接打开文章链接可能被拦截
await page.goto('https://mp.weixin.qq.com/s/xxx', {
  timeoutMs: 40000,
});
// 如果跳转登录页，说明需要先在 Windows Chrome 上登录微信
```

## 百度搜索 (baidu.com)

**检测手段：**
- 搜索频率
- cookie
- UA
- 验证码（频率过高触发）

**应对策略：**
```typescript
await page.goto('https://www.baidu.com/s?wd=健康养生', { timeoutMs: 25000 });
// 百度对 CDP 友好，通常不需要额外 anti-detection
// 但频率不要超过每分钟 6 次搜索
```

## B站 (bilibili.com)

**检测手段：**
- cookie 验证
- 自动化检测（相对宽松）

**应对策略：**
- 标准 anti-detection 注入即可
- 如需查看弹幕 / 评论区，需模拟滚动触发加载

```typescript
await page.goto('https://www.bilibili.com/video/BV1xx411c7mD', { timeoutMs: 35000 });
await randomDelay(2000, 3000);
// 滚动以触发评论区加载
await page.scrollBy(0, 2000);
```

## 反检测通用检查清单

接入新网站时，依次检查：

- [ ] 能否直接 `goto` 打开？→ 能则结束
- [ ] 跳登录页？→ 需先在 Windows Chrome 登录
- [ ] 弹滑块？→ anti-detection 不够，需补更多注入脚本
- [ ] `navigator.webdriver = true`？→ 检查 anti-detection 注入是否生效
- [ ] 返回 403 / 空数据？→ 检查 UA / cookie
- [ ] 验证码？→ 需要真人介入一次
- [ ] 行为检测？→ 使用行为画像 + 贝塞尔鼠标 + 自然延时

## 指纹污染最小化

长期使用同一 Chrome profile 会被积累指纹。定期清理：

```typescript
await browser.clearSiteData([
  'https://www.douyin.com',
  'https://www.xiaohongshu.com',
]);
```

## 安全警告

- 反检测技术仅用于**合规的公开数据获取**或**自动化测试**
- 不得用于破解登录、盗取数据、绕过付费墙等非法用途
- 各平台 ToS 禁止爬取，请自行评估使用风险
