/**
 * Persistent Audio Cache Manager
 * Caches audio URLs to localStorage to reduce API calls and improve performance
 */

// Type definitions
interface AudioCacheEntry {
  url: string;
  source: string;
  timestamp: number;
  expiresAt: number;
  accessCount: number;
}

interface LRUEntry {
  key: string;
  lastAccess: number;
}

interface CacheMetadata {
  version: number;
  maxSize: number;
  expirationDays: number;
  totalEntries: number;
  hitCount: number;
  missCount: number;
  lastCleanup: number;
}

export interface CacheStatistics {
  totalEntries: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  sizeKB: number;
  expiredCount: number;
  avgResponseTime: number;
  sources: { [source: string]: number };
}

// Constants
const CACHE_KEY = 'vibe_audio_cache';
const LRU_KEY = 'vibe_audio_cache_lru';
const META_KEY = 'vibe_audio_cache_meta';
const MAX_SIZE = 1000; // Maximum number of cached words
const EXPIRATION_DAYS = 7; // Cache expiration in days
const MAX_SIZE_BYTES = 4 * 1024 * 1024; // 4MB limit

class AudioCacheManager {
  private cache: Map<string, AudioCacheEntry>;
  private lruList: LRUEntry[];
  private metadata: CacheMetadata;
  private storageAvailable: boolean;

  constructor() {
    this.cache = new Map();
    this.lruList = [];
    this.storageAvailable = this.checkStorageAvailable();
    this.metadata = {
      version: 1,
      maxSize: MAX_SIZE,
      expirationDays: EXPIRATION_DAYS,
      totalEntries: 0,
      hitCount: 0,
      missCount: 0,
      lastCleanup: Date.now()
    };

    if (this.storageAvailable) {
      this.loadFromStorage();
      this.migrateFromOldCache();
      this.cleanupExpired();
    } else {
      console.warn('⚠️ localStorage not available, using memory-only cache');
    }
  }

  /**
   * Check if localStorage is available
   */
  private checkStorageAvailable(): boolean {
    try {
      const test = '__storage_test__';
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get cached audio URL for a word
   */
  get(word: string, lang: string = 'en'): string | null {
    const key = this.getCacheKey(word, lang);

    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;

      // Check if expired
      if (Date.now() > entry.expiresAt) {
        this.delete(word, lang);
        this.metadata.missCount++;
        return null;
      }

      // Update LRU
      this.updateLRU(key);
      this.metadata.hitCount++;

      console.log(`🎯 Cache HIT for "${word}" (${entry.source})`);
      return entry.url;
    }

    this.metadata.missCount++;
    return null;
  }

  /**
   * Cache an audio URL
   */
  set(word: string, lang: string = 'en', url: string, source: string): void {
    const key = this.getCacheKey(word, lang);

    const entry: AudioCacheEntry = {
      url,
      source,
      timestamp: Date.now(),
      expiresAt: Date.now() + (this.metadata.expirationDays * 24 * 60 * 60 * 1000),
      accessCount: 1
    };

    this.cache.set(key, entry);
    this.updateLRU(key);

    // Check if we need to evict
    if (this.cache.size > this.metadata.maxSize) {
      this.evictLRU();
    }

    // Save to localStorage
    if (this.storageAvailable) {
      this.saveToStorage();
    }
  }

  /**
   * Check if a word is cached
   */
  has(word: string, lang: string = 'en'): boolean {
    const key = this.getCacheKey(word, lang);
    return this.cache.has(key);
  }

  /**
   * Delete a cached entry
   */
  delete(word: string, lang: string = 'en'): void {
    const key = this.getCacheKey(word, lang);

    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.lruList = this.lruList.filter(e => e.key !== key);
      this.saveToStorage();
    }
  }

