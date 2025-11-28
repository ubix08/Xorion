// src/workspace/project-manager.ts - Project and Workspace Management

import { Workspace } from './workspace';
import type { TodoPlan, TodoTask, ProjectInfo } from '../types';

export class ProjectManager {
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  // -----------------------------------------------------------
  // Project Creation
  // -----------------------------------------------------------

  async createProject(objective: string): Promise<{ projectId: string; todoPath: string }> {
    const projectId = `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const basePath = `${this.sessionId}/${projectId}`;

    // Create project directory structure
    await Workspace.mkdir(`${basePath}/`);
    await Workspace.mkdir(`${basePath}/results/`);
    await Workspace.mkdir(`${basePath}/research/`);
    await Workspace.mkdir(`${basePath}/code/`);
    await Workspace.mkdir(`${basePath}/reports/`);

    // Create initial todo.json
    const todoPlan: TodoPlan = {
      objective,
      project_id: projectId,
      created_at: Date.now(),
      updated_at: Date.now(),
      tasks: [],
    };

    const todoPath = `${basePath}/todo.json`;
    await this.saveTodoPlan(todoPath, todoPlan);

    // Create plan.md summary
    await Workspace.writeFile(
      `${basePath}/plan.md`,
      `# Project: ${objective}\n\nCreated: ${new Date().toISOString()}\n\n## Tasks\n\n_Planning in progress..._`
    );

    console.log(`[ProjectManager] Created project: ${projectId}`);
    return { projectId, todoPath };
  }

  // -----------------------------------------------------------
  // Todo Plan Management
  // -----------------------------------------------------------

  async saveTodoPlan(todoPath: string, plan: TodoPlan): Promise<void> {
    plan.updated_at = Date.now();
    await Workspace.writeFile(todoPath, JSON.stringify(plan, null, 2));
    
    // Also update human-readable plan.md
    await this.updatePlanMarkdown(todoPath, plan);
  }

  async loadTodoPlan(todoPath: string): Promise<TodoPlan> {
    try {
      const content = await Workspace.readFileText(todoPath);
      return JSON.parse(content);
    } catch (e) {
      throw new Error(`Failed to load todo plan: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async updateTask(todoPath: string, taskId: number, updates: Partial<TodoTask>): Promise<void> {
    const plan = await this.loadTodoPlan(todoPath);
    const task = plan.tasks.find(t => t.id === taskId);
    
    if (!task) {
      throw new Error(`Task ${taskId} not found in plan`);
    }

    Object.assign(task, updates);
    await this.saveTodoPlan(todoPath, plan);
  }

  async getCurrentTask(todoPath: string): Promise<TodoTask | null> {
    const plan = await this.loadTodoPlan(todoPath);
    
    // First, look for in-progress task
    let task = plan.tasks.find(t => t.status === 'in_progress');
    if (task) return task;

    // Then, look for next pending task with satisfied dependencies
    for (const t of plan.tasks) {
      if (t.status === 'pending') {
        const depsOk = await this.areDependenciesSatisfied(plan, t);
        if (depsOk) return t;
      }
    }

    return null;
  }

  async getProgress(todoPath: string): Promise<{ completed: number; total: number; percentage: number }> {
    const plan = await this.loadTodoPlan(todoPath);
    const total = plan.tasks.length;
    const completed = plan.tasks.filter(t => t.status === 'completed').length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    return { completed, total, percentage };
  }

  private async areDependenciesSatisfied(plan: TodoPlan, task: TodoTask): Promise<boolean> {
    if (!task.dependencies || task.dependencies.length === 0) return true;

    for (const depId of task.dependencies) {
      const depTask = plan.tasks.find(t => t.id === depId);
      if (!depTask || depTask.status !== 'completed') {
        return false;
      }
    }

    return true;
  }

  // -----------------------------------------------------------
  // File Operations
  // -----------------------------------------------------------

  async saveToWorkspace(
    projectId: string,
    category: 'results' | 'research' | 'code' | 'reports',
    filename: string,
    content: string
  ): Promise<string> {
    const path = `${this.sessionId}/${projectId}/${category}/${filename}`;
    await Workspace.writeFile(path, content);
    return path;
  }

  async loadFromWorkspace(projectId: string, path: string): Promise<string> {
    const fullPath = `${this.sessionId}/${projectId}/${path}`;
    return await Workspace.readFileText(fullPath);
  }

  async listWorkspaceFiles(projectId: string, category?: string): Promise<string[]> {
    const basePath = category 
      ? `${this.sessionId}/${projectId}/${category}/`
      : `${this.sessionId}/${projectId}/`;
    
    try {
      return await Workspace.readdir(basePath);
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------
  // Project Info
  // -----------------------------------------------------------

  async getProjectInfo(projectId: string): Promise<ProjectInfo | null> {
    try {
      const todoPath = `${this.sessionId}/${projectId}/todo.json`;
      const plan = await this.loadTodoPlan(todoPath);
      const progress = await this.getProgress(todoPath);

      return {
        projectId,
        objective: plan.objective,
        state: this.inferStateFromPlan(plan),
        createdAt: plan.created_at,
        updatedAt: plan.updated_at,
        tasksTotal: progress.total,
        tasksCompleted: progress.completed,
        workspacePath: `${this.sessionId}/${projectId}`,
      };
    } catch {
      return null;
    }
  }

  private inferStateFromPlan(plan: TodoPlan): import('../types').AgentState {
    const hasInProgress = plan.tasks.some(t => t.status === 'in_progress');
    const allCompleted = plan.tasks.every(t => t.status === 'completed');
    
    if (allCompleted) return 'completion';
    if (hasInProgress || plan.tasks.some(t => t.status === 'completed')) return 'execution';
    return 'planning';
  }

  // -----------------------------------------------------------
  // Markdown Summary
  // -----------------------------------------------------------

  private async updatePlanMarkdown(todoPath: string, plan: TodoPlan): Promise<void> {
    const projectPath = todoPath.replace('/todo.json', '');
    const markdown = this.generatePlanMarkdown(plan);
    await Workspace.writeFile(`${projectPath}/plan.md`, markdown);
  }

  private generatePlanMarkdown(plan: TodoPlan): string {
    const lines: string[] = [];
    
    lines.push(`# ${plan.objective}`);
    lines.push('');
    lines.push(`**Project ID**: ${plan.project_id}`);
    lines.push(`**Created**: ${new Date(plan.created_at).toISOString()}`);
    lines.push(`**Updated**: ${new Date(plan.updated_at).toISOString()}`);
    lines.push('');
    lines.push('## Tasks');
    lines.push('');

    for (const task of plan.tasks) {
      const icon = task.status === 'completed' ? '✅' 
                 : task.status === 'in_progress' ? '🔄'
                 : task.status === 'failed' ? '❌'
                 : '⏸️';
      
      const checkpoint = task.checkpoint ? ' 🚦 **CHECKPOINT**' : '';
      lines.push(`${icon} **Task ${task.id}**: ${task.description}${checkpoint}`);
      
      if (task.checkpoint_question) {
        lines.push(`   - *Checkpoint Question*: ${task.checkpoint_question}`);
      }
      
      if (task.dependencies && task.dependencies.length > 0) {
        lines.push(`   - *Dependencies*: Tasks ${task.dependencies.join(', ')}`);
      }
    }

    return lines.join('\n');
  }
}

export default ProjectManager;
