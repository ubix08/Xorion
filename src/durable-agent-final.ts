// src/durable-agent-final.ts
// FULLY SIMPLIFIED: Clean architecture with single source of truth

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env, Message } from './types';
import { GeminiClient } from './gemini';
import { AdminAgent } from './admin/admin-agent';
import { UnifiedStorage } from './storage/d1-storage';
import { SimplifiedMemoryManager } from './memory/memory-simplified';
import { SimpleInit } from './core/initialization-simplified';

// =============================================================
// WebSocket Message Types
// =============================================================

interface WebSocketMessage {
  type: 'user_message' | 'get_status' | 'clear_artifacts';
  content?: string;
}

interface WebSocketResponse {
  type: 'chunk' | 'status' | 'complete' | 'error' | 'worker_progress';
  content?: string;
  message?: string;
  error?: string;
  worker?: string;
  [key: string]: any;
}

// =============================================================
// Simplified Autonomous Agent
// =============================================================

export class AutonomousAgent extends DurableObject {
  // Core components
  private gemini: GeminiClient;
  private adminAgent: AdminAgent;
  private storage!: UnifiedStorage;
  private memory?: SimplifiedMemoryManager;
  
  // Initialization
  private init = new SimpleInit();
  
  // Session state
  private env: Env;
  private sessionId: string;
  private activeSockets = new Set<WebSocket>();
  
  // Metrics
  private metrics = {
    totalRequests: 0,
    avgResponseTime: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.env = env;
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
    this.adminAgent = new AdminAgent(this.gemini, {
      thinkingBudget: 2048,
      temperature: 0.7,
      maxConversationTurns: 15,
    });

    // Extract session ID from DO name
    const name = state.id?.name;
    this.sessionId = name?.startsWith('session:') 
      ? name.slice(8) 
      : `session_${Date.now()}`;
  }

  // =============================================================
  // Initialization (Simple & Robust)
  // =============================================================

  private async ensureInitialized(): Promise<void> {
    await this.init.ensureInitialized(async () => {
      console.log('[Agent] Initializing...');

      // 1. Initialize storage (primary source of truth)
      this.storage = new UnifiedStorage(this.state, this.sessionId, {
        d1: this.env.DB,
        vectorize: this.env.VECTORIZE,
        config: {
          maxMessages: 200,
          replicationDelay: 2000,
        },
      });

      // 2. Hydrate from D1 on cold start
      await this.storage.hydrateFromD1();

      // 3. Initialize memory (if available)
      if (this.env.VECTORIZE) {
        this.memory = new SimplifiedMemoryManager(
          this.env.VECTORIZE,
          this.gemini,
          this.sessionId
        );
        console.log('[Agent] Memory system initialized');
      }

      console.log('[Agent] Initialization complete');
    });
  }

  // =============================================================
  // HTTP Fetch Handler
  // =============================================================

