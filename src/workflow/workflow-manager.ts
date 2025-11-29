// src/durable-agent.ts - Refactored AI-Collaborator Agent

import { DurableObject } from 'cloudflare:workers';
import type { DurableObjectState } from '@cloudflare/workers-types';
import type {
  Env,
  Message,
  Artifact,
  WSOutgoingMessage,
  WSIncomingMessage,
  OrionRPC,
  ChatResponse,
  StatusResponse,
  FileMetadata,
  ConversationContext,
  StepExecutionResult,
  WorkflowTemplate,
  TodoDocument,
} from './types';
import { GeminiClient } from './gemini';
import { DurableStorage } from './durable-storage';
import { D1Manager } from './storage/d1-manager';
import { MemoryManager } from './memory/memory-manager';
import { WorkflowManager } from './workflow/workflow-manager';
import { buildSystemPrompt } from './prompts/system-prompt';
import { ToolParser, type ParsedResponse } from './tools/tool-parser';
import { Workspace } from './workspace/workspace';

export class OrionAgent extends DurableObject implements OrionRPC {
  private state: DurableObjectState;
  private storage: DurableStorage;
  private gemini: GeminiClient;
  private env: Env;
  private d1?: D1Manager;
  private memory?: MemoryManager;
  private workflow?: WorkflowManager;
  private sessionId?: string;
  private initialized = false;
  
  private systemInstruction: string;
  
  private metrics = {
    totalRequests: 0,
    nativeToolCalls: 0,
    totalTurns: 0,
    projectsCreated: 0,
    stepsCompleted: 0,
    thinkingTokensUsed: 0,
  };

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.storage = new DurableStorage(state);
    this.gemini = new GeminiClient({ apiKey: env.GEMINI_API_KEY });
    this.systemInstruction = buildSystemPrompt();
    
    const name = state.id.name;
    if (name?.startsWith('session:')) {
      this.sessionId = name.slice(8);
    }
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    
    if (this.env.DB) {
      this.d1 = new D1Manager(this.env.DB);
    }
    
    if (this.sessionId) {
      if (this.env.VECTORIZE) {
        this.memory = new MemoryManager(
          this.env.VECTORIZE,
          this.gemini,
          this.sessionId,
          {}
        );
        
        // Initialize workflow manager with RAG
        this.workflow = new WorkflowManager(
          this.env.VECTORIZE,
          this.gemini,
          this.sessionId
        );
      } else {
        // Workflow manager without RAG (list-based fallback)
        this.workflow = new WorkflowManager(
          null,
          this.gemini,
          this.sessionId
        );
      }
      
      // Hydrate from D1
      if (this.d1 && this.storage.getMessages().length === 0) {
        await this.hydrateFromD1();
      }
    }
    
