// src/memory/memory-manager.ts - Unified Memory Management

import type { VectorizeIndex } from '@cloudflare/workers-types';
import type { GeminiClient } from '../gemini';
import type { MemoryEntry, MemorySearchResult } from '../types';

// =============================================================
// Memory Manager Configuration
// =============================================================

export interface MemoryConfig {
  stmCapacity: number;      // Short-term memory capacity
  ltmThreshold: number;     // Similarity threshold for LTM retrieval
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
// Embedding Cache
// =============================================================

interface CacheEntry {
  embedding: number[];
  timestamp: number;
  hits: number;
}

class EmbeddingCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private ttl: number;

  constructor(maxSize: number, ttl: number) {
    this.maxSize = maxSize;
    this.ttl = ttl;
  }

  get(key: string): number[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    // Update hit count and move to end (LRU)
    entry.hits++;
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.embedding;
  }

  set(key: string, embedding: number[]): void {
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    this.cache.set(key, {
      embedding,
      timestamp: Date.now(),
      hits: 0,
    });
  }

  private evictLRU(): void {
    // Evict entry with lowest score (hits / age)
    let minScore = Infinity;
    let minKey: string | null = null;
    const now = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      const age = Math.max(now - entry.timestamp, 1);
      const score = entry.hits / (age / 1000);
      if (score < minScore) {
        minScore = score;
        minKey = key;
      }
    }

    if (minKey) this.cache.delete(minKey);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
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
  private embeddingCache: EmbeddingCache;

  // Metrics
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
    config: Partial<MemoryConfig> = {}
  ) {
    this.vectorize = vectorize;
    this.gemini = gemini;
    this.sessionId = sessionId;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embeddingCache = new EmbeddingCache(
      this.config.cacheSize,
      this.config.cacheTTL
    );
  }

  // -----------------------------------------------------------
  // Embedding Generation
  // -----------------------------------------------------------

  async generateEmbedding(text: string): Promise<number[]> {
    const cacheKey = this.hashText(text);

    // Check cache
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) {
      this.metrics.cacheHits++;
      return cached;
    }

    this.metrics.cacheMisses++;

    // Generate new embedding
    const embedding = await this.gemini.embedText(text, {
      model: this.config.embeddingModel,
      normalize: true,
    });

    // Cache it
    this.embeddingCache.set(cacheKey, embedding);
    this.metrics.totalEmbeddings++;

    return embedding;
  }

  async generateEmbeddingBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const uncached: { index: number; text: string }[] = [];

    // Check cache for each text
    for (let i = 0; i < texts.length; i++) {
      const cacheKey = this.hashText(texts[i]);
      const cached = this.embeddingCache.get(cacheKey);
      
      if (cached) {
        results[i] = cached;
        this.metrics.cacheHits++;
      } else {
        uncached.push({ index: i, text: texts[i] });
        this.metrics.cacheMisses++;
      }
    }

    // Batch generate uncached
    if (uncached.length > 0) {
      const newEmbeddings = await this.gemini.embedBatch(
        uncached.map(u => u.text),
        { model: this.config.embeddingModel, normalize: true }
      );

      // Store results and cache
      for (let i = 0; i < uncached.length; i++) {
        const { index, text } = uncached[i];
        results[index] = newEmbeddings[i];
        this.embeddingCache.set(this.hashText(text), newEmbeddings[i]);
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
    if (!this.vectorize) return;

    // Vectorize doesn't support bulk delete by filter
    // This would need to be implemented with a list + delete loop
    // For now, we just clear the cache
    this.embeddingCache.clear();
    console.log(`[Memory] Cleared cache for session ${this.sessionId}`);
  }

  async deleteMemory(id: string): Promise<void> {
    if (!this.vectorize) return;
    await this.vectorize.deleteByIds([id]);
  }

  // -----------------------------------------------------------
  // Summarization
  // -----------------------------------------------------------

  async summarizeConversation(
    messages: Array<{ role: string; content: string }>
  ): Promise<string> {
    if (messages.length === 0) return '';

    const conversation = messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    const prompt = `Summarize this conversation in 2-3 sentences, capturing the key topics and outcomes:

${conversation}

Summary:`;

    const response = await this.gemini.generateWithTools(
      [{ role: 'user', content: prompt }],
      [],
      { stream: false, temperature: 0.3 }
    );

    return response.text.trim();
  }

  async extractTopics(text: string): Promise<string[]> {
    const prompt = `Extract 3-5 key topics from this text. Return as JSON array of strings.

Text: ${text}

Topics:`;

    try {
      const response = await this.gemini.generateWithTools(
        [{ role: 'user', content: prompt }],
        [],
        { stream: false, temperature: 0.2 }
      );

      const match = response.text.match(/\[[\s\S]*\]/);
      if (match) {
        return JSON.parse(match[0]);
      }
    } catch (e) {
      console.warn('[Memory] Topic extraction failed:', e);
    }

    return [];
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
