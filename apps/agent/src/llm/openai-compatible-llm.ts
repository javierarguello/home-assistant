/**
 * An ADK model connector that speaks the OpenAI Chat Completions protocol.
 *
 * The official `@google/adk` for TypeScript only ships native connectors for
 * Gemini and Apigee. This class is the single adapter that lets ADK talk to
 * ANY OpenAI-compatible backend — local Ollama (`http://localhost:11434/v1`),
 * OpenAI, Groq, OpenRouter, or even Gemini's OpenAI-compatible endpoint — by
 * translating between ADK's `@google/genai` request/response types and the
 * OpenAI wire format.
 *
 * It is configured per-agent (model + baseURL + apiKey), so each agent can run
 * on a local or cloud model independently. See {@link resolveModel}.
 */
import { BaseLlm } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';
import type { Content, Part } from '@google/genai';
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

export interface OpenAiCompatibleLlmParams {
  /** The model id sent to the backend, e.g. `llama3.2:3b` or `gpt-4o-mini`. */
  model: string;
  /** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1`. */
  baseURL: string;
  /** API key. For local Ollama any non-empty string works (e.g. `ollama`). */
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  /** Extra headers (e.g. `HTTP-Referer` for OpenRouter). */
  headers?: Record<string, string>;
  /**
   * Optional dynamic bearer token (e.g. a gcloud access token for Vertex AI).
   * When set, it overrides `apiKey` per request and is awaited each call so it
   * can refresh.
   */
  getAuthToken?: () => Promise<string>;
}

export class OpenAiCompatibleLlm extends BaseLlm {
  private readonly client: OpenAI;
  private readonly temperature?: number;
  private readonly maxTokens?: number;
  private readonly getAuthToken?: () => Promise<string>;

  constructor(params: OpenAiCompatibleLlmParams) {
    super({ model: params.model });
    this.client = new OpenAI({
      baseURL: params.baseURL,
      apiKey: params.apiKey,
      defaultHeaders: params.headers,
    });
    this.temperature = params.temperature;
    this.maxTokens = params.maxTokens;
    this.getAuthToken = params.getAuthToken;
  }

  /** Per-request options: abort signal + (optional) dynamic bearer token. */
  private async requestOptions(
    abortSignal?: AbortSignal,
  ): Promise<{ signal?: AbortSignal; headers?: Record<string, string> }> {
    const options: { signal?: AbortSignal; headers?: Record<string, string> } = {
      signal: abortSignal,
    };
    if (this.getAuthToken) {
      options.headers = { Authorization: `Bearer ${await this.getAuthToken()}` };
    }
    return options;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const messages = toOpenAiMessages(llmRequest);
    const tools = toOpenAiTools(llmRequest);
    const options = await this.requestOptions(abortSignal);

    const base = {
      model: this.model,
      messages,
      ...(tools.length ? { tools } : {}),
      ...(this.temperature != null ? { temperature: this.temperature } : {}),
      ...(this.maxTokens != null ? { max_tokens: this.maxTokens } : {}),
    };

    if (!stream) {
      const resp = await this.client.chat.completions.create(
        { ...base, stream: false },
        options,
      );
      const choice = resp.choices[0];
      yield messageToLlmResponse(choice?.message, resp.usage ?? undefined);
      return;
    }

    // Streaming: emit partial text chunks, then a final aggregated response
    // that also carries any tool calls.
    const completion = await this.client.chat.completions.create(
      { ...base, stream: true },
      options,
    );

    let text = '';
    const toolCalls = new Map<number, { id?: string; name: string; args: string }>();

    for await (const chunk of completion) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        text += delta.content;
        yield { content: { role: 'model', parts: [{ text: delta.content }] }, partial: true };
      }
      for (const tc of delta.tool_calls ?? []) {
        const entry = toolCalls.get(tc.index) ?? { name: '', args: '' };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        toolCalls.set(tc.index, entry);
      }
    }

    const parts: Part[] = [];
    if (text) parts.push({ text });
    for (const tc of toolCalls.values()) {
      parts.push({ functionCall: { id: tc.id, name: tc.name, args: safeParseArgs(tc.args) } });
    }
    yield { content: { role: 'model', parts }, turnComplete: true };
  }

  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'OpenAiCompatibleLlm does not support live/bidi connections. ' +
        'Use a streaming STT + this model for turn-based voice instead.',
    );
  }
}

