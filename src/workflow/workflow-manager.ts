// src/workflow/workflow-manager.ts - Workflow Template Management with RAG

import { Workspace } from '../workspace/workspace';
import type { GeminiClient } from '../gemini';
import type { VectorizeIndex } from '@cloudflare/workers-types';
import type { WorkflowTemplate, WorkflowStep, TodoDocument, TodoStep } from '../types';

export class WorkflowManager {
  private vectorize: VectorizeIndex | null;
  private gemini: GeminiClient;
  private sessionId: string;
  private templatesBasePath = 'workflows/templates';
  
  // Cache for loaded templates
  private templateCache = new Map<string, WorkflowTemplate>();

  constructor(
    vectorize: VectorizeIndex | null,
    gemini: GeminiClient,
    sessionId: string
  ) {
    this.vectorize = vectorize;
    this.gemini = gemini;
    this.sessionId = sessionId;
  }

  // -----------------------------------------------------------
  // Template Discovery & RAG Search
  // -----------------------------------------------------------

  async searchTemplates(query: string, limit = 3): Promise<WorkflowTemplate[]> {
    if (!this.vectorize) {
      console.warn('[WorkflowManager] Vectorize not available - falling back to list all');
      return await this.listAllTemplates();
    }

    try {
      // Generate query embedding
      const queryEmbedding = await this.gemini.embedText(query, { normalize: true });

      // Search Vectorize
      const results = await this.vectorize.query(queryEmbedding, {
        topK: limit,
        filter: { type: 'workflow_template' },
        returnMetadata: true,
      });

      const templates: WorkflowTemplate[] = [];

      for (const match of results.matches || []) {
        if (match.score >= 0.6) {
          const templateId = match.metadata?.template_id as string;
          if (templateId) {
            const template = await this.getTemplate(templateId);
            if (template) templates.push(template);
          }
        }
      }

      return templates;
    } catch (e) {
      console.error('[WorkflowManager] Search failed:', e);
      return await this.listAllTemplates();
    }
  }

  async listAllTemplates(): Promise<WorkflowTemplate[]> {
    if (!Workspace.isInitialized()) {
      console.warn('[WorkflowManager] Workspace not initialized');
      return [];
    }

    try {
      const files = await Workspace.readdir(this.templatesBasePath);
      const templates: WorkflowTemplate[] = [];

      for (const file of files) {
        if (file.endsWith('.md')) {
          const templateId = file.replace('.md', '');
          const template = await this.getTemplate(templateId);
          if (template) templates.push(template);
        }
      }

      return templates;
    } catch (e) {
      console.warn('[WorkflowManager] List templates failed:', e);
      return [];
    }
  }

  async getTemplate(templateId: string): Promise<WorkflowTemplate | null> {
    // Check cache
    if (this.templateCache.has(templateId)) {
      return this.templateCache.get(templateId)!;
    }

    if (!Workspace.isInitialized()) {
      console.warn('[WorkflowManager] Workspace not initialized');
      return null;
    }

    try {
      const path = `${this.templatesBasePath}/${templateId}.md`;
      const content = await Workspace.readFileText(path);
      const template = this.parseTemplateMarkdown(templateId, content);
      
      // Cache it
      this.templateCache.set(templateId, template);
      
      return template;
    } catch (e) {
      console.error(`[WorkflowManager] Failed to load template ${templateId}:`, e);
      return null;
    }
  }

  // -----------------------------------------------------------
  // Template Indexing (for RAG)
  // -----------------------------------------------------------

  async indexTemplate(templateId: string): Promise<boolean> {
    if (!this.vectorize) {
      console.warn('[WorkflowManager] Vectorize not available - skipping indexing');
      return false;
    }

    try {
      const template = await this.getTemplate(templateId);
      if (!template) return false;

      // Create searchable text
      const searchableText = `
${template.title}
${template.description}
Domain: ${template.domain}
Tools: ${template.tools.join(', ')}
Steps: ${template.steps.map(s => s.title).join(', ')}
      `.trim();

      // Generate embedding
      const embedding = await this.gemini.embedText(searchableText, { normalize: true });

      // Upsert to Vectorize
      await this.vectorize.upsert([{
        id: `workflow_${templateId}`,
        values: embedding,
        metadata: {
          type: 'workflow_template',
          template_id: templateId,
          title: template.title,
          domain: template.domain,
          complexity: template.complexity,
        },
      }]);

      console.log(`[WorkflowManager] Indexed template: ${templateId}`);
      return true;
    } catch (e) {
      console.error(`[WorkflowManager] Failed to index template ${templateId}:`, e);
      return false;
    }
  }

