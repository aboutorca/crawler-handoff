import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

class EmbeddingService {
  constructor() {
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    this.supabase = supabase;
    this.model = 'text-embedding-3-large';
    this.dimensions = 2000;
    this.maxTokensPerRequest = 8191;
    
    // Rate limiting for OpenAI Tier 1 - Optimized for maximum throughput
    this.requestsPerMinute = 2800; // 93% of 3000 RPM limit for safety margin
    this.tokensPerMinute = 950000; // 95% of 1M TPM limit for safety margin
    this.batchQueueLimit = 3000000; // 3M batch queue limit
    this.requestQueue = [];
    this.tokenUsage = { requests: 0, tokens: 0, windowStart: Date.now() };
    
    if (!this.openaiApiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }
  }

  async generateEmbeddings(texts) {
    // Support both single text and array
    const textArray = Array.isArray(texts) ? texts : [texts];
    
    if (textArray.length === 0 || textArray.some(t => !t || t.trim().length === 0)) {
      throw new Error('All texts must be non-empty');
    }

    // OpenAI supports max 2048 inputs per request
    if (textArray.length > 2048) {
      throw new Error('Maximum 2048 texts per request');
    }

    const totalTokens = textArray.reduce((sum, text) => sum + this.estimateTokens(text), 0);
    await this.enforceRateLimit(totalTokens);

    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openaiApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          input: textArray,
          model: this.model,
          dimensions: this.dimensions
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      this.updateTokenUsage(data.usage.total_tokens);
      
      return {
        embeddings: data.data.map(item => item.embedding),
        usage: data.usage
      };
    } catch (error) {
      console.error('Embedding generation failed:', error);
      throw error;
    }
  }

  // Compatibility method for single text embedding
  async generateEmbedding(text) {
    const result = await this.generateEmbeddings([text]);
    return { embedding: result.embeddings[0], usage: result.usage };
  }

  async generateEmbeddingsBatch(texts, statusCallback = null) {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error('Texts must be a non-empty array');
    }

    const results = [];
    const batchSize = 500; // Optimized for 3000 RPM
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = [];
      
      if (statusCallback) {
        statusCallback(`Processing embedding batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)}`);
      }
      
      for (const text of batch) {
        try {
          const result = await this.generateEmbedding(text);
          batchResults.push(result);
        } catch (error) {
          console.error('Failed to generate embedding for text:', error);
          batchResults.push({ error: error.message, embedding: null });
        }
      }
      
      results.push(...batchResults);
    }
    
    return results;
  }

  async backfillChunkEmbeddings(sessionId = null, statusCallback = null) {
    try {
      // Process chunks in optimized batches for maximum throughput
      // Use offset-based pagination with larger batches for 3000 RPM
      const batchSize = 500;
      let processed = 0;
      let offset = 0;
      let hasMoreChunks = true;
      
      if (statusCallback) {
        statusCallback('Starting batch processing of chunks...');
      }
      
      while (hasMoreChunks) {
        // Fetch next batch of chunks without embeddings
        // IMPORTANT: Always use offset 0 since processed chunks are removed from NULL results
        let query = this.supabase
          .from('document_chunks')
          .select('id, content')
          .is('embedding', null)
          .range(0, batchSize - 1);  // Always fetch from beginning
        
        if (sessionId) {
          query = query.eq('session_id', sessionId);
        }
        
        const { data: chunks, error } = await query;
        
        if (error) {
          throw new Error(`Failed to fetch chunk batch: ${error.message}`);
        }
        
        if (!chunks || chunks.length === 0) {
          hasMoreChunks = false;
          break;
        }
        
        const batchNumber = Math.floor(offset / batchSize) + 1;
        if (statusCallback) {
          statusCallback(`Processing batch ${batchNumber} (${chunks.length} chunks, ${processed} completed so far)`);
        }
        
        
        // Process chunks in safe batches - collect texts for multi-input API calls
        const dbUpdateBatchSize = 200; // Optimized batch size for maximum throughput
        for (let i = 0; i < chunks.length; i += dbUpdateBatchSize) {
          const dbBatch = chunks.slice(i, i + dbUpdateBatchSize);
          
          if (statusCallback) {
            statusCallback(`DB batch ${Math.floor(i / dbUpdateBatchSize) + 1}/${Math.ceil(chunks.length / dbUpdateBatchSize)} in fetch batch ${batchNumber}`);
          }
          
          try {
            // Filter out empty chunks and prepare texts for multi-input API call
            const validChunks = dbBatch.filter(chunk => chunk.content && chunk.content.trim().length > 0);
            if (validChunks.length === 0) continue;
            
            const texts = validChunks.map(chunk => chunk.content);
            
            // Generate embeddings for entire batch in single API call (SAFE: preserves order)
            const { embeddings } = await this.generateEmbeddings(texts);
            
            // Sequential database updates with guaranteed order preservation
            for (let j = 0; j < validChunks.length; j++) {
              const chunk = validChunks[j];
              const embedding = embeddings[j]; // Order guaranteed by OpenAI API
              
              const { error: updateError } = await this.supabase
                .from('document_chunks')
                .update({ embedding })
                .eq('id', chunk.id);
              
              if (updateError) {
                console.error(`Failed to update chunk ${chunk.id}:`, updateError);
                continue;
              }
              
              processed++;
            }
            
            if (processed % 100 === 0) {
            }
            
          } catch (error) {
            console.error(`Failed to process database batch:`, error);
          }
        }
        
        // No need to increment offset - we always fetch from 0
        // Processed chunks are automatically excluded from next query (embedding no longer NULL)
        
        // If we get fewer chunks than batch size, we're done
        if (chunks.length < batchSize) {
          hasMoreChunks = false;
        }
      }
      
      return { 
        message: `Successfully processed ${processed} chunks`,
        processed,
        total: processed // We don't know total without expensive count
      };
      
    } catch (error) {
      console.error('Backfill failed:', error);
      throw error;
    }
  }

  async findSimilarChunks(queryText, options = {}) {
    const {
      sessionId = null,
      company = null,
      caseNumber = null,
      similarityThreshold = 0.7,
      maxResults = 50,
      startYear = null,
      endYear = null,
      caseIds = null  // NEW: Accept case IDs for filtering
    } = options;

    try {
      const { embedding } = await this.generateEmbedding(queryText);
      
      // Add timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Vector search timeout')), 15000)
      );
      
      const searchPromise = this.supabase.rpc('find_similar_chunks', {
        query_embedding: embedding,
        similarity_threshold: similarityThreshold,
        max_results: maxResults,
        start_year: startYear,
        end_year: endYear,
        target_company: company,
        case_ids: caseIds  // NEW: Pass case IDs to SQL function
      });
      
      const { data: similarChunks, error } = await Promise.race([searchPromise, timeoutPromise]);
      
      if (error) {
        throw new Error(`Vector search failed: ${error.message}`);
      }
      
      let filteredChunks = similarChunks || [];
      
      // Session-based filtering (if still needed)
      if (sessionId) {
        const { data: sessionChunks, error: sessionError } = await this.supabase
          .from('document_chunks')
          .select('id')
          .eq('session_id', sessionId);
          
        if (!sessionError && sessionChunks) {
          const sessionChunkIds = new Set(sessionChunks.map(c => c.id));
          filteredChunks = filteredChunks.filter(chunk => sessionChunkIds.has(chunk.id));
        }
      }
      
      // Case number filtering (if still needed)
      if (caseNumber) {
        filteredChunks = filteredChunks.filter(chunk => 
          chunk.case_number === caseNumber
        );
      }
      
      return filteredChunks;
      
    } catch (error) {
      console.error('Similar chunks search failed:', error);
      throw error;
    }
  }

  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  async enforceRateLimit(estimatedTokens = 500) {
    const now = Date.now();
    const windowDuration = 60000; // 1 minute
    
    // Reset window if needed
    if (now - this.tokenUsage.windowStart >= windowDuration) {
      const hadRequests = this.tokenUsage.requests > 0;
      this.tokenUsage = { requests: 0, tokens: 0, windowStart: now };
      // Only log if we actually used the rate limiter in this window
      if (hadRequests) {
      }
    }
    
    // Check if we would exceed limits (much more aggressive)
    const wouldExceedRequests = this.tokenUsage.requests >= this.requestsPerMinute;
    const wouldExceedTokens = this.tokenUsage.tokens + estimatedTokens >= this.tokensPerMinute;
    
    if (wouldExceedRequests || wouldExceedTokens) {
      const waitTime = windowDuration - (now - this.tokenUsage.windowStart);
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
        this.tokenUsage = { requests: 0, tokens: 0, windowStart: Date.now() };
      }
    }
    
    this.tokenUsage.requests++;
  }

  updateTokenUsage(actualTokens) {
    this.tokenUsage.tokens += actualTokens;
  }

  async getEmbeddingStats() {
    try {
      // Use a timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Stats query timeout')), 5000)
      );
      
      const queryPromise = this.supabase
        .from('chunks_with_embeddings')
        .select('*')
        .single();
        
      const { data, error } = await Promise.race([queryPromise, timeoutPromise]);
      
      if (error) {
        throw new Error(`Failed to get embedding stats: ${error.message}`);
      }
      
      return data;
    } catch (error) {
      console.warn('Failed to get embedding statistics, assuming embeddings exist:', error.message);
      // Return conservative fallback stats 
      return {
        total_chunks: 'unknown', 
        chunks_with_embeddings: 'assumed_complete', 
        embedding_coverage_percent: 'assumed_100'
      };
    }
  }
}

const embeddingService = new EmbeddingService();

export default embeddingService;
export { EmbeddingService };