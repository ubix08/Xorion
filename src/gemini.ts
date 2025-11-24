// src/gemini.ts - Gemini API Client

import { GoogleGenAI } from '@google/genai';
import type { FileMetadata } from './types';

// =============================================================
// Types
// =============================================================

export interface GenerateOptions {
  model?: string;
  stream?: boolean;
  timeoutMs?: number;
  thinkingConfig?: { thinkingBudget: number };
  temperature?: number;
  useSearch?: boolean;
  useCodeExecution?: boolean;
  files?: FileMetadata[];
}

export interface GenerateResponse {
  text: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, any>;
  }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

// =============================================================
// Circuit Breaker
// =============================================================

class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private readonly threshold = 5;
  private readonly resetTimeout = 60000;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen()) {
      throw new Error('Circuit breaker open - too many recent failures');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (e) {
      this.onFailure();
      throw e;
    }
  }

  private isOpen(): boolean {
    if (this.failures >= this.threshold) {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.reset();
        return false;
      }
      return true;
    }
    return false;
  }

  private onSuccess(): void {
    this.failures = 0;
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
  }

  private reset(): void {
    this.failures = 0;
  }

  getStatus(): { failures: number; isOpen: boolean } {
    return { failures: this.failures, isOpen: this.isOpen() };
  }
}

// =============================================================
// Gemini Client
// =============================================================

export class GeminiClient {
  private ai: ReturnType<typeof GoogleGenAI>;
  private circuitBreaker = new CircuitBreaker();

  private readonly maxRetries = 3;
  private readonly baseBackoff = 1000;
  private readonly defaultTimeout = 60000;
  private readonly defaultEmbedModel = 'text-embedding-004';

