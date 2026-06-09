/**
 * 轻量 LLM 客户端 — OpenAI 兼容接口，零外部依赖
 *
 * 支持文本 + 图片（base64）的流式/非流式调用。
 * 使用 Node 22 内置 fetch，不引入第三方包。
 *
 * 用法:
 *   const client = new LlmClient({ apiKey: 'sk-xxx', baseUrl: 'https://api.deepseek.com' });
 *   const reply = await client.chat([
 *     { role: 'system', content: '你是AI助手' },
 *     { role: 'user', content: '你好' },
 *   ]);
 *
 *   // 带图片
 *   const reply2 = await client.chat([...], { images: [base64PngData] });
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmClientConfig {
  /** API key */
  apiKey?: string;
  /** API base URL（默认从环境变量推断） */
  baseUrl?: string;
  /** 模型名 */
  model?: string;
  /** 超时 (ms) */
  timeoutMs?: number;
  /** 最大 tokens */
  maxTokens?: number;
  /** 温度 */
  temperature?: number;
}

export interface LlmChatResponseFormat {
  /** 格式类型 */
  type: 'json_object' | 'json_schema';
  /** json_schema 模式下的 schema 定义 */
  jsonSchema?: Record<string, any>;
  /** schema 名称（仅 json_schema 模式） */
  name?: string;
  /** 是否严格遵循 schema（仅 json_schema 模式，默认 true） */
  strict?: boolean;
}

export interface LlmChatOptions {
  /** 图片列表（base64 编码的 PNG/JPEG 数据） */
  images?: string[];
  /** 是否流式输出 */
  stream?: boolean;
  /** 单次调用超时覆盖 */
  timeoutMs?: number;
  /** 温度覆盖 */
  temperature?: number;
  /** max_tokens 覆盖 */
  maxTokens?: number;
  /** 输出格式约束（仅 OpenAI 兼容 API 支持） */
  responseFormat?: LlmChatResponseFormat;
}

export interface LlmChatResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
}

// ─── 默认配置 ──────────────────────────────────────────────

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.1;

/**
 * 查找可用的 LLM API 配置
 * 优先顺序：传参 → 环境变量 → 常见端点
 */
function resolveConfig(config?: LlmClientConfig): Required<Pick<LlmClientConfig, 'baseUrl' | 'model'>> & LlmClientConfig {
  const baseUrl = config?.baseUrl
    || process.env.OPENAI_BASE_URL
    || process.env.AI_BASE_URL
    || 'https://api.deepseek.com';

  const model = config?.model
    || process.env.AI_MODEL
    || process.env.LLM_MODEL
    || 'deepseek-chat';

  return { ...config, baseUrl, model };
}

// ─── LLM Client ─────────────────────────────────────────────

export class LlmClient {
  private _config: Required<Pick<LlmClientConfig, 'baseUrl' | 'model'>> & LlmClientConfig;
  private _apiKey: string;

  constructor(config?: LlmClientConfig) {
    this._config = resolveConfig(config);
    this._apiKey = config?.apiKey
      || process.env.DEEPSEEK_API_KEY
      || process.env.OPENAI_API_KEY
      || process.env.AI_API_KEY
      || '';
  }

  /** 当前使用的模型名 */
  get model() { return this._config.model; }

  /** 更换模型 */
  setModel(model: string) { this._config.model = model; }

  /** 设置 API key */
  setApiKey(key: string) { this._apiKey = key; }

  /**
   * 非流式聊天补全
   */
  async chat(
    messages: LlmMessage[],
    opts: LlmChatOptions = {},
  ): Promise<LlmChatResponse> {
    const body: Record<string, any> = {
      model: this._config.model,
      messages: this._buildMessages(messages, opts.images),
      max_tokens: opts.maxTokens ?? this._config.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? this._config.temperature ?? DEFAULT_TEMPERATURE,
      stream: false,
    };

    // 结构化输出: response_format
    if (opts.responseFormat) {
      const rf: Record<string, any> = { type: opts.responseFormat.type };
      if (opts.responseFormat.type === 'json_schema') {
        rf.json_schema = {
          name: opts.responseFormat.name || 'agent_output',
          schema: opts.responseFormat.jsonSchema,
          strict: opts.responseFormat.strict ?? true,
        };
      }
      body.response_format = rf;
    }

    const res = await this._post('/v1/chat/completions', body, opts.timeoutMs);

    const choice = res.choices?.[0];
    return {
      content: choice?.message?.content || '',
      usage: res.usage ? {
        promptTokens: res.usage.prompt_tokens ?? 0,
        completionTokens: res.usage.completion_tokens ?? 0,
        totalTokens: res.usage.total_tokens ?? 0,
      } : undefined,
      model: res.model || this._config.model,
    };
  }

  /**
   * 流式聊天补全 — 逐块吐出内容
   */
  async *chatStream(
    messages: LlmMessage[],
    opts: LlmChatOptions = {},
  ): AsyncGenerator<string, void, unknown> {
    const body: Record<string, any> = {
      model: this._config.model,
      messages: this._buildMessages(messages, opts.images),
      max_tokens: opts.maxTokens ?? this._config.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? this._config.temperature ?? DEFAULT_TEMPERATURE,
      stream: true,
    };

    const url = `${this._config.baseUrl}/v1/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM API ${res.status}: ${text.slice(0, 200)}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // skip malformed chunks
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** 测试 API 连通性 */
  async ping(): Promise<{ ok: boolean; model: string; error?: string }> {
    try {
      const res = await this.chat(
        [{ role: 'user', content: 'ping' }],
        { maxTokens: 10, timeoutMs: 10_000 },
      );
      return { ok: true, model: res.model };
    } catch (err: any) {
      return { ok: false, model: this._config.model, error: err.message };
    }
  }

  // ── internal ──

  private _buildMessages(messages: LlmMessage[], images?: string[]): any[] {
    if (!images || images.length === 0) {
      return messages;
    }

    // 有图片时用多模态格式
    const result: any[] = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        result.push({
          role: 'user',
          content: [
            { type: 'text', text: msg.content },
            ...images.map(img => ({
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${img}`, detail: 'high' },
            })),
          ],
        });
      } else {
        result.push(msg);
      }
    }
    return result;
  }

  private async _post(path: string, body: any, timeoutMs?: number): Promise<any> {
    const url = `${this._config.baseUrl}${path}`;
    const timeout = timeoutMs ?? DEFAULT_TIMEOUT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this._apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM API ${res.status}: ${text.slice(0, 200)}`);
      }

      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 快速创建 LlmClient（无 new） */
export function createLlmClient(config?: LlmClientConfig): LlmClient {
  return new LlmClient(config);
}
