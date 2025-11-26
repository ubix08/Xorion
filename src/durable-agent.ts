import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type {
  Env,
  Message,
  Artifact,
  TaskEnvelope,
  WSOutgoingMessage,
  WSIncomingMessage,
  OrionRPC,
  ChatResponse,
  StatusResponse,
  FileMetadata,
  WorkerType
} from './types';
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

export class OrionAgent extends DurableObject implements OrionRPC {
  private state: DurableObjectState;
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private env: Env;
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private sessionId?: string;
  private initialized = false;
  private adminSystemInstruction: string;
  private metrics = {
    totalRequests: 0,
    nativeToolCalls: 0,
    delegations: 0,
    adminTurns: 0,
    workerTurns: 0,
    thinkingTokensUsed: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
    this.adminSystemInstruction = buildAdminSystemInstruction();
    const name = state.id.name;
    if (name?.startsWith('session:')) {
      this.sessionId = name.slice(8);
    }
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    if (this.env.DB) this.d1 = new D1Manager(this.env.DB);
    if (this.sessionId && this.env.VECTORIZE) {
      this.memory = new MemoryManager(this.env.VECTORIZE, this.gemini, this.sessionId, {});
    }
    if (this.sessionId && this.d1 && this.storage.getMessages().length === 0) {
      await this.hydrateFromD1();
    }
    this.initialized = true;
  }

