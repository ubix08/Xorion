// src/workspace/workspace-manager.ts - Project-based Workspace Management

import { B2Workspace } from './workspace';

export interface Project {
  name: string;
  title: string;
  status: 'active' | 'paused' | 'completed';
  progress: string;
  lastUpdated: string;
}

export interface ProjectStructure {
  statusMd: string;
  todoMd: string;
  notesMd: string;
  artifacts: string[];
}

/**
 * WorkspaceManager - Manages project-based file organization in Backblaze B2
 * All projects are stored under /projects/<kebab-case-name>/
 */
export class WorkspaceManager {
  private readonly ACTIVE_PROJECTS_FILE = 'active-projects.json';
  private readonly PROJECTS_ROOT = 'projects';
  private workspace: B2Workspace | null = null;

  constructor() {}

  private getWorkspace(): B2Workspace {
    if (!this.workspace) {
      throw new Error('Workspace not initialized - B2 credentials required');
    }
    return this.workspace;
  }

  // Initialize with environment
  init(env: any): void {
    if (env.B2_KEY_ID && env.B2_APPLICATION_KEY && env.B2_S3_ENDPOINT && env.B2_BUCKET) {
      this.workspace = new B2Workspace(env);
    }
  }

  // =============================================================
  // Project Management
  // =============================================================

  /**
   * List all active projects from active-projects.json
   */
  async listProjects(): Promise<Project[]> {
    if (!this.workspace) return [];
    
    try {
      const exists = await this.workspace.exists(this.ACTIVE_PROJECTS_FILE);
      if (!exists) {
        return [];
      }

      const content = await this.workspace.read(this.ACTIVE_PROJECTS_FILE);
      return JSON.parse(content) as Project[];
    } catch (error) {
      console.error('[Workspace] Failed to list projects:', error);
      return [];
    }
  }

  /**
   * Get a specific project by name
   */
  async getProject(projectName: string): Promise<Project | null> {
    const projects = await this.listProjects();
    return projects.find(p => p.name === projectName) || null;
  }

  /**
   * Create a new project with initial structure
   */
  async createProject(
    name: string,
    title: string,
    initialNotes?: string
  ): Promise<Project> {
    const ws = this.getWorkspace();
    const kebabName = this.toKebabCase(name);
    const projectPath = `${this.PROJECTS_ROOT}/${kebabName}`;

    // Create project directory structure
    await ws.mkdir(`${projectPath}/`);
    await ws.mkdir(`${projectPath}/artifacts/`);

    // Create initial files
    const now = new Date().toISOString().split('T')[0];

    await ws.write(
      `${projectPath}/status.md`,
      `# ${title}\n\n**Status:** Active\n**Created:** ${now}\n\n## Current Progress\n\nProject initialized.\n\n## Next Steps\n\n- Define project scope\n- Create initial tasks\n`
    );

    await ws.write(
      `${projectPath}/todo.md`,
      `# TODO - ${title}\n\n## High Priority\n\n- [ ] Define project scope\n\n## Medium Priority\n\n## Low Priority\n\n## Completed\n\n`
    );

    await ws.write(
      `${projectPath}/notes.md`,
      `# Notes - ${title}\n\n${initialNotes || 'Project notes and research snippets go here.'}\n`
    );

    // Update active-projects.json
    const project: Project = {
      name: kebabName,
      title,
      status: 'active',
      progress: 'Project initialized',
      lastUpdated: now,
    };

    await this.updateProjectRegistry(project);

    return project;
  }

  /**
   * Update project status in active-projects.json
   */
  async updateProject(
    projectName: string,
    updates: Partial<Pick<Project, 'title' | 'status' | 'progress'>>
  ): Promise<Project> {
    const ws = this.getWorkspace();
    const projects = await this.listProjects();
    const index = projects.findIndex(p => p.name === projectName);

    if (index === -1) {
      throw new Error(`Project "${projectName}" not found`);
    }

    const updated: Project = {
      ...projects[index],
      ...updates,
      lastUpdated: new Date().toISOString().split('T')[0],
    };

    projects[index] = updated;

    await ws.write(
      this.ACTIVE_PROJECTS_FILE,
      JSON.stringify(projects, null, 2)
    );

    return updated;
  }

  /**
   * Read project structure (status, todo, notes)
   */
  async readProjectStructure(projectName: string): Promise<ProjectStructure> {
    const projectPath = `${this.PROJECTS_ROOT}/${projectName}`;

    const [statusMd, todoMd, notesMd, artifactFiles] = await Promise.all([
      this.safeReadFile(`${projectPath}/status.md`, '# Status\n\nNo status file found.'),
      this.safeReadFile(`${projectPath}/todo.md`, '# TODO\n\nNo tasks defined.'),
      this.safeReadFile(`${projectPath}/notes.md`, '# Notes\n\nNo notes available.'),
      this.listArtifacts(projectName),
    ]);

    return {
      statusMd,
      todoMd,
      notesMd,
      artifacts: artifactFiles,
    };
  }

  /**
   * Update status.md file
   */
  async updateStatus(projectName: string, statusContent: string): Promise<void> {
    const ws = this.getWorkspace();
    const projectPath = `${this.PROJECTS_ROOT}/${projectName}`;
    await ws.write(`${projectPath}/status.md`, statusContent);

    // Update lastUpdated in registry
    await this.updateProject(projectName, {
      lastUpdated: new Date().toISOString().split('T')[0],
    });
  }