  async indexAllTemplates(): Promise<number> {
    const templates = await this.listAllTemplates();
    let indexed = 0;

    for (const template of templates) {
      const success = await this.indexTemplate(template.id);
      if (success) indexed++;
    }

    console.log(`[WorkflowManager] Indexed ${indexed}/${templates.length} templates`);
    return indexed;
  }

  // -----------------------------------------------------------
  // Project Creation from Template
  // -----------------------------------------------------------

  async createProjectFromTemplate(
    workflowId: string,
    objective: string,
    adaptations?: string
  ): Promise<{ projectId: string; projectPath: string }> {
    if (!Workspace.isInitialized()) {
      throw new Error('[WorkflowManager] Workspace not initialized');
    }

    const template = await this.getTemplate(workflowId);
    if (!template) {
      throw new Error(`[WorkflowManager] Template not found: ${workflowId}`);
    }

    // Generate project ID
    const projectId = `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const projectPath = `${this.sessionId}/${projectId}`;

    try {
      console.log(`[WorkflowManager] Creating project: ${projectId} from ${workflowId}`);

      // Create project structure
      await Workspace.createDirectoryStructure(projectPath, [
        'data',
        'results',
        'artifacts',
      ]);

      // Create adapted todo.md
      const todoDoc = await this.adaptTemplate(template, objective, adaptations);
      await this.saveTodoDocument(projectPath, todoDoc);

      // Create README
      await Workspace.writeFile(
        `${projectPath}/README.md`,
        this.generateReadme(projectId, objective, template)
      );

      console.log(`[WorkflowManager] ✅ Project created: ${projectId}`);
      return { projectId, projectPath };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      throw new Error(`[WorkflowManager] Project creation failed: ${error}`);
    }
  }

  // -----------------------------------------------------------
  // Todo Document Management
  // -----------------------------------------------------------

  async saveTodoDocument(projectPath: string, todo: TodoDocument): Promise<void> {
    const markdown = this.generateTodoMarkdown(todo);
    await Workspace.writeFile(`${projectPath}/todo.md`, markdown);
    console.log(`[WorkflowManager] Saved todo.md for ${todo.projectId}`);
  }

  async loadTodoDocument(projectPath: string): Promise<TodoDocument | null> {
    try {
      const content = await Workspace.readFileText(`${projectPath}/todo.md`);
      return this.parseTodoMarkdown(content);
    } catch (e) {
      console.error('[WorkflowManager] Failed to load todo.md:', e);
      return null;
    }
  }

  async updateStepStatus(
    projectPath: string,
    stepNumber: number,
    status: 'pending' | 'in_progress' | 'completed' | 'skipped',
    notes?: string
  ): Promise<void> {
    const todo = await this.loadTodoDocument(projectPath);
    if (!todo) throw new Error('Todo document not found');

    const step = todo.steps.find(s => s.number === stepNumber);
    if (!step) throw new Error(`Step ${stepNumber} not found`);

    step.status = status;
    if (notes) step.notes = notes;

    if (status === 'in_progress' && !step.startedAt) {
      step.startedAt = Date.now();
    }
    if (status === 'completed' && !step.completedAt) {
      step.completedAt = Date.now();
    }

    todo.updatedAt = Date.now();
    await this.saveTodoDocument(projectPath, todo);
  }

  getCurrentStep(todo: TodoDocument): TodoStep | null {
    // Find in_progress step
    let step = todo.steps.find(s => s.status === 'in_progress');
    if (step) return step;

    // Find next pending step
    step = todo.steps.find(s => s.status === 'pending');
    return step || null;
  }

  getProgress(todo: TodoDocument): { completed: number; total: number; percentage: number } {
    const completed = todo.steps.filter(s => s.status === 'completed').length;
    const total = todo.steps.length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { completed, total, percentage };
  }

  // -----------------------------------------------------------
  // Template Parsing
  // -----------------------------------------------------------

  private parseTemplateMarkdown(templateId: string, markdown: string): WorkflowTemplate {
    // Extract frontmatter
    const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
    let title = templateId;
    let domain = 'General';
    let complexity: 'Simple' | 'Medium' | 'Complex' = 'Medium';
    let estimatedTime = 'Varies';
    let tools: string[] = [];

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      const titleMatch = frontmatter.match(/title:\s*(.+)/);
      const domainMatch = frontmatter.match(/domain:\s*(.+)/);
      const complexityMatch = frontmatter.match(/complexity:\s*(.+)/);
      const timeMatch = frontmatter.match(/estimatedTime:\s*(.+)/);
      const toolsMatch = frontmatter.match(/tools:\s*\[(.*?)\]/);

      if (titleMatch) title = titleMatch[1].trim();
      if (domainMatch) domain = domainMatch[1].trim();
      if (complexityMatch) complexity = complexityMatch[1].trim() as any;
      if (timeMatch) estimatedTime = timeMatch[1].trim();
      if (toolsMatch) tools = toolsMatch[1].split(',').map(t => t.trim());
    }

    // Extract description (first paragraph after frontmatter)
    const contentAfterFrontmatter = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
    const descMatch = contentAfterFrontmatter.match(/^#[^\n]*\n\n([^\n]+)/);
    const description = descMatch ? descMatch[1].trim() : 'No description';

    // Extract steps
    const steps = this.extractStepsFromMarkdown(contentAfterFrontmatter);

    return {
      id: templateId,
      title,
      domain,
      complexity,
      estimatedTime,
      description,
      tools,
      steps,
    };
  }

  private extractStepsFromMarkdown(markdown: string): WorkflowStep[] {
    const steps: WorkflowStep[] = [];
    const stepRegex = /## Step (\d+):\s*([^\n]+)\n([\s\S]*?)(?=\n## Step \d+:|$)/g;
    let match;

    while ((match = stepRegex.exec(markdown)) !== null) {
      const number = parseInt(match[1], 10);
      const title = match[2].trim();
      const content = match[3].trim();

      // Extract description
      const descMatch = content.match(/^([^\n]+)/);
      const description = descMatch ? descMatch[1].trim() : title;

      // Extract outputs
      const outputsMatch = content.match(/\*\*Expected Outputs?\*\*:\s*([^\n]+)/);
      const outputs = outputsMatch
        ? outputsMatch[1].split(',').map(o => o.trim())
        : [];

      // Check if checkpoint
      const checkpoint = content.toLowerCase().includes('checkpoint') ||
                        content.toLowerCase().includes('review');

      steps.push({
        number,
        title,
        description,
        tools: [],
        outputs,
        checkpoint,
        estimatedTurns: 3,
      });
    }

    return steps;
  }

  // -----------------------------------------------------------
  // Template Adaptation
  // -----------------------------------------------------------

  private async adaptTemplate(
    template: WorkflowTemplate,
    objective: string,
    adaptations?: string
  ): Promise<TodoDocument> {
    const todoSteps: TodoStep[] = template.steps.map(step => ({
      number: step.number,
      title: step.title,
      description: step.description,
      status: 'pending',
      checkpoint: step.checkpoint,
      outputs: step.outputs,
    }));

    return {
      objective,
      projectId: '', // Will be set when saving
      workflowId: template.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: todoSteps,
    };
  }

  // -----------------------------------------------------------
  // Markdown Generation
  // -----------------------------------------------------------

  private generateTodoMarkdown(todo: TodoDocument): string {
    const lines: string[] = [];

    lines.push(`# ${todo.objective}`);
    lines.push('');
    lines.push(`**Project ID**: \`${todo.projectId}\``);
    if (todo.workflowId) lines.push(`**Workflow**: ${todo.workflowId}`);
    lines.push(`**Created**: ${new Date(todo.createdAt).toISOString()}`);
    lines.push(`**Updated**: ${new Date(todo.updatedAt).toISOString()}`);
    lines.push('');

    const progress = this.getProgress(todo);
    lines.push('## Progress');
    lines.push('');
    lines.push(`- ✅ Completed: ${progress.completed}/${progress.total}`);
    lines.push(`- 📊 Overall: ${progress.percentage}%`);
    lines.push('');

    lines.push('## Steps');
    lines.push('');

    for (const step of todo.steps) {
      const icon = step.status === 'completed' ? '✅'
                 : step.status === 'in_progress' ? '🔄'
                 : step.status === 'skipped' ? '⏭️'
                 : '⏸️';

      const checkpoint = step.checkpoint ? ' 🚦 **CHECKPOINT**' : '';

      lines.push(`### ${icon} Step ${step.number}: ${step.title}${checkpoint}`);
      lines.push('');
      lines.push(step.description);
      lines.push('');
      lines.push(`**Status**: ${step.status}`);
      lines.push('');

      if (step.outputs.length > 0) {
        lines.push(`**Expected Outputs**: ${step.outputs.join(', ')}`);
        lines.push('');
      }

      if (step.notes) {
        lines.push(`**Notes**: ${step.notes}`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private parseTodoMarkdown(markdown: string): TodoDocument | null {
    try {
      // Extract objective (title)
      const titleMatch = markdown.match(/^# (.+)/m);
      const objective = titleMatch ? titleMatch[1].trim() : 'Unknown Objective';

      // Extract project ID
      const projectIdMatch = markdown.match(/\*\*Project ID\*\*:\s*`([^`]+)`/);
      const projectId = projectIdMatch ? projectIdMatch[1].trim() : '';

      // Extract workflow ID
      const workflowIdMatch = markdown.match(/\*\*Workflow\*\*:\s*(.+)/);
      const workflowId = workflowIdMatch ? workflowIdMatch[1].trim() : undefined;

      // Extract timestamps
      const createdMatch = markdown.match(/\*\*Created\*\*:\s*(.+)/);
      const updatedMatch = markdown.match(/\*\*Updated\*\*:\s*(.+)/);
      const createdAt = createdMatch ? new Date(createdMatch[1].trim()).getTime() : Date.now();
      const updatedAt = updatedMatch ? new Date(updatedMatch[1].trim()).getTime() : Date.now();

      // Extract steps
      const steps: TodoStep[] = [];
      const stepRegex = /### [^\s]+ Step (\d+):\s*([^\n🚦]+)(?:🚦\s*\*\*CHECKPOINT\*\*)?\n([\s\S]*?)(?=\n### |$)/g;
      let match;

      while ((match = stepRegex.exec(markdown)) !== null) {
        const number = parseInt(match[1], 10);
        const title = match[2].trim();
        const content = match[3].trim();

        const statusMatch = content.match(/\*\*Status\*\*:\s*(\w+)/);
        const status = (statusMatch ? statusMatch[1] : 'pending') as TodoStep['status'];

        const outputsMatch = content.match(/\*\*Expected Outputs\*\*:\s*([^\n]+)/);
        const outputs = outputsMatch
          ? outputsMatch[1].split(',').map(o => o.trim())
          : [];

        const notesMatch = content.match(/\*\*Notes\*\*:\s*([^\n]+)/);
        const notes = notesMatch ? notesMatch[1].trim() : undefined;

        const checkpoint = match[0].includes('🚦');

        const descMatch = content.match(/^([^\n]+)/);
        const description = descMatch ? descMatch[1].trim() : title;

        steps.push({
          number,
          title,
          description,
          status,
          checkpoint,
          outputs,
          notes,
        });
      }

      return {
        objective,
        projectId,
        workflowId,
        createdAt,
        updatedAt,
        steps,
      };
    } catch (e) {
      console.error('[WorkflowManager] Failed to parse todo.md:', e);
      return null;
    }
  }

  private generateReadme(projectId: string, objective: string, template: WorkflowTemplate): string {
    return `# ${objective}

**Project ID**: \`${projectId}\`
**Workflow Template**: ${template.title}

## Overview
${template.description}

## Project Structure

- \`todo.md\` - Step-by-step plan and progress tracker
- \`data/\` - Raw data, research, intermediate files
- \`results/\` - Final deliverables
- \`artifacts/\` - Code, visualizations, tools

## Workflow Steps

${template.steps.map(s => `${s.number}. ${s.title}`).join('\n')}

## Progress

See \`todo.md\` for current progress and step details.

---
*Generated by ORION AI-Collaborator*
`;
  }
}

export default WorkflowManager;
