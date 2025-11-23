// src/durable-agent-refactored.ts - DO as Orchestrator (REFACTORED)

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { 
  Env, Message, Artifact, AgentState, TaskEnvelope, 
  WSIncomingMessage, WSOutgoingMessage, WorkerType
} from './types';
import { GeminiClient } from './gemini';
import { ReactExecutor, type ToolCall, type GenerateResponse } from './core/react-executor';
import { DurableStorage } from './durable-storage';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import { 
  globalToolRegistry, 
  createMemorySearchTool, 
  createArtifactRetrievalTool,
  type ToolResult 
} from './tools/tool-registry';
import { buildAdminPrompt } from './admin/admin-prompts';
import { workerRegistry } from './workers/worker-registry';
import { buildWorkerPrompt } from './workers/worker-prompts';

// =============================================================
// Orion Durable Object (REFACTORED)
// =============================================================

export class OrionAgent extends DurableObject {
  // Core dependencies
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private env: Env;

  // React executors
  private adminReact: ReactExecutor;
  private workerReact: ReactExecutor | null = null;

  // Optional services
  private d1?: D1Manager;
  private memory?: MemoryManager;

  // Session state
  private sessionId?: string;
  private initialized = false;
  private activeSockets = new Set<WebSocket>();

  // Metrics
  private metrics = {
    totalRequests: 0,
    totalDelegations: 0,
    adminTurns: 0,
    workerTurns: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });

    // Initialize Admin React executor with placeholder prompt
    this.adminReact = new ReactExecutor(this.gemini, '', 0.7);

    // Extract session ID
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
    }

    // Register artifact retrieval tool
    globalToolRegistry.register(
      createArtifactRetrievalTool(async (id: string) => {
        if (!this.d1 || !this.sessionId) return null;
        const artifacts = await this.d1.getArtifacts(this.sessionId);
        return artifacts.find(a => a.id === id);
      })
    );

    // Update admin prompt with context
    const state = await this.storage.loadState();
    const adminPrompt = buildAdminPrompt({
      memoryContext: state.context.memoryContext,
      activeProject: state.currentProject,
    });
    this.adminReact.updateSystemPrompt(adminPrompt);

    // Hydrate from D1
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
  // HTTP Request Handler
  // =============================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!this.sessionId) {
      this.sessionId = request.headers.get('X-Session-ID') || 
                       url.searchParams.get('session_id') || 
                       undefined;
    }

    // WebSocket upgrade
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
  // Chat Processing (Admin Loop)
  // =============================================================

  private async handleChatRequest(request: Request): Promise<Response> {
    const body = await request.json() as { message: string };
    const message = body.message?.trim();

    if (!message) {
      return this.jsonResponse({ error: 'Missing message' }, 400);
    }

    const result = await this.executeAdminLoop(message);
    return this.jsonResponse(result);
  }

  async executeAdminLoop(
    userMessage: string,
    callbacks?: {
      onChunk?: (chunk: string) => void;
      onStatus?: (msg: string) => void;
      onWorkerProgress?: (event: WSOutgoingMessage) => void;
      onArtifact?: (artifact: Artifact) => void;
    }
  ): Promise<{ response: string; artifacts: Artifact[] }> {
    const startTime = Date.now();
    this.metrics.totalRequests++;

    callbacks?.onStatus?.('Processing your request...');

    // Save user message
    await this.saveMessage('user', userMessage);

    // Load conversation context (persistent)
    const context = this.storage.getMessages();

    // Build admin tools (includes delegate_to_worker)
    const adminTools = this.buildAdminTools();

    const artifacts: Artifact[] = [];
    let turn = 0;
    const maxTurns = 10;
    let fullResponse = '';

    while (turn < maxTurns) {
      turn++;
      this.metrics.adminTurns++;

      callbacks?.onStatus?.(`Admin thinking (turn ${turn}/${maxTurns})...`);

      // Call Admin LLM
      const response = await this.adminReact.generate(
        context.slice(-20), // Last 20 messages for context
        turn === 1 ? userMessage : 'Continue addressing the user\'s request.',
        adminTools,
        {
          stream: true,
          useSearch: true,
          onChunk: callbacks?.onChunk,
        }
      );

      fullResponse = response.text;

      // No tool calls? Admin is done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        break;
      }

      // Execute tool calls
      callbacks?.onStatus?.('Executing tools...');
      const toolResults = await this.executeToolCalls(
        response.toolCalls,
        'admin',
        callbacks
      );

      // Add artifacts from worker delegations
      for (const result of toolResults) {
        if (result.name === 'delegate_to_worker' && result.success) {
          try {
            const parsed = JSON.parse(result.result);
            if (parsed.artifactId) {
              const artifact = this.storage.getArtifacts().find(
                a => a.id === parsed.artifactId
              );
              if (artifact) {
                artifacts.push(artifact);
                callbacks?.onArtifact?.(artifact);
              }
            }
          } catch {}
        }
      }

      // Add assistant response to context
      const assistantMsg: Message = {
        role: 'model',
        parts: [{ text: fullResponse }],
        timestamp: Date.now(),
      };
      context.push(assistantMsg);

      // Add tool results as function response
      const functionMsg: Message = {
        role: 'user',
        parts: [{ text: this.formatToolResults(toolResults) }],
        timestamp: Date.now(),
        metadata: { isInternal: true },
      };
      context.push(functionMsg);
    }

    // Save final assistant response
    await this.saveMessage('model', fullResponse);

    // Background sync to D1
    this.syncToD1().catch(e => console.warn('[Orion] Sync failed:', e));

    console.log(`[Orion] Admin loop completed in ${Date.now() - startTime}ms, ${turn} turns`);

    return { response: fullResponse, artifacts };
  }

  // =============================================================
  // Worker Loop Execution
  // =============================================================

  private async executeWorkerLoop(
    envelope: TaskEnvelope,
    callbacks?: {
      onStatus?: (msg: string) => void;
      onWorkerProgress?: (event: WSOutgoingMessage) => void;
    }
  ): Promise<string> {
    const config = workerRegistry.get(envelope.workerType);
    if (!config) {
      throw new Error(`Unknown worker type: ${envelope.workerType}`);
    }

    this.metrics.totalDelegations++;

    callbacks?.onStatus?.(`Starting ${config.name}...`);
    callbacks?.onWorkerProgress?.({
      type: 'worker_started',
      message: `${config.name} starting task`,
      worker: envelope.workerType,
      taskId: envelope.taskId,
    });

    // Create ephemeral worker context (not persisted)
    const workerContext: Message[] = [];

    // Build worker prompt
    const workerPrompt = buildWorkerPrompt(envelope, config);

    // Initialize worker executor
    this.workerReact = new ReactExecutor(
      this.gemini,
      config.systemPrompt,
      config.temperature
    );

    // Build worker tools (NO delegate_to_worker!)
    const workerTools = this.buildWorkerTools(config);

    const toolsUsed: string[] = [];
    let turn = 0;
    const maxTurns = config.maxTurns || 8;
    let lastResponse = '';

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

      // Call Worker LLM
      const response = await this.workerReact.generate(
        workerContext,
        turn === 1 ? workerPrompt : 'Continue with your task.',
        workerTools,
        {
          stream: false,
          useSearch: config.tools.some(t => t.name === 'web_search' && t.enabled),
          useCodeExecution: config.tools.some(t => t.name === 'code_execution' && t.enabled),
        }
      );

      lastResponse = response.text;

      // Check if worker output is complete
      if (this.isWorkerComplete(lastResponse)) {
        // Parse output
        const parsed = this.parseWorkerOutput(lastResponse);

        // Create artifact
        const artifact = await this.createArtifact(
          envelope,
          parsed.output,
          config.type
        );

        // Save artifact
        await this.storage.saveArtifact(artifact);

        callbacks?.onWorkerProgress?.({
          type: 'worker_completed',
          message: `${config.name} completed`,
          worker: envelope.workerType,
          taskId: envelope.taskId,
        });

        // Return result for Admin
        return JSON.stringify({
          success: true,
          summary: parsed.summary || envelope.objective,
          artifactId: artifact.id,
          artifactType: artifact.type,
          confidence: parsed.confidence || 0.8,
          toolsUsed,
          turnsUsed: turn,
        }, null, 2);
      }

      // Execute worker tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        const state = await this.storage.loadState();
        const toolResults = await globalToolRegistry.executeMany(
          response.toolCalls,
          state
        );

        // Track tools used
        toolResults.forEach(r => {
          if (!toolsUsed.includes(r.name)) toolsUsed.push(r.name);
        });

        // Add to worker context
        workerContext.push({
          role: 'model',
          parts: [{ text: lastResponse }],
          timestamp: Date.now(),
        });

        workerContext.push({
          role: 'user',
          parts: [{ text: globalToolRegistry.formatResults(toolResults) }],
          timestamp: Date.now(),
        });

        continue;
      }

      // No tool calls, no completion - continue
      workerContext.push({
        role: 'model',
        parts: [{ text: lastResponse }],
        timestamp: Date.now(),
      });

      workerContext.push({
        role: 'user',
        parts: [{ text: 'Continue with your task. Remember to format final output with ---OUTPUT--- markers.' }],
        timestamp: Date.now(),
      });
    }

    // Max turns reached without completion
    console.warn(`[Worker:${config.type}] Max turns reached`);

    return JSON.stringify({
      success: false,
      error: 'Worker exceeded maximum turns',
      partialOutput: lastResponse,
      toolsUsed,
      turnsUsed: turn,
    }, null, 2);
  }

  // =============================================================
  // Tool Execution
  // =============================================================

  private async executeToolCalls(
    calls: ToolCall[],
    source: 'admin' | 'worker',
    callbacks?: {
      onStatus?: (msg: string) => void;
      onWorkerProgress?: (event: WSOutgoingMessage) => void;
    }
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of calls) {
      if (call.name === 'delegate_to_worker' && source === 'admin') {
        // Execute worker loop
        try {
          const envelope = this.buildTaskEnvelope(call.args);
          const workerResult = await this.executeWorkerLoop(envelope, callbacks);
          
          results.push({
            name: call.name,
            success: true,
            result: workerResult,
          });
        } catch (error) {
          results.push({
            name: call.name,
            success: false,
            result: `Worker failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      } else {
        // Execute external tool
        const state = await this.storage.loadState();
        const result = await globalToolRegistry.execute(call.name, call.args, state);
        results.push(result);
      }
    }

    return results;
  }

  // =============================================================
  // Tool Building
  // =============================================================

  private buildAdminTools() {
    const externalTools = globalToolRegistry.getDefinitions();
    
    // Add delegate_to_worker tool
    const delegateTool = {
      name: 'delegate_to_worker',
      description: 'Delegate a task to a specialized worker agent for focused execution',
      parameters: {
        type: 'object' as const,
        properties: {
          workerType: {
            type: 'string',
            enum: ['deep_search', 'data_analyst', 'content_writer', 'code_developer', 
                   'report_generator', 'seo_specialist', 'editor', 'synthesizer'],
            description: 'Type of specialist worker to use',
          },
          objective: {
            type: 'string',
            description: 'Clear, specific goal for the worker',
          },
          instructions: {
            type: 'string',
            description: 'Detailed instructions for the worker',
          },
          context: {
            type: 'string',
            description: 'Relevant background information',
          },
          expectedFormat: {
            type: 'string',
            enum: ['markdown', 'json', 'code', 'list', 'report'],
            description: 'Expected output format',
          },
        },
        required: ['workerType', 'objective', 'instructions'],
      },
    };

    return [...externalTools, delegateTool];
  }

  private buildWorkerTools(config: any) {
    // Only external tools, no delegate_to_worker
    return globalToolRegistry.getDefinitions();
  }

  // =============================================================
  // Helper Methods
  // =============================================================

  private buildTaskEnvelope(args: any): TaskEnvelope {
    return {
      taskId: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      workerType: args.workerType as WorkerType,
      objective: args.objective,
      context: args.context || '',
      instructions: args.instructions,
      constraints: args.constraints || [],
      expectedOutput: {
        format: args.expectedFormat || 'markdown',
        structure: args.structure,
      },
      qualityCriteria: args.qualityCriteria || ['accurate', 'complete'],
    };
  }

  private isWorkerComplete(text: string): boolean {
    return text.includes('---OUTPUT---') && text.includes('---END OUTPUT---');
  }

  private parseWorkerOutput(text: string): {
    output: string;
    summary?: string;
    confidence?: number;
  } {
    const outputMatch = text.match(/---OUTPUT---\s*([\s\S]*?)\s*---END OUTPUT---/);
    const output = outputMatch ? outputMatch[1].trim() : text.trim();

    const summaryMatch = text.match(/SUMMARY:\s*(.+?)(?:\n|$)/i);
    const summary = summaryMatch ? summaryMatch[1].trim() : undefined;

    const confMatch = text.match(/CONFIDENCE:\s*(high|medium|low)/i);
    const confidenceMap = { high: 0.9, medium: 0.7, low: 0.5 };
    const confidence = confMatch ? confidenceMap[confMatch[1].toLowerCase() as keyof typeof confidenceMap] : undefined;

    return { output, summary, confidence };
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
      seo_specialist: 'analysis',
      editor: 'content',
      synthesizer: 'content',
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

  private formatToolResults(results: ToolResult[]): string {
    return `Tool Execution Results:\n\n${globalToolRegistry.formatResults(results)}\n\nUse these results to continue addressing the user's request.`;
  }

  // =============================================================
  // Message Management
  // =============================================================

  private async saveMessage(role: 'user' | 'model', content: string): Promise<void> {
    await this.storage.saveMessage(role, [{ text: content }], Date.now());
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
      console.error('[Orion] D1 sync failed:', err);
    }
  }

  // =============================================================
  // WebSocket Handling
  // =============================================================

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.ctx.acceptWebSocket(server);

    server.addEventListener('message', (event: MessageEvent) => {
      if (!this.initialized) {
        this.init().then(() => {
          this.handleWebSocketMessage(server, event.data).catch(console.error);
        }).catch(console.error);
      } else {
        this.handleWebSocketMessage(server, event.data).catch(console.error);
      }
    });

    server.addEventListener('close', () => {
      this.activeSockets.delete(server);
    });

    server.addEventListener('error', () => {
      this.activeSockets.delete(server);
    });

    this.activeSockets.add(server);

    setTimeout(() => {
      this.sendWS(server, { type: 'status', message: 'Connected to Orion' });
    }, 100);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleWebSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string') return;

    let msg: WSIncomingMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      this.sendWS(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (msg.type === 'user_message' && msg.content) {
      await this.processWebSocketMessage(ws, msg.content);
    }
  }

  private async processWebSocketMessage(ws: WebSocket, userMessage: string): Promise<void> {
    try {
      const result = await this.executeAdminLoop(userMessage, {
        onChunk: (chunk) => this.sendWS(ws, { type: 'chunk', content: chunk }),
        onStatus: (message) => this.sendWS(ws, { type: 'status', message }),
        onWorkerProgress: (event) => this.sendWS(ws, event),
        onArtifact: (artifact) => this.sendWS(ws, { type: 'artifact', artifact }),
      });

      this.sendWS(ws, { type: 'complete', content: result.response });
    } catch (error) {
      this.sendWS(ws, { 
        type: 'error', 
        message: error instanceof Error ? error.message : String(error) 
      });
    }
  }

  private sendWS(ws: WebSocket, message: WSOutgoingMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      console.error('[Orion] WS send error:', e);
    }
  }

  // =============================================================
  // Status
  // =============================================================

  private async getStatus(): Promise<object> {
    const storageStatus = this.storage.getStatus();

    return {
      sessionId: this.sessionId,
      ...storageStatus,
      tools: {
        registered: globalToolRegistry.getAll().map(t => t.name),
      },
      metrics: this.metrics,
      memory: this.memory ? this.memory.getMetrics() : null,
    };
  }

  // =============================================================
  // Utilities
  // =============================================================

  private jsonResponse(data: any, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // =============================================================
  // Durable Object WebSocket API
  // =============================================================

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.handleWebSocketMessage(ws, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.activeSockets.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.activeSockets.delete(ws);
  }
}

export default OrionAgent;
