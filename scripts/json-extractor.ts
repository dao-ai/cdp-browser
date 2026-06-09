/**
 * JsonExtractor — 从 LLM 回复中鲁棒提取结构化 JSON
 *
 * LLM 输出的 JSON 经常有各种"小毛病":
 * - 单引号代替双引号
 * - 末尾逗号
 * - Python 风格的 True/False/None
 * - unquoted keys
 * - 注释
 * - 代码块标记
 * - 多段 JSON 块嵌套
 *
 * 本模块分级容错，尽可能从混乱的文本中提取有效 JSON。
 *
 * 策略（按优先级）:
 *   1. 完整 JSON parse (API JSON模式/优秀模型)
 *   2. 提取 ```json 代码块
 *   3. 提取第一个 {} 并用 loose parse 修复
 *   4. 逐级修复常见错误后重试
 */

// ─── Loose JSON Parse ─────────────────────────────────────

export interface JsonExtractOptions {
  /** strict 模式: 仅精确 JSON parse，不做修复（默认 false） */
  strict?: boolean;
  /** 允许提取多个候选（默认 false，只取第一个） */
  multi?: boolean;
}

export interface JsonExtractResult<T = any> {
  success: boolean;
  data?: T;
  /** 提取方式: 'exact' | 'code_block' | 'brace_fix' | 'native_repair' */
  method?: string;
  /** 原始文本 */
  raw: string;
  /** 修复后的文本（与原始不同时） */
  repaired?: string;
  /** 错误信息 */
  error?: string;
  /** 置信度 0-1 */
  confidence: number;
}

/**
 * 从 LLM 回复中提取 JSON
 * 默认宽松模式: 一步一步修复直到能解析
 */
export function extractJson<T = any>(
  text: string,
  opts?: JsonExtractOptions,
): JsonExtractResult<T> {
  const result = _tryExtract(text, opts);
  return result;
}

/**
 * 提取并校验符合 schema 的 JSON
 * 如果提取的 JSON 不符合提供的校验函数，返回错误
 */
export function extractValidatedJson<T = any>(
  text: string,
  validate: (data: any) => data is T,
  opts?: JsonExtractOptions,
): JsonExtractResult<T> {
  const result = _tryExtract(text, opts);
  if (result.success && result.data !== undefined) {
    if (!validate(result.data)) {
      return {
        success: false,
        raw: text,
        repaired: result.repaired,
        error: '提取的 JSON 不符合 schema',
        confidence: result.confidence * 0.5,
        method: result.method,
      };
    }
  }
  return result;
}

// ── 内部实现 ──

function _tryExtract(text: string, opts?: JsonExtractOptions): JsonExtractResult {
  if (!text || !text.trim()) {
    return { success: false, raw: text, error: '空输入', confidence: 0 };
  }

  const trimmed = text.trim();

  // strict 模式: 只试精确 parse
  if (opts?.strict) {
    try {
      const data = JSON.parse(trimmed);
      return { success: true, data, raw: text, method: 'exact', confidence: 1 };
    } catch (e: any) {
      return { success: false, raw: text, error: e.message, confidence: 0 };
    }
  }

  // 策略 1: 直接 parse
  const exact = _tryParseExact(trimmed);
  if (exact) return exact;

  // 策略 2: 从 ```json 代码块提取
  const codeBlock = _tryExtractCodeBlock(trimmed);
  if (codeBlock) return codeBlock;

  // 策略 3: 从第一个 {} 提取并修复
  const braceExtract = _tryExtractBrace(trimmed);
  if (braceExtract) return braceExtract;

  // 策略 4: 原生修复试图（Python 风格 True/False/None）
  const nativeFix = _tryNativeFix(trimmed);
  if (nativeFix) return nativeFix;

  // 策略 5: 尝试多段 JSON
  if (opts?.multi) {
    const multi = _tryMultiExtract(trimmed);
    if (multi) return multi;
  }

  return {
    success: false,
    raw: text,
    error: '所有解析策略均失败',
    confidence: 0,
  };
}

/** 策略 1: 精确 JSON.parse */
function _tryParseExact(text: string): JsonExtractResult | null {
  // 直接 parse
  try {
    const data = JSON.parse(text);
    return { success: true, data, raw: text, method: 'exact', confidence: 1 };
  } catch {}

  // 去除首尾 ```json 标记后 parse（有些模型会带）
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  if (cleaned !== text) {
    try {
      const data = JSON.parse(cleaned);
      return { success: true, data, raw: text, repaired: cleaned, method: 'exact', confidence: 0.95 };
    } catch {}
  }

  return null;
}

