// src/durable-agent.ts - FIXED VERSION with All Phase 1 Improvements
// ✅ Loop completion detection
// ✅ Tool execution timeouts
// ✅ Graceful error handling
// ✅ Worker structured output
// ✅ Better user messaging

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type { Env, Message, OrionRPC, ChatResponse, StatusResponse } from './types';
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
import { WorkspaceManager } from './workspace/workspace-manager';
import { XMLToolParser, XMLToolExecutor, type ToolExecutionResult } from './tools/xml-tool-executor';

// =============================================================
// Types & Interfaces
// =============================================================

interface ParsedAdminResponse {
  action: 'respond' | 'tool_call';
  content: string;
  toolCalls?: Array<{
    toolName: string;
    params: Record<string, any>;
    rawXml: string;
  }>;
  delegation?: any;
  metadata?: Record<string, any>;
}

interface CompletionState {
  resolved: boolean;
  confidence: number;
  reason: string;
}

interface ErrorRecovery {
  userMessage: string;
  suggestedAction?: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  partialResults?: any;
}

// =============================================================
// Completion Detector
// =============================================================

class CompletionDetector {
  async checkCompletion(
    userQuery: string,
    currentResponse: string,
    executionState: {
      toolCalls: any[];
      artifacts: any[];
      turnsUsed: number;
      maxTurns: number;
    }
  ): Promise<CompletionState> {
    const noToolCalls = executionState.toolCalls.length === 0;
    const hasCompletionMarker = this.hasCompletionMarker(currentResponse);
    const queryResolved = this.checkQueryResolved(userQuery, currentResponse);
    const hasArtifacts = executionState.artifacts.length > 0;
    const nearBudget = executionState.turnsUsed >= executionState.maxTurns * 0.8;
    
    const confidence = this.calculateConfidence({
      noToolCalls,
      hasCompletionMarker,
      queryResolved,
      hasArtifacts,
      nearBudget,
      turnsUsed: executionState.turnsUsed
    });
    
    const resolved = (
      (noToolCalls && confidence > 0.7) ||
      (hasCompletionMarker && confidence > 0.6) ||
      (queryResolved && noToolCalls)
    );
    
    const reason = this.getCompletionReason({
      noToolCalls,
      hasCompletionMarker,
      queryResolved,
      nearBudget
    });
    
    return { resolved, confidence, reason };
  }
  
