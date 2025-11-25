// src/gemini-enhanced.ts - Enhanced Gemini Client with Full Native Capabilities

import { GoogleGenAI } from '@google/genai';
import type { FileMetadata } from './types';

// =============================================================
// Enhanced Types
// =============================================================

export interface GenerateOptions {
  model?: string;
  stream?: boolean;
  timeoutMs?: number;
  
  // Thinking configuration
  thinkingConfig?: {
    thinkingBudget?: number;
    enableThinking?: boolean;
  };
  
  // Generation parameters
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  
  // Native Gemini tools
  useSearch?: boolean;
  useMaps?: boolean;
  useCodeExecution?: boolean;
  useUrlContext?: string[];  // Array of URLs to ground with
  useFileSearch?: boolean;
  
  // Files and media
  files?: FileMetadata[];
  images?: Array<{ data: string; mimeType: string }>;
  
  // External tools (function calling)
  tools?: ToolDefinition[];
  
  // Response format
  responseMimeType?: 'text/plain' | 'application/json';
  responseSchema?: Record<string, any>;
  
  // Safety settings
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
    promptTokens?: number;
    candidatesTokens?: number;
    totalTokens?: number;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

// =============================================================
// Enhanced Gemini Client
// =============================================================

export class GeminiClient {
  // `InstanceType<typeof GoogleGenAI>` is preferred when available; fall back to `any` for safety
  private ai: InstanceType<typeof GoogleGenAI> | any;
  private circuitBreaker: CircuitBreaker;
  
  private readonly maxRetries = 3;
  private readonly baseBackoff = 1000;
  private readonly defaultTimeout = 120000; // 2 minutes for complex queries
  private readonly defaultEmbedModel = 'text-embedding-004';

  constructor(opts?: { apiKey?: string }) {
    // If the SDK constructor expects different shape, adapt here.
    this.ai = new (GoogleGenAI as any)({ apiKey: opts?.apiKey });
    this.circuitBreaker = new CircuitBreaker();
  }

  // -----------------------------------------------------------
  // Enhanced Content Generation
  // -----------------------------------------------------------

  async generateWithNativeTools(
    conversationHistory: Array<{ role: string; content: string; files?: FileMetadata[] }>,
    options: GenerateOptions = {}
  ): Promise<GenerateResponse> {
    return this.withRetry(async () => {
      const model = options.model ?? 'gemini-2.5-flash';

      // Format messages with enhanced content types
      const contents = await this.formatMessages(conversationHistory, options);

      // Build comprehensive config
      const config = this.buildConfig(options);

      // Execute with streaming support
      if (options.stream) {
        return await this.streamGenerate(model, contents, config, options.timeoutMs);
      } else {
        return await this.generate(model, contents, config, options.timeoutMs);
      }
    });
  }

  private async generate(
    model: string,
    contents: any[],
    config: any,
    timeoutMs?: number
  ): Promise<GenerateResponse> {
    const response = await this.withTimeout(
      (this.ai as any).models.generateContent?.({ model, contents, config } as any) ??
        (this.ai as any).models?.generate?.({ model, input: contents, config } as any),
      'Generate timeout',
      timeoutMs ?? this.defaultTimeout
    );

    return this.parseResponse(response);
  }