  private async hydrateFromD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;
    try {
      const messages = await this.d1.loadMessages(this.sessionId, 100);
      for (const msg of messages) {
        await this.storage.saveMessage(msg.role as 'user' | 'model', msg.parts || [], msg.timestamp);
      }
    } catch (e) {
      console.warn(e);
    }
  }

  async chat(
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<ChatResponse> {
    await this.init();
    if (!message?.trim()) throw new Error('Message cannot be empty');
    const result = await this.executeAdminLoop(message, images);
    return {
      response: result.response,
      artifacts: result.artifacts,
      metadata: {
        turnsUsed: result.turnsUsed || 0,
        toolsUsed: result.toolsUsed || [],
        thinkingTokens: result.thinkingTokens || 0,
      },
    } as unknown as ChatResponse;
  }

  private async syncToD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;
    try {
      const messages = this.storage.getMessages();
      if (messages.length === 0) return;
      const latestInD1 = await this.d1.getLatestMessageTimestamp(this.sessionId);
      const newMessages = messages.filter((m) => (m.timestamp || 0) > latestInD1);
      if (newMessages.length > 0) await this.d1.saveMessages(this.sessionId, newMessages);
      const artifacts = this.storage.getArtifacts();
      for (const artifact of artifacts) await this.d1.saveArtifact(this.sessionId, artifact);
    } catch (err) {
      console.error(err);
    }
  }

  async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.storage.getMessages() };
  }

  async getArtifacts(): Promise<{ artifacts: Artifact[] }> {
    await this.init();
    return { artifacts: this.storage.getArtifacts() };
  }

  async clear(): Promise<{ ok: boolean }> {
    await this.init();
    await this.storage.clearAll();
    if (this.memory) await this.memory.clearSessionMemory();
    return { ok: true };
  }

  async uploadFile(base64: string, mimeType: string, name: string): Promise<{ success: boolean; file: FileMetadata }> {
    await this.init();
    const metadata = await this.gemini.uploadFile(base64, mimeType, name);
    return { success: true, file: metadata };
  }

  async listFiles(): Promise<{ files: FileMetadata[] }> {
    await this.init();
    const files = await this.gemini.listFiles();
    return { files };
  }

  async deleteFile(fileUri: string): Promise<{ ok: boolean }> {
    await this.init();
    await this.gemini.deleteFile(fileUri);
    return { ok: true };
  }

  async getStatus(): Promise<StatusResponse> {
    await this.init();
    return {
      sessionId: this.sessionId,
      messageCount: this.storage.getMessages().length,
      artifactCount: this.storage.getArtifacts().length,
      protocol: 'Optimized Gemini 2.5 with System Instructions',
      promptingStrategy: 'XML-structured with few-shot examples',
      metrics: this.metrics,
      nativeTools: {
        googleSearch: true,
        googleMaps: false,
        codeExecution: true,
        urlContext: true,
        fileSearch: true,
        thinking: true,
      },
      memory: this.memory ? this.memory.getMetrics() : null,
    } as unknown as StatusResponse;
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') return this.handleWebSocketUpgrade(request);
    return new Response('Use RPC methods for API calls', { status: 400, headers: { 'Content-Type': 'text/plain' } });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // @ts-ignore
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    try {
      const msg: WSIncomingMessage = JSON.parse(message);
      switch (msg.type) {
        case 'user_message':
          await this.handleWebSocketChat(ws, msg.content, msg.images);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' } as WSOutgoingMessage));
          break;
        case 'cancel_task':
          ws.send(JSON.stringify({ type: 'status', message: 'Task cancellation not yet implemented' } as WSOutgoingMessage));
          break;
      }
    } catch (e) {
      console.error(e);
      ws.send(JSON.stringify({ type: 'error', error: e instanceof Error ? e.message : String(e) } as WSOutgoingMessage));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    console.log(`${code} - ${reason} (clean: ${wasClean})`);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error(error);
  }

  private async handleWebSocketChat(ws: WebSocket, message: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
    await this.init();
    const callbacks = {
      onStatus: (msg: string) => ws.send(JSON.stringify({ type: 'status', message: msg } as WSOutgoingMessage)),
      onThought: (thought: string) => ws.send(JSON.stringify({ type: 'thought', content: thought } as WSOutgoingMessage)),
      onChunk: (chunk: string) => ws.send(JSON.stringify({ type: 'chunk', content: chunk } as WSOutgoingMessage)),
      onToolUse: (tool: string, params: any) => ws.send(JSON.stringify({ type: 'tool_use', tool, params } as WSOutgoingMessage)),
      onArtifact: (artifact: Artifact) => ws.send(JSON.stringify({ type: 'artifact', artifact } as WSOutgoingMessage)),
      onWorkerProgress: (event: WSOutgoingMessage) => ws.send(JSON.stringify(event)),
    } as const;
    try {
      const result = await this.executeAdminLoop(message, images, callbacks as any);
      ws.send(JSON.stringify({ type: 'complete', response: result.response, artifacts: result.artifacts, metadata: { turnsUsed: result.turnsUsed, toolsUsed: result.toolsUsed, thinkingTokens: result.thinkingTokens } } as WSOutgoingMessage));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : String(error) } as WSOutgoingMessage));
    }
  }

  /////////////////////////////////////////////////////////////////
  async executeAdminLoop(
    userMessage: string,
    images?: Array<{ data: string; mimeType: string }>,
    callbacks?: {
      onThought?: (thought: string) => void;
      onChunk?: (chunk: string) => void;
      onStatus?: (msg: string) => void;
      onToolUse?: (tool: string, params: any) => void;
      onArtifact?: (artifact: Artifact) => void;
      onWorkerProgress?: (event: WSOutgoingMessage) => void;
    }
  ): Promise<{
    response: string;
    artifacts: Artifact[];
    turnsUsed?: number;
    toolsUsed?: string[];
    thinkingTokens?: number;
  }> {
    const startTime = Date.now();
    this.metrics.totalRequests++;
    callbacks?.onStatus?.('Analyzing your request...');
    
    await this.saveMessage('user', userMessage);
    const files = await this.gemini.listFiles();
    const userPrompt = buildAdminUserPrompt(userMessage, {
      hasFiles: files.length > 0,
      hasImages: !!images,
      fileCount: files.length,
      conversationLength: this.storage.getMessages().length,
      memoryAvailable: !!this.memory,
    });
    
    const artifacts: Artifact[] = [];
    const toolsUsed = new Set<string>();
    let turn = 0;
    const maxTurns = 10;
    let totalThinkingTokens = 0;
    const conversationHistory = this.formatContextForGemini(this.storage.getMessages().slice(-10));
    
    while (turn < maxTurns) {
      turn++;
      this.metrics.adminTurns++;
      callbacks?.onStatus?.(`Processing (turn ${turn}/${maxTurns})...`);
      
      const messages = [
        { role: 'system', content: this.adminSystemInstruction },
        ...conversationHistory,
        { role: 'user', content: turn === 1 ? userPrompt : 'Continue with your task.' },
      ];
      
      // ============================================================
      // ✅ TRUE REAL-TIME STREAMING: Pass callbacks directly to Gemini
      // ============================================================
      const response = await this.gemini.generateWithNativeTools(
        messages,
        {
          stream: true,
          temperature: 1.0,
          thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
          useSearch: true,
          useMaps: false,
          useCodeExecution: true,
          useFileSearch: files.length > 0,
          images: turn === 1 ? images : undefined,
          files: files.length > 0 ? files : undefined,
          maxOutputTokens: 8192,
        },
        callbacks?.onChunk,    // ✅ Stream text chunks in real-time
        callbacks?.onThought   // ✅ Stream thinking in real-time
      );
      
      // Track usage metadata
      if (response.usageMetadata) {
        totalThinkingTokens += response.usageMetadata.totalTokens || 0;
        this.metrics.thinkingTokensUsed += response.usageMetadata.totalTokens || 0;
      }
      
      // Track tool usage
      if (response.searchResults) {
        this.metrics.nativeToolCalls++;
        toolsUsed.add('google_search');
        callbacks?.onToolUse?.('google_search', { 
          query: 'automatic', 
          results: response.searchResults.length 
        });
      }
      
      if (response.codeExecutionResults) {
        this.metrics.nativeToolCalls++;
        toolsUsed.add('code_execution');
        callbacks?.onToolUse?.('code_execution', { 
          executed: response.codeExecutionResults.length 
        });
      }
      
      // Parse the response to determine next action
      const parsed = this.parseAdminResponse(response.text, response);
      
      switch (parsed.action) {
        case 'respond': {
          const fullResponse = parsed.content;
          await this.saveMessage('model', fullResponse);
          
          // Save to memory (background)
          if (this.memory) {
            this.saveToMemory(userMessage, fullResponse).catch(() => {});
          }
          
          // Sync to D1 (background)
          this.syncToD1().catch(() => {});
          
          return { 
            response: fullResponse, 
            artifacts, 
            turnsUsed: turn, 
            toolsUsed: Array.from(toolsUsed), 
            thinkingTokens: totalThinkingTokens 
          };
        }
        
        case 'memory_search': {
          callbacks?.onStatus?.('Searching conversation memory...');
          toolsUsed.add('memory_search');
          const memoryResults = await this.performMemorySearch(parsed.memoryQuery || '');
          conversationHistory.push({ 
            role: 'user', 
            content: `<memory_results>\n${memoryResults}\n</memory_results>` 
          });
          break;
        }
        
        case 'delegate': {
          if (!parsed.delegation) {
            conversationHistory.push({ 
              role: 'user', 
              content: '<error>Invalid delegation format. Please correct and try again.</error>' 
            });
            break;
          }
          
          callbacks?.onStatus?.(`Delegating to ${parsed.delegation.workerType}...`);
          this.metrics.delegations++;
          toolsUsed.add(`worker_${parsed.delegation.workerType}`);
          
          // Execute worker task
          const workerResult = await this.executeWorkerLoop(parsed.delegation, callbacks);
          
          // Handle artifacts
          if (workerResult.success && workerResult.artifactId) {
            const artifact = this.storage.getArtifacts().find((a) => a.id === workerResult.artifactId);
            if (artifact) {
              artifacts.push(artifact);
              callbacks?.onArtifact?.(artifact);
            }
          }
          
          // Track worker tools
          workerResult.toolsUsed.forEach((t) => toolsUsed.add(t));
          
          // Add worker result to conversation history
          const workerSummary = workerResult.success
            ? `<worker_result status="success">\nWorker: ${parsed.delegation.workerType}\nSummary: ${workerResult.summary}\nArtifact ID: ${workerResult.artifactId}\nTools Used: ${workerResult.toolsUsed.join(', ')}\n</worker_result>`
            : `<worker_result status="failed">\nWorker: ${parsed.delegation.workerType}\nError: ${workerResult.error}\n</worker_result>`;
          
          conversationHistory.push({ role: 'user', content: workerSummary });
          break;
        }
      }
      
      // Add assistant response to history
      conversationHistory.push({ role: 'assistant', content: response.text });
    }
    
    // Max turns reached
    const timeoutResponse = 'I reached my processing limit while working on your request. Let me summarize what I was able to accomplish so far...';
    await this.saveMessage('model', timeoutResponse);
    
    return { 
      response: timeoutResponse, 
      artifacts, 
      turnsUsed: turn, 
      toolsUsed: Array.from(toolsUsed), 
      thinkingTokens: totalThinkingTokens 
    };
  }
  


