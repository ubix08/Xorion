// src/gemini.ts - Gemini Client with Full Native Capabilities (Fixed)

import { GoogleGenAI } from '@google/genai';
import type { FileMetadata } from './types';

// =============================================================
//  Types
// =============================================================

export interface GenerateOptions {
  model?: string;
  stream?: boolean;
  timeoutMs?: number;
  
  thinkingConfig?: {
    thinkingBudget?: number;
    includeThoughts?: boolean;
  };
  
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  
  useSearch?: boolean;
  useMaps?: boolean;
  useCodeExecution?: boolean;
  useUrlContext?: string[];
  useFileSearch?: boolean;
  
  files?: FileMetadata[];
  images?: Array<{ data: string; mimeType: string }>;
  
  tools?: ToolDefinition[];
  
  responseMimeType?: 'text/plain' | 'application/json';
  responseSchema?: Record<string, any>;
  
  safetySettings?: Array<{
    category: string;
    threshold: string;
  }>;
}

export interface GenerateResponse {
  text: string;
  thinking?: string;
  toolCalls?: Array<{
    name: string;
    args: Record<string, any>;
  }>;
  searchResults?: any[];
  codeExecutionResults?: any[];
  finishReason?: string;
  usageMetadata?: {
    promptTokens: number;
    candidatesTokens: number;
    totalTokens: number;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

// =============================================================
//  Gemini Client
// =============================================================

export class GeminiClient {
  private ai: ReturnType<typeof GoogleGenAI>;
  private circuitBreaker: CircuitBreaker;
  
  private readonly maxRetries = 3;
  private readonly baseBackoff = 1000;
  private readonly defaultTimeout = 120000;
  private readonly defaultEmbedModel = 'text-embedding-004';

  constructor(opts?: { apiKey?: string }) {
    this.ai = new GoogleGenAI({ apiKey: opts?.apiKey });
    this.circuitBreaker = new CircuitBreaker();
  }

  // -----------------------------------------------------------
  //  Content Generation with Real-Time Streaming
  // -----------------------------------------------------------

  async generateWithNativeTools(
    conversationHistory: Array<{ role: string; content: string; files?: FileMetadata[] }>,
    options: GenerateOptions = {},
    onChunk?: (chunk: string) => void,
    onThinking?: (thought: string) => void
  ): Promise<GenerateResponse> {
    return this.withRetry(async () => {
      const model = options.model ?? 'gemini-2.5-flash';
      const contents = await this.formatMessages(conversationHistory, options);
      const config = this.buildConfig(options);

      if (options.stream) {
        return await this.streamGenerate(model, contents, config, options.timeoutMs, onChunk, onThinking);
      } else {
        return await this.generate(model, contents, config, options.timeoutMs);
      }
    });
  }

  // Alias for backward compatibility
  async generateWithTools(
    conversationHistory: Array<{ role: string; content: string; files?: FileMetadata[] }>,
    tools: ToolDefinition[],
    options: GenerateOptions = {},
    onChunk?: (chunk: string) => void,
    onThinking?: (thought: string) => void
  ): Promise<GenerateResponse> {
    return this.generateWithNativeTools(
      conversationHistory,
      { ...options, tools },
      onChunk,
      onThinking
    );
  }

  private async generate(
    model: string,
    contents: any[],
    config: any,
    timeoutMs?: number
  ): Promise<GenerateResponse> {
    const response = await this.withTimeout(
      this.ai.models.generateContent({ model, contents, config } as any),
      'Generate timeout',
      timeoutMs ?? this.defaultTimeout
    );

    return this.parseResponse(response);
  }

  private async streamGenerate(
    model: string,
    contents: any[],
    config: any,
    timeoutMs?: number,
    onChunk?: (chunk: string) => void,
    onThinking?: (thought: string) => void
  ): Promise<GenerateResponse> {
    const streamResp = await this.withTimeout(
      this.ai.models.generateContentStream({ model, contents, config } as any),
      'Stream timeout',
      timeoutMs ?? this.defaultTimeout
    );

    let fullText = '';
    let thinking = '';
    const toolCalls: Array<{ name: string; args: Record<string, any> }> = [];
    const searchResults: any[] = [];
    const codeExecutionResults: any[] = [];
    let usageMetadata: any = null;
    let finishReason: string | undefined;

    try {
      if (streamResp && typeof streamResp[Symbol.asyncIterator] === 'function') {
        for await (const chunk of streamResp) {
          // Extract and stream text content
          const text = chunk?.text ?? chunk?.delta ?? '';
          if (text) {
            fullText += text;
            if (onChunk) {
              onChunk(text);
            }
          }

          // Extract and stream thinking content
          if (chunk?.candidates?.[0]?.content?.parts) {
            for (const part of chunk.candidates[0].content.parts) {
              if (part.thought) {
                const thoughtChunk = part.thought;
                thinking += thoughtChunk;
                if (onThinking) {
                  onThinking(thoughtChunk);
                }
              }
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

          // Extract search grounding metadata
          if (chunk?.candidates?.[0]?.groundingMetadata?.searchEntryPoint) {
            searchResults.push(chunk.candidates[0].groundingMetadata);
          }

          // Extract code execution results
          if (chunk?.candidates?.[0]?.content?.parts) {
            for (const part of chunk.candidates[0].content.parts) {
              if (part.executableCode || part.codeExecutionResult) {
                codeExecutionResults.push({
                  code: part.executableCode,
                  result: part.codeExecutionResult,
                });
              }
            }
          }

          if (chunk?.usageMetadata) {
            usageMetadata = chunk.usageMetadata;
          }

          if (chunk?.candidates?.[0]?.finishReason) {
            finishReason = chunk.candidates[0].finishReason;
          }
        }
      }
    } catch (e) {
      console.error('[Gemini] Stream error:', e);
    }

    return {
      text: fullText,
      thinking: thinking || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      searchResults: searchResults.length > 0 ? searchResults : undefined,
      codeExecutionResults: codeExecutionResults.length > 0 ? codeExecutionResults : undefined,
      finishReason,
      usageMetadata,
    };
  }

  // -----------------------------------------------------------
  // Message Formatting with Content
  // -----------------------------------------------------------

  private async formatMessages(
    history: Array<{ role: string; content: string; files?: FileMetadata[] }>,
    options: GenerateOptions
  ): Promise<any[]> {
    const contents: any[] = [];

    for (const msg of history) {
      const parts: any[] = [];

      if (msg.role === 'system') {
        contents.push({
          role: 'user',
          parts: [{ text: `[System Instructions]\n${msg.content}` }],
        });
        continue;
      }

      if (msg.content) {
        parts.push({ text: msg.content });
      }

      if (msg.files) {
        for (const file of msg.files) {
          parts.push({
            fileData: {
              mimeType: file.mimeType,
              fileUri: file.fileUri,
            },
          });
        }
      }

      if (options.images && contents.length === history.length - 1) {
        for (const img of options.images) {
          parts.push({
            inlineData: {
              mimeType: img.mimeType,
              data: img.data,
            },
          });
        }
      }

      contents.push({
        role: msg.role === 'model' || msg.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }

    return contents;
  }

  // -----------------------------------------------------------
  // Configuration Building
  // -----------------------------------------------------------

  private buildConfig(options: GenerateOptions): any {
    const config: any = {
      thinkingConfig: options.thinkingConfig ?? {
        thinkingBudget: 8192,
        includeThoughts: true,
      },
      
      temperature: options.temperature ?? 0.7,
      topP: options.topP,
      topK: options.topK,
      maxOutputTokens: options.maxOutputTokens,
      
      responseMimeType: options.responseMimeType,
      responseSchema: options.responseSchema,
      
      safetySettings: options.safetySettings,
    };

    const tools: any[] = [];

    if (options.useSearch) {
      tools.push({ googleSearch: {} });
    }

    if (options.useMaps) {
      tools.push({ googleMaps: {} });
    }

    if (options.useCodeExecution) {
      tools.push({ codeExecution: {} });
    }

    if (options.useUrlContext && options.useUrlContext.length > 0) {
      tools.push({
        urlContext: {
          urls: options.useUrlContext,
        },
      });
    }

    if (options.useFileSearch) {
      tools.push({ fileSearch: {} });
    }

    if (options.tools && options.tools.length > 0) {
      tools.push({
        functionDeclarations: options.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      });
    }

    if (tools.length > 0) {
      config.tools = tools;
    }

    return config;
  }

  // Continued in Part 2...
  // src/gemini.ts - Part 2: File Upload, Embeddings, Utilities

  // -----------------------------------------------------------
  // Response Parsing
  // -----------------------------------------------------------

  private parseResponse(response: any): GenerateResponse {
    const result: GenerateResponse = { text: '' };

    if (response?.candidates?.[0]?.content?.parts) {
      const parts = response.candidates[0].content.parts;

      result.text = parts
        .filter((p: any) => p.text)
        .map((p: any) => p.text)
        .join('');

      const thoughts = parts.filter((p: any) => p.thought);
      if (thoughts.length > 0) {
        result.thinking = thoughts.map((t: any) => t.thought).join('\n');
      }

      const functionCalls = parts.filter((p: any) => p.functionCall);
      if (functionCalls.length > 0) {
        result.toolCalls = functionCalls.map((fc: any) => ({
          name: fc.functionCall.name,
          args: fc.functionCall.args || {},
        }));
      }

      const codeResults = parts.filter((p: any) => p.codeExecutionResult);
      if (codeResults.length > 0) {
        result.codeExecutionResults = codeResults.map((cr: any) => cr.codeExecutionResult);
      }

      if (response.candidates[0].groundingMetadata) {
        result.searchResults = [response.candidates[0].groundingMetadata];
      }

      if (response.usageMetadata) {
        result.usageMetadata = {
          promptTokens: response.usageMetadata.promptTokenCount,
          candidatesTokens: response.usageMetadata.candidatesTokenCount,
          totalTokens: response.usageMetadata.totalTokenCount,
        };
      }

      if (response.candidates[0].finishReason) {
        result.finishReason = response.candidates[0].finishReason;
      }
    } else if (typeof response?.text === 'string') {
      result.text = response.text;
    }

    return result;
  }

  // -----------------------------------------------------------
  // File Management (Fixed Upload Timeout & Error Handling)
  // -----------------------------------------------------------

  async uploadFile(
    fileDataBase64: string,
    mimeType: string,
    displayName: string
  ): Promise<FileMetadata> {
    return this.withRetry(async () => {
      const buffer = Buffer.from(fileDataBase64, 'base64');

      // Dynamic timeout based on file size
      const timeoutMs = Math.max(60000, buffer.length / 1000);

      const uploadResp: any = await this.withTimeout(
        this.ai.files.upload({
          file: buffer as any,
          config: { mimeType, displayName },
        }),
        'Upload timeout',
        timeoutMs
      );

      const name = uploadResp?.name;
      if (!name) throw new Error('Upload failed: no file name returned');

      // Wait for processing with better error handling
      let meta: any = await this.ai.files.get({ name });
      let attempts = 0;

      while (meta.state === 'PROCESSING' && attempts < 30) {
        await new Promise(r => setTimeout(r, 2000));
        meta = await this.ai.files.get({ name });
        attempts++;
      }

      // Handle failed or timeout states
      if (meta.state === 'FAILED') {
        throw new Error(`File processing failed: ${meta.error || 'Unknown error'}`);
      }

      if (meta.state === 'PROCESSING') {
        throw new Error('File processing timeout after 60 seconds');
      }

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

  async listFiles(): Promise<FileMetadata[]> {
    try {
      const response: any = await this.ai.files.list();
      return (response?.files || []).map((f: any) => ({
        fileUri: f.uri,
        mimeType: f.mimeType,
        name: f.displayName,
        sizeBytes: f.sizeBytes,
        uploadedAt: new Date(f.createTime).getTime(),
        state: f.state,
        expiresAt: f.expirationTime ? new Date(f.expirationTime).getTime() : undefined,
      }));
    } catch (e) {
      console.error('[Gemini] List files error:', e);
      return [];
    }
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
  // Embeddings (Fixed Batch Size)
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
    // Cap batch size at 10 for safety
    const batchSize = Math.min(opts?.batchSize ?? 10, 10);
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
      if (typeof (this.ai as any)?.models?.embedContent === 'function') {
        const resp = await this.withTimeout(
          (this.ai as any).models.embedContent({ model, input: clean }),
          'Embed timeout',
          timeoutMs ?? this.defaultTimeout
        );

        return this.extractEmbeddings(resp);
      }

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
  // Resilience Helpers
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

  getCircuitBreakerStatus() {
    return this.circuitBreaker.getStatus();
  }
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

export default GeminiClient;
