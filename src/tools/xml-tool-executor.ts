// src/tools/xml-tool-executor.ts - Unified XML Tool Parser and Executor

import { WorkspaceManager } from '../workspace/workspace-manager';
import { MemoryManager } from '../memory/memory-manager';
import { GeminiClient } from '../gemini';
import type { TaskEnvelope, WorkerType, FileMetadata } from '../types';

// =============================================================
// Tool Execution Results
// =============================================================

export type ToolExecutionResult = {
  success: boolean;
  toolName: string;
  result?: string;
  error?: string;
  metadata?: Record<string, any>;
};

// =============================================================
// XML Tool Parser
// =============================================================

export class XMLToolParser {
  /**
   * Parse all tool invocations from response text
   */
  static parseTools(text: string): Array<{
    toolName: string;
    params: Record<string, any>;
    rawXml: string;
  }> {
    const tools: Array<{ toolName: string; params: Record<string, any>; rawXml: string }> = [];
    
    // Match all <tool> blocks
    const toolRegex = /<tool\s+name="([^"]+)">([\s\S]*?)<\/tool>/g;
    let match;

    while ((match = toolRegex.exec(text)) !== null) {
      const toolName = match[1];
      const content = match[2];
      const params = this.parseToolContent(content);
      
      tools.push({
        toolName,
        params,
        rawXml: match[0],
      });
    }

    return tools;
  }

  /**
   * Parse content inside a tool block
   */
  private static parseToolContent(content: string): Record<string, any> {
    const params: Record<string, any> = {};

    // Parse <operation>
    const opMatch = content.match(/<operation>([^<]+)<\/operation>/);
    if (opMatch) params.operation = opMatch[1].trim();

    // Parse <query>
    const queryMatch = content.match(/<query>([^<]+)<\/query>/);
    if (queryMatch) params.query = queryMatch[1].trim();

    // Parse <worker>
    const workerMatch = content.match(/<worker>([^<]+)<\/worker>/);
    if (workerMatch) params.worker = workerMatch[1].trim();

    // Parse <objective>
    const objMatch = content.match(/<objective>([\s\S]*?)<\/objective>/);
    if (objMatch) params.objective = objMatch[1].trim();

    // Parse <context>
    const ctxMatch = content.match(/<context>([\s\S]*?)<\/context>/);
    if (ctxMatch) params.context = ctxMatch[1].trim();

    // Parse <instructions>
    const instrMatch = content.match(/<instructions>([\s\S]*?)<\/instructions>/);
    if (instrMatch) params.instructions = instrMatch[1].trim();

    // Parse <output_format>
    const formatMatch = content.match(/<output_format>([^<]+)<\/output_format>/);
    if (formatMatch) params.output_format = formatMatch[1].trim();

    // Parse <quality_criteria>
    const qualityMatch = content.match(/<quality_criteria>([\s\S]*?)<\/quality_criteria>/);
    if (qualityMatch) {
      params.quality_criteria = qualityMatch[1]
        .split('\n')
        .map(line => line.trim().replace(/^-\s*/, ''))
        .filter(Boolean);
    }

    // Parse <options> block
    const optionsMatch = content.match(/<options>([\s\S]*?)<\/options>/);
    if (optionsMatch) {
      params.options = this.parseOptions(optionsMatch[1]);
    }

    // Parse <params> block
    const paramsMatch = content.match(/<params>([\s\S]*?)<\/params>/);
    if (paramsMatch) {
      const nestedParams = this.parseNestedParams(paramsMatch[1]);
      Object.assign(params, nestedParams);
    }

    return params;
  }

  private static parseOptions(optionsContent: string): Record<string, any> {
    const options: Record<string, any> = {};

    const topKMatch = optionsContent.match(/<top_k>(\d+)<\/top_k>/);
    if (topKMatch) options.top_k = parseInt(topKMatch[1]);

    const thresholdMatch = optionsContent.match(/<threshold>([\d.]+)<\/threshold>/);
    if (thresholdMatch) options.threshold = parseFloat(thresholdMatch[1]);

    const fileFilterMatch = optionsContent.match(/<file_filter>([^<]+)<\/file_filter>/);
    if (fileFilterMatch) options.file_filter = fileFilterMatch[1].trim();

    const filterMatch = optionsContent.match(/<filter>([\s\S]*?)<\/filter>/);
    if (filterMatch) {
      options.filter = this.parseFilter(filterMatch[1]);
    }

    return options;
  }

  private static parseFilter(filterContent: string): Record<string, any> {
    const filter: Record<string, any> = {};
    
    const typeMatch = filterContent.match(/<type>([^<]+)<\/type>/);
    if (typeMatch) filter.type = typeMatch[1].trim();

    return filter;
  }

  private static parseNestedParams(paramsContent: string): Record<string, any> {
    const params: Record<string, any> = {};

    // Match all simple tags
    const tagRegex = /<(\w+)>([^<]*)<\/\1>/g;
    let match;

    while ((match = tagRegex.exec(paramsContent)) !== null) {
      const key = match[1];
      const value = match[2].trim();
      params[key] = value;
    }

    return params;
  }
}

