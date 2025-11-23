// src/durable-agent.ts - Orion Durable Object (WebSocket Fix)

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { 
  Env, Message, Artifact, AgentState, ProjectState,
  WSIncomingMessage, WSOutgoingMessage
} from './types';
import { GeminiClient } from './gemini';
import { AdminAgent, type AdminCallbacks } from './admin/admin-agent';
import { DurableStorage } from './durable-storage';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import { globalToolRegistry, createMemorySearchTool } from './tools/tool-system';

// =============================================================
// Orion Durable Object (WEBSOCKET FIXED)
// =============================================================

export class OrionAgent extends DurableObject {
  // Core dependencies
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private admin: AdminAgent;
  private env: Env;

  // Optional dependencies
  private d1?: D1Manager;
  private memory?: MemoryManager;

  // Session state
  private sessionId?: string;
  private initialized = false;
  private activeSockets = new Set<WebSocket>();

  // Performance tracking
  private metrics = {
    totalRequests: 0,
    totalDelegations: 0,
    avgResponseTime: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
    this.admin = new AdminAgent(this.gemini);

    // Extract session ID from DO name
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

    console.log('[Orion] Initializing...');

    // Initialize D1
    if (this.env.DB) {
      this.d1 = new D1Manager(this.env.DB);
      console.log('[Orion] D1 initialized');
    }

    // Initialize Memory
    if (this.sessionId && this.env.VECTORIZE) {
      this.memory = new MemoryManager(
        this.env.VECTORIZE,
        this.gemini,
        this.sessionId,
        {}
      );

      globalToolRegistry.register(createMemorySearchTool(this.memory));
      console.log('[Orion] Memory system initialized');
    }

    // Hydrate from D1 if storage is empty
    if (this.sessionId && this.d1 && this.storage.getMessages().length === 0) {
      await this.hydrateFromD1();
    }

    this.initialized = true;
    console.log('[Orion] Initialization complete');
  }

  private async hydrateFromD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;