  private async streamGenerate(
    model: string,
    contents: any[],
    config: any,
    timeoutMs?: number
  ): Promise<GenerateResponse> {
    const streamSource =
      (this.ai as any).models.generateContentStream?.({ model, contents, config } as any) ??
      (this.ai as any).models?.stream?.({ model, input: contents, config } as any);

    const streamResp = await this.withTimeout(
      Promise.resolve(streamSource),
      'Stream timeout',
      timeoutMs ?? this.defaultTimeout
    );

    let fullText = '';
    let thinking = '';
    const toolCalls: Array<{ name: string; args: Record<string, any> }> = [];
    const searchResults: any[] = [];
    const codeExecutionResults: any[] = [];
    let usageMetadata: any = undefined;
    let finishReason: string | undefined;

    try {
      // If streamResp is async iterable
      if (streamResp && typeof (streamResp as any)[Symbol.asyncIterator] === 'function') {
        for await (const chunk of streamResp) {
          if (!chunk) continue;

          // Extract text content (support multiple possible shapes)
          const textCandidates = [
            chunk.text,
            chunk.delta,
            chunk.candidateText,
            chunk?.candidates?.[0]?.content?.text,
          ];
          for (const t of textCandidates) {
            if (typeof t === 'string' && t.length > 0) {
              fullText += t;
              break;
            }
          }

          // Extract thinking content (new in some Gemini shapes)
          if (chunk?.candidates?.[0]?.content?.parts && Array.isArray(chunk.candidates[0].content.parts)) {
            for (const part of chunk.candidates[0].content.parts) {
              if (part?.thought) thinking += String(part.thought);
              if (part?.functionCall) {
                toolCalls.push({
                  name: part.functionCall.name,
                  args: part.functionCall.args ?? {},
                });
              }
              if (part?.executableCode || part?.codeExecutionResult) {
                codeExecutionResults.push({
                  code: part.executableCode,
                  result: part.codeExecutionResult,
                });
              }
              if (part?.text) {
                fullText += part.text;
              }
            }
          }

          // Extract grounding metadata (search)
          if (chunk?.candidates?.[0]?.groundingMetadata) {
            searchResults.push(chunk.candidates[0].groundingMetadata);
          }

          // Capture usage metadata & finish reason if present
          if (chunk?.usageMetadata) {
            usageMetadata = chunk.usageMetadata;
          }
          if (chunk?.candidates?.[0]?.finishReason) {
            finishReason = chunk.candidates[0].finishReason;
          }
        }
      } else if (streamResp && Array.isArray(streamResp)) {
        // Some SDKs return an array of chunks synchronously
        for (const chunk of streamResp) {
          const parsed = this.parseResponse(chunk);
          if (parsed.text) fullText += parsed.text;
          if (parsed.thinking) thinking += parsed.thinking;
          if (parsed.toolCalls) toolCalls.push(...parsed.toolCalls);
          if (parsed.searchResults) searchResults.push(...parsed.searchResults);
          if (parsed.codeExecutionResults) codeExecutionResults.push(...parsed.codeExecutionResults);
          if (parsed.usageMetadata) usageMetadata = parsed.usageMetadata;
          if (parsed.finishReason) finishReason = parsed.finishReason;
        }
      } else {
        // Not a recognized streaming shape; attempt to parse as single response
        const parsed = this.parseResponse(streamResp);
        fullText = parsed.text ?? fullText;
        thinking = parsed.thinking ?? thinking;
        if (parsed.toolCalls) toolCalls.push(...parsed.toolCalls);
        if (parsed.searchResults) searchResults.push(...parsed.searchResults);
        if (parsed.codeExecutionResults) codeExecutionResults.push(...parsed.codeExecutionResults);
        usageMetadata = parsed.usageMetadata ?? usageMetadata;
        finishReason = parsed.finishReason ?? finishReason;
      }
    } catch (e) {
      console.error('[EnhancedGemini] Stream error:', e);
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
  // Message Formatting with Enhanced Content
  // -----------------------------------------------------------

  private async formatMessages(
    history: Array<{ role: string; content: string; files?: FileMetadata[] }>,
    options: GenerateOptions
  ): Promise<any[]> {
    const contents: any[] = [];

    for (let i = 0; i < history.length; i++) {
      const msg = history[i];
      const parts: any[] = [];

      // Handle system messages (convert to user instructions but specifically labeled)
      if (msg.role === 'system') {
        contents.push({
          role: 'system',
          parts: [{ text: `[System Instructions]\n${msg.content}` }],
        });
        continue;
      }

      // Add text content
      if (msg.content) {
        parts.push({ text: msg.content });
      }

      // Add file attachments (documents, images, etc.)
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

      // Add images from options only to the last message (if provided)
      if (options.images && i === history.length - 1) {
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
      // Thinking configuration (Gemini 2.5 feature)
      thinkingConfig: options.thinkingConfig ?? {
        thinkingBudget: 8192, // Max thinking tokens
        enableThinking: true,
      },
      
      // Generation parameters
      temperature: typeof options.temperature === 'number' ? options.temperature : 0.7,
      topP: options.topP,
      topK: options.topK,
      maxOutputTokens: options.maxOutputTokens,
      
      // Response format
      responseMimeType: options.responseMimeType,
      responseSchema: options.responseSchema,
      
      // Safety settings
      safetySettings: options.safetySettings,
    };

    // Build tools array
    const tools: any[] = [];

    // Google Search grounding
    if (options.useSearch) {
      tools.push({ googleSearch: {} });
    }

    // Maps grounding
    if (options.useMaps) {
      tools.push({ googleMaps: {} });
    }

    // Code execution
    if (options.useCodeExecution) {
      tools.push({ codeExecution: {} });
    }

    // URL context grounding
    if (options.useUrlContext && options.useUrlContext.length > 0) {
      tools.push({
        urlContext: {
          urls: options.useUrlContext,
        },
      });
    }

    // File search (RAG over uploaded files)
    if (options.useFileSearch) {
      tools.push({ fileSearch: {} });
    }

    // External function calling tools
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

  // -----------------------------------------------------------
  // Response Parsing
  // -----------------------------------------------------------

  private parseResponse(response: any): GenerateResponse {
    const result: GenerateResponse = { text: '' };

    // Handle structured candidate responses
    if (response?.candidates?.[0]?.content?.parts && Array.isArray(response.candidates[0].content.parts)) {
      const parts = response.candidates[0].content.parts;

      // Extract text
      result.text = parts
        .filter((p: any) => typeof p.text === 'string' && p.text.length > 0)
        .map((p: any) => p.text)
        .join('');

      // Extract thinking/thoughts
      const thoughts = parts.filter((p: any) => p.thought);
      if (thoughts.length > 0) {
        result.thinking = thoughts.map((t: any) => String(t.thought)).join('\n');
      }

      // Extract function calls
      const functionCalls = parts.filter((p: any) => p.functionCall);
      if (functionCalls.length > 0) {
        result.toolCalls = functionCalls.map((fc: any) => ({
          name: fc.functionCall.name,
          args: fc.functionCall.args || {},
        }));
      }

      // Extract code execution results
      const codeResults = parts.filter((p: any) => p.codeExecutionResult || p.executableCode);
      if (codeResults.length > 0) {
        result.codeExecutionResults = codeResults.map((cr: any) => ({
          code: cr.executableCode,
          result: cr.codeExecutionResult,
        }));
      }

      // Extract grounding metadata (search results)
      if (response.candidates[0].groundingMetadata) {
        result.searchResults = [response.candidates[0].groundingMetadata];
      }

      // Extract usage metadata
      if (response.usageMetadata) {
        result.usageMetadata = {
          promptTokens: response.usageMetadata.promptTokenCount ?? response.usageMetadata.promptTokens,
          candidatesTokens: response.usageMetadata.candidatesTokenCount ?? response.usageMetadata.candidatesTokens,
          totalTokens: response.usageMetadata.totalTokenCount ?? response.usageMetadata.totalTokens,
        };
      }

      // Extract finish reason
      if (response.candidates[0].finishReason) {
        result.finishReason = response.candidates[0].finishReason;
      }
    } else if (typeof response?.text === 'string') {
      // Fallback to simple text responses
      result.text = response.text;
    } else if (response && typeof response === 'object') {
      // Try to extract text from a few other common shapes
      result.text = response?.outputText ?? response?.generatedText ?? '';
      if (response?.usage) {
        result.usageMetadata = {
          promptTokens: response.usage.promptTokenCount ?? response.usage.promptTokens,
          candidatesTokens: response.usage.candidatesTokenCount ?? response.usage.candidatesTokens,
          totalTokens: response.usage.totalTokenCount ?? response.usage.totalTokens,
        };
      }
    }

    return result;
  }

  // -----------------------------------------------------------
  // File Management (Enhanced)
  // -----------------------------------------------------------

  async uploadFile(
    fileDataBase64: string,
    mimeType: string,
    displayName: string
  ): Promise<FileMetadata> {
    return this.withRetry(async () => {
      const buffer = Buffer.from(fileDataBase64, 'base64');

      const uploadResp: any = await this.withTimeout(
        (this.ai as any).files?.upload?.({
          file: buffer as any,
          config: { mimeType, displayName },
        }) ??
          (this.ai as any).files?.create?.({ file: buffer as any, config: { mimeType, displayName } }),
        'Upload timeout',
        60000
      );

      const name = uploadResp?.name ?? uploadResp?.fileName ?? uploadResp?.id;
      if (!name) throw new Error('Upload failed: no file name/id returned');

      // Poll for processing status with a reasonable limit
      let meta: any = await (this.ai as any).files?.get?.({ name }) ?? {};
      let attempts = 0;
      
      while (meta?.state === 'PROCESSING' && attempts < 30) {
        // 2 seconds per attempt => up to ~60 seconds total
        await new Promise(r => setTimeout(r, 2000));
        meta = await (this.ai as any).files?.get?.({ name }) ?? meta;
        attempts++;
      }

      return {
        fileUri: meta?.uri ?? meta?.fileUri ?? name,
        mimeType: meta?.mimeType ?? mimeType,
        name: meta?.displayName ?? displayName,
        sizeBytes: meta?.sizeBytes ?? buffer.length,
        uploadedAt: Date.now(),
        state: meta?.state ?? 'ACTIVE',
        expiresAt: meta?.expirationTime ? new Date(meta.expirationTime).getTime() : undefined,
      };
    });
  }

  async listFiles(): Promise<FileMetadata[]> {
    try {
      const response: any = await (this.ai as any).files?.list?.();
      return (response?.files || []).map((f: any) => ({
        fileUri: f.uri ?? f.fileUri ?? f.name,
        mimeType: f.mimeType,
        name: f.displayName ?? f.name,
        sizeBytes: f.sizeBytes,
        uploadedAt: f.createTime ? new Date(f.createTime).getTime() : undefined,
        state: f.state,
        expiresAt: f.expirationTime ? new Date(f.expirationTime).getTime() : undefined,
      }));
    } catch (e) {
      console.error('[EnhancedGemini] List files error:', e);
      return [];
    }
  }

  async deleteFile(fileUriOrName: string): Promise<void> {
    try {
      const name = fileUriOrName.split('/').pop() ?? fileUriOrName;
      await (this.ai as any).files?.delete?.({ name });
    } catch (e) {
      console.warn('[EnhancedGemini] Delete file failed:', e);
    }
  }

  // -----------------------------------------------------------
  // Embeddings (unchanged from original, slightly hardened)
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
      console.error('[EnhancedGemini] Embedding error:', e);
      throw e;
    }
  }

  private extractEmbeddings(resp: any): number[][] {
    const embeddings: number[][] = [];

    if (resp?.embeddings && Array.isArray(resp.embeddings)) {
      for (const e of resp.embeddings) {
        if (Array.isArray(e?.values)) embeddings.push(e.values);
        else if (Array.isArray(e)) embeddings.push(e as number[]);
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
        console.warn(`[dGemini] Attempt ${i + 1}/${this.maxRetries} failed:`, err);

        if (i < this.maxRetries - 1) {
          const delay = this.baseBackoff * Math.pow(2, i);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    throw lastErr;
  }

  private async withTimeout<T>(
    promise: Promise<T> | T,
    errorMsg = 'Timeout',
    ms?: number
  ): Promise<T> {
    const timeout = ms ?? this.defaultTimeout;

    // Accept either a promise or direct value
    const p = promise instanceof Promise ? promise : Promise.resolve(promise);

    return Promise.race([
      p,
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
// Circuit Breaker (unchanged)
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
