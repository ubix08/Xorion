// src/memory/memory-manager.ts - Fixed Memory Management with Persistent Cache

import type { VectorizeIndex } from '@cloudflare/workers-types';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { GeminiClient } from '../gemini';
import type { MemoryEntry, MemorySearchResult } from '../types';

// =============================================================
// Memory Manager Configuration
// =============================================================

export interface MemoryConfig {
  stmCapacity: number;
  ltmThreshold: number;
  embeddingModel: string;
  cacheSize: number;
  cacheTTL: number;
}

const DEFAULT_CONFIG: MemoryConfig = {
  stmCapacity: 50,
  ltmThreshold: 0.65,
  embeddingModel: 'text-embedding-004',
  cacheSize: 200,
  cacheTTL: 3600000, // 1 hour
};

// =============================================================
// Persistent Embedding Cache
// =============================================================

interface CacheEntry {
  embedding: number[];
  timestamp: number;
  hits: number;
}

class PersistentEmbeddingCache {
  private storage: DurableObjectStorage;
  private maxSize: number;
  private ttl: number;
  private memoryCache = new Map<string, CacheEntry>();

  constructor(storage: DurableObjectStorage, maxSize: number, ttl: number) {
    this.storage = storage;
    this.maxSize = maxSize;
    this.ttl = ttl;
  }

  async get(key: string): Promise<number[] | null> {
    // Check memory cache first
    const memCached = this.memoryCache.get(key);
    if (memCached && Date.now() - memCached.timestamp < this.ttl) {
      memCached.hits++;
      return memCached.embedding;
    }

    // Check persistent storage
    try {
      const stored = await this.storage.get<CacheEntry>(`emb:${key}`);
      if (!stored) return null;
      
      if (Date.now() - stored.timestamp > this.ttl) {
        await this.storage.delete(`emb:${key}`);
        return null;
      }
      
      stored.hits++;
      
      // Update both caches
      this.memoryCache.set(key, stored);
      await this.storage.put(`emb:${key}`, stored);
      
      return stored.embedding;
    } catch (e) {
      console.warn('[Cache] Get failed:', e);
      return null;
    }
  }

  async set(key: string, embedding: number[]): Promise<void> {
    const entry: CacheEntry = {
      embedding,
      timestamp: Date.now(),
      hits: 0,
    };

    // Update memory cache
    if (this.memoryCache.size >= this.maxSize) {
      this.evictLRU();
    }
    this.memoryCache.set(key, entry);

    // Update persistent storage
    try {
      await this.storage.put(`emb:${key}`, entry);
    } catch (e) {
      console.warn('[Cache] Set failed:', e);
    }
  }

  private evictLRU(): void {
    let minScore = Infinity;
    let minKey: string | null = null;
    const now = Date.now();

    for (const [key, entry] of this.memoryCache.entries()) {
      const age = Math.max(now - entry.timestamp, 1);
      const score = entry.hits / (age / 1000);
      if (score < minScore) {
        minScore = score;
        minKey = key;
      }
    }

    if (minKey) this.memoryCache.delete(minKey);
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    
    try {
      const keys = await this.storage.list<CacheEntry>({ prefix: 'emb:' });
      for (const key of keys.keys()) {
        await this.storage.delete(key);
      }
    } catch (e) {
      console.warn('[Cache] Clear failed:', e);
    }
  }

  get size(): number {
    return this.memoryCache.size;
  }
}

// =============================================================
// Memory Manager Class
// =============================================================

export class MemoryManager {
  private vectorize: VectorizeIndex | null;
  private gemini: GeminiClient;
  private sessionId: string;
  private config: MemoryConfig;
  private embeddingCache: PersistentEmbeddingCache;

  private metrics = {
    cacheHits: 0,
    cacheMisses: 0,
    totalEmbeddings: 0,
    totalSearches: 0,
  };

  constructor(
    vectorize: VectorizeIndex | null,
    gemini: GeminiClient,
    sessionId: string,
    storage: DurableObjectStorage,
    config: Partial<MemoryConfig> = {}
  ) {
    this.vectorize = vectorize;
    this.gemini = gemini;
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embeddingCache = new PersistentEmbeddingCache(
      storage,
      this.config.cacheSize,
      this.config.cacheTTL
    );
  }

  // -----------------------------------------------------------
  // Embedding Generation
  // -----------------------------------------------------------

  async generateEmbedding(text: string): Promise<number[]> {
    const cacheKey = this.hashText(text);

    const cached = await this.embeddingCache.get(cacheKey);
    if (cached) {
      this.metrics.cacheHits++;
      return cached;
    }

    this.metrics.cacheMisses++;

    const embedding = await this.gemini.embedText(text, {
      model: this.config.embeddingModel,
      normalize: true,
    });

    await this.embeddingCache.set(cacheKey, embedding);
    this.metrics.totalEmbeddings++;

    return embedding;
  }

  async generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const uncached: { index: number; text: string }[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cacheKey = this.hashText(texts[i]);
      const cached = await this.embeddingCache.get(cacheKey);
      
      if (cached) {
        results[i] = cached;
        this.metrics.cacheHits++;
      } else {
        uncached.push({ index: i, text: texts[i] });
        this.metrics.cacheMisses++;
      }
    }

    if (uncached.length > 0) {
      const newEmbeddings = await this.gemini.embedBatch(
        uncached.map(u => u.text),
        { model: this.config.embeddingModel, normalize: true }
      );

      for (let i = 0; i < uncached.length; i++) {
        const { index, text } = uncached[i];
        results[index] = newEmbeddings[i];
        await this.embeddingCache.set(this.hashText(text), newEmbeddings[i]);
      }

      this.metrics.totalEmbeddings += uncached.length;
    }