  constructor(opts?: { apiKey?: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts?.apiKey });
  }

  // -----------------------------------------------------------
  // Content Generation
  // -----------------------------------------------------------

  async generateWithTools(
    conversationHistory: Array<{ role: string; content: string }>,
    tools: ToolDefinition[],
    options: GenerateOptions = {},
    onChunk?: (text: string) => void
  ): Promise<GenerateResponse> {
    return this.withRetry(async () => {
      const model = options.model ?? 'gemini-2.0-flash';

      // Format messages
      const contents = this.formatMessages(conversationHistory);

      // Build tool configs
      const toolConfigs = this.buildToolConfigs(tools, options);

      // Generation config
      const config: any = {
        thinkingConfig: options.thinkingConfig ?? { thinkingBudget: 1024 },
        temperature: options.temperature ?? 0.7,
      };

      if (toolConfigs.length > 0) {
        config.tools = toolConfigs;
      }

      // Execute
      if (options.stream) {
        return await this.streamGenerate(model, contents, config, options.timeoutMs, onChunk);
      } else {
        return await this.generate(model, contents, config, options.timeoutMs, onChunk);
      }
    });
  }

  private async generate(
    model: string,
    contents: any[],
    config: any,
    timeoutMs?: number,
    onChunk?: (text: string) => void
  ): Promise<GenerateResponse> {
    const response = await this.withTimeout(
      this.ai.models.generateContent({ model, contents, config } as any),
      'Generate timeout',
      timeoutMs
    );

    const result = this.parseResponse(response);

    if (result.text && onChunk) {
      try { onChunk(result.text); } catch {}
    }

    return result;
  }

  private async streamGenerate(
    model: string,
    contents: any[],
    config: any,
    timeoutMs?: number,
    onChunk?: (text: string) => void
  ): Promise<GenerateResponse> {
    const streamResp = await this.withTimeout(
      this.ai.models.generateContentStream({ model, contents, config } as any),
      'Stream timeout',
      timeoutMs
    );

    let fullText = '';
    const toolCalls: Array<{ name: string; args: Record<string, any> }> = [];

    try {
      if (streamResp && typeof streamResp[Symbol.asyncIterator] === 'function') {
        for await (const chunk of streamResp) {
          const text = chunk?.text ?? chunk?.delta ?? '';
          if (text) {
            fullText += text;
            if (onChunk) {
              try { onChunk(text); } catch {}
            }
          }

          // Extract tool calls
          if (chunk?.candidates?.[0]?.content?.parts) {
            for (const part of chunk.candidates[0].content.parts) {
              if (part.functionCall) {
                toolCalls.push({
                  name: part.functionCall.name,
                  args: part.functionCall.args || {},
                });
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('[Gemini] Stream error:', e);
    }

    return {
      text: fullText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
  }

  // -----------------------------------------------------------
  // Embeddings
  // -----------------------------------------------------------

  async embedText(
    text: string,
    opts?: { model?: string; normalize?: boolean; timeoutMs?: number }
  ): Promise<number[]> {
    const model = opts?.model ?? this.defaultEmbedModel;

    return this.withRetry(async () => {
      const response = await this.callEmbedApi([text], model, opts?.timeoutMs);
      
      if (!response || response.length === 0) {
        throw new Error('Empty embedding response');
      }

      return opts?.normalize === false ? response[0] : this.normalize(response[0]);
    });
  }

  async embedBatch(
    texts: string[],
    opts?: { model?: string; normalize?: boolean; timeoutMs?: number; batchSize?: number }
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const model = opts?.model ?? this.defaultEmbedModel;
    const batchSize = opts?.batchSize ?? 16;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      
      const embeddings = await this.withRetry(async () => {
        return await this.callEmbedApi(batch, model, opts?.timeoutMs);
      });

      for (const emb of embeddings) {
        allEmbeddings.push(opts?.normalize === false ? emb : this.normalize(emb));
      }
    }

    return allEmbeddings;
  }

  private async callEmbedApi(
    texts: string[],
    model: string,
    timeoutMs?: number
  ): Promise<number[][]> {
    const clean = texts.filter(t => t && typeof t === 'string');
    if (clean.length === 0) return [];

    try {
      // Try models.embedContent
      if (typeof (this.ai as any)?.models?.embedContent === 'function') {
        const resp = await this.withTimeout(
          (this.ai as any).models.embedContent({ model, input: clean }),
          'Embed timeout',
          timeoutMs ?? this.defaultTimeout
        );

        return this.extractEmbeddings(resp);
      }

      // Try embeddings.create
      if (typeof (this.ai as any)?.embeddings?.create === 'function') {
        const resp = await this.withTimeout(
          (this.ai as any).embeddings.create({ model, input: clean }),
          'Embed timeout',
          timeoutMs ?? this.defaultTimeout
        );

        return this.extractEmbeddings(resp);
      }

      throw new Error('No embedding API found on SDK');
    } catch (e) {
      console.error('[Gemini] Embedding error:', e);
      throw e;
    }
  }

  private extractEmbeddings(resp: any): number[][] {
    const embeddings: number[][] = [];

    if (resp?.embeddings && Array.isArray(resp.embeddings)) {
      for (const e of resp.embeddings) {
        if (Array.isArray(e?.values)) embeddings.push(e.values);
        else if (Array.isArray(e)) embeddings.push(e);
      }
    } else if (resp?.data && Array.isArray(resp.data)) {
      for (const d of resp.data) {
        if (Array.isArray(d?.embedding)) embeddings.push(d.embedding);
      }
    } else if (Array.isArray(resp)) {
      for (const item of resp) {
        if (Array.isArray(item)) embeddings.push(item);
      }
    }

    return embeddings;
  }

  private normalize(vec: number[]): number[] {
    if (!vec || vec.length === 0) return vec;

    let sumSq = 0;
    for (const v of vec) sumSq += v * v;

    const mag = Math.sqrt(sumSq) || 1;
    return vec.map(v => v / mag);
  }

  // -----------------------------------------------------------
  // File Management
  // -----------------------------------------------------------

  async uploadFile(
    fileDataBase64: string,
    mimeType: string,
    displayName: string
  ): Promise<FileMetadata> {
    return this.withRetry(async () => {
      const buffer = Buffer.from(fileDataBase64, 'base64');

      const uploadResp: any = await this.withTimeout(
        this.ai.files.upload({
          file: buffer as any,
          config: { mimeType, displayName },
        }),
        'Upload timeout'
      );

      const name = uploadResp?.name;
      if (!name) throw new Error('Upload failed: no file name returned');

      const meta: any = await this.ai.files.get({ name });

      return {
        fileUri: meta?.uri,
        mimeType: meta?.mimeType ?? mimeType,
        name: meta?.displayName ?? displayName,
        sizeBytes: meta?.sizeBytes ?? buffer.length,
        uploadedAt: Date.now(),
        state: meta?.state ?? 'ACTIVE',
        expiresAt: meta?.expirationTime
          ? new Date(meta.expirationTime).getTime()
          : undefined,
      };
    });
  }

  async deleteFile(fileUriOrName: string): Promise<void> {
    try {
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      await this.ai.files.delete({ name });
    } catch (e) {
      console.warn('[Gemini] Delete file failed:', e);
    }
  }

  // -----------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------

  private formatMessages(history: Array<{ role: string; content: string }>): any[] {
    return history.map(msg => {
      if (msg.role === 'system') {
        return {
          role: 'user',
          parts: [{ text: `[System Instructions]\n${msg.content}` }],
        };
      }

      return {
        role: msg.role === 'model' || msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content || '' }],
      };
    });
  }

  private buildToolConfigs(tools: ToolDefinition[], options: GenerateOptions): any[] {
    const configs: any[] = [];

    // External tools
    if (tools.length > 0) {
      configs.push({
        functionDeclarations: tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      });
    }

    // Native tools
    if (options.useSearch) configs.push({ googleSearch: {} });
    if (options.useCodeExecution) configs.push({ codeExecution: {} });

    return configs;
  }

  private parseResponse(response: any): GenerateResponse {
    const result: GenerateResponse = { text: '' };

    if (response?.candidates?.[0]?.content?.parts) {
      const parts = response.candidates[0].content.parts;

      result.text = parts
        .filter((p: any) => p.text)
        .map((p: any) => p.text)
        .join('');

      const functionCalls = parts.filter((p: any) => p.functionCall);
      if (functionCalls.length > 0) {
        result.toolCalls = functionCalls.map((fc: any) => ({
          name: fc.functionCall.name,
          args: fc.functionCall.args || {},
        }));
      }
    } else if (typeof response?.text === 'string') {
      result.text = response.text;
    }

    return result;
  }

  // -----------------------------------------------------------
  // Resilience
  // -----------------------------------------------------------

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: any;

    for (let i = 0; i < this.maxRetries; i++) {
      try {
        return await this.circuitBreaker.execute(fn);
      } catch (err) {
        lastErr = err;
        console.warn(`[Gemini] Attempt ${i + 1}/${this.maxRetries} failed:`, err);

        if (i < this.maxRetries - 1) {
          const delay = this.baseBackoff * Math.pow(2, i);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    throw lastErr;
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    errorMsg = 'Timeout',
    ms?: number
  ): Promise<T> {
    const timeout = ms ?? this.defaultTimeout;

    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(errorMsg)), timeout)
      ),
    ]);
  }

  // -----------------------------------------------------------
  // Status
  // -----------------------------------------------------------

  getCircuitBreakerStatus() {
    return this.circuitBreaker.getStatus();
  }
}

export default GeminiClient;