    this.initialized = true;
  }

  private async hydrateFromD1(): Promise<void> {
    if (!this.d1 || !this.sessionId) return;
    try {
      const messages = await this.d1.loadMessages(this.sessionId, 100);
      for (const msg of messages) {
        await this.storage.saveMessage(
          msg.role as 'user' | 'model',
          msg.parts || [],
          msg.timestamp
        );
      }
    } catch (e) {
      console.warn('[Agent] Hydration failed:', e);
    }
  }

  // =============================================================
  // RPC Interface Implementation
  // =============================================================

  async chat(
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<ChatResponse> {
    await this.init();
    
    if (!message?.trim()) {
      throw new Error('Message cannot be empty');
    }

    this.metrics.totalRequests++;
    
    const result = await this.executeConversationLoop(message, images);
    
    return {
      response: result.response,
      artifacts: result.artifacts,
      conversationPhase: result.phase,
      suggestedWorkflows: result.suggestedWorkflows,
      activeProject: result.activeProject,
      metadata: {
        turnsUsed: result.turnsUsed,
        toolsUsed: result.toolsUsed,
        thinkingTokens: result.thinkingTokens,
      },
    } as ChatResponse;
  }

  async executeStep(projectPath: string, stepNumber: number): Promise<StepExecutionResult> {
    await this.init();
    
    if (!this.workflow) {
      throw new Error('Workflow manager not initialized');
    }

    return await this.executeStepExecution(projectPath, stepNumber);
  }

  async getHistory(): Promise<{ messages: Message[] }> {
    await this.init();
    return { messages: this.storage.getMessages() };
  }

  async getArtifacts(): Promise<{ artifacts: Artifact[] }> {
    await this.init();
    return { artifacts: this.storage.getArtifacts() };
  }

  async getProjects(): Promise<{ projects: import('./types').ProjectInfo[] }> {
    await this.init();
    
    if (!this.workflow || !this.sessionId || !Workspace.isInitialized()) {
      return { projects: [] };
    }

    try {
      const sessionPath = this.sessionId;
      const items = await Workspace.readdir(sessionPath);
      const projects: import('./types').ProjectInfo[] = [];

      for (const item of items) {
        if (item.startsWith('project_')) {
          const projectPath = `${sessionPath}/${item}`;
          const todo = await this.workflow.loadTodoDocument(projectPath);
          
          if (todo) {
            const progress = this.workflow.getProgress(todo);
            const phase: 'discovery' | 'execution' | 'delivery' = 
              progress.percentage === 0 ? 'discovery' :
              progress.percentage === 100 ? 'delivery' : 'execution';

            projects.push({
              projectId: item,
              objective: todo.objective,
              workflowId: todo.workflowId,
              conversationPhase: phase,
              createdAt: todo.createdAt,
              updatedAt: todo.updatedAt,
              stepsTotal: progress.total,
              stepsCompleted: progress.completed,
              currentStep: this.workflow.getCurrentStep(todo)?.number,
              workspacePath: projectPath,
            });
          }
        }
      }

      projects.sort((a, b) => b.updatedAt - a.updatedAt);
      return { projects };
    } catch (e) {
      console.error('[Agent] Failed to list projects:', e);
      return { projects: [] };
    }
  }

  async listWorkflows(): Promise<{ workflows: WorkflowTemplate[] }> {
    await this.init();
    
    if (!this.workflow) {
      throw new Error('Workflow manager not initialized');
    }

    const workflows = await this.workflow.listAllTemplates();
    return { workflows };
  }

  async searchWorkflows(query: string): Promise<{ workflows: WorkflowTemplate[] }> {
    await this.init();
    
    if (!this.workflow) {
      throw new Error('Workflow manager not initialized');
    }

    const workflows = await this.workflow.searchTemplates(query, 3);
    return { workflows };
  }

  async createProjectFromWorkflow(
    workflowId: string,
    objective: string,
    adaptations?: string
  ): Promise<{ projectId: string; projectPath: string }> {
    await this.init();
    
    if (!this.workflow) {
      throw new Error('Workflow manager not initialized');
    }

    const result = await this.workflow.createProjectFromTemplate(
      workflowId,
      objective,
      adaptations
    );

    this.metrics.projectsCreated++;
    
    return result;
  }

  async clear(): Promise<{ ok: boolean }> {
    await this.init();
    await this.storage.clearAll();
    if (this.memory) await this.memory.clearSessionMemory();
    return { ok: true };
  }

  async uploadFile(
    base64: string,
    mimeType: string,
    name: string
  ): Promise<{ success: boolean; file: FileMetadata }> {
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
    
    let projectCount = 0;
    let availableWorkflows = 0;
    
    if (Workspace.isInitialized()) {
      if (this.sessionId) {
        try {
          const items = await Workspace.readdir(this.sessionId);
          projectCount = items.filter(i => i.startsWith('project_')).length;
        } catch {}
      }
      
      if (this.workflow) {
        try {
          const workflows = await this.workflow.listAllTemplates();
          availableWorkflows = workflows.length;
        } catch {}
      }
    }
    
    const context = await this.getConversationContext();
    
    return {
      sessionId: this.sessionId,
      messageCount: this.storage.getMessages().length,
      artifactCount: this.storage.getArtifacts().length,
      conversationPhase: context.conversationPhase,
      activeProject: context.activeProject,
      protocol: 'Conversational AI-Collaborator with Workflow Templates',
      metrics: this.metrics,
      nativeTools: {
        googleSearch: true,
        codeExecution: true,
        fileSearch: true,
        thinking: true,
      },
      memory: this.memory ? this.memory.getMetrics() : null,
      workspace: {
        enabled: Workspace.isInitialized(),
        initialized: Workspace.isInitialized(),
        projectCount,
      },
      availableWorkflows,
    } as StatusResponse;
  }

  // =============================================================
  // WebSocket Support
  // =============================================================

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader?.toLowerCase() === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }
    return new Response('Use RPC methods for API calls', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
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
        case 'execute_step':
          await this.handleWebSocketStepExecution(ws, msg.projectPath, msg.stepNumber);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' } as WSOutgoingMessage));
          break;
      }
    } catch (e) {
      console.error('[Agent] WebSocket error:', e);
      ws.send(
        JSON.stringify({
          type: 'error',
          error: e instanceof Error ? e.message : String(e),
        } as WSOutgoingMessage)
      );
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    console.log(`[Agent] WebSocket closed: ${code} - ${reason} (clean: ${wasClean})`);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[Agent] WebSocket error:', error);
  }

  private async handleWebSocketChat(
    ws: WebSocket,
    message: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Promise<void> {
    await this.init();
    
    const callbacks = {
      onStatus: (msg: string) =>
        ws.send(JSON.stringify({ type: 'status', message: msg } as WSOutgoingMessage)),
      onThought: (thought: string) =>
        ws.send(JSON.stringify({ type: 'thought', content: thought } as WSOutgoingMessage)),
      onAction: (action: string) =>
        ws.send(JSON.stringify({ type: 'action', content: action } as WSOutgoingMessage)),
      onObservation: (obs: string) =>
        ws.send(JSON.stringify({ type: 'observation', content: obs } as WSOutgoingMessage)),
      onChunk: (chunk: string) =>
        ws.send(JSON.stringify({ type: 'chunk', content: chunk } as WSOutgoingMessage)),
      onToolUse: (tool: string, params: any) =>
        ws.send(JSON.stringify({ type: 'tool_use', tool, params } as WSOutgoingMessage)),
      onArtifact: (artifact: Artifact) =>
        ws.send(JSON.stringify({ type: 'artifact', artifact } as WSOutgoingMessage)),
    };
    
    try {
      const result = await this.executeConversationLoop(message, images, callbacks);
      
      ws.send(
        JSON.stringify({
          type: 'complete',
          response: result.response,
          artifacts: result.artifacts,
          metadata: {
            turnsUsed: result.turnsUsed,
            toolsUsed: result.toolsUsed,
            thinkingTokens: result.thinkingTokens,
          },
        } as WSOutgoingMessage)
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        } as WSOutgoingMessage)
      );
    }
  }

  private async handleWebSocketStepExecution(
    ws: WebSocket,
    projectPath: string,
    stepNumber: number
  ): Promise<void> {
    await this.init();
    
    const callbacks = {
      onStatus: (msg: string) =>
        ws.send(JSON.stringify({ type: 'status', message: msg } as WSOutgoingMessage)),
      onThought: (thought: string) =>
        ws.send(JSON.stringify({ type: 'thought', content: thought } as WSOutgoingMessage)),
      onAction: (action: string) =>
        ws.send(JSON.stringify({ type: 'action', content: action } as WSOutgoingMessage)),
      onObservation: (obs: string) =>
        ws.send(JSON.stringify({ type: 'observation', content: obs } as WSOutgoingMessage)),
      onChunk: (chunk: string) =>
        ws.send(JSON.stringify({ type: 'chunk', content: chunk } as WSOutgoingMessage)),
      onToolUse: (tool: string, params: any) =>
        ws.send(JSON.stringify({ type: 'tool_use', tool, params } as WSOutgoingMessage)),
      onArtifact: (artifact: Artifact) =>
        ws.send(JSON.stringify({ type: 'artifact', artifact } as WSOutgoingMessage)),
    };
    
    try {
      ws.send(JSON.stringify({ type: 'step_started', stepNumber, stepTitle: '' } as WSOutgoingMessage));
      
      const result = await this.executeStepExecution(projectPath, stepNumber, callbacks);
      
      ws.send(
        JSON.stringify({
          type: 'step_complete',
          stepNumber: result.stepNumber,
          stepTitle: result.stepTitle,
          outputs: result.outputs,
          nextStepReady: result.nextStepReady,
        } as WSOutgoingMessage)
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        } as WSOutgoingMessage)
      );
    }
  }

  // =============================================================
  // Core Conversation Loop (Refactored)
  // =============================================================

  private async executeConversationLoop(
    userMessage: string,
    images?: Array<{ data: string; mimeType: string }>,
    callbacks?: {
      onThought?: (thought: string) => void;
      onAction?: (action: string) => void;
      onObservation?: (obs: string) => void;
      onChunk?: (chunk: string) => void;
      onStatus?: (msg: string) => void;
      onToolUse?: (tool: string, params: any) => void;
      onArtifact?: (artifact: Artifact) => void;
    }
  ): Promise<{
    response: string;
    artifacts: Artifact[];
    phase: 'discovery' | 'execution' | 'delivery';
    activeProject?: import('./types').ActiveProject;
    suggestedWorkflows?: WorkflowTemplate[];
    turnsUsed: number;
    toolsUsed: string[];
    thinkingTokens: number;
  }> {
    let turn = 0;
    const maxTurns = 5; // Max turns for conversational response
    const toolsUsed = new Set<string>();
    let totalThinkingTokens = 0;
    const artifacts: Artifact[] = [];
    let finalResponse = '';
    let suggestedWorkflows: WorkflowTemplate[] | undefined;

    try {
      await this.saveMessage('user', userMessage);
      
      const context = await this.getConversationContext();
      const files = await this.gemini.listFiles();

      // Main conversation loop
      while (turn < maxTurns) {
        turn++;
        this.metrics.totalTurns++;
        
        callbacks?.onStatus?.(`Processing (turn ${turn}/${maxTurns})...`);

        // Build conversational prompt with context
        const userPrompt = await this.buildContextualPrompt(userMessage, context, files.length);
        
        // Get conversation history
        const history = this.formatContextForGemini(this.storage.getMessages().slice(-10));
        
        const messages = [
          { role: 'system', content: this.systemInstruction },
          ...history,
          { role: 'user', content: userPrompt },
        ];

        // Call Gemini with native tools + streaming
        const response = await this.gemini.generateWithNativeTools(
          messages,
          {
            stream: true,
            temperature: 0.8,
            thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
            useSearch: true,
            useMaps: false,
            useCodeExecution: true,
            useFileSearch: files.length > 0,
            images: turn === 1 ? images : undefined,
            files: files.length > 0 ? files : undefined,
            maxOutputTokens: 8192,
          },
          callbacks?.onChunk,
          callbacks?.onThought
        );

        // Track usage
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

        // Parse response for XML tools and narrative
        const parsed = ToolParser.parse(response.text);
        
        // Stream narrative
        if (parsed.narrative.thought) {
          callbacks?.onThought?.(parsed.narrative.thought);
        }
        if (parsed.narrative.action) {
          callbacks?.onAction?.(parsed.narrative.action);
        }
        if (parsed.narrative.observation) {
          callbacks?.onObservation?.(parsed.narrative.observation);
        }

        await this.saveMessage('model', response.text);

        // Execute tool calls
        const toolResult = await this.executeToolCalls(parsed, context, callbacks);
        
        if (toolResult.finalResponse) {
          finalResponse = toolResult.finalResponse;
          break;
        }
        
        if (toolResult.workflowSuggested && toolResult.workflows) {
          suggestedWorkflows = toolResult.workflows;
        }
        
        toolResult.toolsUsed.forEach(t => toolsUsed.add(t));
        if (toolResult.artifacts) {
          artifacts.push(...toolResult.artifacts);
        }
      }

      // Sync to D1
      if (this.d1 && this.sessionId) {
        this.syncToD1().catch(() => {});
      }

      const updatedContext = await this.getConversationContext();

      return {
        response: finalResponse || 'Processing complete',
        artifacts,
        phase: updatedContext.conversationPhase,
        activeProject: updatedContext.activeProject,
        suggestedWorkflows,
        turnsUsed: turn,
        toolsUsed: Array.from(toolsUsed),
        thinkingTokens: totalThinkingTokens,
      };

    } catch (error) {
      console.error('[Agent] ❌ Conversation loop error:', error);
      
      return {
        response: `Error: ${error instanceof Error ? error.message : String(error)}`,
        artifacts,
        phase: 'discovery',
        turnsUsed: turn,
        toolsUsed: Array.from(toolsUsed),
        thinkingTokens: totalThinkingTokens,
      };
    }
  }

  // =============================================================
  // Step Execution (For Active Projects)
  // =============================================================

  private async executeStepExecution(
    projectPath: string,
    stepNumber: number,
    callbacks?: {
      onThought?: (thought: string) => void;
      onAction?: (action: string) => void;
      onObservation?: (obs: string) => void;
      onChunk?: (chunk: string) => void;
      onStatus?: (msg: string) => void;
      onToolUse?: (tool: string, params: any) => void;
      onArtifact?: (artifact: Artifact) => void;
    }
  ): Promise<StepExecutionResult> {
    if (!this.workflow) {
      throw new Error('Workflow manager not initialized');
    }

    const todo = await this.workflow.loadTodoDocument(projectPath);
    if (!todo) {
      throw new Error('Todo document not found');
    }

    const step = todo.steps.find(s => s.number === stepNumber);
    if (!step) {
      throw new Error(`Step ${stepNumber} not found`);
    }

    await this.workflow.updateStepStatus(projectPath, stepNumber, 'in_progress');

    const maxTurns = 5;
    let turn = 0;
    const toolsUsed = new Set<string>();
    const artifacts: Artifact[] = [];
    let stepResponse = '';

    try {
      callbacks?.onStatus?.(`Executing Step ${stepNumber}: ${step.title}`);

      const stepPrompt = this.buildStepPrompt(todo, step, projectPath);
      
      while (turn < maxTurns) {
        turn++;
        
        callbacks?.onStatus?.(`Step ${stepNumber} - Turn ${turn}/${maxTurns}`);

        const history = this.formatContextForGemini(this.storage.getMessages().slice(-5));
        
        const messages = [
          { role: 'system', content: this.systemInstruction },
          ...history,
          { role: 'user', content: stepPrompt },
        ];

        const response = await this.gemini.generateWithNativeTools(
          messages,
          {
            stream: true,
            temperature: 0.7,
            thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
            useSearch: true,
            useCodeExecution: true,
            maxOutputTokens: 4096,
          },
          callbacks?.onChunk,
          callbacks?.onThought
        );

        if (response.searchResults) toolsUsed.add('google_search');
        if (response.codeExecutionResults) toolsUsed.add('code_execution');

        const parsed = ToolParser.parse(response.text);
        
        if (parsed.narrative.observation) {
          callbacks?.onObservation?.(parsed.narrative.observation);
        }

        await this.saveMessage('model', response.text);

        // Execute tools
        const context = await this.getConversationContext();
        const toolResult = await this.executeToolCalls(parsed, context, callbacks);
        
        if (toolResult.finalResponse) {
          stepResponse = toolResult.finalResponse;
          break;
        }
        
        toolResult.toolsUsed.forEach(t => toolsUsed.add(t));
        if (toolResult.artifacts) {
          artifacts.push(...toolResult.artifacts);
        }
      }

      // Mark step complete
      await this.workflow.updateStepStatus(
        projectPath,
        stepNumber,
        'completed',
        `Completed in ${turn} turns`
      );
      
      this.metrics.stepsCompleted++;

      const nextStep = todo.steps.find(s => s.number === stepNumber + 1 && s.status === 'pending');

      return {
        stepNumber,
        stepTitle: step.title,
        status: 'completed',
        response: stepResponse || `Step ${stepNumber} completed successfully`,
        outputs: step.outputs,
        artifacts,
        nextStepReady: !!nextStep,
        turnsUsed: turn,
      };

    } catch (error) {
      await this.workflow.updateStepStatus(
        projectPath,
        stepNumber,
        'pending', // Reset to pending on failure
        `Failed: ${error instanceof Error ? error.message : String(error)}`
      );

      throw error;
    }
  }

  // =============================================================
  // Tool Execution
  // =============================================================

  private async executeToolCalls(
    parsed: ParsedResponse,
    context: ConversationContext,
    callbacks?: {
      onToolUse?: (tool: string, params: any) => void;
      onArtifact?: (artifact: Artifact) => void;
    }
  ): Promise<{
    finalResponse?: string;
    workflows?: WorkflowTemplate[];
    workflowSuggested?: boolean;
    toolsUsed: string[];
    artifacts?: Artifact[];
  }> {
    const result: any = {
      toolsUsed: [],
      artifacts: [],
    };

    for (const toolCall of parsed.toolCalls) {
      switch (toolCall.type) {
        case 'response':
          result.finalResponse = toolCall.content;
          return result;

        case 'ask_user':
          result.finalResponse = toolCall.content;
          return result;

        case 'file_tool':
          if (Workspace.isInitialized()) {
            await this.executeFileTool(toolCall);
            result.toolsUsed.push('file_tool');
            callbacks?.onToolUse?.('file_tool', { action: toolCall.action });
          }
          break;

        case 'workflow_tool':
          await this.executeWorkflowTool(toolCall, result, callbacks);
          result.toolsUsed.push('workflow_tool');
          break;
      }
    }

    return result;
  }

  private async executeFileTool(toolCall: Extract<import('./tools/tool-parser').ToolCall, { type: 'file_tool' }>): Promise<void> {
    const { action, path, content } = toolCall;

    try {
      switch (action) {
        case 'read':
          await Workspace.readFileText(path);
          break;
        case 'write':
          if (!content) throw new Error('Content required for write');
          await Workspace.writeFile(path, content);
          break;
        case 'append':
          if (!content) throw new Error('Content required for append');
          await Workspace.appendFile(path, content);
          break;
        case 'delete':
          await Workspace.unlink(path);
          break;
        case 'list':
          await Workspace.readdir(path);
          break;
        case 'mkdir':
          await Workspace.mkdir(path);
          break;
      }
    } catch (e) {
      console.error('[Agent] File operation failed:', e);
      throw e;
    }
  }

  private async executeWorkflowTool(
    toolCall: Extract<import('./tools/tool-parser').ToolCall, { type: 'workflow_tool' }>,
    result: any,
    callbacks?: {
      onToolUse?: (tool: string, params: any) => void;
    }
  ): Promise<void> {
    if (!this.workflow) {
      throw new Error('Workflow manager not initialized');
    }

    const { action, query, workflowId, projectPath, stepNumber, adaptations } = toolCall;

    try {
      switch (action) {
        case 'search':
          if (!query) throw new Error('Query required for search');
          const workflows = await this.workflow.searchTemplates(query, 3);
          result.workflows = workflows;
          result.workflowSuggested = true;
          callbacks?.onToolUse?.('workflow_search', { query, found: workflows.length });
          break;

        case 'get':
          if (!workflowId) throw new Error('Workflow ID required for get');
          const template = await this.workflow.getTemplate(workflowId);
          result.workflows = template ? [template] : [];
          callbacks?.onToolUse?.('workflow_get', { workflowId });
          break;

        case 'create_project':
          if (!workflowId) throw new Error('Workflow ID required for create_project');
          const objective = query || 'New Project';
          const project = await this.workflow.createProjectFromTemplate(
            workflowId,
            objective,
            adaptations
          );
          result.finalResponse = `Project created: ${project.projectId} at ${project.projectPath}`;
          callbacks?.onToolUse?.('project_created', project);
          break;

        case 'load_step':
          if (!projectPath) throw new Error('Project path required for load_step');
          const todo = await this.workflow.loadTodoDocument(projectPath);
          if (!todo) throw new Error('Todo document not found');
          
          const step = stepNumber 
            ? todo.steps.find(s => s.number === stepNumber)
            : this.workflow.getCurrentStep(todo);
          
          if (!step) throw new Error('No step found');
          callbacks?.onToolUse?.('step_loaded', { stepNumber: step.number, title: step.title });
          break;

        default:
          throw new Error(`Unknown workflow action: ${action}`);
      }
    } catch (e) {
      console.error('[Agent] Workflow operation failed:', e);
      throw e;
    }
  }

  // =============================================================
  // Context Building
  // =============================================================

  private async getConversationContext(): Promise<ConversationContext> {
    const context: ConversationContext = {
      sessionId: this.sessionId || '',
      recentTools: [],
      conversationPhase: 'discovery',
    };

    // Check for active project
    if (this.sessionId && Workspace.isInitialized() && this.workflow) {
      try {
        const items = await Workspace.readdir(this.sessionId);
        const projectDirs = items.filter(i => i.startsWith('project_'));
        
        if (projectDirs.length > 0) {
          // Find most recently updated project
          let latestProject: string | null = null;
          let latestTime = 0;

          for (const projectDir of projectDirs) {
            const projectPath = `${this.sessionId}/${projectDir}`;
            const todo = await this.workflow.loadTodoDocument(projectPath);
            
            if (todo && todo.updatedAt > latestTime) {
              latestTime = todo.updatedAt;
              latestProject = projectDir;
            }
          }

          if (latestProject) {
            const projectPath = `${this.sessionId}/${latestProject}`;
            const todo = await this.workflow.loadTodoDocument(projectPath);
            
            if (todo) {
              const progress = this.workflow.getProgress(todo);
              const currentStep = this.workflow.getCurrentStep(todo);

              context.activeProject = {
                projectId: latestProject,
                projectPath,
                workflowId: todo.workflowId,
                currentStep: currentStep?.number,
                totalSteps: progress.total,
                createdAt: todo.createdAt,
                updatedAt: todo.updatedAt,
              };

              // Determine phase
              if (progress.completed === 0) {
                context.conversationPhase = 'discovery';
              } else if (progress.completed === progress.total) {
                context.conversationPhase = 'delivery';
              } else {
                context.conversationPhase = 'execution';
              }
            }
          }
        }
      } catch (e) {
        console.warn('[Agent] Failed to get active project:', e);
      }
    }

    return context;
  }

  private async buildContextualPrompt(
    userMessage: string,
    context: ConversationContext,
    fileCount: number
  ): string {
    const parts: string[] = [];

    parts.push(`<user_message>${userMessage}</user_message>`);

    if (fileCount > 0) {
      parts.push(`<files_available>${fileCount} uploaded documents available</files_available>`);
    }

    if (context.activeProject) {
      parts.push(`<active_project>`);
      parts.push(`Project: ${context.activeProject.projectId}`);
      parts.push(`Path: ${context.activeProject.projectPath}`);
      if (context.activeProject.workflowId) {
        parts.push(`Workflow: ${context.activeProject.workflowId}`);
      }
      if (context.activeProject.currentStep) {
        parts.push(`Current Step: ${context.activeProject.currentStep}/${context.activeProject.totalSteps}`);
      }
      parts.push(`</active_project>`);

      // Load current todo if available
      if (this.workflow) {
        try {
          const todo = await this.workflow.loadTodoDocument(context.activeProject.projectPath);
          if (todo) {
            const currentStep = this.workflow.getCurrentStep(todo);
            if (currentStep) {
              parts.push(`<current_step>`);
              parts.push(`Step ${currentStep.number}: ${currentStep.title}`);
              parts.push(`Status: ${currentStep.status}`);
              parts.push(`Description: ${currentStep.description}`);
              parts.push(`</current_step>`);
            }
          }
        } catch (e) {
          console.warn('[Agent] Failed to load todo context:', e);
        }
      }
    }

    parts.push(`<conversation_phase>${context.conversationPhase}</conversation_phase>`);

    return parts.join('\n');
  }

  private buildStepPrompt(todo: TodoDocument, step: import('./types').TodoStep, projectPath: string): string {
    return `<step_execution>
<objective>${todo.objective}</objective>

<current_step>
Step ${step.number}: ${step.title}
${step.description}
</current_step>

<expected_outputs>
${step.outputs.join(', ')}
</expected_outputs>

<project_path>${projectPath}</project_path>

<instructions>
Execute this step of the workflow. You have up to 5 turns.

1. Understand the step requirements
2. Use tools as needed (search, code, files)
3. Save outputs to workspace files
4. Summarize what was accomplished

Save outputs to appropriate folders:
- Research/data → data/
- Final deliverables → results/
- Code/tools → artifacts/

When complete, use <response> to summarize the step results.
</instructions>
</step_execution>`;
  }

  // =============================================================
  // Helper Methods
  // =============================================================

  private formatContextForGemini(
    messages: Message[]
  ): Array<{ role: string; content: string }> {
    return messages.map(msg => ({
      role: msg.role === 'model' ? 'assistant' : 'user',
      content: this.extractMessageContent(msg),
    }));
  }

  private extractMessageContent(msg: Message): string {
    if ((msg as any).content) return (msg as any).content;
    if ((msg as any).parts) {
      return (msg as any).parts
        .map((p: any) => p.text || '')
        .filter(Boolean)
        .join('\n');
    }
    return '';
  }

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
      console.error('[Agent] D1 sync failed:', err);
    }
  }
}

export default OrionAgent;
