/**
 * Behavior Profile — 学习用户的真实操作习惯，让 CDP 自动化模仿你的风格
 *
 * 用法:
 *   const { BehaviorProfile } = require('./behavior-profile');
 *   const profile = await BehaviorProfile.record(page, 30);  // 录30秒
 *   profile.save('my-behavior.json');
 *   CdpPage.setBehaviorProfile(profile);  // 后续操作模仿你的习惯
 *
 * 画像包含:
 *   • 打字节奏（击键间隔分布）
 *   • 鼠标移动曲线（贝塞尔控制点偏移、步数、抖动幅度）
 *   • 点击时长
 *   • 滚动节奏
 *   • 操作间停顿
 */
import fs from 'fs';

// ─── 统计工具 ─────────────────────────────────────────

function mean(arr: number[]) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function std(arr: number[]) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function quantile(arr: number[], q: number) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function logmean(arr: number[]) {
  const logs = arr.filter(v => v > 1).map(v => Math.log(v));
  return logs.length ? mean(logs) : 0;
}

function logstd(arr: number[]) {
  const logs = arr.filter(v => v > 1).map(v => Math.log(v));
  return logs.length > 1 ? std(logs) : 0;
}

function clamp(v: number, min: number, max: number) { return Math.min(Math.max(v, min), max); }

// ─── 统计分布模型 ─────────────────────────────────────

function sampleLogNormal(logMean: number, logStd: number) {
  if (!logMean || !logStd) return 50;
  const u1 = Math.random() || 0.001;
  const u2 = Math.random() || 0.001;
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(Math.exp(logMean + logStd * z));
}

function humanDelay(fastMs = 28, slowMs = 55, burstPause = 0.08) {
  if (Math.random() < burstPause) return Math.floor(120 + Math.random() * 230);
  return Math.floor(fastMs + Math.random() * (slowMs - fastMs));
}

// ─── 事件录制脚本 ─────────────────────────────────────

const RECORDER_SCRIPT = `
(function() {
  'use strict';
  if (window.__behaviorRecorder) return;
  window.__behaviorRecorder = {
    events: [],
    startTime: Date.now(),
    lastMouseSample: 0,
    mouseSampleInterval: 50,
  };

  var r = window.__behaviorRecorder;

  function push(type, data) {
    r.events.push({ t: Date.now() - r.startTime, type: type, data: data });
  }

  document.addEventListener('keydown', function(e) {
    push('keydown', { key: e.key, code: e.code, ctrl: e.ctrlKey });
  });
  document.addEventListener('keyup', function(e) {
    push('keyup', { key: e.key });
  });

  document.addEventListener('mousemove', function(e) {
    var now = Date.now();
    if (now - r.lastMouseSample < r.mouseSampleInterval) return;
    r.lastMouseSample = now;
    push('mousemove', { x: e.clientX, y: e.clientY });
  });

  document.addEventListener('mousedown', function(e) {
    push('mousedown', { x: e.clientX, y: e.clientY, button: e.button });
  });
  document.addEventListener('mouseup', function(e) {
    push('mouseup', { x: e.clientX, y: e.clientY, button: e.button });
  });

  document.addEventListener('wheel', function(e) {
    push('wheel', { deltaX: e.deltaX, deltaY: e.deltaY });
  }, { passive: true });
})();
`;

// ─── 画像构建 ─────────────────────────────────────────