  private hasCompletionMarker(response: string): boolean {
    const markers = [
      /TASK_COMPLETE/i,
      /\[DONE\]/i,
      /I(?:'ve| have) completed/i,
      /Here(?:'s| is) (?:your|the) final/i,
      /Let me know if you need anything else/i
    ];
    return markers.some(marker => marker.test(response));
  }
  
  private checkQueryResolved(userQuery: string, response: string): boolean {
    const queryLower = userQuery.toLowerCase();
    const responseLower = response.toLowerCase();
    
    if (queryLower.match(/what|who|when|where|why|how/)) {
      return response.length > 100 && !responseLower.includes('need more information');
    }
    
    if (queryLower.match(/create|build|make|generate|write/)) {
      return responseLower.includes('created') || 
             responseLower.includes('generated') ||
             responseLower.includes('completed');
    }
    
    if (queryLower.match(/search|research|find|look up/)) {
      return responseLower.includes('found') || 
             responseLower.includes('results') ||
             response.length > 200;
    }
    
    return response.length > 150;
  }
  
  private calculateConfidence(signals: {
    noToolCalls: boolean;
    hasCompletionMarker: boolean;
    queryResolved: boolean;
    hasArtifacts: boolean;
    nearBudget: boolean;
    turnsUsed: number;
  }): number {
    let score = 0.5;
    
    if (signals.noToolCalls) score += 0.2;
    if (signals.hasCompletionMarker) score += 0.3;
    if (signals.queryResolved) score += 0.25;
    if (signals.hasArtifacts) score += 0.15;
    if (signals.turnsUsed < 2) score -= 0.1;
    if (signals.nearBudget) score -= 0.2;
    
    return Math.max(0, Math.min(1, score));
  }
  
  private getCompletionReason(signals: any): string {
    if (signals.hasCompletionMarker) return 'explicit_completion';
    if (signals.queryResolved && signals.noToolCalls) return 'query_resolved';
    if (signals.nearBudget) return 'turn_budget_exhausted';
    if (signals.noToolCalls) return 'no_further_actions';
    return 'confidence_threshold';
  }
}

// =============================================================
// Error Handler
// =============================================================

class ErrorHandler {
  handleError(error: Error, context: {
    userQuery: string;
    turnsCompleted: number;
    artifactsCreated: any[];
    toolsUsed: string[];
  }): ErrorRecovery {
    if (error.message.includes('429') || error.message.includes('rate limit')) {
      return {
        userMessage: "I'm experiencing high demand right now. Your request is saved and I'll retry automatically in 30 seconds.",
        suggestedAction: "You can also try rephrasing to a simpler query.",
        retryable: true,
        retryAfterSeconds: 30
      };
    }
    
    if (error.message.includes('timeout')) {
      return {
        userMessage: "The operation is taking longer than expected. I've saved your progress.",
        suggestedAction: "Try breaking your request into smaller steps, or ask 'continue from where we left off'.",
        retryable: true,
        partialResults: context.artifactsCreated
      };
    }
    
    if (error.message.includes('ECONNREFUSED') || error.message.includes('503')) {
      const service = this.detectService(error);
      return {
        userMessage: `The ${service} service is temporarily unavailable. I can still help with other tasks.`,
        suggestedAction: `Try a query that doesn't require ${service}, or wait a few minutes and retry.`,
        retryable: true,
        retryAfterSeconds: 60
      };
    }
    
    if (error.message.includes('B2') || error.message.includes('workspace')) {
      return {
        userMessage: "I'm having trouble accessing your workspace. Your project data is safe.",
        suggestedAction: "Try again in a moment. If this persists, I can work without the workspace temporarily.",
        retryable: true,
        retryAfterSeconds: 30
      };
    }
    
    if (error.message.includes('Vectorize') || error.message.includes('memory')) {
      return {
        userMessage: "I'm having trouble accessing conversation memory. I can still help, but won't recall past discussions.",
        suggestedAction: "Feel free to provide any context from previous conversations.",
        retryable: false
      };
    }
    
    return {
      userMessage: "I encountered an unexpected issue. Let me try a different approach.",
      suggestedAction: "Could you rephrase your request or break it into smaller steps?",
      retryable: true
    };
  }
  
  private detectService(error: Error): string {
    if (error.message.includes('B2') || error.message.includes('workspace')) return 'workspace';
    if (error.message.includes('Vectorize') || error.message.includes('memory')) return 'memory';
    if (error.message.includes('Gemini')) return 'AI model';
    return 'external';
  }
}

// =============================================================
// Timeout Wrapper
// =============================================================

class TimeoutWrapper {
  private readonly TOOL_TIMEOUTS: Record<string, number> = {
    'memory_search': 10000,
    'knowledge_search': 15000,
    'workspace': 20000,
    'delegate_worker': 120000,
  };
  
  async executeWithTimeout<T>(
    toolName: string,
    executor: () => Promise<T>
  ): Promise<T> {
    const timeout = this.TOOL_TIMEOUTS[toolName] || 30000;
    
    return Promise.race([
      executor(),
      this.createTimeout<T>(timeout, toolName)
    ]);
  }
  
  private createTimeout<T>(ms: number, toolName: string): Promise<T> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Tool '${toolName}' timed out after ${ms}ms`));
      }, ms);
    });
  }
}

// =============================================================
// Main Orion Agent
// =============================================================

export class OrionAgent extends DurableObject implements OrionRPC {
  private state: DurableObjectState;
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private env: Env;
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private workspace: WorkspaceManager;
  private sessionId?: string;
  private initialized = false;
  private adminSystemInstruction: string;
  
  // Helper classes
  private completionDetector = new CompletionDetector();
  private errorHandler = new ErrorHandler();
  private timeoutWrapper = new TimeoutWrapper();
  
  private metrics = {
    totalRequests: 0,
    nativeToolCalls: 0,
    delegations: 0,
    adminTurns: 0,
    workerTurns: 0,
    thinkingTokensUsed: 0,
    workspaceOperations: 0,
    memorySearches: 0,
    knowledgeSearches: 0,
    completionReasons: {} as Record<string, number>,
    timeouts: 0,
    errors: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
    this.workspace = new WorkspaceManager();
    this.workspace.init(env);
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
      console.warn('[Agent] Hydration failed:', e);
    }
  }

  // =============================================================
  // RPC Interface
  // =============================================================

  async chat(
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<ChatResponse> {
    await this.init();
    if (!message?.trim()) throw new Error('Message cannot be empty');
    
    try {
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
    } catch (error) {
      this.metrics.errors++;
      const recovery = this.errorHandler.handleError(error as Error, {
        userQuery: message,
        turnsCompleted: 0,
        artifactsCreated: [],
        toolsUsed: []
      });
      
      return {
        response: `${recovery.userMessage}\n\n${recovery.suggestedAction || ''}`,
        artifacts: recovery.partialResults || [],
        metadata: {
          error: true,
          retryable: recovery.retryable,
          retryAfter: recovery.retryAfterSeconds
        }
      } as unknown as ChatResponse;
    }
  }

  async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.storage.getMessages() };
  }

  async getArtifacts(): Promise<{ artifacts: any[] }> {
    await this.init();
    return { artifacts: this.storage.getArtifacts() };
  }

  async clear(): Promise<{ ok: boolean }> {
    await this.init();
    await this.storage.clearAll();
    if (this.memory) await this.memory.clearSessionMemory();
    return { ok: true };
  }

  async uploadFile(base64: string, mimeType: string, name: string): Promise<{ success: boolean; file: any }> {
    await this.init();
    const metadata = await this.gemini.uploadFile(base64, mimeType, name);
    return { success: true, file: metadata };
  }

  async listFiles(): Promise<{ files: any[] }> {
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
    const projects = await this.workspace.listProjects();
    
    return {
      sessionId: this.sessionId,
      messageCount: this.storage.getMessages().length,
      artifactCount: this.storage.getArtifacts().length,
      protocol: 'Unified XML Protocol with Workspace',
      promptingStrategy: 'XML-structured with project continuity',
      metrics: this.metrics as any,
      nativeTools: {
        googleSearch: true,
        googleMaps: true,
        codeExecution: true,
        urlContext: true,
        fileSearch: true,
        thinking: true,
      },
      memory: this.memory ? this.memory.getMetrics() : null,
      workspace: {
        enabled: true,
        projectCount: projects.length,
        activeProjects: projects.filter(p => p.status === 'active').length,
      },
    } as unknown as StatusResponse;
  }

  // =============================================================
  // WebSocket Support
  // =============================================================

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
      const msg = JSON.parse(message);
      switch (msg.type) {
        case 'user_message':
          await this.handleWebSocketChat(ws, msg.content, msg.images);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    } catch (e) {
      console.error('[Agent] WebSocket error:', e);
      ws.send(JSON.stringify({ type: 'error', error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    console.log(`[Agent] WebSocket closed: ${code} - ${reason} (clean: ${wasClean})`);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[Agent] WebSocket error:', error);
  }

  private async handleWebSocketChat(ws: WebSocket, message: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
    await this.init();
    const callbacks = {
      onStatus: (msg: string) => ws.send(JSON.stringify({ type: 'status', message: msg })),
      onThought: (thought: string) => ws.send(JSON.stringify({ type: 'thought', content: thought })),
      onChunk: (chunk: string) => ws.send(JSON.stringify({ type: 'chunk', content: chunk })),
      onToolUse: (tool: string, params: any) => ws.send(JSON.stringify({ type: 'tool_use', tool, params })),
      onArtifact: (artifact: any) => ws.send(JSON.stringify({ type: 'artifact', artifact })),
    };
    
    try {
      const result = await this.executeAdminLoop(message, images, callbacks as any);
      ws.send(JSON.stringify({ 
        type: 'complete', 
        response: result.response, 
        artifacts: result.artifacts, 
        metadata: { 
          turnsUsed: result.turnsUsed, 
          toolsUsed: result.toolsUsed, 
          thinkingTokens: result.thinkingTokens,
          completionReason: result.completionReason,
          confidence: result.confidence
        } 
      }));
    } catch (error) {
      const recovery = this.errorHandler.handleError(error as Error, {
        userQuery: message,
        turnsCompleted: 0,
        artifactsCreated: [],
        toolsUsed: []
      });
      ws.send(JSON.stringify({ 
        type: 'error', 
        error: recovery.userMessage,
        suggestion: recovery.suggestedAction,
        retryable: recovery.retryable
      }));
    }
  }

  // =============================================================
  // Main Execution Loop (FIXED)
  // =============================================================

  async executeAdminLoop(
    userMessage: string,
    images?: Array<{ data: string; mimeType: string }>,
    callbacks?: {
      onThought?: (thought: string) => void;
      onChunk?: (chunk: string) => void;
      onStatus?: (msg: string) => void;
      onToolUse?: (tool: string, params: any) => void;
      onArtifact?: (artifact: any) => void;
    }
  ): Promise<{
    response: string;
    artifacts: any[];
    turnsUsed?: number;
    toolsUsed?: string[];
    thinkingTokens?: number;
    completionReason?: string;
    confidence?: number;
    partial?: boolean;
  }> {
    this.metrics.totalRequests++;
    callbacks?.onStatus?.('Analyzing your request...');
    
    await this.saveMessage('user', userMessage);
    const files = await this.gemini.listFiles();
    
    const projects = await this.workspace.listProjects();
    const activeProject = projects.find(p => p.status === 'active');
    
    const userPrompt = buildAdminUserPrompt(userMessage, {
      hasFiles: files.length > 0,
      hasImages: !!images,
      fileCount: files.length,
      conversationLength: this.storage.getMessages().length,
      memoryAvailable: !!this.memory,
      workspaceAvailable: true,
      activeProject: activeProject?.name,
    });
    
    const artifacts: any[] = [];
    const toolsUsed = new Set<string>();
    let turn = 0;
    const maxTurns = 15;
    let totalThinkingTokens = 0;
    const conversationHistory = this.formatContextForGemini(this.storage.getMessages().slice(-10));
    
    const executionState = {
      resolved: false,
      confidence: 0,
      toolCalls: [] as any[],
      artifacts: [] as any[],
      turnsUsed: 0,
      maxTurns
    };
    
    // ✅ FIXED: Loop with completion detection
    while (turn < maxTurns && !executionState.resolved) {
      turn++;
      this.metrics.adminTurns++;
      callbacks?.onStatus?.(`Processing (turn ${turn}/${maxTurns})...`);
      
      const messages = [
        { role: 'system', content: this.adminSystemInstruction },
        ...conversationHistory,
        { role: 'user', content: turn === 1 ? userPrompt : 'Continue with your task.' },
      ];
      
      const response = await this.gemini.generateWithNativeTools(
        messages,
        {
          stream: true,
          temperature: 1.0,
          thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
          useSearch: true,
          useMaps: true,
          useCodeExecution: true,
          useFileSearch: files.length > 0,
          images: turn === 1 ? images : undefined,
          files: files.length > 0 ? files : undefined,
          maxOutputTokens: 8192,
        },
        callbacks?.onChunk,
        callbacks?.onThought
      );
      
      if (response.usageMetadata) {
        totalThinkingTokens += response.usageMetadata.totalTokens || 0;
        this.metrics.thinkingTokensUsed += response.usageMetadata.totalTokens || 0;
      }
      
      if (response.searchResults) {
        this.metrics.nativeToolCalls++;
        toolsUsed.add('google_search');
        callbacks?.onToolUse?.('google_search', { results: response.searchResults.length });
      }
      
      if (response.codeExecutionResults) {
        this.metrics.nativeToolCalls++;
        toolsUsed.add('code_execution');
        callbacks?.onToolUse?.('code_execution', { executed: response.codeExecutionResults.length });
      }
      
      const parsed = this.parseAdminResponse(response.text, response);
      
      // ✅ FIXED: Execute tools with timeout
      if (parsed.action === 'tool_call' && parsed.toolCalls) {
        executionState.toolCalls = parsed.toolCalls;
        
        const toolExecutor = new XMLToolExecutor(
          this.workspace,
          this.gemini,
          this.memory,
          files
        );
        
        for (const toolCall of parsed.toolCalls) {
          callbacks?.onStatus?.(`Executing ${toolCall.toolName}...`);
          callbacks?.onToolUse?.(toolCall.toolName, toolCall.params);
          
          try {
            // ✅ FIXED: Timeout wrapper
            const result = await this.timeoutWrapper.executeWithTimeout(
              toolCall.toolName,
              () => toolExecutor.executeTool(toolCall.toolName, toolCall.params)
            );
            
            toolsUsed.add(toolCall.toolName);
            
            if (toolCall.toolName === 'workspace') this.metrics.workspaceOperations++;
            if (toolCall.toolName === 'memory_search') this.metrics.memorySearches++;
            if (toolCall.toolName === 'knowledge_search') this.metrics.knowledgeSearches++;
            if (toolCall.toolName === 'delegate_worker') this.metrics.delegations++;
            
            if (toolCall.toolName === 'delegate_worker' && result.success && result.metadata?.envelope) {
              const workerResult = await this.executeWorkerLoop(result.metadata.envelope, callbacks);
              
              if (workerResult.success && workerResult.artifactId) {
                const artifact = this.storage.getArtifacts().find((a) => a.id === workerResult.artifactId);
                if (artifact) {
                  artifacts.push(artifact);
                  executionState.artifacts.push(artifact);
                  callbacks?.onArtifact?.(artifact);
                }
              }
              
              workerResult.toolsUsed.forEach((t) => toolsUsed.add(t));
              
              const workerSummary = workerResult.success
                ? `<tool_result tool="delegate_worker" status="success">\nWorker completed task\nSummary: ${workerResult.summary}\nArtifact: ${workerResult.artifactId}\n</tool_result>`
                : `<tool_result tool="delegate_worker" status="failed">\nError: ${workerResult.error}\n</tool_result>`;
              
              conversationHistory.push({ role: 'user', content: workerSummary });
            } else {
              const toolResult = result.success
                ? `<tool_result tool="${result.toolName}" status="success">\n${result.result}\n</tool_result>`
                : `<tool_result tool="${result.toolName}" status="error">\n${result.error}\n</tool_result>`;
              
              conversationHistory.push({ role: 'user', content: toolResult });
            }
          } catch (error) {
            this.metrics.timeouts++;
            console.error(`[Agent] Tool ${toolCall.toolName} failed:`, error);
            
            conversationHistory.push({ 
              role: 'user', 
              content: `<tool_result tool="${toolCall.toolName}" status="timeout">\nOperation timed out. Please try again.\n</tool_result>` 
            });
          }
        }
        
        conversationHistory.push({ role: 'assistant', content: response.text });
        
        // ✅ FIXED: Check completion
        const completion = await this.completionDetector.checkCompletion(
          userMessage,
          response.text,
          { ...executionState, turnsUsed: turn }
        );
        
        executionState.resolved = completion.resolved;
        executionState.confidence = completion.confidence;
        
        if (completion.resolved) {
          console.log(`[Orion] Completion detected: ${completion.reason} (confidence: ${completion.confidence})`);
          this.metrics.completionReasons[completion.reason] = (this.metrics.completionReasons[completion.reason] || 0) + 1;
        }
        
        continue;
      }
      
      // ✅ FIXED: Natural completion check
      if (parsed.action === 'respond') {
        const completion = await this.completionDetector.checkCompletion(
          userMessage,
          response.text,
          { ...executionState, turnsUsed: turn }
        );
        
        if (completion.resolved || completion.confidence > 0.7) {
          const fullResponse = parsed.content;
          await this.saveMessage('model', fullResponse);
          
          if (this.memory) {
            this.saveToMemory(userMessage, fullResponse).catch(() => {});
          }
          
          this.syncToD1().catch(() => {});
          this.metrics.completionReasons[completion.reason] = (this.metrics.completionReasons[completion.reason] || 0) + 1;
          
          return { 
            response: fullResponse, 
            artifacts, 
            turnsUsed: turn, 
            toolsUsed: Array.from(toolsUsed), 
            thinkingTokens: totalThinkingTokens,
            completionReason: completion.reason,
            confidence: completion.confidence
          };
        }
      }
      
      conversationHistory.push({ role: 'assistant', content: response.text });
    }
    
    // ✅ FIXED: Better timeout handling with partial results
    const partialSummary = this.summarizeWorkDone(conversationHistory, artifacts);
    const timeoutResponse = `I've made progress on your request:\n\n${partialSummary}\n\nTo continue, please ask specific follow-up questions or say "continue from where we left off".`;
    
    await this.saveMessage('model', timeoutResponse);
    this.metrics.completionReasons['turn_limit_reached'] = (this.metrics.completionReasons['turn_limit_reached'] || 0) + 1;
    
    return { 
      response: timeoutResponse, 
      artifacts, 
      turnsUsed: turn, 
      toolsUsed: Array.from(toolsUsed), 
      thinkingTokens: totalThinkingTokens,
      partial: true,
      completionReason: 'turn_limit_reached',
      confidence: 0.5
    };
  }

  // =============================================================
  // Worker Execution (FIXED with JSON Schema)
  // =============================================================

  private async executeWorkerLoop(
    envelope: any,
    callbacks?: { onStatus?: (msg: string) => void }
  ): Promise<{ success: boolean; summary: string; artifactId?: string; error?: string; toolsUsed: string[]; turnsUsed: number }> {
    const config = workerRegistry.get(envelope.workerType);
    if (!config) return { success: false, summary: '', error: `Unknown worker type: ${envelope.workerType}`, toolsUsed: [], turnsUsed: 0 };
    
    callbacks?.onStatus?.(`Starting ${config.name}...`);
    
    const systemInstruction = buildWorkerSystemInstruction(envelope.workerType, { 
      name: config.name, 
      description: config.description, 
      capabilities: config.capabilities, 
      outputFormat: envelope.expectedOutput.format 
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
    const workerHistory: Array<{ role: string; content: string }> = [];
    
    while (turn < maxTurns) {
      turn++;
      this.metrics.workerTurns++;
      
      const messages = [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: turn === 1 ? taskPrompt : 'Continue working. Remember to set status=complete when done.' },
        ...workerHistory,
      ];
      
      // ✅ FIXED: Use JSON schema for structured output
      const response = await this.gemini.generateWithNativeTools(messages, {
        stream: false,
        temperature: config.temperature || 0.7,
        useSearch: config.tools.some((t) => t.name === 'web_search' && t.enabled),
        useCodeExecution: config.tools.some((t) => t.name === 'code_execution' && t.enabled),
        thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            status: { 
              type: 'string', 
              enum: ['working', 'complete', 'error'],
              description: 'Current status of the task'
            },
            progress: { 
              type: 'number', 
              minimum: 0, 
              maximum: 100,
              description: 'Percentage complete (0-100)'
            },
            currentStep: { 
              type: 'string',
              description: 'What the worker is currently doing'
            },
            output: { 
              type: 'string',
              description: 'Final deliverable (only when status=complete)'
            },
            summary: { 
              type: 'string',
              description: 'Brief summary of work done'
            },
            error: { 
              type: 'string',
              description: 'Error message if status=error'
            }
          },
          required: ['status']
        }
      });
      
      if (response.searchResults) toolsUsed.push('web_search');
      if (response.codeExecutionResults) toolsUsed.push('code_execution');
      
      // ✅ FIXED: Parse JSON structure
      let workerOutput: any;
      try {
        workerOutput = JSON.parse(response.text);
      } catch (error) {
        console.error('[Worker] Failed to parse JSON output:', error);
        return {
          success: false,
          summary: 'Worker output parsing failed',
          error: 'Invalid JSON response from worker',
          toolsUsed: [...new Set(toolsUsed)],
          turnsUsed: turn
        };
      }
      
      // Handle completion
      if (workerOutput.status === 'complete' && workerOutput.output) {
        const artifact = await this.createArtifact(envelope, workerOutput.output, envelope.workerType);
        await this.storage.saveArtifact(artifact);
        
        return { 
          success: true, 
          summary: workerOutput.summary || envelope.objective, 
          artifactId: artifact.id, 
          toolsUsed: [...new Set(toolsUsed)], 
          turnsUsed: turn 
        };
      }
      
      if (workerOutput.status === 'error') {
        return {
          success: false,
          summary: 'Worker encountered an error',
          error: workerOutput.error || 'Unknown error',
          toolsUsed: [...new Set(toolsUsed)],
          turnsUsed: turn
        };
      }
      
      // Status is 'working' - provide progress update
      if (workerOutput.currentStep) {
        callbacks?.onStatus?.(
          `${config.name}: ${workerOutput.progress || 0}% - ${workerOutput.currentStep}`
        );
      }
      
      workerHistory.push(
        { role: 'assistant', content: response.text },
        { role: 'user', content: 'Continue. Output status=complete when ready.' }
      );
    }
    
    // Exceeded max turns
    return { 
      success: false, 
      summary: 'Task incomplete', 
      error: 'Worker exceeded maximum turns', 
      toolsUsed: [...new Set(toolsUsed)], 
      turnsUsed: turn 
    };
  }

