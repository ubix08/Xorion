// src/durable-agent.ts - FIXED VERSION

import { DurableObject } from 'cloudflare:workers';
import type { Env, Message, Artifact, TaskEnvelope, WSOutgoingMessage } from './types';
import { GeminiClient } from './gemini';
import { DurableStorage } from './durable-storage';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import { workerRegistry } from './workers/worker-registry';
import {
  buildAdminSystemInstruction,
  buildAdminUserPrompt,
  buildWorkerSystemInstruction,
  buildWorkerTaskPrompt,
} from './admin/admin-prompts';

// =============================================================
// Response Parsing
// =============================================================

interface ParsedAdminResponse {
  action: 'respond' | 'memory_search' | 'delegate';
  content: string;
  delegation?: TaskEnvelope;
  memoryQuery?: string;
  metadata?: Record<string, any>;
}

interface ParsedWorkerResponse {
  output?: string;
  summary?: string;
  confidence?: 'high' | 'medium' | 'low';
  complete: boolean;
}

// =============================================================
// Orion Agent - FIXED
// =============================================================

export class OrionAgent extends DurableObject {
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private env: Env;
  private state: any; // DurableObjectState
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private sessionId?: string;
  private initialized = false;
  private activeSockets = new Set<WebSocket>();
  private adminSystemInstruction: string;

  private metrics = {
    totalRequests: 0,
    nativeToolCalls: 0,
    delegations: 0,
    adminTurns: 0,
    workerTurns: 0,
    thinkingTokensUsed: 0,
  };

  constructor(state: any, env: Env) {
    super(state, env);
    this.state = state; // Store state reference
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
    this.adminSystemInstruction = buildAdminSystemInstruction();

    const name = state.id?.name;
    if (name?.startsWith('session:')) {
      this.sessionId = name.slice(8);
    }
  }

  // =============================================================
  // Initialization
  // =============================================================

  private async init(): Promise<void> {
    if (this.initialized) return;

    console.log('[OrionAgent] Initializing...');

    if (this.env.DB) {
      this.d1 = new D1Manager(this.env.DB);
    }

    if (this.sessionId && this.env.VECTORIZE) {
      this.memory = new MemoryManager(
        this.env.VECTORIZE,
        this.gemini,
        this.sessionId,
        {}
      );
    }

    if (this.sessionId && this.d1 && this.storage.getMessages().length === 0) {
      await this.hydrateFromD1();
    }

    this.initialized = true;
    console.log('[OrionAgent] Ready');
  }

  private async hydrateFromD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;