function buildProfile(rawEvents: any[]) {
  const profile: any = {
    version: 1,
    createdAt: new Date().toISOString(),
    typing: { delayMs: {} },
    mouse: {},
    click: {},
    scroll: {},
    pauses: {},
  };

  // 打字节奏
  const keydownTimes = rawEvents.filter(e => e.type === 'keydown').map(e => e.t);
  const interKeyDels: number[] = [];
  for (let i = 1; i < keydownTimes.length; i++) {
    const d = keydownTimes[i] - keydownTimes[i - 1];
    if (d > 0 && d < 2000) interKeyDels.push(d);
  }
  const REGULAR_MAX = 300;
  const regularDelays = interKeyDels.filter(d => d <= REGULAR_MAX);
  const burstPauses = interKeyDels.filter(d => d > REGULAR_MAX);

  profile.typing.delayMs = {
    mean: Math.round(mean(interKeyDels)),
    std: Math.round(std(interKeyDels)),
    p50: Math.round(quantile(interKeyDels, 0.50)),
    p95: Math.round(quantile(interKeyDels, 0.95)),
    logMean: Math.round(logmean(regularDelays) * 100) / 100,
    logStd: Math.round(logstd(regularDelays) * 100) / 100,
    regularMean: Math.round(mean(regularDelays)),
    regularStd: Math.round(std(regularDelays)),
    burstPauseRate: interKeyDels.length > 0 ? burstPauses.length / interKeyDels.length : 0,
    burstPauseMin: burstPauses.length ? Math.min(...burstPauses) : 0,
    burstPauseMax: burstPauses.length ? Math.max(...burstPauses) : 0,
    sampleCount: interKeyDels.length,
  };

  // 鼠标移动
  const mouseMoves = rawEvents.filter(e => e.type === 'mousemove');
  const positions = mouseMoves.map(e => ({ x: e.data.x, y: e.data.y, t: e.t }));
  const speeds: number[] = [];
  for (let i = 1; i < positions.length; i++) {
    const dx = positions[i].x - positions[i - 1].x;
    const dy = positions[i].y - positions[i - 1].y;
    const dt = positions[i].t - positions[i - 1].t;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dt > 0 && dist > 0) speeds.push(dist / dt);
  }
  const controlOffsets: number[] = [];
  for (let i = 2; i < positions.length; i++) {
    const p0 = positions[i - 2], p1 = positions[i - 1], p2 = positions[i];
    const dx = p2.x - p0.x, dy = p2.y - p0.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 10) continue;
    const t2 = ((p1.x - p0.x) * dx + (p1.y - p0.y) * dy) / (len * len);
    const projX = p0.x + t2 * dx, projY = p0.y + t2 * dy;
    const offset = Math.sqrt((p1.x - projX) ** 2 + (p1.y - projY) ** 2);
    if (offset > 0 && offset < len * 0.5) controlOffsets.push(offset);
  }

  profile.mouse = {
    speedPxPerMs: {
      mean: Math.round(mean(speeds) * 100) / 100,
      std: Math.round(std(speeds) * 100) / 100,
      p50: Math.round(quantile(speeds, 0.50) * 100) / 100,
      p95: Math.round(quantile(speeds, 0.95) * 100) / 100,
    },
    controlPointOffsetPx: {
      mean: controlOffsets.length ? Math.round(mean(controlOffsets)) : 60,
      std: controlOffsets.length ? Math.round(std(controlOffsets)) : 30,
      p50: controlOffsets.length ? Math.round(quantile(controlOffsets, 0.50)) : 50,
      p95: controlOffsets.length ? Math.round(quantile(controlOffsets, 0.95)) : 100,
      sampleCount: controlOffsets.length,
    },
  };

  // 点击时长
  const downs: any[] = [];
  const clickDurations: number[] = [];
  rawEvents.forEach((e: any) => {
    if (e.type === 'mousedown') downs.push(e);
    if (e.type === 'mouseup' && downs.length) {
      const d = downs.pop();
      const dur = e.t - d.t;
      if (dur > 0 && dur < 2000) clickDurations.push(dur);
    }
  });
  profile.click = {
    durationMs: {
      mean: clickDurations.length ? Math.round(mean(clickDurations)) : 100,
      std: clickDurations.length ? Math.round(std(clickDurations)) : 30,
      p50: clickDurations.length ? Math.round(quantile(clickDurations, 0.50)) : 90,
      p95: clickDurations.length ? Math.round(quantile(clickDurations, 0.95)) : 200,
      sampleCount: clickDurations.length,
    },
  };

  // 操作间停顿
  const actionEnds = rawEvents.filter((e: any) => ['keyup', 'mouseup', 'wheel'].includes(e.type)).map((e: any) => e.t);
  const actionStarts = rawEvents.filter((e: any) => ['keydown', 'mousedown', 'wheel'].includes(e.type)).map((e: any) => e.t);
  const interActionPauses: number[] = [];
  let lastEnd = 0;
  for (const start of actionStarts) {
    if (lastEnd && start > lastEnd) {
      const p = start - lastEnd;
      if (p > 30 && p < 10000) interActionPauses.push(p);
    }
    lastEnd = start;
  }
  profile.pauses = {
    betweenActionsMs: {
      mean: interActionPauses.length ? Math.round(mean(interActionPauses)) : 800,
      std: interActionPauses.length ? Math.round(std(interActionPauses)) : 400,
      p50: interActionPauses.length ? Math.round(quantile(interActionPauses, 0.50)) : 600,
      p95: interActionPauses.length ? Math.round(quantile(interActionPauses, 0.95)) : 2000,
      sampleCount: interActionPauses.length,
    },
  };

  profile.stats = {
    totalEvents: rawEvents.length,
    keydowns: rawEvents.filter((e: any) => e.type === 'keydown').length,
    keyups: rawEvents.filter((e: any) => e.type === 'keyup').length,
    mouseMoves: mouseMoves.length,
    mousedowns: rawEvents.filter((e: any) => e.type === 'mousedown').length,
    mouseups: rawEvents.filter((e: any) => e.type === 'mouseup').length,
    scrolls: rawEvents.filter((e: any) => e.type === 'wheel').length,
    durationMs: rawEvents.length > 1 ? Math.round(rawEvents[rawEvents.length - 1].t) : 0,
  };

  return profile;
}