/** 策略 2: 提取 ```json 代码块 */
function _tryExtractCodeBlock(text: string): JsonExtractResult | null {
  // 匹配 ```json ... ``` 或 ``` ... ```
  const blockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let match: RegExpExecArray | null;
  let lastResult: JsonExtractResult | null = null;

  while ((match = blockRegex.exec(text)) !== null) {
    const content = match[1].trim();
    const result = _tryParseLoose(content);
    if (result) {
      // 返回最后一个成功的代码块（模型常常先输出思考再给最终 JSON）
      lastResult = result;
      lastResult.method = 'code_block';
      lastResult.raw = text;
    }
  }

  return lastResult;
}

/** 策略 3: 找第一个 {} 并修复 */
function _tryExtractBrace(text: string): JsonExtractResult | null {
  // 匹配平衡的 {}（处理嵌套）
  const startIdx = text.indexOf('{');
  if (startIdx < 0) return null;

  const endIdx = _findBalancedBrace(text, startIdx);
  if (endIdx < 0) return null;

  const jsonStr = text.slice(startIdx, endIdx + 1);
  const result = _tryParseLoose(jsonStr);
  if (result) {
    result.method = 'brace_fix';
    result.raw = text;
    return result;
  }

  // 尝试逐步缩小范围（处理模型在 JSON 前后加了额外字段）
  // 找到 JSON 的真正结尾: 在 } 后还有额外文本时，可能需要更精确的截断
  const strictJson = _tryStrictBrace(text, startIdx);
  if (strictJson) return strictJson;

  return null;
}

/** 找到平衡的 }，支持任意嵌套深度 */
function _findBalancedBrace(text: string, startIdx: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/** 策略 3b: 精确截断到第一个完整 JSON 对象 */
function _tryStrictBrace(text: string, startIdx: number): JsonExtractResult | null {
  // 尝试更精确的截断：找到 } 后检查紧跟的字符
  let endIdx = _findBalancedBrace(text, startIdx);
  if (endIdx < 0) return null;

  // 尝试 }
  let candidate = text.slice(startIdx, endIdx + 1);
  let result = _tryParseLoose(candidate);
  if (result && !_hasTrailingGarbage(text, endIdx, result.data)) {
    return { ...result, method: 'brace_fix', raw: text };
  }

  // 有些模型会在 } 后加逗号或其他垃圾，尝试在后续的 }} 中寻找
  while (endIdx > 0 && endIdx < text.length) {
    endIdx = text.indexOf('}', endIdx + 1);
    if (endIdx < 0) break;
    candidate = text.slice(startIdx, endIdx + 1);
    result = _tryParseLoose(candidate);
    if (result) {
      return { ...result, method: 'brace_fix', raw: text };
    }
  }

  return null;
}

function _hasTrailingGarbage(text: string, endIdx: number, data: any): boolean {
  const after = text.slice(endIdx + 1).trim();
  if (!after) return false;
  // 如果 } 后只有空白、标点或明显的结束符，不算垃圾
  if (/^[,\]\s)]*$/.test(after)) return false;
  // 如果后面是另一个 JSON 块开头，也不算
  if (/^\s*\{/.test(after)) return false;
  // 如果有可见文本，算垃圾
  if (/^\s*[a-zA-Z0-9_"]/.test(after)) return true;
  return false;
}

/** 策略 4: 原生修复（处理 Python 风格 True/False/None） */
function _tryNativeFix(text: string): JsonExtractResult | null {
  let fixed = text;
  // Python → JS: True → true, False → false, None → null
  fixed = fixed.replace(/\bTrue\b/g, 'true');
  fixed = fixed.replace(/\bFalse\b/g, 'false');
  fixed = fixed.replace(/\bNone\b/g, 'null');

  if (fixed !== text) {
    // 修复后重试全流程
    const result = _tryExtractBrace(fixed);
    if (result) {
      return {
        ...result,
        raw: text,
        repaired: fixed,
        method: 'native_repair',
        confidence: Math.min(result.confidence * 0.9, 0.95),
      };
    }
  }

  return null;
}

/** 策略 5: 多段 JSON（取最后一个完整的） */
function _tryMultiExtract(text: string): JsonExtractResult | null {
  const results: JsonExtractResult[] = [];
  const blockRegex = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(text)) !== null) {
    const result = _tryParseLoose(match[1].trim());
    if (result) results.push(result);
  }

  if (results.length === 0) return null;
  // 取最后一个（模型常先输出思考再给最终答案）
  const last = results[results.length - 1];
  last.raw = text;
  last.method = 'multi';
  return last;
}

// ── Loose Parse — 宽松 JSON 解析 ──

/**
 * 尝试宽松解析 JSON 字符串
 * 逐步修复常见问题
 */