///////////////////////////////////////////////////////////////////
  private async executeWorkerLoop(
    envelope: TaskEnvelope,
    callbacks?: { onStatus?: (msg: string) => void; onWorkerProgress?: (event: WSOutgoingMessage) => void }
  ): Promise<{ success: boolean; summary: string; artifactId?: string; error?: string; toolsUsed: string[]; turnsUsed: number }> {
    const config = workerRegistry.get(envelope.workerType);
    if (!config) return { success: false, summary: '', error: `Unknown worker type: ${envelope.workerType}`, toolsUsed: [], turnsUsed: 0 };
    callbacks?.onStatus?.(`Starting ${config.name}...`);
    callbacks?.onWorkerProgress?.({ type: 'worker_started', message: `${config.name} starting task`, worker: envelope.workerType, taskId: envelope.taskId } as WSOutgoingMessage);
    const systemInstruction = buildWorkerSystemInstruction(envelope.workerType, { name: config.name, description: config.description, capabilities: config.capabilities, outputFormat: envelope.expectedOutput.format });
    const taskPrompt = buildWorkerTaskPrompt({ objective: envelope.objective, context: envelope.context, instructions: envelope.instructions, constraints: envelope.constraints, format: envelope.expectedOutput.format, qualityCriteria: envelope.qualityCriteria });
    const toolsUsed: string[] = [];
    let turn = 0;
    const maxTurns = config.maxTurns || 8;
    const workerHistory: Array<{ role: string; content: string }> = [];
    while (turn < maxTurns) {
      turn++;
      this.metrics.workerTurns++;
      callbacks?.onWorkerProgress?.({ type: 'worker_progress', message: `Processing (turn ${turn}/${maxTurns})`, worker: envelope.workerType, taskId: envelope.taskId, progress: Math.round((turn / maxTurns) * 100) } as WSOutgoingMessage);
      const messages = [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: turn === 1 ? taskPrompt : 'Continue with your task. Remember to output in the specified format when complete.' },
        ...workerHistory,
      ];
      const response = await this.gemini.generateWithNativeTools(messages, {
        stream: false,
        temperature: config.temperature || 0.7,
        useSearch: config.tools.some((t) => t.name === 'web_search' && t.enabled),
        useCodeExecution: config.tools.some((t) => t.name === 'code_execution' && t.enabled),
        thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
        maxOutputTokens: 8192,
      });
      if (response.searchResults) toolsUsed.push('web_search');
      if (response.codeExecutionResults) toolsUsed.push('code_execution');
      const parsed = this.parseWorkerResponse(response.text);
      if (parsed.complete && parsed.output) {
        const artifact = await this.createArtifact(envelope, parsed.output, envelope.workerType);
        await this.storage.saveArtifact(artifact);
        callbacks?.onWorkerProgress?.({ type: 'worker_completed', message: `${config.name} completed successfully`, worker: envelope.workerType, taskId: envelope.taskId } as WSOutgoingMessage);
        return { success: true, summary: parsed.summary || envelope.objective, artifactId: artifact.id, toolsUsed: [...new Set(toolsUsed)], turnsUsed: turn };
      }
      workerHistory.push({ role: 'assistant', content: response.text }, { role: 'user', content: '<instruction>Continue working on the task. Output your final deliverable when ready.</instruction>' });
    }
    return { success: false, summary: 'Task incomplete', error: 'Worker exceeded maximum turns without completing task', toolsUsed: [...new Set(toolsUsed)], turnsUsed: turn };
  }

  private parseAdminResponse(text: string, geminiResponse: any): ParsedAdminResponse {
    const memoryMatch = text.match(/\[MEMORY_SEARCH:\s*([^\]]+)\]/i);
    if (memoryMatch) return { action: 'memory_search', content: text, memoryQuery: memoryMatch[1].trim() };
    const delegateMatch = text.match(/<delegate>([\s\S]*?)<\/delegate>/);
    if (delegateMatch) {
      const delegation = this.parseDelegationXML(delegateMatch[1]);
      if (delegation) return { action: 'delegate', content: text.replace(/<delegate>[\s\S]*?<\/delegate>/, '').trim(), delegation, metadata: { searchResults: geminiResponse.searchResults, codeExecutionResults: geminiResponse.codeExecutionResults } };
    }
    return { action: 'respond', content: text.trim(), metadata: { searchResults: geminiResponse.searchResults, codeExecutionResults: geminiResponse.codeExecutionResults } };
  }

  private parseDelegationXML(xmlContent: string): TaskEnvelope | null {
    try {
      const extract = (tag: string): string => {
        const match = xmlContent.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
        return match ? match[1].trim() : '';
      };
      const workerType = extract('worker') as WorkerType;
      const objective = extract('objective');
      if (!workerType || !objective) return null;
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
      console.error(e);
      return null;
    }
  }

  private parseWorkerResponse(text: string): ParsedWorkerResponse {
    const outputMatch = text.match(/OUTPUT:\s*\n([\s\S]*?)(?:\n\nSUMMARY:|$)/i);
    if (outputMatch) {
      const output = outputMatch[1].trim();
      const summaryMatch = text.match(/SUMMARY:\s*([^\n]+)/i);
      const summary = summaryMatch ? summaryMatch[1].trim() : undefined;
      const confMatch = text.match(/CONFIDENCE:\s*(high|medium|low)/i);
      const confidence = confMatch ? (confMatch[1].toLowerCase() as any) : undefined;
      return { output, summary, confidence, complete: true };
    }
    return { complete: false };
  }

  private formatContextForGemini(messages: Message[]): Array<{ role: string; content: string }> {
    return messages.map((msg) => ({ role: msg.role === 'model' ? 'assistant' : 'user', content: this.extractMessageContent(msg) }));
  }

  private extractMessageContent(msg: Message): string {
    if ((msg as any).content) return (msg as any).content;
    if ((msg as any).parts) return (msg as any).parts.map((p: any) => p.text || '').filter(Boolean).join('\n');
    return '';
  }

  private async saveMessage(role: 'user' | 'model', content: string): Promise<void> {
    await this.storage.saveMessage(role, [{ text: content }], Date.now());
  }

  private async performMemorySearch(query: string): Promise<string> {
    if (!this.memory) return '<memory_error>Memory search not available - Vectorize not configured</memory_error>';
    try {
      const results = await this.memory.searchMemory(query, { topK: 5 });
      if (results.length === 0) return '<memory_result>No relevant past conversations found</memory_result>';
      return results.map((r, i) => `<memory_item index="${i + 1}" relevance="${Math.round(r.score * 100)}%">\n${r.content}\n</memory_item>`).join('\n\n');
    } catch (e) {
      return `<memory_error>${e instanceof Error ? e.message : 'Memory search failed'}</memory_error>`;
    }
  }

  private async saveToMemory(userMsg: string, assistantMsg: string): Promise<void> {
    if (!this.memory) return;
    await this.memory.saveMemoryBatch([
      { content: `User: ${userMsg}`, type: 'conversation', importance: 0.5, timestamp: Date.now() },
      { content: `Assistant: ${assistantMsg.substring(0, 500)}`, type: 'conversation', importance: 0.5, timestamp: Date.now() },
    ]);
  }

  private async createArtifact(envelope: TaskEnvelope, content: string, workerType: WorkerType): Promise<Artifact> {
    const typeMap: Record<WorkerType, Artifact['type']> = {
      deep_search: 'research',
      data_analyst: 'analysis',
      content_writer: 'content',
      code_developer: 'code',
      report_generator: 'report',
      seo_specialist: 'analysis',
      editor: 'content',
      synthesizer: 'content',
    };
    return { id: `artifact_${envelope.taskId}_${Date.now()}`, type: typeMap[workerType] || 'content', title: envelope.objective.substring(0, 100), content, workerType, createdAt: Date.now(), metadata: { taskId: envelope.taskId, format: envelope.expectedOutput.format } } as Artifact;
  }
}

export default OrionAgent;
