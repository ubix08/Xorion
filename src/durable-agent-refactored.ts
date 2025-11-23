// src/durable-agent-refactored.ts
// REFACTORED: Admin-Worker architecture with simplified orchestration

import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env, Message } from './types';
import { DurableStorage } from './durable-storage';
import { GeminiClient } from './gemini';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import { SessionManager } from './session/session-manager';
import { AdminAgent } from './admin/admin-agent';
import { initManager } from './core/initialization-manager';
import { StorageCoordinator } from './storage/storage-coordinator';

// =============================================================
// WebSocket Message Types
// =============================================================

interface WebSocketMessage {
  type: 'user_message' | 'get_status' | 'clear_artifacts';
  content?: string;
}

interface WebSocketResponse {
  type: 'chunk' | 'status' | 'complete' | 'error' | 'worker_progress' | 'artifacts';
  content?: string;
  message?: string;
  error?: string;
  worker?: string;
  artifacts?: any;
  [key: string]: any;
}

// =============================================================
// Refactored Autonomous Agent Durable Object
// =============================================================

export class AutonomousAgent extends DurableObject {
  // Core dependencies
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private env: Env;
  
  // NEW: Admin agent replaces orchestration system
  private adminAgent: AdminAgent;
  
  // Optional dependencies
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private sessionManager?: SessionManager;
  private storageCoordinator?: StorageCoordinator;
  
  // Session state
  private sessionId?: string;
  private activeSockets = new Set<WebSocket>();
  
  // Performance metrics
  private metrics = {
    totalRequests: 0,
    adminDelegations: 0,
    workerCalls: 0,
    avgResponseTime: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

    // Extract session ID from Durable Object name
    const name = state.id?.name;
    if (name && name.startsWith('session:')) {
      this.sessionId = name.slice(8);
    }

    // Initialize Admin Agent
    this.adminAgent = new AdminAgent(this.gemini, {
      thinkingBudget: 2048,
      temperature: 0.7,
      maxConversationTurns: 15,
    });
  }

  // =============================================================
  // Initialization (Simplified)
  // =============================================================

  private async init(): Promise<void> {
    await initManager.initialize('durable-agent', async () => {
      console.log('[DurableAgent] Starting initialization...');

      // 1. Initialize D1 if available
      if (this.env.DB) {
        this.d1 = new D1Manager(this.env.DB);
        this.sessionManager = new SessionManager(this.env.DB);
        console.log('[DurableAgent] D1 initialized');
      }

      // 2. Initialize Memory if available
      if (this.sessionId && this.env.VECTORIZE && !this.memory) {
        this.memory = new MemoryManager(
          this.env.VECTORIZE,
          this.gemini,
          this.sessionId,
          { longTermEnabled: true, ltmThreshold: 0.65 }
        );
        console.log('[DurableAgent] Memory system initialized');
      }

      // 3. Initialize Storage Coordinator
      this.storageCoordinator = new StorageCoordinator({
        batchSize: 10,
        flushInterval: 2000,
        enablePriorityWrite: false,
      });

      this.storageCoordinator.registerDurableStorage(this.storage);
      
      if (this.d1 && this.sessionId) {
        this.storageCoordinator.registerD1(this.d1, this.sessionId);
      }
      
      if (this.memory && this.sessionId) {
        this.storageCoordinator.registerMemory(this.memory, this.sessionId);
      }

      console.log('[DurableAgent] Storage coordinator initialized');

      // 4. Ensure session exists in D1
      if (this.sessionId && this.sessionManager && this.d1) {
        try {
          await this.sessionManager.getOrCreateSession(this.sessionId);
          
          // Hydrate from D1 if durable storage is empty
          if (this.storage.getMessages().length === 0) {
            await this.loadFromD1(this.sessionId);
          }
        } catch (e) {
          console.warn('[DurableAgent] D1 hydration skipped:', e);
        }
      }

      console.log('[DurableAgent] ✅ Initialization complete');
    });
  }

  // =============================================================
  // HTTP Fetch Handler
  // =============================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract session ID from query or header
    if (!this.sessionId) {
      const fromHeader = request.headers.get('X-Session-ID');
      const fromQuery = url.searchParams.get('session_id');
      if (fromHeader || fromQuery) {
        this.sessionId = fromHeader || fromQuery || undefined;
      }
    }

    // Handle WebSocket upgrade
    if (
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket' && 
      url.pathname === '/api/ws'
    ) {
      await this.init();
      return this.handleWebSocketUpgrade(request);
    }

