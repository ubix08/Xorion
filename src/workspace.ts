// src/workspace.ts
import { AwsClient } from 'aws4fetch';

/**
 * B2Workspace - Single dedicated Backblaze B2 workspace for your agent (one user = one workspace)
 * 
 * → No session isolation anymore
 * → All files/dirs live under one prefix (default: orion-workspace/)
 * → You can change the prefix to '' (empty string) in your env to use the bucket root
 * → Perfect for personal agent - everything is shared forever
 */

export class B2Workspace {
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

    // Change this if you want a different root folder
    // Set B2_BASE_PATH='' in your env to use the bucket root directly
    const customPath = env.B2_BASE_PATH as string | undefined;
    this.basePath = customPath !== undefined 
      ? (customPath.trim() === '' ? '' : customPath.replace(/\/+$/, '/') + '/')
      : 'orion-workspace/';
  }

  private getKey(path: string): string {
    const normalized = path.replace(/^\/+/, '').replace(/\/+$/, '');
    return normalized ? `${this.basePath}${normalized}` : this.basePath.replace(/\/$/, '');
  }

  private getKeyWithTrailingSlash(path: string): string {
    const key = this.getKey(path);
    return key.endsWith('/') ? key : `${key}/`;
  }

  async mkdir(path: string): Promise<void> {
    if (!path.trim()) throw new Error('Path cannot be empty');
    const key = this.getKeyWithTrailingSlash(path);
    const url = `${this.endpoint}/${this.bucket}/${key}`;

    const resp = await this.s3.fetch(url, {
      method: 'PUT',
      body: new Uint8Array(0),
      headers: { 'Content-Length': '0' },
    });

    if (!resp.ok) throw new Error(`mkdir failed (${resp.status}): ${await resp.text()}`);
  }

  async ls(path: string = ''): Promise<{
    directories: string[];
    files: { name: string; size: number; modified: Date }[]
  }> {
    const prefix = this.getKeyWithTrailingSlash(path);
    const encodedPrefix = encodeURIComponent(prefix);
    const url = `${this.endpoint}/${this.bucket}?list-type=2&delimiter=/&prefix=${encodedPrefix}`;

    const resp = await this.s3.fetch(url);
    if (!resp.ok) throw new Error(`ls failed (${resp.status}): ${await resp.text()}`);

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

      // Skip directory placeholders and empty names
      if (!name || name.endsWith('/')) return;

      files.push({
        name,
        size: Number(sizeNode?.textContent || 0),
        modified: new Date(dateNode?.textContent || 0),
      });
    });

    return { directories, files };
  }

  async read(path: string): Promise<string> {
    const key = this.getKey(path);
    const url = `${this.endpoint}/${this.bucket}/${key}`;
    const resp = await this.s3.fetch(url);

    if (resp.status === 404) throw new Error(`File not found: ${path}`);
    if (!resp.ok) throw new Error(`read failed (${resp.status}): ${await resp.text()}`);

    return await resp.text();
  }

  async write(path: string, content: string | Uint8Array, mimeType = 'text/plain;charset=utf-8'): Promise<void> {
    const key = this.getKey(path);
    const url = `${this.endpoint}/${this.bucket}/${key}`;

    const resp = await this.s3.fetch(url, {
      method: 'PUT',
      body: typeof content === 'string' ? content : content,
      headers: { 'Content-Type': mimeType },
    });

    if (!resp.ok) throw new Error(`write failed (${resp.status}): ${await resp.text()}`);
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
    if (!path.trim()) throw new Error('Cannot delete the workspace root');

    const prefix = this.getKeyWithTrailingSlash(path);
    const encodedPrefix = encodeURIComponent(prefix);

    let marker: string | undefined;
    do {
      let listUrl = `${this.endpoint}/${this.bucket}?prefix=${encodedPrefix}&list-type=2`;
      if (marker) listUrl += `&marker=${encodeURIComponent(marker)}`;

      const listResp = await this.s3.fetch(listUrl);
      if (!listResp.ok) throw new Error('List during delete failed');

      const xml = await listResp.text();
      const doc = new DOMParser().parseFromString(xml, 'application/xml');

      const keys = Array.from(doc.querySelectorAll('Contents Key'))
        .map(n => n.textContent || '')
        .filter(Boolean);

      marker = doc.querySelector('NextMarker')?.textContent || undefined;

      await Promise.all(
        keys.map(key => this.s3.fetch(`${this.endpoint}/${this.bucket}/${key}`, { method: 'DELETE' }))
      );
    } while (marker);
  }

  async exists(path: string): Promise<'file' | 'directory' | false> {
    // Check as file
    const fileKey = this.getKey(path);
    let resp = await this.s3.fetch(`${this.endpoint}/${this.bucket}/${fileKey}`, { method: 'HEAD' });
    if (resp.ok) return 'file';

    // Check as directory (placeholder)
    const dirKey = this.getKeyWithTrailingSlash(path);
    resp = await this.s3.fetch(`${this.endpoint}/${this.bucket}/${dirKey}`, { method: 'HEAD' });
    if (resp.ok) return 'directory';

    // Check if directory has contents (no placeholder needed)
    try {
      const listing = await this.ls(path);
      if (listing.files.length > 0 || listing.directories.length > 0) return 'directory';
    } catch {
      // ignore
    }

    return false;
  }
}
export default B2Workspace;
