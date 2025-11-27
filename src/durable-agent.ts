// src/durable-agent.ts - Updated with Workspace & Unified XML Protocol
// Key changes marked with // ✅ NEW

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
} from './admin/admin-prompts'; // ✅ NEW: Updated prompts
import { WorkspaceManager } from './workspace/workspace-manager'; // ✅ NEW
import { XMLToolParser, XMLToolExecutor, type ToolExecutionResult } from './tools/xml-tool-executor'; // ✅ NEW

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

export class OrionAgent extends DurableObject implements OrionRPC {
  private state: DurableObjectState;
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private env: Env;
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private workspace: WorkspaceManager; // ✅ NEW
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
    workspaceOperations: 0, // ✅ NEW
    memorySearches: 0, // ✅ NEW
    knowledgeSearches: 0, // ✅ NEW
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
    this.workspace = new WorkspaceManager(); // ✅ NEW
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
      console.error('[Agent] D1 sync failed:', err);
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
    
    // ✅ NEW: Get workspace status
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
      workspace: { // ✅ NEW
        enabled: true,
        projectCount: projects.length,
        activeProjects: projects.filter(p => p.status === 'active').length,
      },
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
          thinkingTokens: result.thinkingTokens 
        } 
      }));
    } catch (error) {
      ws.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : String(error) }));
    }
  }

  // ✅ NEW: Main execution loop with XML tool support
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
  }> {
    this.metrics.totalRequests++;
    callbacks?.onStatus?.('Analyzing your request...');
    
    await this.saveMessage('user', userMessage);
    const files = await this.gemini.listFiles();
    
    // ✅ NEW: Check for active project context
    const projects = await this.workspace.listProjects();
    const activeProject = projects.find(p => p.status === 'active');
    
    const userPrompt = buildAdminUserPrompt(userMessage, {
      hasFiles: files.length > 0,
      hasImages: !!images,
      fileCount: files.length,
      conversationLength: this.storage.getMessages().length,
      memoryAvailable: !!this.memory,
      workspaceAvailable: true, // ✅ NEW
      activeProject: activeProject?.name, // ✅ NEW
    });
    
    const artifacts: any[] = [];
    const toolsUsed = new Set<string>();
    let turn = 0;
    const maxTurns = 15; // ✅ NEW: Increased for tool iterations
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
      
      // ✅ NEW: Parse and execute XML tool calls
      const parsed = this.parseAdminResponse(response.text, response);
      
      if (parsed.action === 'tool_call' && parsed.toolCalls) {
        // Execute all tool calls
        const toolExecutor = new XMLToolExecutor(
          this.workspace,
          this.gemini,
          this.memory,
          files
        );
        
        for (const toolCall of parsed.toolCalls) {
          callbacks?.onStatus?.(`Executing ${toolCall.toolName}...`);
          callbacks?.onToolUse?.(toolCall.toolName, toolCall.params);
          
          const result = await toolExecutor.executeTool(toolCall.toolName, toolCall.params);
          
          toolsUsed.add(toolCall.toolName);
          
          // Update metrics
          if (toolCall.toolName === 'workspace') this.metrics.workspaceOperations++;
          if (toolCall.toolName === 'memory_search') this.metrics.memorySearches++;
          if (toolCall.toolName === 'knowledge_search') this.metrics.knowledgeSearches++;
          if (toolCall.toolName === 'delegate_worker') this.metrics.delegations++;
          
          // Handle worker delegation specially
          if (toolCall.toolName === 'delegate_worker' && result.success && result.metadata?.envelope) {
            const workerResult = await this.executeWorkerLoop(result.metadata.envelope, callbacks);
            
            if (workerResult.success && workerResult.artifactId) {
              const artifact = this.storage.getArtifacts().find((a) => a.id === workerResult.artifactId);
              if (artifact) {
                artifacts.push(artifact);
                callbacks?.onArtifact?.(artifact);
              }
            }
            
            workerResult.toolsUsed.forEach((t) => toolsUsed.add(t));
            
            const workerSummary = workerResult.success
              ? `<tool_result tool="delegate_worker" status="success">\nWorker completed task\nSummary: ${workerResult.summary}\nArtifact: ${workerResult.artifactId}\n</tool_result>`
              : `<tool_result tool="delegate_worker" status="failed">\nError: ${workerResult.error}\n</tool_result>`;
            
            conversationHistory.push({ role: 'user', content: workerSummary });
          } else {
            // Add tool result to conversation
            const toolResult = result.success
              ? `<tool_result tool="${result.toolName}" status="success">\n${result.result}\n</tool_result>`
              : `<tool_result tool="${result.toolName}" status="error">\n${result.error}\n</tool_result>`;
            
            conversationHistory.push({ role: 'user', content: toolResult });
          }
        }
        
        // Add assistant response to history
        conversationHistory.push({ role: 'assistant', content: response.text });
        
        // Continue loop to let agent process tool results
        continue;
      }
      
      // If no tool calls, we have final response
      if (parsed.action === 'respond') {
        const fullResponse = parsed.content;
        await this.saveMessage('model', fullResponse);
        
        if (this.memory) {
          this.saveToMemory(userMessage, fullResponse).catch(() => {});
        }
        
        this.syncToD1().catch(() => {});
        
        return { 
          response: fullResponse, 
          artifacts, 
          turnsUsed: turn, 
          toolsUsed: Array.from(toolsUsed), 
          thinkingTokens: totalThinkingTokens 
        };
      }
      
      conversationHistory.push({ role: 'assistant', content: response.text });
    }
    
    const timeoutResponse = 'I reached my processing limit while working on your request. Let me summarize what I accomplished...';
    await this.saveMessage('model', timeoutResponse);
    
    return { 
      response: timeoutResponse, 
      artifacts, 
      turnsUsed: turn, 
      toolsUsed: Array.from(toolsUsed), 
      thinkingTokens: totalThinkingTokens 
    };
  }

  // ✅ NEW: Updated response parser for XML tools
  private parseAdminResponse(text: string, geminiResponse: any): ParsedAdminResponse {
    const toolCalls = XMLToolParser.parseTools(text);
    
    if (toolCalls.length > 0) {
      // Remove tool XML from content
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

  // Worker execution (unchanged from original)
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
        { role: 'user', content: turn === 1 ? taskPrompt : 'Continue with your task.' },
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
        
        return { 
          success: true, 
          summary: parsed.summary || envelope.objective, 
          artifactId: artifact.id, 
          toolsUsed: [...new Set(toolsUsed)], 
          turnsUsed: turn 
        };
      }
      
      workerHistory.push(
        { role: 'assistant', content: response.text },
        { role: 'user', content: '<instruction>Continue working. Output final deliverable when ready.</instruction>' }
      );
    }
    
    return { 
      success: false, 
      summary: 'Task incomplete', 
      error: 'Worker exceeded maximum turns', 
      toolsUsed: [...new Set(toolsUsed)], 
      turnsUsed: turn 
    };
  }

  private parseWorkerResponse(text: string): { output?: string; summary?: string; complete: boolean } {
    const outputMatch = text.match(/OUTPUT:\s*\n([\s\S]*?)(?:\n\nSUMMARY:|$)/i);
    if (outputMatch) {
      const output = outputMatch[1].trim();
      const summaryMatch = text.match(/SUMMARY:\s*([^\n]+)/i);
      const summary = summaryMatch ? summaryMatch[1].trim() : undefined;
      return { output, summary, complete: true };
    }
    return { complete: false };
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
}

export default OrionAgent;