    try {
      const messages = await this.d1.loadMessages(this.sessionId, 100);
      for (const msg of messages) {
        await this.storage.saveMessage(msg.role as any, msg.parts || [], msg.timestamp);
      }
      console.log(`[OrionAgent] Hydrated ${messages.length} messages`);
    } catch (e) {
      console.warn('[OrionAgent] Hydration failed:', e);
    }
  }

  // =============================================================
  // HTTP Handler
  // =============================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!this.sessionId) {
      this.sessionId = request.headers.get('X-Session-ID') || 
                       url.searchParams.get('session_id') || 
                       undefined;
    }

    // Handle WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    await this.init();

    try {
      switch (path) {
        case '/api/chat':
          if (request.method === 'POST') {
            return await this.handleChatRequest(request);
          }
          break;

        case '/api/history':
          if (request.method === 'GET') {
            return this.jsonResponse({ messages: this.storage.getMessages() });
          }
          break;

        case '/api/artifacts':
          if (request.method === 'GET') {
            return this.jsonResponse({ artifacts: this.storage.getArtifacts() });
          }
          break;

        case '/api/clear':
          if (request.method === 'POST') {
            await this.storage.clearAll();
            if (this.memory) await this.memory.clearSessionMemory();
            return this.jsonResponse({ ok: true });
          }
          break;

        case '/api/status':
          if (request.method === 'GET') {
            return this.jsonResponse(await this.getStatus());
          }
          break;

        case '/api/upload':
          if (request.method === 'POST') {
            return await this.handleFileUpload(request);
          }
          break;

        case '/api/files':
          if (request.method === 'GET') {
            return await this.handleListFiles();
          }
          break;
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('[OrionAgent] Request error:', err);
      return this.jsonResponse({ error: err.message }, 500);
    }
  }

  // =============================================================
  // Admin Loop
  // =============================================================

  private async handleChatRequest(request: Request): Promise<Response> {
    const body = await request.json() as { 
      message: string; 
      images?: Array<{ data: string; mimeType: string }>;
    };
    
    const message = body.message?.trim();
    if (!message) {
      return this.jsonResponse({ error: 'Missing message' }, 400);
    }

    const result = await this.executeAdminLoop(message, body.images);
    return this.jsonResponse(result);
  }

  async executeAdminLoop(
    userMessage: string,
    images?: Array<{ data: string; mimeType: string }>,
    callbacks?: {
      onThought?: (thought: string) => void;
      onChunk?: (chunk: string) => void;
      onStatus?: (msg: string) => void;
      onToolUse?: (tool: string, params: any) => void;
      onArtifact?: (artifact: Artifact) => void;
    }
  ): Promise<{ response: string; artifacts: Artifact[] }> {
    const startTime = Date.now();
    this.metrics.totalRequests++;

    callbacks?.onStatus?.('🧠 Analyzing your request...');

    // Save user message
    await this.saveMessage('user', userMessage);

    // Get files info
    const files = await this.gemini.listFiles();
    
    // Build user prompt with context
    const userPrompt = buildAdminUserPrompt(userMessage, {
      hasFiles: files.length > 0,
      hasImages: !!images,
      fileCount: files.length,
      conversationLength: this.storage.getMessages().length,
      memoryAvailable: !!this.memory,
    });

    const artifacts: Artifact[] = [];
    let turn = 0;
    const maxTurns = 10;

    // Build conversation history (FIXED: proper format)
    const conversationHistory: Array<{ role: string; content: string }> = [];
    
    // Add system instruction as first message
    conversationHistory.push({
      role: 'system',
      content: this.adminSystemInstruction
    });

    // Add recent conversation context
    const recentMessages = this.storage.getMessages().slice(-10);
    for (const msg of recentMessages) {
      conversationHistory.push({
        role: msg.role === 'model' ? 'assistant' : 'user',
        content: this.extractMessageContent(msg)
      });
    }

    while (turn < maxTurns) {
      turn++;
      this.metrics.adminTurns++;

      callbacks?.onStatus?.(`Processing (turn ${turn}/${maxTurns})...`);

      // Add current user message on first turn
      if (turn === 1) {
        conversationHistory.push({
          role: 'user',
          content: userPrompt
        });
      } else {
        conversationHistory.push({
          role: 'user',
          content: 'Continue with your task.'
        });
      }

      // Call Gemini with native tools
      const response = await this.gemini.generateWithNativeTools(
        conversationHistory,
        {
          stream: false, // Simplified for debugging
          temperature: 1.0,
          thinkingConfig: {
            thinkingBudget: 8192,
            enableThinking: true,
          },
          useSearch: true,
          useMaps: true,
          useCodeExecution: true,
          useFileSearch: files.length > 0,
          images: turn === 1 ? images : undefined,
          files: files.length > 0 ? files : undefined,
          maxOutputTokens: 8192,
        }
      );

      // Track metrics
      if (response.usageMetadata) {
        this.metrics.thinkingTokensUsed += response.usageMetadata.totalTokens;
      }

      // Stream thinking
      if (response.thinking && callbacks?.onThought) {
        callbacks.onThought(response.thinking);
      }

      // Track native tool usage
      if (response.searchResults) {
        this.metrics.nativeToolCalls++;
        callbacks?.onToolUse?.('google_search', { 
          query: 'automatic', 
          results: response.searchResults.length 
        });
      }

      if (response.codeExecutionResults) {
        this.metrics.nativeToolCalls++;
        callbacks?.onToolUse?.('code_execution', { 
          executed: response.codeExecutionResults.length 
        });
      }

      // Parse response
      const parsed = this.parseAdminResponse(response.text, response);

      // Add assistant response to history
      conversationHistory.push({
        role: 'assistant',
        content: response.text
      });

      // Handle actions
      switch (parsed.action) {
        case 'respond':
          // Direct response - complete
          const fullResponse = parsed.content;
          await this.saveMessage('model', fullResponse);
          
          // Save to memory
          if (this.memory) {
            this.saveToMemory(userMessage, fullResponse).catch(console.warn);
          }
          
          // Background D1 sync
          this.syncToD1().catch(console.warn);
          
          console.log(`[OrionAgent] Completed in ${Date.now() - startTime}ms, ${turn} turns`);
          return { response: fullResponse, artifacts };

        case 'memory_search':
          callbacks?.onStatus?.('💾 Searching conversation memory...');
          const memoryResults = await this.performMemorySearch(parsed.memoryQuery!);
          
          conversationHistory.push({
            role: 'user',
            content: `<memory_results>\n${memoryResults}\n</memory_results>`,
          });
          break;

        case 'delegate':
          if (!parsed.delegation) {
            conversationHistory.push({
              role: 'user',
              content: '<error>Invalid delegation format. Please correct and try again.</error>',
            });
            break;
          }

          callbacks?.onStatus?.(`👤 Delegating to ${parsed.delegation.workerType}...`);
          this.metrics.delegations++;
          
          const workerResult = await this.executeWorkerLoop(
            parsed.delegation,
            callbacks
          );

          // Handle worker result
          if (workerResult.success && workerResult.artifactId) {
            const artifact = this.storage.getArtifacts().find(
              a => a.id === workerResult.artifactId
            );
            if (artifact) {
              artifacts.push(artifact);
              callbacks?.onArtifact?.(artifact);
            }
          }

          const workerSummary = workerResult.success
            ? `<worker_result status="success">
Worker: ${parsed.delegation.workerType}
Summary: ${workerResult.summary}
Artifact ID: ${workerResult.artifactId}
</worker_result>`
            : `<worker_result status="failed">
Worker: ${parsed.delegation.workerType}
Error: ${workerResult.error}
</worker_result>`;

          conversationHistory.push({
            role: 'user',
            content: workerSummary,
          });
          break;
      }
    }

    // Max turns reached
    const timeoutResponse = 'I reached my processing limit. Let me provide what I have so far.';
    await this.saveMessage('model', timeoutResponse);
    
    return { response: timeoutResponse, artifacts };
  }

  // =============================================================
  // Worker Loop
  // =============================================================

  private async executeWorkerLoop(
    envelope: TaskEnvelope,
    callbacks?: {
      onStatus?: (msg: string) => void;
      onWorkerProgress?: (event: WSOutgoingMessage) => void;
    }
  ): Promise<{
    success: boolean;
    summary: string;
    artifactId?: string;
    error?: string;
    toolsUsed: string[];
    turnsUsed: number;
  }> {
    const config = workerRegistry.get(envelope.workerType);
    if (!config) {
      return {
        success: false,
        summary: '',
        error: `Unknown worker type: ${envelope.workerType}`,
        toolsUsed: [],
        turnsUsed: 0,
      };
    }

    callbacks?.onStatus?.(`Starting ${config.name}...`);

    const systemInstruction = buildWorkerSystemInstruction(envelope.workerType, {
      name: config.name,
      description: config.description,
      capabilities: config.capabilities,
      outputFormat: envelope.expectedOutput.format,
    });

    const taskPrompt = buildWorkerTaskPrompt({
      objective: envelope.objective,
      context: envelope.context,
      instructions: envelope.instructions,
      constraints: envelope.constraints,
      format: envelope.expectedOutput.format,
      qualityCriteria: envelope.qualityCriteria,
    });

    const toolsUsed: string[] = [];
    let turn = 0;
    const maxTurns = config.maxTurns || 8;

    const workerHistory: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: taskPrompt }
    ];

    while (turn < maxTurns) {
      turn++;
      this.metrics.workerTurns++;

      callbacks?.onWorkerProgress?.({
        type: 'worker_progress',
        message: `Processing (turn ${turn}/${maxTurns})`,
        worker: envelope.workerType,
        taskId: envelope.taskId,
        progress: Math.round((turn / maxTurns) * 100),
      });

      const response = await this.gemini.generateWithNativeTools(
        workerHistory,
        {
          stream: false,
          temperature: config.temperature || 0.7,
          useSearch: config.tools.some(t => t.name === 'web_search' && t.enabled),
          useCodeExecution: config.tools.some(t => t.name === 'code_execution' && t.enabled),
          thinkingConfig: {
            thinkingBudget: 4096,
            enableThinking: true,
          },
          maxOutputTokens: 8192,
        }
      );

      if (response.searchResults) toolsUsed.push('web_search');
      if (response.codeExecutionResults) toolsUsed.push('code_execution');

      const parsed = this.parseWorkerResponse(response.text);

      workerHistory.push({
        role: 'assistant',
        content: response.text
      });

      if (parsed.complete && parsed.output) {
        const artifact = await this.createArtifact(
          envelope,
          parsed.output,
          envelope.workerType
        );

        await this.storage.saveArtifact(artifact);

        callbacks?.onWorkerProgress?.({
          type: 'worker_completed',
          message: `${config.name} completed successfully`,
          worker: envelope.workerType,
          taskId: envelope.taskId,
        });

        return {
          success: true,
          summary: parsed.summary || envelope.objective,
          artifactId: artifact.id,
          toolsUsed: [...new Set(toolsUsed)],
          turnsUsed: turn,
        };
      }

      workerHistory.push({
        role: 'user',
        content: '<instruction>Continue working on the task. Output your final deliverable when ready.</instruction>'
      });
    }

    return {
      success: false,
      summary: 'Task incomplete',
      error: 'Worker exceeded maximum turns',
      toolsUsed: [...new Set(toolsUsed)],
      turnsUsed: turn,
    };
  }

  // =============================================================
  // Response Parsing
  // =============================================================

  private parseAdminResponse(
    text: string,
    geminiResponse: any
  ): ParsedAdminResponse {
    const memoryMatch = text.match(/\[MEMORY_SEARCH:\s*([^\]]+)\]/i);
    if (memoryMatch) {
      return {
        action: 'memory_search',
        content: text,
        memoryQuery: memoryMatch[1].trim(),
      };
    }

    const delegateMatch = text.match(/<delegate>([\s\S]*?)<\/delegate>/);
    if (delegateMatch) {
      const delegation = this.parseDelegationXML(delegateMatch[1]);
      if (delegation) {
        return {
          action: 'delegate',
          content: text.replace(/<delegate>[\s\S]*?<\/delegate>/, '').trim(),
          delegation,
        };
      }
    }

    return {
      action: 'respond',
      content: text.trim(),
    };
  }

  private parseDelegationXML(xmlContent: string): TaskEnvelope | null {
    try {
      const extract = (tag: string): string => {
        const match = xmlContent.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
        return match ? match[1].trim() : '';
      };

      const workerType = extract('worker') as any;
      const objective = extract('objective');

      if (!workerType || !objective) {
        return null;
      }

      return {
        taskId: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        workerType,
        objective,
        context: extract('context'),
        instructions: extract('instructions'),
        constraints: extract('constraints').split('\n').filter(Boolean),
        expectedOutput: { format: (extract('format') as any) || 'markdown' },
        qualityCriteria: extract('quality').split('\n').filter(Boolean),
      };
    } catch (e) {
      console.error('[OrionAgent] Delegation parsing error:', e);
      return null;
    }
  }

  private parseWorkerResponse(text: string): ParsedWorkerResponse {
    const outputMatch = text.match(/OUTPUT:\s*\n([\s\S]*?)(?:\n\nSUMMARY:|$)/i);
    if (outputMatch) {
      const output = outputMatch[1].trim();
      const summaryMatch = text.match(/SUMMARY:\s*([^\n]+)/i);
      const summary = summaryMatch ? summaryMatch[1].trim() : undefined;
      
      return {
        output,
        summary,
        complete: true,
      };
    }

    return { complete: false };
  }

  // =============================================================
  // Helper Methods
  // =============================================================

  private extractMessageContent(msg: Message): string {
    if (msg.content) return msg.content;
    if (msg.parts) {
      return msg.parts.map(p => p.text || '').filter(Boolean).join('\n');
    }
    return '';
  }

  private async saveMessage(role: 'user' | 'model', content: string): Promise<void> {
    await this.storage.saveMessage(role, [{ text: content }], Date.now());
  }

  private async performMemorySearch(query: string): Promise<string> {
    if (!this.memory) {
      return '<memory_error>Memory search not available</memory_error>';
    }
    
    try {
      const results = await this.memory.searchMemory(query, { topK: 5 });
      if (results.length === 0) {
        return '<memory_result>No relevant past conversations found</memory_result>';
      }
      
      return results
        .map((r, i) => `<memory_item index="${i + 1}" relevance="${Math.round(r.score * 100)}%">\n${r.content}\n</memory_item>`)
        .join('\n\n');
    } catch (e) {
      return `<memory_error>${e instanceof Error ? e.message : 'Memory search failed'}</memory_error>`;
    }
  }

  private async saveToMemory(userMsg: string, assistantMsg: string): Promise<void> {
    if (!this.memory) return;
    
    await this.memory.saveMemoryBatch([
      {
        content: `User: ${userMsg}`,
        type: 'conversation',
        importance: 0.5,
        timestamp: Date.now(),
      },
      {
        content: `Assistant: ${assistantMsg.substring(0, 500)}`,
        type: 'conversation',
        importance: 0.5,
        timestamp: Date.now(),
      },
    ]);
  }

  private async createArtifact(
    envelope: TaskEnvelope,
    content: string,
    workerType: string
  ): Promise<Artifact> {
    const typeMap: Record<string, Artifact['type']> = {
      deep_search: 'research',
      data_analyst: 'analysis',
      content_writer: 'content',
      code_developer: 'code',
      report_generator: 'report',
    };

    return {
      id: `artifact_${envelope.taskId}_${Date.now()}`,
      type: typeMap[workerType] || 'content',
      title: envelope.objective.substring(0, 100),
      content,
      workerType,
      createdAt: Date.now(),
      metadata: {
        taskId: envelope.taskId,
        format: envelope.expectedOutput.format,
      },
    };
  }

  private async syncToD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;

    try {
      const messages = this.storage.getMessages();
      if (messages.length === 0) return;

      const latestInD1 = await this.d1.getLatestMessageTimestamp(this.sessionId);
      const newMessages = messages.filter(m => (m.timestamp || 0) > latestInD1);

      if (newMessages.length > 0) {
        await this.d1.saveMessages(this.sessionId, newMessages);
      }

      const artifacts = this.storage.getArtifacts();
      for (const artifact of artifacts) {
        await this.d1.saveArtifact(this.sessionId, artifact);
      }
    } catch (err) {
      console.error('[OrionAgent] D1 sync failed:', err);
    }
  }

  // =============================================================
  // File Management
  // =============================================================

  private async handleFileUpload(request: Request): Promise<Response> {
    try {
      const formData = await request.formData();
      const file = formData.get('file') as File;
      
      if (!file) {
        return this.jsonResponse({ error: 'No file provided' }, 400);
      }

      const buffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(buffer);
      const base64 = this.arrayBufferToBase64(uint8Array);

      const metadata = await this.gemini.uploadFile(
        base64,
        file.type,
        file.name
      );

      return this.jsonResponse({ success: true, file: metadata });
    } catch (err: any) {
      return this.jsonResponse({ error: err.message }, 500);
    }
  }

  private async handleListFiles(): Promise<Response> {
    const files = await this.gemini.listFiles();
    return this.jsonResponse({ files });
  }

  // Helper to convert ArrayBuffer to base64 (Cloudflare Workers compatible)
  private arrayBufferToBase64(buffer: Uint8Array): string {
    let binary = '';
    const len = buffer.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(buffer[i]);
    }
    return btoa(binary);
  }

  // =============================================================
  // WebSocket (FIXED)
  // =============================================================

  private handleWebSocketUpgrade(request: Request): Response {
    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection
    this.state.acceptWebSocket(server);
    this.activeSockets.add(server);

    // Set up event handlers
    server.addEventListener('message', async (event: MessageEvent) => {
      await this.handleWebSocketMessage(server, event.data);
    });

    server.addEventListener('close', () => {
      this.activeSockets.delete(server);
    });

    server.addEventListener('error', () => {
      this.activeSockets.delete(server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleWebSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string') return;

    try {
      const msg = JSON.parse(data);
      
      if (msg.type === 'user_message' && msg.content) {
        // Execute admin loop with callbacks
        const result = await this.executeAdminLoop(
          msg.content,
          msg.images,
          {
            onThought: (thought) => {
              this.sendWebSocketMessage(ws, {
                type: 'thinking',
                message: thought
              });
            },
            onStatus: (status) => {
              this.sendWebSocketMessage(ws, {
                type: 'status',
                message: status
              });
            },
            onChunk: (chunk) => {
              this.sendWebSocketMessage(ws, {
                type: 'chunk',
                content: chunk
              });
            },
            onArtifact: (artifact) => {
              this.sendWebSocketMessage(ws, {
                type: 'artifact',
                artifact
              });
            },
            onWorkerProgress: (event) => {
              this.sendWebSocketMessage(ws, event);
            }
          }
        );

        // Send complete response
        this.sendWebSocketMessage(ws, {
          type: 'complete',
          content: result.response,
          artifacts: result.artifacts
        });
      }
    } catch (e) {
      console.error('[OrionAgent] WS error:', e);
      this.sendWebSocketMessage(ws, {
        type: 'error',
        message: e instanceof Error ? e.message : 'Unknown error'
      });
    }
  }

  private sendWebSocketMessage(ws: WebSocket, message: any): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    } catch (e) {
      console.error('[OrionAgent] Failed to send WS message:', e);
    }
  }

  // =============================================================
  // Status
  // =============================================================

  private async getStatus(): Promise<object> {
    return {
      sessionId: this.sessionId,
      ...this.storage.getStatus(),
      protocol: 'Optimized Gemini 2.5',
      metrics: this.metrics,
      nativeTools: {
        googleSearch: true,
        googleMaps: true,
        codeExecution: true,
        thinking: true,
      },
      memory: this.memory ? this.memory.getMetrics() : null,
    };
  }

  private jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

export default OrionAgent;