// =============================================================
// XML Tool Executor
// =============================================================

export class XMLToolExecutor {
  private workspace: WorkspaceManager;
  private memory?: MemoryManager;
  private gemini: GeminiClient;
  private files: FileMetadata[];

  constructor(
    workspace: WorkspaceManager,
    gemini: GeminiClient,
    memory?: MemoryManager,
    files: FileMetadata[] = []
  ) {
    this.workspace = workspace;
    this.memory = memory;
    this.gemini = gemini;
    this.files = files;
  }

  /**
   * Execute a parsed tool invocation
   */
  async executeTool(
    toolName: string,
    params: Record<string, any>
  ): Promise<ToolExecutionResult> {
    try {
      switch (toolName) {
        case 'memory_search':
          return await this.executeMemorySearch(params);
        
        case 'knowledge_search':
          return await this.executeKnowledgeSearch(params);
        
        case 'workspace':
          return await this.executeWorkspace(params);
        
        case 'delegate_worker':
          return await this.executeDelegateWorker(params);
        
        default:
          return {
            success: false,
            toolName,
            error: `Unknown tool: ${toolName}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // =============================================================
  // Memory Search
  // =============================================================

  private async executeMemorySearch(params: Record<string, any>): Promise<ToolExecutionResult> {
    if (!this.memory) {
      return {
        success: false,
        toolName: 'memory_search',
        error: 'Memory not available - Vectorize not configured',
      };
    }

    const query = params.query;
    if (!query) {
      return {
        success: false,
        toolName: 'memory_search',
        error: 'Missing required parameter: query',
      };
    }

    const options = params.options || {};
    const results = await this.memory.searchMemory(query, {
      topK: options.top_k || 5,
      threshold: options.threshold || 0.65,
      filter: options.filter,
    });

    if (results.length === 0) {
      return {
        success: true,
        toolName: 'memory_search',
        result: '<memory_result>No relevant past conversations found</memory_result>',
      };
    }

    const formattedResults = results
      .map((r, i) => `<memory_item index="${i + 1}" relevance="${Math.round(r.score * 100)}%">\n${r.content}\n</memory_item>`)
      .join('\n\n');

    return {
      success: true,
      toolName: 'memory_search',
      result: `<memory_results>\n${formattedResults}\n</memory_results>`,
      metadata: { resultsCount: results.length },
    };
  }

  // =============================================================
  // Knowledge Search (RAG with Gemini File Search)
  // =============================================================

  private async executeKnowledgeSearch(params: Record<string, any>): Promise<ToolExecutionResult> {
    const query = params.query;
    if (!query) {
      return {
        success: false,
        toolName: 'knowledge_search',
        error: 'Missing required parameter: query',
      };
    }

    if (this.files.length === 0) {
      return {
        success: false,
        toolName: 'knowledge_search',
        error: 'No documents uploaded for knowledge search',
      };
    }

    // Use Gemini's native file search capability
    const response = await this.gemini.generateWithNativeTools(
      [{ role: 'user', content: query }],
      {
        stream: false,
        useFileSearch: true,
        files: this.files,
        temperature: 0.3,
      }
    );

    return {
      success: true,
      toolName: 'knowledge_search',
      result: `<knowledge_result>\n${response.text}\n</knowledge_result>`,
      metadata: { filesSearched: this.files.length },
    };
  }

  // =============================================================
  // Workspace Operations
  // =============================================================

  private async executeWorkspace(params: Record<string, any>): Promise<ToolExecutionResult> {
    const operation = params.operation;
    if (!operation) {
      return {
        success: false,
        toolName: 'workspace',
        error: 'Missing required parameter: operation',
      };
    }

    switch (operation) {
      case 'list_projects':
        return await this.workspaceListProjects();
      
      case 'create_project':
        return await this.workspaceCreateProject(params);
      
      case 'read_project':
        return await this.workspaceReadProject(params);
      
      case 'update_status':
        return await this.workspaceUpdateStatus(params);
      
      case 'append_note':
        return await this.workspaceAppendNote(params);
      
      case 'save_artifact':
        return await this.workspaceSaveArtifact(params);
      
      case 'search_projects':
        return await this.workspaceSearchProjects(params);
      
      default:
        return {
          success: false,
          toolName: 'workspace',
          error: `Unknown workspace operation: ${operation}`,
        };
    }
  }

  private async workspaceListProjects(): Promise<ToolExecutionResult> {
    const projects = await this.workspace.listProjects();
    
    const formatted = projects
      .map(p => `- **${p.title}** (${p.name})\n  Status: ${p.status} | Progress: ${p.progress}\n  Last updated: ${p.lastUpdated}`)
      .join('\n\n');

    return {
      success: true,
      toolName: 'workspace',
      result: `<workspace_result operation="list_projects">\n${formatted || 'No projects yet'}\n</workspace_result>`,
      metadata: { projectCount: projects.length },
    };
  }

  private async workspaceCreateProject(params: Record<string, any>): Promise<ToolExecutionResult> {
    const name = params.n || params.name;
    const title = params.title;
    
    if (!name || !title) {
      return {
        success: false,
        toolName: 'workspace',
        error: 'Missing required parameters: n (name) and title',
      };
    }

    const project = await this.workspace.createProject(
      name,
      title,
      params.initial_notes
    );

    return {
      success: true,
      toolName: 'workspace',
      result: `<workspace_result operation="create_project">\nProject "${project.title}" created successfully at /projects/${project.name}/\n\nInitial structure:\n- status.md\n- todo.md\n- notes.md\n- artifacts/\n</workspace_result>`,
      metadata: { projectName: project.name },
    };
  }

  private async workspaceReadProject(params: Record<string, any>): Promise<ToolExecutionResult> {
    const projectName = params.project;
    if (!projectName) {
      return {
        success: false,
        toolName: 'workspace',
        error: 'Missing required parameter: project',
      };
    }

    const context = await this.workspace.formatProjectContext(projectName);

    return {
      success: true,
      toolName: 'workspace',
      result: context,
      metadata: { projectName },
    };
  }

  private async workspaceUpdateStatus(params: Record<string, any>): Promise<ToolExecutionResult> {
    const projectName = params.project;
    const content = params.content;
    
    if (!projectName || !content) {
      return {
        success: false,
        toolName: 'workspace',
        error: 'Missing required parameters: project and content',
      };
    }

    await this.workspace.updateStatus(projectName, content);

    return {
      success: true,
      toolName: 'workspace',
      result: `<workspace_result operation="update_status">\nStatus updated for project "${projectName}"\n</workspace_result>`,
      metadata: { projectName },
    };
  }

  private async workspaceAppendNote(params: Record<string, any>): Promise<ToolExecutionResult> {
    const projectName = params.project;
    const note = params.note;
    
    if (!projectName || !note) {
      return {
        success: false,
        toolName: 'workspace',
        error: 'Missing required parameters: project and note',
      };
    }

    await this.workspace.appendNote(projectName, note);

    return {
      success: true,
      toolName: 'workspace',
      result: `<workspace_result operation="append_note">\nNote appended to project "${projectName}"\n</workspace_result>`,
      metadata: { projectName },
    };
  }

  private async workspaceSaveArtifact(params: Record<string, any>): Promise<ToolExecutionResult> {
    const projectName = params.project;
    const filename = params.filename;
    const content = params.content;
    
    if (!projectName || !filename || !content) {
      return {
        success: false,
        toolName: 'workspace',
        error: 'Missing required parameters: project, filename, and content',
      };
    }

    const path = await this.workspace.saveArtifact(projectName, filename, content);

    return {
      success: true,
      toolName: 'workspace',
      result: `<workspace_result operation="save_artifact">\nArtifact saved: ${path}\n</workspace_result>`,
      metadata: { projectName, filename, path },
    };
  }

  private async workspaceSearchProjects(params: Record<string, any>): Promise<ToolExecutionResult> {
    const query = params.query;
    if (!query) {
      return {
        success: false,
        toolName: 'workspace',
        error: 'Missing required parameter: query',
      };
    }

    const results = await this.workspace.searchProjects(query);

    if (results.length === 0) {
      return {
        success: true,
        toolName: 'workspace',
        result: `<workspace_result operation="search_projects">\nNo matches found for "${query}"\n</workspace_result>`,
      };
    }

    const formatted = results
      .map(r => `**${r.project}** (${r.file}):\n${r.matches.map(m => `  - ${m}`).join('\n')}`)
      .join('\n\n');

    return {
      success: true,
      toolName: 'workspace',
      result: `<workspace_result operation="search_projects">\nFound ${results.length} result(s):\n\n${formatted}\n</workspace_result>`,
      metadata: { resultsCount: results.length },
    };
  }

  // =============================================================
  // Worker Delegation
  // =============================================================

  private async executeDelegateWorker(params: Record<string, any>): Promise<ToolExecutionResult> {
    const worker = params.worker as WorkerType;
    const objective = params.objective;
    
    if (!worker || !objective) {
      return {
        success: false,
        toolName: 'delegate_worker',
        error: 'Missing required parameters: worker and objective',
      };
    }

    const envelope: TaskEnvelope = {
      taskId: `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      workerType: worker,
      objective,
      context: params.context || '',
      instructions: params.instructions || '',
      constraints: [],
      expectedOutput: {
        format: (params.output_format as any) || 'markdown',
      },
      qualityCriteria: params.quality_criteria || [],
    };

    return {
      success: true,
      toolName: 'delegate_worker',
      result: '<delegation_initiated>Worker task created and will be executed</delegation_initiated>',
      metadata: { envelope },
    };
  }
}

export default XMLToolExecutor;