  /**
   * Update todo.md file
   */
  async updateTodo(projectName: string, todoContent: string): Promise<void> {
    const ws = this.getWorkspace();
    const projectPath = `${this.PROJECTS_ROOT}/${projectName}`;
    await ws.write(`${projectPath}/todo.md`, todoContent);
  }

  /**
   * Append to notes.md file
   */
  async appendNote(projectName: string, note: string): Promise<void> {
    const ws = this.getWorkspace();
    const projectPath = `${this.PROJECTS_ROOT}/${projectName}`;
    const timestamp = new Date().toISOString();
    const noteEntry = `\n\n---\n**${timestamp}**\n\n${note}\n`;
    await ws.append(`${projectPath}/notes.md`, noteEntry);
  }

  // =============================================================
  // Artifact Management
  // =============================================================

  /**
   * Save an artifact to the project
   */
  async saveArtifact(
    projectName: string,
    filename: string,
    content: string | ArrayBuffer | Uint8Array,
    mimeType = 'text/plain'
  ): Promise<string> {
    const ws = this.getWorkspace();
    const projectPath = `${this.PROJECTS_ROOT}/${projectName}`;
    const artifactPath = `${projectPath}/artifacts/${filename}`;

    const contentStr = typeof content === 'string' 
      ? content 
      : content instanceof Uint8Array 
        ? content 
        : new Uint8Array(content);

    await ws.write(artifactPath, contentStr, mimeType);

    return artifactPath;
  }

  /**
   * List all artifacts in a project
   */
  async listArtifacts(projectName: string): Promise<string[]> {
    if (!this.workspace) return [];
    
    try {
      const projectPath = `${this.PROJECTS_ROOT}/${projectName}`;
      const result = await this.workspace.ls(`${projectPath}/artifacts/`);
      return result.files.map(f => f.name);
    } catch (error) {
      console.error('[Workspace] Failed to list artifacts:', error);
      return [];
    }
  }

  /**
   * Read an artifact
   */
  async readArtifact(projectName: string, filename: string): Promise<string> {
    const ws = this.getWorkspace();
    const projectPath = `${this.PROJECTS_ROOT}/${projectName}`;
    return await ws.read(`${projectPath}/artifacts/${filename}`);
  }

  /**
   * Delete an artifact
   */
  async deleteArtifact(projectName: string, filename: string): Promise<void> {
    const ws = this.getWorkspace();
    const projectPath = `${this.PROJECTS_ROOT}/${projectName}`;
    await ws.rm(`${projectPath}/artifacts/${filename}`);
  }

  // =============================================================
  // Search and Discovery
  // =============================================================

  /**
   * Search across all project notes and status files
   */
  async searchProjects(query: string): Promise<Array<{
    project: string;
    file: string;
    matches: string[];
  }>> {
    const projects = await this.listProjects();
    const results: Array<{ project: string; file: string; matches: string[] }> = [];
    const queryLower = query.toLowerCase();

    for (const project of projects) {
      const structure = await this.readProjectStructure(project.name);

      const files = [
        { name: 'status.md', content: structure.statusMd },
        { name: 'todo.md', content: structure.todoMd },
        { name: 'notes.md', content: structure.notesMd },
      ];

      for (const file of files) {
        const lines = file.content.split('\n');
        const matches = lines.filter(line => 
          line.toLowerCase().includes(queryLower)
        );

        if (matches.length > 0) {
          results.push({
            project: project.name,
            file: file.name,
            matches: matches.slice(0, 3), // Top 3 matches
          });
        }
      }
    }

    return results;
  }

  // =============================================================
  // Utilities
  // =============================================================

  private async updateProjectRegistry(project: Project): Promise<void> {
    const ws = this.getWorkspace();
    const projects = await this.listProjects();
    const existing = projects.findIndex(p => p.name === project.name);

    if (existing >= 0) {
      projects[existing] = project;
    } else {
      projects.push(project);
    }

    await ws.write(
      this.ACTIVE_PROJECTS_FILE,
      JSON.stringify(projects, null, 2)
    );
  }

  private async safeReadFile(path: string, fallback: string): Promise<string> {
    if (!this.workspace) return fallback;
    
    try {
      return await this.workspace.read(path);
    } catch {
      return fallback;
    }
  }

  private toKebabCase(str: string): string {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Format project context for Orion to understand current state
   */
  async formatProjectContext(projectName: string): Promise<string> {
    const project = await this.getProject(projectName);
    if (!project) {
      return `<project_error>Project "${projectName}" not found</project_error>`;
    }

    const structure = await this.readProjectStructure(projectName);

    return `<project_context>
<project_name>${project.title}</project_name>
<status>${project.status}</status>
<progress>${project.progress}</progress>
<last_updated>${project.lastUpdated}</last_updated>

<current_status>
${structure.statusMd}
</current_status>

<todo_list>
${structure.todoMd}
</todo_list>

<notes>
${structure.notesMd.substring(0, 1000)}${structure.notesMd.length > 1000 ? '...' : ''}
</notes>

<artifacts>
${structure.artifacts.length > 0 ? structure.artifacts.join(', ') : 'No artifacts yet'}
</artifacts>
</project_context>`;
  }
}

export default WorkspaceManager;