    // Initialize for HTTP requests
    await this.init();
    const pathname = url.pathname;

    try {
      switch (pathname) {
        case '/api/chat':
          if (request.method === 'POST') {
            return await this.handleChatRequest(request);
          }
          break;

        case '/api/history':
          if (request.method === 'GET') {
            return await this.handleHistoryRequest();
          }
          break;

        case '/api/clear':
          if (request.method === 'POST') {
            return await this.handleClearRequest();
          }
          break;

        case '/api/status':
          if (request.method === 'GET') {
            return await this.handleStatusRequest();
          }
          break;

        case '/api/sync':
          if (request.method === 'POST') {
            return await this.handleSyncRequest();
          }
          break;

        case '/api/memory/search':
          if (request.method === 'POST') {
            return await this.handleMemorySearchRequest(request);
          }
          break;

        case '/api/memory/stats':
          if (request.method === 'GET') {
            return await this.handleMemoryStatsRequest();
          }
          break;

        case '/api/artifacts':
          if (request.method === 'GET') {
            return await this.handleArtifactsRequest();
          }
          break;
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('[DurableAgent] fetch error:', err);
      return this.jsonResponse({ error: err?.message || String(err) }, 500);
    }
  }

  // =============================================================
  // HTTP Request Handlers
  // =============================================================

  private async handleChatRequest(request: Request): Promise<Response> {
    const body = await request.json() as { message: string };
    const message = body.message?.trim();
    
    if (!message) {
      return this.jsonResponse({ error: 'Missing message' }, 400);
    }

    const result = await this.processMessage(message);
    return this.jsonResponse({ response: result });
  }

  private async handleHistoryRequest(): Promise<Response> {
    const messages = this.storage.getMessages();
    return this.jsonResponse({ messages });
  }

  private async handleClearRequest(): Promise<Response> {
    await this.storage.clearAll();
    
    if (this.memory) {
      await this.memory.clearSessionMemory();
    }

    this.adminAgent.clearArtifacts();
    this.adminAgent.resetTurnCount();
    
    return this.jsonResponse({ ok: true });
  }

  private async handleStatusRequest(): Promise<Response> {
    const storageStatus = this.storage.getStatus();
    const adminMetrics = this.adminAgent.getMetrics();

    const status = {
      ...storageStatus,
      d1Status: {
        enabled: !!this.d1,
        sessionId: this.sessionId || null,
      },
      memoryStatus: {
        enabled: !!this.memory,
        vectorizeAvailable: !!this.env.VECTORIZE,
      },
      adminMetrics,
      metrics: this.metrics,
      storageCoordinatorMetrics: this.storageCoordinator?.getMetrics(),
    };

    return this.jsonResponse(status);
  }

  private async handleSyncRequest(): Promise<Response> {
    if (this.storageCoordinator) {
      await this.storageCoordinator.flush();
    }
    return this.jsonResponse({ ok: true, sessionId: this.sessionId });
  }

  private async handleMemorySearchRequest(request: Request): Promise<Response> {
    if (!this.memory) {
      return this.jsonResponse({ error: 'Memory not available' }, 400);
    }

    const body = await request.json() as { query: string; topK?: number };
    const results = await this.memory.searchMemory(body.query, {
      topK: body.topK || 10,
    });

    return this.jsonResponse({ results });
  }

  private async handleMemoryStatsRequest(): Promise<Response> {
    if (!this.memory) {
      return this.jsonResponse({ error: 'Memory not available' }, 400);
    }

    const stats = await this.memory.getMemoryStats();
    return this.jsonResponse(stats);
  }

  private async handleArtifactsRequest(): Promise<Response> {
    const artifacts = Array.from(this.adminAgent.getArtifacts().values());
    return this.jsonResponse({ artifacts });
  }

  // =============================================================
  // WebSocket Handling
  // =============================================================

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Array.from(pair) as [WebSocket, WebSocket];

    try {
      (server as any).accept?.();
    } catch (e) {
      console.error('[DurableAgent] WebSocket accept error', e);
      return new Response(null, { status: 101, webSocket: client });
    }

    server.onmessage = (evt) => {
      void this.handleWebSocketMessage(server, evt.data).catch((err) => {
        console.error('[DurableAgent] WS message error:', err);
        this.sendToSocket(server, { type: 'error', error: String(err) });
      });
    };

    server.onclose = () => {
      this.activeSockets.delete(server);
      console.log('[DurableAgent] WebSocket closed');
    };

