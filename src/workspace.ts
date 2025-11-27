// src/workspace.ts
import { AwsClient } from 'aws4fetch';

/**
 * B2Workspace - Dedicated Backblaze B2 workspace for the Orion agent
 * 
 * Features:
 * - Full file system emulation (directories are virtual via prefixes + optional empty placeholder objects ending in /)
 * - All operations are async and throw descriptive errors on failure
 * - Per-session isolation by default (base path = orion-workspace/{sessionId}/)
 * - Works perfectly on Cloudflare Workers free tier (aws4fetch is tiny, no heavy deps)
 * - Text-first but supports binary via Uint8Array/Blob if needed
 * 
 * Required environment variables (add to your wrangler.toml or dashboard):
 *   B2_KEY_ID            - Application Key ID
 *   B2_APPLICATION_KEY   - Application Key (secret)
 *   B2_S3_ENDPOINT       - e.g. https://s3.us-west-000.backblazeb2.com
 *   B2_BUCKET            - Your bucket name
 */

export class B2Workspace {
  private s3: AwsClient;
  private endpoint: string;
  private bucket: string;
  private basePath: string;

  constructor(env: Env, sessionId?: string) {
    this.s3 = new AwsClient({
      accessKeyId: env.B2_KEY_ID as string,
      secretAccessKey: env.B2_APPLICATION_KEY as string,
    });

    this.endpoint = (env.B2_S3_ENDPOINT as string).replace(/\/$/, ''); // ensure no trailing slash
    this.bucket = env.B2_BUCKET as string;
    this.basePath = sessionId 
      ? `orion-workspace/${sessionId}/` 
      : 'orion-workspace/shared/';
  }

  private getKey(path: string): string {
    const normalized = path.replace(/^\/+/, '').replace(/\/+$/, '');
    return normalized ? `${this.basePath}${normalized}` : this.basePath.slice(0, -1);
  }

  private getKeyWithTrailingSlash(path: string): string {
    const key = this.getKey(path);
    return key.endsWith('/') ? key : `${key}/`;
  }

  /** Create directory (uploads 0-byte placeholder object ending in / so empty dirs are visible) */
  async mkdir(path: string): Promise<void> {
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

  /** List directory contents */
  async ls(path: string = ''): Promise<{
    directories: string[];
    files: { name: string; size: number; modified: Date }[];
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

      // Skip placeholder objects (size 0 and ends with / or empty name)
      if (name && !fullKey.endsWith('/') && (sizeNode?.textContent || '0') !== '0') {
        files.push({
          name,
          size: Number(sizeNode?.textContent || 0),
          modified: new Date(dateNode?.textContent || 0),
        });
      }
    });

    return { directories, files };
  }

  /** Read entire file as text (UTF-8) */
  async read(path: string): Promise<string> {
    const key = this.getKey(path);
    const url = `${this.endpoint}/${this.bucket}/${key}`;

    const resp = await this.s3.fetch(url);
    if (resp.status === 404) throw new Error(`File not found: ${path}`);
    if (!resp.ok) throw new Error(`read failed (${resp.status}): ${await resp.text()}`);

    return await resp.text();
  }

  /** Write/overwrite file */
  async write(path: string, content: string | Uint8Array, mimeType = 'text/plain;charset=utf-8'): Promise<void> {
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

  /** Append to file (read → append → write) */
  async append(path: string, content: string): Promise<void> {
    let current = '';
    try {
      current = await this.read(path);
    } catch (e: any) {
      if (!e.message.includes('not found')) throw e;
    }
    await this.write(path, current + content);
  }

  /** Update = overwrite (alias for write) */
  update = this.write;

  /** Delete file or directory (recursive for directories) */
  async rm(path: string): Promise<void> {
    const prefix = this.getKeyWithTrailingSlash(path);
    const encodedPrefix = encodeURIComponent(prefix);

    // List everything with this prefix (no delimiter to get all keys)
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

      // Delete all found objects
      await Promise.all(
        keys.map(key =>
          this.s3.fetch(`${this.endpoint}/${this.bucket}/${key}`, { method: 'DELETE' })
        )
      );
    } while (marker);
  }

  /** Check if path exists (file or directory) */
  async exists(path: string): Promise<boolean> {
    try {
      const key = this.getKey(path);
      const resp = await this.s3.fetch(`${this.endpoint}/${this.bucket}/${key}`, { method: 'HEAD' });
      if (resp.ok) return true;

      // Might be a virtual directory - check if it has contents
      const { files, directories } = await this.ls(path);
      return files.length > 0 || directories.length > 0;
    } catch {
      return false;
    }
  }
}
