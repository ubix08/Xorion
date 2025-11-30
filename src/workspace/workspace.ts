// src/workspace/workspace.ts - B2 Workspace with Singleton Pattern

import { AwsClient } from 'aws4fetch';
import type { Env } from '../types';

/**
 * B2Workspace Implementation
 * Single dedicated Backblaze B2 workspace with proper singleton pattern
 */
class WorkspaceImpl {
  private s3: AwsClient;
  private endpoint: string;
  private bucket: string;
  private basePath: string;

  constructor(env: Env) {
    this.s3 = new AwsClient({
      accessKeyId: env.B2_KEY_ID as string,
      secretAccessKey: env.B2_APPLICATION_KEY as string,
    });

    this.endpoint = (env.B2_S3_ENDPOINT as string).replace(/\/$/, '');
    this.bucket = env.B2_BUCKET as string;

    const customPath = env.B2_BASE_PATH as string | undefined;
    this.basePath = customPath !== undefined 
      ? (customPath.trim() === '' ? '' : customPath.replace(/\/+$/, '') + '/')
      : 'orion-workspace/';
  }

  // -----------------------------------------------------------
  // Path Sanitization (Security Fix)
  // -----------------------------------------------------------

  private sanitizePath(path: string): string {
    // Remove leading slashes
    let clean = path.replace(/^\/+/, '');
    
    // Resolve .. and . components
    const parts = clean.split('/').filter(p => p && p !== '.');
    const resolved: string[] = [];
    
    for (const part of parts) {
      if (part === '..') {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }
    
    return resolved.join('/');
  }

  private getKey(path: string): string {
    const sanitized = this.sanitizePath(path);
    const normalized = sanitized.replace(/^\/+/, '').replace(/\/+$/, '');
    return normalized ? `${this.basePath}${normalized}` : this.basePath.replace(/\/$/, '');
  }

  private getKeyWithTrailingSlash(path: string): string {
    const key = this.getKey(path);
    return key.endsWith('/') ? key : `${key}/`;
  }

  // -----------------------------------------------------------
  // Directory Operations
  // -----------------------------------------------------------

  async mkdir(path: string): Promise<void> {
    if (!path.trim()) throw new Error('Path cannot be empty');
    const key = this.getKeyWithTrailingSlash(path);
    const url = `${this.endpoint}/${this.bucket}/${key}`;

    const resp = await this.s3.fetch(url, {
      method: 'PUT',
      body: new Uint8Array(0),
      headers: { 'Content-Length': '0' },
    });

    if (!resp.ok) {
      throw new Error(`mkdir failed (${resp.status}): ${await resp.text()}`);
    }
  }

  async ls(path: string = ''): Promise<{
    directories: string[];
    files: { name: string; size: number; modified: Date }[];
  }> {
    const prefix = this.getKeyWithTrailingSlash(path);
    const encodedPrefix = encodeURIComponent(prefix);
    const url = `${this.endpoint}/${this.bucket}?list-type=2&delimiter=/&prefix=${encodedPrefix}`;

    const resp = await this.s3.fetch(url);
    if (!resp.ok) {
      throw new Error(`ls failed (${resp.status}): ${await resp.text()}`);
    }

    const xml = await resp.text();
    const doc = new DOMParser().parseFromString(xml, 'application/xml');

    const directories: string[] = [];
    doc.querySelectorAll('CommonPrefixes Prefix').forEach(node => {
      let p = (node.textContent || '').slice(prefix.length);
      if (p.endsWith('/')) p = p.slice(0, -1);
      if (p) directories.push(p);
    });

    const files: { name: string; size: number; modified: Date }[] = [];
    doc.querySelectorAll('Contents').forEach(content => {
      const keyNode = content.querySelector('Key');
      const sizeNode = content.querySelector('Size');
      const dateNode = content.querySelector('LastModified');

      const fullKey = keyNode?.textContent || '';
      const name = fullKey.slice(prefix.length);

      if (!name || name.endsWith('/')) return;

      files.push({
        name,
        size: Number(sizeNode?.textContent || 0),
        modified: new Date(dateNode?.textContent || 0),
      });
    });

    return { directories, files };
  }

  // -----------------------------------------------------------
  // File Operations
  // -----------------------------------------------------------

  async read(path: string): Promise<string> {
    const key = this.getKey(path);
    const url = `${this.endpoint}/${this.bucket}/${key}`;
    const resp = await this.s3.fetch(url);

    if (resp.status === 404) {
      throw new Error(`File not found: ${path}`);
    }
    if (!resp.ok) {
      throw new Error(`read failed (${resp.status}): ${await resp.text()}`);
    }

    return await resp.text();
  }

  async write(
    path: string,
    content: string | Uint8Array,
    mimeType = 'text/plain;charset=utf-8'
  ): Promise<void> {
    const key = this.getKey(path);
    const url = `${this.endpoint}/${this.bucket}/${key}`;

    const resp = await this.s3.fetch(url, {
      method: 'PUT',
      body: typeof content === 'string' ? content : content,
      headers: { 'Content-Type': mimeType },
    });

    if (!resp.ok) {
      throw new Error(`write failed (${resp.status}): ${await resp.text()}`);
    }
  }

  async append(path: string, content: string): Promise<void> {
    let current = '';
    try {
      current = await this.read(path);
    } catch (e: any) {
      if (!e.message.includes('not found')) throw e;
    }
    await this.write(path, current + content);
  }

  update = this.write;

  async rm(path: string): Promise<void> {
    if (!path.trim()) {
      throw new Error('Cannot delete the workspace root');
    }

    const prefix = this.getKeyWithTrailingSlash(path);
    const encodedPrefix = encodeURIComponent(prefix);

    let marker: string | undefined;
    do {
      let listUrl = `${this.endpoint}/${this.bucket}?prefix=${encodedPrefix}&list-type=2`;
      if (marker) {
        listUrl += `&marker=${encodeURIComponent(marker)}`;
      }

      const listResp = await this.s3.fetch(listUrl);
      if (!listResp.ok) {
        throw new Error('List during delete failed');
      }

      const xml = await listResp.text();
      const doc = new DOMParser().parseFromString(xml, 'application/xml');

      const keys = Array.from(doc.querySelectorAll('Contents Key'))
        .map(n => n.textContent || '')
        .filter(Boolean);

      marker = doc.querySelector('NextMarker')?.textContent || undefined;

      await Promise.all(
        keys.map(key =>
          this.s3.fetch(`${this.endpoint}/${this.bucket}/${key}`, {
            method: 'DELETE',
          })
        )
      );
    } while (marker);
  }

  async exists(path: string): Promise<'file' | 'directory' | false> {
    // Check as file
    const fileKey = this.getKey(path);
    let resp = await this.s3.fetch(
      `${this.endpoint}/${this.bucket}/${fileKey}`,
      { method: 'HEAD' }
    );
    if (resp.ok) return 'file';

    // Check as directory (placeholder)
    const dirKey = this.getKeyWithTrailingSlash(path);
    resp = await this.s3.fetch(
      `${this.endpoint}/${this.bucket}/${dirKey}`,
      { method: 'HEAD' }
    );
    if (resp.ok) return 'directory';

    // Check if directory has contents
    try {
      const listing = await this.ls(path);
      if (listing.files.length > 0 || listing.directories.length > 0) {
        return 'directory';
      }
    } catch {
      // ignore
    }

    return false;
  }
}

// =============================================================
// Singleton Wrapper
// =============================================================

class WorkspaceSingleton {
  private static instance: WorkspaceImpl | null = null;

  static initialize(env: Env): void {
    if (!this.instance) {
      this.instance = new WorkspaceImpl(env);
      console.log('[Workspace] Initialized successfully');
    }
  }

  static isInitialized(): boolean {
    return this.instance !== null;
  }

  static async readdir(path: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.ls(path);
  }

  static async readFileText(path: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.read(path);
  }

  static async writeFile(path: string, content: string | Uint8Array, mimeType?: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.write(path, content, mimeType);
  }

  static async appendFile(path: string, content: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.append(path, content);
  }

  static async unlink(path: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.rm(path);
  }

  static async mkdir(path: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.mkdir(path);
  }

  static async exists(path: string) {
    if (!this.instance) throw new Error('Workspace not initialized');
    return this.instance.exists(path);
  }

  static async createDirectoryStructure(base: string, dirs: string[]): Promise<void> {
    for (const dir of dirs) {
      await this.mkdir(`${base}/${dir}`);
    }
  }
}

export { WorkspaceSingleton as Workspace };
export default WorkspaceSingleton;