    server.onerror = (evt) => {
      console.error('[DurableAgent] WebSocket error:', evt);
      this.activeSockets.delete(server);
    };

    this.activeSockets.add(server);

    // Send initial greeting
    this.sendToSocket(server, {
      type: 'status',
      message: 'Connected to Orion Admin Agent',
    });

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
        const adminMetrics = this.adminAgent.getMetrics();
        this.sendToSocket(ws, { type: 'status', metrics: adminMetrics });
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
      // Save user message
      await this.saveUserMessage(userMessage);

      // Get conversation history and memory context
      const history = this.storage.getMessages();
      const memoryContext = await this.buildMemoryContext(userMessage);

      // Get current agent state
      const state = await this.storage.loadState();

      // Execute via Admin Agent
      const response = await this.adminAgent.processUserMessage(
        userMessage,
        history,
        memoryContext,
        state,
        {
          onChunk: (chunk) => this.sendToSocket(ws, { type: 'chunk', content: chunk }),
          onStatus: (status) => this.sendToSocket(ws, { type: 'status', message: status }),
          onWorkerProgress: (worker, msg) => 
            this.sendToSocket(ws, { type: 'worker_progress', worker, message: msg }),
        }
      );

      // Save model response
      await this.saveModelMessage(response);

      // Send completion
      this.sendToSocket(ws, { type: 'complete', response });

      // Update metrics
      const responseTime = Date.now() - startTime;
      this.metrics.avgResponseTime =
        (this.metrics.avgResponseTime * (this.metrics.totalRequests - 1) + responseTime) /
        this.metrics.totalRequests;