// ─── BehaviorProfile 类 ─────────────────────────────────

export class BehaviorProfile {
  data: any;

  constructor(data: any) {
    this.data = data || null;
  }

  /** 从原始事件列表构建画像 */
  static fromEvents(rawEvents: any[]) {
    return new BehaviorProfile(buildProfile(rawEvents));
  }

  /** 从 JSON 文件加载 */
  static load(filePath: string) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return new BehaviorProfile(data);
  }

  /** 保存到文件 */
  save(filePath: string) {
    fs.writeFileSync(filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    return filePath;
  }

  // ── 采样方法 ──

  /** 采样一次打字间隔 (ms) */
  sampleTypingDelay() {
    const t = this.data.typing.delayMs;
    if (t.sampleCount < 5) return humanDelay();
    return clamp(Math.round(sampleLogNormal(t.logMean, t.logStd)), 10, 200);
  }

  /** 判断是否触发 burst pause */
  shouldBurstPause() {
    const t = this.data.typing.delayMs;
    if (t.sampleCount < 5) return Math.random() < 0.08;
    return Math.random() < (t.burstPauseRate || 0.08);
  }

  /** Burst pause 时长 */
  sampleBurstPause() {
    const t = this.data.typing.delayMs;
    if (t.sampleCount < 5) return 120 + Math.random() * 230;
    const min = t.burstPauseMin || 120;
    const max = t.burstPauseMax || 350;
    return Math.round(min + Math.random() * (max - min));
  }

  /** 采样鼠标步数 */
  sampleMouseSteps() {
    const offset = this.data.mouse.controlPointOffsetPx;
    if (offset.sampleCount < 5) return 22 + Math.floor(Math.random() * 16);
    return clamp(18 + Math.round(offset.mean / 8), 12, 60);
  }

  /** 采样控制点偏移 */
  sampleControlOffset() {
    const m = this.data.mouse.controlPointOffsetPx;
    if (m.sampleCount < 5) return 40 + Math.random() * 80;
    return Math.round(m.p50 + (Math.random() - 0.5) * (m.p95 - m.p50));
  }

  /** 采样步间延迟 */
  sampleStepDelay() {
    const speed = this.data.mouse.speedPxPerMs;
    if (speed.sampleCount < 10) return 3 + Math.random() * 6;
    const base = 8 - Math.min(speed.mean * 2, 6);
    return clamp(Math.round(base + (Math.random() - 0.5) * 4), 2, 20);
  }

  /** 采样点击时长 */
  sampleClickDuration() {
    const c = this.data.click.durationMs;
    if (c.sampleCount < 2) return 80 + Math.random() * 80;
    return Math.round(c.p50 + (Math.random() - 0.5) * (c.p95 - c.p50));
  }

  /** 采样操作间停顿 */
  samplePause() {
    const p = this.data.pauses.betweenActionsMs;
    if (p.sampleCount < 2) return 400 + Math.random() * 800;
    return Math.round(p.p50 + Math.random() * (p.p95 - p.p50));
  }

  /** 获取人类化配置（给 cdp-client 用） */
  getHumanizeConfig() {
    return {
      steps: this.sampleMouseSteps(),
      cpOffset: this.sampleControlOffset(),
      stepDelayMs: this.sampleStepDelay(),
      jitterAmplitude: 1 + Math.random() * 2,
    };
  }

  /** 获取统计摘要 */
  summary() {
    const s = this.data.stats;
    const t = this.data.typing.delayMs;
    const c = this.data.click.durationMs;
    return {
      duration: `${Math.round(s.durationMs / 1000)}s`,
      events: s.totalEvents,
      typing: `平均击键间隔 ${t.mean}ms (共${t.sampleCount}次)`,
      click: `平均点击时长 ${c.mean}ms (共${c.sampleCount}次)`,
    };
  }

  /** 在 CDP Page 上录制用户行为 */
  static async record(page: any, durationSec: number) {
    const dur = durationSec * 1000;

    // 注入录制脚本（用字符串表达式，不用箭头函数）
    await page.evaluate(RECORDER_SCRIPT);

    // 显示录制 UI
    const uiScript = `
      document.title = 'Behavior Recorder';
      document.body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#f5f5f5;text-align:center;padding:20px">' +
        '<h2 style="color:#333;margin-bottom:10px">⏱️ 行为录制中</h2>' +
        '<p style="color:#666;font-size:18px;max-width:400px">正常操作鼠标和键盘...</p>' +
        '<div id="cdp-timer" style="font-size:48px;color:#1976d2;margin-top:20px;font-weight:bold">' + ${durationSec} + 's</div>' +
        '<p style="color:#999;margin-top:20px;font-size:14px">随便打字、点击、滚动都行</p>' +
        '</div>';
      var remaining = ${durationSec};
      var timerEl = document.getElementById('cdp-timer');
      setInterval(function() {
        remaining--;
        if (timerEl) timerEl.textContent = remaining + 's';
      }, 1000);
    `;
    await page.evaluate(uiScript);

    // 等待录制结束
    await new Promise(resolve => setTimeout(resolve, dur));

    // 提取录制数据
    const rawEvents = await page.evaluate('(window.__behaviorRecorder && window.__behaviorRecorder.events) || []');

    return BehaviorProfile.fromEvents(rawEvents);
  }

  /** 报告录制结果 */
  report() {
    const s = this.summary();
    return [
      `📊 行为画像构建完成`,
      `  时长: ${s.duration}`,
      `  事件数: ${s.events}`,
      `  ${s.typing}`,
      `  ${s.click}`,
    ].join('\n');
  }
}

export { humanDelay };

// ─── CLI entry ──────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const recordIdx = args.indexOf('--record');
  if (recordIdx >= 0) {
    const duration = parseInt(args[recordIdx + 1]) || 30;
    console.log(`🎯 行为录制（${duration}秒）`);
    console.log('   正在连接 Chrome...');
    const { connectBrowser } = await import('./cdp-manager');
    const { CdpPage } = await import('./cdp-client');
    const browser = await connectBrowser();
    const page = await browser.newPage();
    await page.setContent('<h1>Behavior Recorder</h1><p>正常操作即可...</p>');
    const profile = await BehaviorProfile.record(page, duration);
    const filePath = `behavior-${Date.now()}.json`;
    profile.save(filePath);
    console.log(profile.report());
    console.log(`💾 已保存: ${filePath}`);
    await page.close();
    await browser.close();
    process.exit(0);
  }
}

function isMain() {
  try { return import.meta.url?.endsWith(process.argv[1]?.replace(/^.*[\\/]/, '')); } catch { return false; }
}
if (isMain()) {
  main().catch(console.error);
}