  // =============================================================
  // Helper Methods
  // =============================================================

  private parseAdminResponse(text: string, geminiResponse: any): ParsedAdminResponse {
    const toolCalls = XMLToolParser.parseTools(text);
    
    if (toolCalls.length > 0) {
      let cleanedText = text;
      toolCalls.forEach(tc => {
        cleanedText = cleanedText.replace(tc.rawXml, '');
      });
      
      return {
        action: 'tool_call',
        content: cleanedText.trim(),
        toolCalls,
        metadata: {
          searchResults: geminiResponse.searchResults,
          codeExecutionResults: geminiResponse.codeExecutionResults,
        },
      };
    }
    
    return {
      action: 'respond',
      content: text.trim(),
      metadata: {
        searchResults: geminiResponse.searchResults,
        codeExecutionResults: geminiResponse.codeExecutionResults,
      },
    };
  }

  private formatContextForGemini(messages: Message[]): Array<{ role: string; content: string }> {
    return messages.map((msg) => ({ 
      role: msg.role === 'model' ? 'assistant' : 'user', 
      content: this.extractMessageContent(msg) 
    }));
  }

  private extractMessageContent(msg: Message): string {
    if ((msg as any).content) return (msg as any).content;
    if ((msg as any).parts) return (msg as any).parts.map((p: any) => p.text || '').filter(Boolean).join('\n');
    return '';
  }