      // Create LTM if needed
      await this.maybeCreateLTM(history, userMessage, response);
    } catch (error) {
      console.error('[DurableAgent] Message processing error:', error);
      this.sendToSocket(ws, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // =============================================================
  // Message Processing (Simplified)
  // =============================================================

  private async processMessage(userMessage: string): Promise<string> {
    await this.saveUserMessage(userMessage);

    const history = this.storage.getMessages();
    const memoryContext = await this.buildMemoryContext(userMessage);
    const state = await this.storage.loadState();

    const response = await this.adminAgent.processUserMessage(
      userMessage,
      history,
      memoryContext,
      state
    );

    await this.saveModelMessage(response);
    await this.maybeCreateLTM(history, userMessage, response);

    return response;
  }

  // =============================================================
  // Message Persistence
  // =============================================================

  private async saveUserMessage(content: string): Promise<void> {
    const message: Message = {
      role: 'user',
      parts: [{ text: content }],
      timestamp: Date.now(),
    };

    if (this.storageCoordinator) {
      await this.storageCoordinator.saveMessage(message);
    } else {
      await this.storage.saveMessage('user', message.parts, message.timestamp);
    }
  }

  private async saveModelMessage(content: string): Promise<void> {
    const message: Message = {
      role: 'model',
      parts: [{ text: content }],
      timestamp: Date.now(),
    };

    if (this.storageCoordinator) {
      await this.storageCoordinator.saveMessage(message);
    } else {
      await this.storage.saveMessage('model', message.parts, message.timestamp);
    }
  }

  // =============================================================
  // Memory Helpers
  // =============================================================

  private async buildMemoryContext(query: string): Promise<string> {
    if (!this.memory) return '';

    try {
      const result = await this.memory.buildEnhancedContext(query, undefined, {
        includeSTM: true,
        includeLTM: true,
        maxSTMResults: 5,
        maxLTMResults: 3,
      });
      return result.context;
    } catch (error) {
      console.error('[DurableAgent] Memory context building failed:', error);
      return '';
    }
  }

  private async maybeCreateLTM(
    history: Message[],
    lastQuery: string,
    lastResponse: string
  ): Promise<void> {
    if (!this.memory || !this.sessionId) return;
    if (history.length === 0 || history.length % 15 !== 0) return;

    try {
      const messagesToSummarize = history.slice(-15).map((m) => ({
        role: m.role,
        content: m.parts?.map((p) => (typeof p === 'string' ? p : p.text)).join(' ') || '',
      }));

      const summary = await this.memory.summarizeConversation(messagesToSummarize);
      const topics = await this.memory.extractImportantTopics(summary);

      const userQueries = messagesToSummarize
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join(' | ');

      await this.memory.addLongTermMemory({
        id: `ltm_${this.sessionId}_${Date.now()}`,
        sessionId: this.sessionId,
        query: userQueries || lastQuery,
        summary,
        importance: this.calculateImportance(summary, topics),
        timestamp: Date.now(),
        interactions: 1,
        lastAccessed: Date.now(),
        answer: lastResponse,
        topics: topics.join(', '),
      } as any);

      console.log('[DurableAgent] Created LTM summary');
    } catch (error) {
      console.error('[DurableAgent] Failed to create LTM:', error);
    }
  }

  private calculateImportance(summary: string, topics: string[]): number {
    let score = 0.5;

    if (summary.length > 500) score += 0.2;
    else if (summary.length > 200) score += 0.1;

    score += Math.min(topics.length * 0.05, 0.2);

    const importantKeywords = [
      'error', 'bug', 'fix', 'solution', 'problem', 'deploy',
      'production', 'critical', 'important', 'api', 'database',
    ];

    const lowerSummary = summary.toLowerCase();
    const keywordMatches = importantKeywords.filter((kw) => lowerSummary.includes(kw)).length;
    score += Math.min(keywordMatches * 0.05, 0.15);

    return Math.min(Math.max(score, 0.5), 1.0);
  }

  // =============================================================
  // D1 Helpers
  // =============================================================

  private async loadFromD1(sessionId: string): Promise<void> {
    if (!this.d1) return;

    try {
      const messages = await this.d1.loadMessages(sessionId, 200);
      console.log(`[DurableAgent] Loaded ${messages.length} messages from D1`);

      for (const msg of messages) {
        await this.storage.saveMessage(msg.role as any, msg.parts, msg.timestamp);
      }

      await this.d1.updateSessionActivity(sessionId);
    } catch (err) {
      console.error('[DurableAgent] D1 load failed:', err);
    }
  }

  // =============================================================
  // WebSocket Broadcasting
  // =============================================================

  private broadcast(message: WebSocketResponse): void {
    const data = JSON.stringify(message);
    for (const socket of this.activeSockets) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(data);
        } catch (e) {
          console.error('[DurableAgent] Broadcast error:', e);
        }
      }
    }
  }

  private sendToSocket(ws: WebSocket, message: WebSocketResponse): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      console.error('[DurableAgent] Send error:', e);
    }
  }

  // =============================================================
  // Utility Methods
  // =============================================================

  private jsonResponse(data: any, status: number = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // =============================================================
  // RPC Methods (for Worker to DO calls)
  // =============================================================

  public async handleChat(message: string): Promise<{ response: string }> {
    await this.init();
    const response = await this.processMessage(message);
    return { response };
  }

  public async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.storage.getMessages() };
  }

  public async clearHistory(): Promise<{ ok: boolean }> {
    await this.init();
    await this.storage.clearAll();
    
    if (this.memory) {
      await this.memory.clearSessionMemory();
    }

    this.adminAgent.clearArtifacts();
    this.adminAgent.resetTurnCount();
    
    return { ok: true };
  }

  public async getStatus(): Promise<object> {
    await this.init();
    
    const storageStatus = this.storage.getStatus();
    const adminMetrics = this.adminAgent.getMetrics();

    return {
      ...storageStatus,
      d1Status: {
        enabled: !!this.d1,
        sessionId: this.sessionId || null,
      },
      memoryStatus: {
        enabled: !!this.memory,
        vectorizeAvailable: !!this.env.VECTORIZE,
      },
      adminMetrics,
      metrics: this.metrics,
      storageCoordinatorMetrics: this.storageCoordinator?.getMetrics(),
    };
  }

  public async syncToD1(): Promise<object> {
    await this.init();
    
    if (this.storageCoordinator) {
      await this.storageCoordinator.flush();
    }
    
    return { ok: true, sessionId: this.sessionId };
  }

  public async searchMemory(body: { query: string; topK?: number }): Promise<{ results: any[] }> {
    await this.init();

    if (!this.memory) {
      throw new Error('Memory system not available');
    }

    const results = await this.memory.searchMemory(body.query, {
      topK: body.topK || 10,
    });

    return { results };
  }

  public async getMemoryStats(): Promise<object> {
    await this.init();

    if (!this.memory) {
      throw new Error('Memory system not available');
    }

    return await this.memory.getMemoryStats();
  }

  // =============================================================
  // Lifecycle Methods
  // =============================================================

  async alarm(): Promise<void> {
    console.log('[DurableAgent] Alarm triggered - running maintenance');

    if (this.storageCoordinator) {
      await this.storageCoordinator.flush();
    }

    const nextAlarm = Date.now() + 3600000; // 1 hour
    await this.storage.setAlarm(nextAlarm);
  }
}

export default AutonomousAgent;