    try {
      const messages = await this.d1.loadMessages(this.sessionId, 100);
      for (const msg of messages) {
        await this.storage.saveMessage(msg.role as any, msg.parts || [], msg.timestamp);
      }
      console.log(`[Orion] Hydrated ${messages.length} messages from D1`);
    } catch (e) {
      console.warn('[Orion] D1 hydration failed:', e);
    }
  }

  // =============================================================
  // HTTP Request Handler (WEBSOCKET FIX)
  // =============================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Extract session ID
    if (!this.sessionId) {
      this.sessionId = request.headers.get('X-Session-ID') || 
                       url.searchParams.get('session_id') || 
                       undefined;
    }

    // ✅ FIX: Handle WebSocket BEFORE initialization
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      // Must handle WebSocket immediately, cannot await init first
      return this.handleWebSocketUpgrade(request);
    }

    // For HTTP requests, initialize normally
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

        case '/api/artifacts':
          if (request.method === 'GET') {
            return this.jsonResponse({ artifacts: this.storage.getArtifacts() });
          }
          break;

        case '/api/sync':
          if (request.method === 'POST') {
            await this.syncToD1();
            return this.jsonResponse({ ok: true });
          }
          break;
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      console.error('[Orion] Request error:', err);
      return this.jsonResponse({ error: err.message }, 500);
    }
  }

  // =============================================================
  // Chat Processing
  // =============================================================

  private async handleChatRequest(request: Request): Promise<Response> {
    const body = await request.json() as { message: string };
    const message = body.message?.trim();

    if (!message) {
      return this.jsonResponse({ error: 'Missing message' }, 400);
    }

    const result = await this.processMessage(message);
    return this.jsonResponse(result);
  }

  async processMessage(
    userMessage: string,
    callbacks?: AdminCallbacks
  ): Promise<{ response: string; artifacts: Artifact[] }> {
    const startTime = Date.now();
    this.metrics.totalRequests++;

    // Save user message
    await this.saveMessage('user', userMessage);

    // Build state
    const state = await this.buildAgentState();

    // Get conversation history
    const history = this.storage.getMessages();

    // Process with Admin agent
    const result = await this.admin.process(
      userMessage,
      history,
      state,
      callbacks || {}
    );

    // Save assistant response
    await this.saveMessage('model', result.response);

    // Save artifacts
    for (const artifact of result.artifacts) {
      await this.storage.saveArtifact(artifact);
    }

    // Sync to D1 in background
    this.syncToD1().catch(e => console.warn('[Orion] Background sync failed:', e));

    // Update metrics
    const responseTime = Date.now() - startTime;
    this.metrics.avgResponseTime = 
      (this.metrics.avgResponseTime * (this.metrics.totalRequests - 1) + responseTime) /
      this.metrics.totalRequests;

    return {
      response: result.response,
      artifacts: result.artifacts,
    };
  }

  // =============================================================
  // WebSocket Handling (COMPLETELY FIXED)
  // =============================================================

  private handleWebSocketUpgrade(request: Request): Response {
    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // ✅ CRITICAL: Accept the WebSocket on the server side
    // This must be done synchronously before returning
    this.ctx.acceptWebSocket(server);

    // Setup event handlers
    server.addEventListener('message', (event: MessageEvent) => {
      // Initialize on first message if needed
      if (!this.initialized) {
        this.init().then(() => {
          this.handleWebSocketMessage(server, event.data).catch(err => {
            console.error('[Orion] WS message error:', err);
            this.sendWS(server, { type: 'error', message: String(err) });
          });
        }).catch(err => {
          console.error('[Orion] Init error:', err);
          this.sendWS(server, { type: 'error', message: 'Initialization failed' });
        });
      } else {
        this.handleWebSocketMessage(server, event.data).catch(err => {
          console.error('[Orion] WS message error:', err);
          this.sendWS(server, { type: 'error', message: String(err) });
        });
      }
    });

    server.addEventListener('close', () => {
      this.activeSockets.delete(server);
      console.log('[Orion] WebSocket closed');
    });

    server.addEventListener('error', (event: Event) => {
      console.error('[Orion] WebSocket error:', event);
      this.activeSockets.delete(server);
    });

    this.activeSockets.add(server);

    // Send greeting after a short delay to ensure connection is ready
    setTimeout(() => {
      this.sendWS(server, {
        type: 'status',
        message: 'Connected to Orion',
      });
    }, 100);

    // ✅ FIX: Return Response with status 101 and webSocket
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleWebSocketMessage(
    ws: WebSocket,
    data: string | ArrayBuffer
  ): Promise<void> {
    if (typeof data !== 'string') return;

    let msg: WSIncomingMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      this.sendWS(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'user_message':
        if (!msg.content) {
          this.sendWS(ws, { type: 'error', message: 'Missing content' });
          return;
        }
        await this.processWebSocketMessage(ws, msg.content);
        break;

      case 'cancel':
        this.sendWS(ws, { type: 'status', message: 'Cancellation not yet implemented' });
        break;

      default:
        this.sendWS(ws, { type: 'error', message: `Unknown type: ${msg.type}` });
    }
  }

  private async processWebSocketMessage(
    ws: WebSocket,
    userMessage: string
  ): Promise<void> {
    // Create callbacks for streaming
    const callbacks: AdminCallbacks = {
      onChunk: (chunk) => {
        this.sendWS(ws, { type: 'chunk', content: chunk });
      },
      onStatus: (message) => {
        this.sendWS(ws, { type: 'status', message });
      },
      onWorkerProgress: (event) => {
        this.sendWS(ws, event);
      },
      onArtifact: (artifact) => {
        this.sendWS(ws, { type: 'artifact', artifact });
      },
    };

    try {
      const result = await this.processMessage(userMessage, callbacks);
      
      this.sendWS(ws, {
        type: 'complete',
        content: result.response,
      });
    } catch (error) {
      this.sendWS(ws, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // =============================================================
  // State Management
  // =============================================================

  private async buildAgentState(): Promise<AgentState> {
    const baseState = await this.storage.loadState();

    // Enhance with memory context
    if (this.memory) {
      try {
        const recentMessages = this.storage.getMessages().slice(-5);
        const query = recentMessages
          .filter(m => m.role === 'user')
          .map(m => m.parts?.[0]?.text || '')
          .join(' ');

        if (query) {
          const memoryResults = await this.memory.searchMemory(query, { topK: 5 });
          baseState.context.memoryContext = memoryResults
            .map(r => r.content)
            .join('\n\n');
        }
      } catch (e) {
        console.warn('[Orion] Memory search failed:', e);
      }
    }

    return baseState;
  }

  // =============================================================
  // Persistence
  // =============================================================

  private async saveMessage(role: 'user' | 'model', content: string): Promise<void> {
    const parts = [{ text: content }];
    const timestamp = Date.now();
    
    await this.storage.saveMessage(role, parts, timestamp);
  }

  private async syncToD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;

    try {
      // Sync messages
      const messages = this.storage.getMessages();
      if (messages.length === 0) return;

      const latestInD1 = await this.d1.getLatestMessageTimestamp(this.sessionId);
      const newMessages = messages.filter(m => (m.timestamp || 0) > latestInD1);

      if (newMessages.length > 0) {
        await this.d1.saveMessages(this.sessionId, newMessages);
        console.log(`[Orion] Synced ${newMessages.length} messages to D1`);
      }

      // Sync artifacts
      const artifacts = this.storage.getArtifacts();
      for (const artifact of artifacts) {
        await this.d1.saveArtifact(this.sessionId, artifact);
      }

    } catch (err) {
      console.error('[Orion] D1 sync failed:', err);
    }
  }

  // =============================================================
  // Status & Metrics
  // =============================================================

  private async getStatus(): Promise<object> {
    const storageStatus = this.storage.getStatus();
    const state = await this.storage.loadState();

    return {
      sessionId: this.sessionId,
      ...storageStatus,
      currentProject: state.currentProject ? {
        id: state.currentProject.id,
        objective: state.currentProject.objective,
        status: state.currentProject.status,
        artifactCount: state.currentProject.artifacts.length,
      } : null,
      memory: {
        enabled: !!this.memory,
        contextLoaded: !!state.context.memoryContext,
        metrics: this.memory?.getMetrics(),
      },
      tools: {
        registered: globalToolRegistry.getAll().map(t => t.name),
      },
      metrics: this.metrics,
    };
  }

  // =============================================================
  // Utilities
  // =============================================================

  private sendWS(ws: WebSocket, message: WSOutgoingMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      console.error('[Orion] WS send error:', e);
    }
  }

  private jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // =============================================================
  // RPC Methods (Worker → DO)
  // =============================================================

  async handleChat(message: string): Promise<{ response: string; artifacts: Artifact[] }> {
    await this.init();
    return this.processMessage(message);
  }

  async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.storage.getMessages() };
  }

  async clearHistory(): Promise<{ ok: boolean }> {
    await this.init();
    await this.storage.clearAll();
    if (this.memory) await this.memory.clearSessionMemory();
    return { ok: true };
  }

  // =============================================================
  // WebSocket Handler (for Durable Objects WebSocket API)
  // =============================================================

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.handleWebSocketMessage(ws, message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.activeSockets.delete(ws);
    console.log(`[Orion] WebSocket closed: ${code} ${reason}`);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[Orion] WebSocket error:', error);
    this.activeSockets.delete(ws);
  }

  // =============================================================
  // Alarm Handler
  // =============================================================

  async alarm(): Promise<void> {
    console.log('[Orion] Alarm triggered - running maintenance');

    try {
      await this.syncToD1();
      const nextAlarm = Date.now() + 3600000;
      await this.storage.setAlarm(nextAlarm);
    } catch (e) {
      console.error('[Orion] Alarm handler error:', e);
    }
  }
}

export default OrionAgent;