// --- genai <-> OpenAI mapping helpers -------------------------------------

function toOpenAiMessages(req: LlmRequest): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];

  const system = systemInstructionText(req.config?.systemInstruction);
  if (system) messages.push({ role: 'system', content: system });

  for (const content of req.contents ?? []) {
    const parts = content.parts ?? [];
    const text = parts
      .map((p) => p.text)
      .filter((t): t is string => !!t)
      .join('');
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall!);
    const functionResponses = parts
      .filter((p) => p.functionResponse)
      .map((p) => p.functionResponse!);

    // Tool results become one `tool` message per response.
    if (functionResponses.length) {
      for (const fr of functionResponses) {
        messages.push({
          role: 'tool',
          tool_call_id: fr.id ?? fallbackCallId(fr.name),
          content: JSON.stringify(fr.response ?? {}),
        });
      }
      continue;
    }

    if (content.role === 'model') {
      const message: ChatCompletionMessageParam = { role: 'assistant', content: text || null };
      if (functionCalls.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (message as any).tool_calls = functionCalls.map((fc) => ({
          id: fc.id ?? fallbackCallId(fc.name),
          type: 'function',
          function: { name: fc.name ?? '', arguments: JSON.stringify(fc.args ?? {}) },
        }));
      }
      messages.push(message);
    } else {
      messages.push({ role: 'user', content: text });
    }
  }

  return messages;
}

function toOpenAiTools(req: LlmRequest): ChatCompletionTool[] {
  const declarations = (req.config?.tools ?? []).flatMap(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t: any) => t.functionDeclarations ?? [],
  );
  return declarations.map((d: Record<string, unknown>) => ({
    type: 'function',
    function: {
      name: String(d.name),
      description: (d.description as string) ?? '',
      parameters: geminiSchemaToJsonSchema(d.parametersJsonSchema ?? d.parameters),
    },
  }));
}

function messageToLlmResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  usage?: any,
): LlmResponse {
  const parts: Part[] = [];
  if (message?.content) parts.push({ text: message.content });
  for (const tc of message?.tool_calls ?? []) {
    parts.push({
      functionCall: {
        id: tc.id,
        name: tc.function?.name,
        args: safeParseArgs(tc.function?.arguments),
      },
    });
  }
  const response: LlmResponse = { content: { role: 'model', parts } };
  if (usage) {
    response.usageMetadata = {
      promptTokenCount: usage.prompt_tokens,
      candidatesTokenCount: usage.completion_tokens,
      totalTokenCount: usage.total_tokens,
    };
  }
  return response;
}

/** Flattens genai's `systemInstruction` (string | Content | Part | array). */
function systemInstructionText(instruction: unknown): string {
  if (!instruction) return '';
  if (typeof instruction === 'string') return instruction;
  const items = Array.isArray(instruction) ? instruction : [instruction];
  const texts: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      texts.push(item);
    } else if (item && typeof item === 'object') {
      const obj = item as { text?: string; parts?: Array<{ text?: string }> };
      if (typeof obj.text === 'string') texts.push(obj.text);
      for (const part of obj.parts ?? []) {
        if (typeof part.text === 'string') texts.push(part.text);
      }
    }
  }
  return texts.join('\n');
}

/**
 * Converts a `@google/genai` Schema (Gemini's OpenAPI-ish format with
 * uppercase types like `OBJECT`/`STRING`) into standard JSON Schema for the
 * OpenAI `tools` field. Passes through if it already looks like JSON Schema.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function geminiSchemaToJsonSchema(schema: any): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const out: Record<string, unknown> = {};
  if (schema.type) out.type = String(schema.type).toLowerCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.format) out.format = schema.format;
  if (schema.nullable) out.nullable = schema.nullable;
  if (schema.properties) {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      props[key] = geminiSchemaToJsonSchema(value);
    }
    out.properties = props;
  }
  if (schema.items) out.items = geminiSchemaToJsonSchema(schema.items);
  if (schema.required) out.required = schema.required;
  if (out.type === undefined && out.properties) out.type = 'object';
  return out;
}

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

let fallbackCounter = 0;
function fallbackCallId(name?: string): string {
  return `call_${name ?? 'fn'}_${fallbackCounter++}`;
}