  private async saveMessage(role: 'user' | 'model', content: string): Promise<void> {
    await this.storage.saveMessage(role, [{ text: content }], Date.now());
  }

  private async saveToMemory(userMsg: string, assistantMsg: string): Promise<void> {
    if (!this.memory) return;
    await this.memory.saveMemoryBatch([
      { content: `User: ${userMsg}`, type: 'conversation', importance: 0.5, timestamp: Date.now() },
      { content: `Assistant: ${assistantMsg.substring(0, 500)}`, type: 'conversation', importance: 0.5, timestamp: Date.now() },
    ]);
  }

  private async createArtifact(envelope: any, content: string, workerType: any): Promise<any> {
    const typeMap: Record<string, string> = {
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
      console.error('[Agent] D1 sync failed:', err);
    }
  }

  private summarizeWorkDone(history: any[], artifacts: any[]): string {
    const summary: string[] = [];
    
    if (artifacts.length > 0) {
      summary.push(`✅ Created ${artifacts.length} artifact(s):`);
      artifacts.forEach(a => summary.push(`  - ${a.title}`));
    }
    
    const toolsUsed = history
      .filter(m => m.content?.includes('<tool_result'))
      .map(m => m.content.match(/tool="([^"]+)"/)?.[1])
      .filter(Boolean);
    
    if (toolsUsed.length > 0) {
      summary.push(`\n✅ Completed ${toolsUsed.length} operation(s)`);
    }
    
    return summary.join('\n') || 'Made initial progress on analysis';
  }
}

export default OrionAgent;