function _tryParseLoose(jsonStr: string): JsonExtractResult | null {
  if (!jsonStr) return null;

  // Level 1: 原始
  try {
    const data = JSON.parse(jsonStr);
    return { success: true, data, raw: jsonStr, method: 'exact', confidence: 1 };
  } catch {}

  let current = jsonStr;

  // Level 2: 去除 BOM 和零宽字符
  current = current.replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '');
  try {
    const data = JSON.parse(current);
    return { success: true, data, raw: jsonStr, repaired: current, method: 'clean', confidence: 0.95 };
  } catch {}

  // Level 3: 去除注释（// 和 /* */）
  current = current.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  try {
    const data = JSON.parse(current);
    return { success: true, data, raw: jsonStr, repaired: current, method: 'no_comment', confidence: 0.9 };
  } catch {}

  // Level 4: 去除末尾逗号
  current = current.replace(/,(\s*[}\]])/g, '$1');
  try {
    const data = JSON.parse(current);
    return { success: true, data, raw: jsonStr, repaired: current, method: 'no_tail_comma', confidence: 0.85 };
  } catch {}

  // Level 5: 单引号 → 双引号（仅外部字符串）
  current = current.replace(/'/g, '"');
  try {
    const data = JSON.parse(current);
    return { success: true, data, raw: jsonStr, repaired: current, method: 'single_quote', confidence: 0.8 };
  } catch {}

  // Level 6: Python 风格 True/False/None
  current = current.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
  try {
    const data = JSON.parse(current);
    return { success: true, data, raw: jsonStr, repaired: current, method: 'python_to_js', confidence: 0.75 };
  } catch {}

  // Level 7: 补引号 — 处理无引号 key ({action: {name: "click"}})
  current = current.replace(/([\[,\{])\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*/g, (match, prefix, key, offset, full) => {
    const afterBrace = full.slice(offset + prefix.length).trimStart();
    if (afterBrace.startsWith('"')) return match;
    return `${prefix}"${key}":`;
  });
  try {
    const data = JSON.parse(current);
    return { success: true, data, raw: jsonStr, repaired: current, method: 'unquoted_key', confidence: 0.7 };
  } catch {}

  // Level 8: 数值字符串修复（"index": "3" → "index": 3）
  current = current.replace(/"(\d+(?:\.\d+)?)"/g, (m) => {
    // 只在明确知道是数值字段时修复
    return `"${m.slice(1, -1)}"`;
  });
  // 这个替换比较复杂，跳过

  // Level 8: 去除尾随文本（在 JSON 后面的非 JSON 文本）
  const braceEnd = _findBalancedBrace(current, current.indexOf('{'));
  if (braceEnd > 0) {
    const trimmed = current.slice(0, braceEnd + 1);
    try {
      const data = JSON.parse(trimmed);
      return { success: true, data, raw: jsonStr, repaired: trimmed, method: 'trim_tail', confidence: 0.7 };
    } catch {}
  }

  return null;
}

// ── 验证工具 ──

/**
 * 验证数据是否包含指定字段
 */
export function hasFields(data: any, fields: string[]): boolean {
  if (!data || typeof data !== 'object') return false;
  return fields.every(f => f in data);
}

/**
 * 确保提取的数据包含 AgentStepDecision 所需字段
 */
export function isValidAgentDecision(data: any): data is Record<string, any> {
  if (!data || typeof data !== 'object') return false;
  // action 字段可以是指向对象的 name 或直接就是对象
  if (data.action === undefined && data.actions === undefined) return false;
  return true;
}

// ── schema 构建 ──

/**
 * JSON Schema 描述（用于注入 LLM prompt）
 * 不是严格 JSON Schema 格式，而是更易读的描述形式
 */
export function buildAgentOutputSchema(): string {
  return `{
  "reasoning": "string (必填) — 思考过程，解释为什么执行这个动作",
  "action": {                    // (单动作模式, 与 actions 二选一)
    "name": "string (必填) — 动作名称",
    "args": {}
  },
  "actions": [                   // (多动作模式, 与 action 二选一)
    {
      "name": "string (必填) — 动作名称",
      "args": {}
    }
  ],
  "nextGoal": "string (必填) — 下一步目标描述",
  "taskComplete": "boolean (必填) — true=任务完成",
  "planUpdate": ["string", ...]  // (可选) 新计划步骤列表
}`;
}

/**
 * 构建兼容 JSON Schema 格式的 schema（用于支持 response_format 的 API）
 */
export function buildAgentOutputJsonSchema(): Record<string, any> {
  return {
    type: 'object',
    properties: {
      reasoning: { type: 'string', description: '思考过程' },
      action: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          args: { type: 'object' },
        },
      },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            args: { type: 'object' },
          },
        },
      },
      nextGoal: { type: 'string' },
      taskComplete: { type: 'boolean' },
      planUpdate: {
        type: 'array',
        items: { type: 'string' },
      },
      currentPlanItem: { type: 'integer' },
    },
    required: ['reasoning', 'action', 'nextGoal', 'taskComplete'],
  };
}