  /**
   * Clear all cached entries
   */
  clear(): void {
    const clearedCount = this.cache.size;

    this.cache.clear();
    this.lruList = [];

    if (this.storageAvailable) {
      localStorage.removeItem(CACHE_KEY);
      localStorage.removeItem(LRU_KEY);
      localStorage.removeItem(META_KEY);
    }

    console.log(`🗑️ Cleared ${clearedCount} cache entries`);
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStatistics {
    const sizeInBytes = JSON.stringify({
      cache: Object.fromEntries(this.cache),
      lru: this.lruList,
      meta: this.metadata
    }).length;

    const sources: { [source: string]: number } = {};
    this.cache.forEach(entry => {
      sources[entry.source] = (sources[entry.source] || 0) + 1;
    });

    return {
      totalEntries: this.cache.size,
      hitCount: this.metadata.hitCount,
      missCount: this.metadata.missCount,
      hitRate: this.metadata.hitCount + this.metadata.missCount > 0
        ? Math.round((this.metadata.hitCount / (this.metadata.hitCount + this.metadata.missCount)) * 100)
        : 0,
      sizeKB: Math.round(sizeInBytes / 1024),
      expiredCount: 0,
      avgResponseTime: 0, // TODO: Track response times
      sources
    };
  }

  /**
   * Generate cache key for word and language
   */
  private getCacheKey(word: string, lang: string): string {
    return `${word.toLowerCase()}-${lang}`;
  }

  /**
   * Load cache from localStorage
   */
  private loadFromStorage(): void {
    try {
      const cacheData = localStorage.getItem(CACHE_KEY);
      const lruData = localStorage.getItem(LRU_KEY);
      const metaData = localStorage.getItem(META_KEY);

      if (cacheData) {
        const parsed = JSON.parse(cacheData);
        this.cache = new Map(Object.entries(parsed));
      }

      if (lruData) {
        this.lruList = JSON.parse(lruData);
      }

      if (metaData) {
        this.metadata = JSON.parse(metaData);
      }

      console.log(`📦 Loaded ${this.cache.size} cached entries from localStorage`);
    } catch (error) {
      console.error('❌ Failed to load cache from storage:', error);
      // Reset if corrupted
      this.cache = new Map();
      this.lruList = [];
    }
  }

  /**
   * Save cache to localStorage
   */
  private saveToStorage(): void {
    if (!this.storageAvailable) return;

    try {
      this.metadata.totalEntries = this.cache.size;
      this.metadata.lastCleanup = Date.now();

      const cacheData = JSON.stringify(Object.fromEntries(this.cache));
      const lruData = JSON.stringify(this.lruList);
      const metaData = JSON.stringify(this.metadata);

      // Check size before saving
      const totalSize = cacheData.length + lruData.length + metaData.length;

      if (totalSize > MAX_SIZE_BYTES) {
        console.warn(`⚠️ Cache size exceeding ${MAX_SIZE_BYTES / 1024 / 1024}MB, triggering cleanup`);
        this.cleanupExpired();
        this.evictLRU();
        return this.saveToStorage(); // Retry after cleanup
      }

      localStorage.setItem(CACHE_KEY, cacheData);
      localStorage.setItem(LRU_KEY, lruData);
      localStorage.setItem(META_KEY, metaData);

    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.error('❌ localStorage quota exceeded, clearing cache');
        this.clear();
      } else {
        console.error('❌ Failed to save cache:', error);
      }
    }
  }

  /**
   * Update LRU (Least Recently Used) tracking
   */
  private updateLRU(key: string): void {
    const existingIndex = this.lruList.findIndex(e => e.key === key);

    if (existingIndex >= 0) {
      // Update existing entry
      this.lruList[existingIndex].lastAccess = Date.now();
    } else {
      // Add new entry
      this.lruList.push({ key, lastAccess: Date.now() });
    }
  }

  /**
   * Evict LRU entries when cache is full
   */
  private evictLRU(): void {
    if (this.lruList.length > this.metadata.maxSize) {
      // Find least recently used entry
      const lruEntry = this.lruList.reduce((oldest, current) =>
        current.lastAccess < oldest.lastAccess ? current : oldest
      );

      const key = lruEntry.key;

      // Delete from cache
      if (this.cache.has(key)) {
        this.cache.delete(key);
      }

      // Remove from LRU list
      this.lruList = this.lruList.filter(e => e.key !== key);

      console.log(`🗑️ Evicted LRU entry: ${key}`);
    }
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;
    const keysToDelete: string[] = [];

    this.cache.forEach((entry, key) => {
      if (now > entry.expiresAt) {
        keysToDelete.push(key);
        cleaned++;
      }
    });

    keysToDelete.forEach(key => {
      this.cache.delete(key);
      this.lruList = this.lruList.filter(e => e.key !== key);
    });

    if (cleaned > 0) {
      console.log(`🧹 Cleaned ${cleaned} expired cache entries`);
      this.saveToStorage();
    }
  }

  /**
   * Migrate from old cache format if exists
   */
  private migrateFromOldCache(): void {
    const oldCache = localStorage.getItem('vibe_pronunciation_cache');
    if (oldCache) {
      try {
        // Old format was direct key-value pairs
        const parsed = JSON.parse(oldCache);
        const newEntries = Object.entries(parsed).map(([word, urlData]) => {
          return [
            this.getCacheKey(word, 'en'),
            {
              url: urlData.url || urlData,
              source: urlData.source || 'Migrated',
              timestamp: urlData.timestamp || Date.now(),
              expiresAt: urlData.expiresAt || Date.now() + (7 * 24 * 60 * 60 * 1000),
              accessCount: 0
            }
          ];
        });

        const cacheMap = new Map(newEntries);
        this.cache = cacheMap;
        this.saveToStorage();

        // Remove old cache
        localStorage.removeItem('vibe_pronunciation_cache');
        console.log(`✅ Migrated ${cacheMap.size} entries from old cache format`);
      } catch (error) {
        console.warn('⚠️ Failed to migrate old cache:', error);
      }
    }
  }
}

// Singleton instance
let audioCacheManagerInstance: AudioCacheManager | null = null;

export const getAudioCacheManager = (): AudioCacheManager => {
  if (!audioCacheManagerInstance) {
    audioCacheManagerInstance = new AudioCacheManager();
  }
  return audioCacheManagerInstance;
};

// Convenience exports
export const audioCacheManager = getAudioCacheManager();

// Export statistics function
export const getCacheStats = (): CacheStatistics => {
  return audioCacheManager.getStats();
};

// Export cache control functions
export const clearAudioCache = (): void => {
  audioCacheManager.clear();
};