  async fetch(request: Request): Promise<Response> {
    await this.ensureInitialized();

    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade
    if (
      path === '/api/ws' &&
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    ) {
      return this.handleWebSocketUpgrade(request);
    }

    // Route to handlers
    try {
      switch (path) {
        case '/api/chat':
          if (request.method === 'POST') {
            return await this.handleChat(request);
          }
          break;

        case '/api/history':
          if (request.method === 'GET') {
            return await this.handleHistory();
          }
          break;

        case '/api/clear':
          if (request.method === 'POST') {
            return await this.handleClear();
          }
          break;

        case '/api/status':
          if (request.method === 'GET') {
            return await this.handleStatus();
          }
          break;

        case '/api/sync':
          if (request.method === 'POST') {
            return await this.handleSync();
          }
          break;

        case '/api/memory/search':
          if (request.method === 'POST') {
            return await this.handleMemorySearch(request);
          }
          break;
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('[Agent] Request error:', err);
      return this.jsonResponse({ error: err.message }, 500);
    }
  }

  // =============================================================
  // HTTP Handlers
  // =============================================================

  private async handleChat(request: Request): Promise<Response> {
    const body = (await request.json()) as { message: string };
    const userMessage = body.message?.trim();

    if (!userMessage) {
      return this.jsonResponse({ error: 'Missing message' }, 400);
    }

    const response = await this.processMessage(userMessage);
    return this.jsonResponse({ response });
  }

  private async handleHistory(): Promise<Response> {
    const messages = await this.storage.getMessages();
    return this.jsonResponse({ messages });
  }

  private async handleClear(): Promise<Response> {
    await this.storage.clearAll();
    this.adminAgent.clearArtifacts();
    this.adminAgent.resetTurnCount();

    if (this.memory) {
      await this.memory.clearSessionMemory();
    }

    return this.jsonResponse({ ok: true });
  }

  private async handleStatus(): Promise<Response> {
    const storageStatus = await this.storage.getStatus();
    const adminMetrics = this.adminAgent.getMetrics();

    return this.jsonResponse({
      ...storageStatus,
      adminMetrics,
      memoryAvailable: !!this.memory,
      metrics: this.metrics,
    });
  }

  private async handleSync(): Promise<Response> {
    await this.storage.flush();
    return this.jsonResponse({ ok: true });
  }

  private async handleMemorySearch(request: Request): Promise<Response> {
    if (!this.memory) {
      return this.jsonResponse({ error: 'Memory not available' }, 400);
    }

    const body = (await request.json()) as { query: string; topK?: number };
    const results = await this.memory.searchMemory(body.query, {
      topK: body.topK || 5,
    });

    return this.jsonResponse({ results });
  }

  // =============================================================
  // WebSocket Handler
  // =============================================================

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Array.from(pair) as [WebSocket, WebSocket];

    (server as any).accept?.();

    server.onmessage = (evt) => {
      void this.handleWebSocketMessage(server, evt.data).catch((err) => {
        console.error('[Agent] WS error:', err);
        this.sendToSocket(server, { type: 'error', error: String(err) });
      });
    };

    server.onclose = () => {
      this.activeSockets.delete(server);
    };

    server.onerror = (evt) => {
      console.error('[Agent] WS error:', evt);
      this.activeSockets.delete(server);
    };

    this.activeSockets.add(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleWebSocketMessage(
    ws: WebSocket,
    data: string | ArrayBuffer
  ): Promise<void> {
    if (typeof data !== 'string' || ws.readyState !== WebSocket.OPEN) return;

    let message: WebSocketMessage;
    try {
      message = JSON.parse(data);
    } catch {
      this.sendToSocket(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }

    switch (message.type) {
      case 'user_message':
        if (!message.content) {
          this.sendToSocket(ws, { type: 'error', error: 'Missing content' });
          return;
        }
        await this.processWebSocketMessage(message.content, ws);
        break;

      case 'get_status':
        const status = await this.storage.getStatus();
        this.sendToSocket(ws, { type: 'status', ...status });
        break;

      case 'clear_artifacts':
        this.adminAgent.clearArtifacts();
        this.sendToSocket(ws, { type: 'status', message: 'Artifacts cleared' });
        break;

      default:
        this.sendToSocket(ws, { type: 'error', error: 'Unknown message type' });
    }
  }

  private async processWebSocketMessage(
    userMessage: string,
    ws: WebSocket
  ): Promise<void> {
    const startTime = Date.now();
    this.metrics.totalRequests++;

    try {
      const response = await this.processMessage(userMessage, {
        onChunk: (chunk) => this.sendToSocket(ws, { type: 'chunk', content: chunk }),
        onStatus: (status) => this.sendToSocket(ws, { type: 'status', message: status }),
        onWorkerProgress: (worker, msg) =>
          this.sendToSocket(ws, { type: 'worker_progress', worker, message: msg }),
      });

      this.sendToSocket(ws, { type: 'complete', response });

      // Update metrics
      const responseTime = Date.now() - startTime;
      this.metrics.avgResponseTime =
        (this.metrics.avgResponseTime * (this.metrics.totalRequests - 1) + responseTime) /
        this.metrics.totalRequests;
    } catch (error) {
      console.error('[Agent] Processing error:', error);
      this.sendToSocket(ws, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // =============================================================
  // Core Message Processing
  // =============================================================

  private async processMessage(
    userMessage: string,
    callbacks?: {
      onChunk?: (chunk: string) => void;
      onStatus?: (message: string) => void;
      onWorkerProgress?: (worker: string, message: string) => void;
    }
  ): Promise<string> {
    // 1. Save user message
    await this.storage.saveMessage({
      role: 'user',
      parts: [{ text: userMessage }],
      timestamp: Date.now(),
    });

    // 2. Get conversation history
    const history = await this.storage.getMessages();

    // 3. Build memory context
    const memoryContext = this.memory
      ? await this.memory.buildContext(userMessage)
      : '';

    // 4. Get agent state
    const state = await this.storage.loadState();

    // 5. Process via Admin Agent
    const response = await this.adminAgent.processUserMessage(
      userMessage,
      history,
      memoryContext,
      state,
      callbacks || {}
    );

    // 6. Save model response
    await this.storage.saveMessage({
      role: 'model',
      parts: [{ text: response }],
      timestamp: Date.now(),
    });

    // 7. Save memory (async, best effort)
    if (this.memory) {
      this.memory.saveMemory(userMessage, {
        type: 'user_query',
        response: response.substring(0, 500),
      }).catch(err => {
        console.error('[Agent] Memory save failed:', err);
      });
    }

    return response;
  }

  // =============================================================
  // Alarm Handler (for replication)
  // =============================================================

  async alarm(): Promise<void> {
    console.log('[Agent] Alarm triggered - executing replication');
    
    try {
      await this.storage.executeReplication();
    } catch (err) {
      console.error('[Agent] Replication failed:', err);
    }

    // Schedule next alarm (1 hour from now)
    const nextAlarm = Date.now() + 3600000;
    await this.state.storage.setAlarm(nextAlarm);
  }

  // =============================================================
  // Utility Methods
  // =============================================================

  private sendToSocket(ws: WebSocket, message: WebSocketResponse): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      console.error('[Agent] Send error:', e);
    }
  }

  private jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // =============================================================
  // RPC Methods (for Worker → DO calls)
  // =============================================================

  public async handleChatRPC(message: string): Promise<{ response: string }> {
    await this.ensureInitialized();
    const response = await this.processMessage(message);
    return { response };
  }

  public async getHistoryRPC(): Promise<{ messages: Message[] }> {
    await this.ensureInitialized();
    const messages = await this.storage.getMessages();
    return { messages };
  }

  public async clearHistoryRPC(): Promise<{ ok: boolean }> {
    await this.ensureInitialized();
    await this.storage.clearAll();
    this.adminAgent.clearArtifacts();
    this.adminAgent.resetTurnCount();
    if (this.memory) {
      await this.memory.clearSessionMemory();
    }
    return { ok: true };
  }

  public async getStatusRPC(): Promise<object> {
    await this.ensureInitialized();
    const storageStatus = await this.storage.getStatus();
    const adminMetrics = this.adminAgent.getMetrics();
    return {
      ...storageStatus,
      adminMetrics,
      memoryAvailable: !!this.memory,
      metrics: this.metrics,
    };
  }

  public async syncRPC(): Promise<{ ok: boolean }> {
    await this.ensureInitialized();
    await this.storage.flush();
    return { ok: true };
  }
}

export default AutonomousAgent;