    return results;
  }

  // -----------------------------------------------------------
  // Memory Storage
  // -----------------------------------------------------------

  async saveMemory(entry: Omit<MemoryEntry, 'id'>): Promise<string> {
    if (!this.vectorize) {
      console.warn('[Memory] Vectorize not available');
      return '';
    }

    const id = `mem_${this.sessionId}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const embedding = await this.generateEmbedding(entry.content);

    await this.vectorize.upsert([{
      id,
      values: embedding,
      metadata: {
        sessionId: this.sessionId,
        content: entry.content,
        type: entry.type,
        importance: entry.importance,
        timestamp: entry.timestamp,
        ...entry.metadata,
      },
    }]);

    return id;
  }

  async saveMemoryBatch(entries: Omit<MemoryEntry, 'id'>[]): Promise<string[]> {
    if (!this.vectorize || entries.length === 0) return [];

    const ids: string[] = [];
    const texts = entries.map(e => e.content);
    const embeddings = await this.generateEmbeddingBatch(texts);

    const vectors = entries.map((entry, i) => {
      const id = `mem_${this.sessionId}_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 4)}`;
      ids.push(id);

      return {
        id,
        values: embeddings[i],
        metadata: {
          sessionId: this.sessionId,
          content: entry.content,
          type: entry.type,
          importance: entry.importance,
          timestamp: entry.timestamp,
          ...entry.metadata,
        },
      };
    });

    await this.vectorize.upsert(vectors);
    return ids;
  }

  // -----------------------------------------------------------
  // Memory Search
  // -----------------------------------------------------------

  async searchMemory(
    query: string,
    options: {
      topK?: number;
      filter?: Record<string, unknown>;
      threshold?: number;
    } = {}
  ): Promise<MemorySearchResult[]> {
    if (!this.vectorize) return [];

    this.metrics.totalSearches++;

    const topK = options.topK || 10;
    const threshold = options.threshold || this.config.ltmThreshold;

    const queryEmbedding = await this.generateEmbedding(query);

    const results = await this.vectorize.query(queryEmbedding, {
      topK,
      filter: {
        sessionId: this.sessionId,
        ...options.filter,
      },
      returnMetadata: true,
    });

    return (results.matches || [])
      .filter(match => match.score >= threshold)
      .map(match => ({
        id: match.id,
        content: (match.metadata as any)?.content || '',
        score: match.score,
        metadata: match.metadata as Record<string, unknown>,
      }));
  }

  async searchAcrossSessions(
    query: string,
    options: { topK?: number; threshold?: number } = {}
  ): Promise<MemorySearchResult[]> {
    if (!this.vectorize) return [];

    const topK = options.topK || 10;
    const threshold = options.threshold || this.config.ltmThreshold;

    const queryEmbedding = await this.generateEmbedding(query);

    const results = await this.vectorize.query(queryEmbedding, {
      topK,
      returnMetadata: true,
    });

    return (results.matches || [])
      .filter(match => match.score >= threshold)
      .map(match => ({
        id: match.id,
        content: (match.metadata as any)?.content || '',
        score: match.score,
        metadata: match.metadata as Record<string, unknown>,
      }));
  }

  // -----------------------------------------------------------
  // Context Building
  // -----------------------------------------------------------

  async buildContext(
    query: string,
    options: {
      maxResults?: number;
      includeTimestamp?: boolean;
    } = {}
  ): Promise<string> {
    const maxResults = options.maxResults || 5;

    const results = await this.searchMemory(query, { topK: maxResults });

    if (results.length === 0) {
      return 'No relevant past context found.';
    }

    const contextParts = results.map((r, i) => {
      const timestamp = options.includeTimestamp && r.metadata?.timestamp
        ? ` (${new Date(r.metadata.timestamp as number).toLocaleDateString()})`
        : '';
      return `[${i + 1}]${timestamp} ${r.content}`;
    });

    return `Relevant context from memory:\n${contextParts.join('\n\n')}`;
  }

  // -----------------------------------------------------------
  // Memory Management
  // -----------------------------------------------------------

  async clearSessionMemory(): Promise<void> {
    await this.embeddingCache.clear();
    console.log(`[Memory] Cleared cache for session ${this.sessionId}`);
  }

  async deleteMemory(id: string): Promise<void> {
    if (!this.vectorize) return;
    await this.vectorize.deleteByIds([id]);
  }

  // -----------------------------------------------------------
  // Metrics & Status
  // -----------------------------------------------------------

  getMetrics(): {
    cacheHits: number;
    cacheMisses: number;
    cacheHitRate: number;
    totalEmbeddings: number;
    totalSearches: number;
    cacheSize: number;
  } {
    const total = this.metrics.cacheHits + this.metrics.cacheMisses;
    return {
      ...this.metrics,
      cacheHitRate: total > 0 ? this.metrics.cacheHits / total : 0,
      cacheSize: this.embeddingCache.size,
    };
  }

  async getMemoryStats(): Promise<{
    sessionId: string;
    vectorizeAvailable: boolean;
    metrics: ReturnType<typeof this.getMetrics>;
  }> {
    return {
      sessionId: this.sessionId,
      vectorizeAvailable: !!this.vectorize,
      metrics: this.getMetrics(),
    };
  }

  // -----------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------

  private hashText(text: string): string {
    let hash = 5381;
    let hash2 = 52711;

    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) + hash) ^ char;
      hash2 = ((hash2 << 5) + hash2) ^ char;
    }

    return `${(hash >>> 0).toString(36)}_${(hash2 >>> 0).toString(36)}`;
  }
}

export default MemoryManager;
