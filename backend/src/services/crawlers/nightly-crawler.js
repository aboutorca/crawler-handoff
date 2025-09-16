#!/usr/bin/env node

/**
 * Nightly Crawler for Idaho PUC Documents
 * 
 * Designed to run daily via cron/scheduler to:
 * 1. Check for new cases in the last N days
 * 2. Process any new documents found
 * 3. Generate embeddings for new chunks
 * 
 * Optimized for production deployment on Railway
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

// ES module directory setup
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import dependencies after env vars are loaded
import embeddingService from '../embeddings.js';

// Configuration for nightly runs
const NIGHTLY_CONFIG = {
  // Reduced workers for nightly runs (lighter resource usage)
  MAX_WORKERS: parseInt(process.env.NIGHTLY_MAX_WORKERS || '5'),
  
  // Whether to run embeddings after crawling
  GENERATE_EMBEDDINGS: process.env.SKIP_EMBEDDINGS !== 'true',
  
  // Production environment detection
  IS_PRODUCTION: process.env.RAILWAY_ENVIRONMENT === 'production' || 
                  process.env.NODE_ENV === 'production'
};


/**
 * Main nightly crawl function
 */
async function runNightlyCrawl() {
  const startTime = Date.now();
  const summary = {
    newDocuments: 0,
    chunksCreated: 0,
    embeddingsGenerated: 0,
    errors: [],
    success: false
  };
  
  try {
    console.log('🌙 NIGHTLY CRAWLER STARTING');
    console.log('=' .repeat(50));
    console.log(`📋 Checking all open cases for new documents`);
    console.log(`👷 Using ${NIGHTLY_CONFIG.MAX_WORKERS} workers`);
    console.log(`🔧 Environment: ${NIGHTLY_CONFIG.IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log('=' .repeat(50));
    
    // Override max workers for nightly run
    const originalMaxWorkers = process.env.CRAWLER_MAX_WORKERS;
    process.env.CRAWLER_MAX_WORKERS = NIGHTLY_CONFIG.MAX_WORKERS.toString();
    
    // Dynamic import to ensure env vars are set
    const { HistoricalCrawler } = await import('./historical-crawler.js');
    
    console.log('\n📄 Starting document discovery and extraction...\n');
    
    // Create crawler instance - it will check all open cases
    // The crawler already handles duplicate detection via database checks
    const crawler = new HistoricalCrawler();
    
    // Track results
    const originalUploadDocument = crawler.uploader.uploadDocument.bind(crawler.uploader);
    crawler.uploader.uploadDocument = async function(documentData) {
      const result = await originalUploadDocument.call(this, documentData);
      if (result.success && !result.duplicate) {
        summary.newDocuments++;
        summary.chunksCreated += result.chunksCreated || 0;
      }
      return result;
    };
    
    // Run the nightly update mode
    const crawlResult = await crawler.crawlNightlyUpdates();
    
    // Update summary with actual counts
    if (crawlResult) {
      summary.newDocuments = crawlResult.documentsProcessed || 0;
      summary.documentsChecked = crawlResult.documentsChecked || 0;
    }
    
    // Restore original env var
    if (originalMaxWorkers) {
      process.env.CRAWLER_MAX_WORKERS = originalMaxWorkers;
    } else {
      delete process.env.CRAWLER_MAX_WORKERS;
    }
    
    console.log('\n✅ Document crawling complete');
    console.log(`📊 Results: ${summary.documentsChecked} documents checked, ${summary.newDocuments} new documents created, ${summary.chunksCreated} chunks created`);
    
    // Step 3: Generate embeddings for new chunks
    if (NIGHTLY_CONFIG.GENERATE_EMBEDDINGS) {
      console.log('\n🧠 Starting embedding generation for new chunks...\n');
      
      try {
        const embeddingResult = await embeddingService.backfillChunkEmbeddings(
          null, // No session filtering - process all NULL embeddings
          (status) => console.log(`  📈 ${status}`)
        );
        
        summary.embeddingsGenerated = embeddingResult.processed || 0;
        console.log(`\n✅ Embeddings complete: ${summary.embeddingsGenerated} chunks vectorized`);
        
      } catch (embeddingError) {
        console.error('❌ Embedding generation failed:', embeddingError.message);
        summary.errors.push({
          stage: 'embeddings',
          error: embeddingError.message
        });
        // Continue - don't fail the whole job for embedding errors
      }
    } else {
      console.log('\n⏭️  Skipping embedding generation (SKIP_EMBEDDINGS=true)');
    }
    
    // Calculate duration
    const duration = Math.round((Date.now() - startTime) / 1000);
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;
    summary.duration = `${minutes}m ${seconds}s`;
    summary.success = true;
    
    // Final report
    console.log('\n' + '=' .repeat(50));
    console.log('🌙 NIGHTLY CRAWLER COMPLETE');
    console.log('=' .repeat(50));
    console.log(`⏱️  Duration: ${summary.duration}`);
    console.log(`🔍 Documents Checked: ${summary.documentsChecked || 0}`);
    console.log(`📄 New Documents Created: ${summary.newDocuments}`);
    console.log(`📦 Chunks Created: ${summary.chunksCreated}`);
    console.log(`🧠 Embeddings Generated: ${summary.embeddingsGenerated}`);
    
    if (summary.errors.length > 0) {
      console.log(`⚠️  Errors: ${summary.errors.length}`);
      summary.errors.forEach(err => {
        console.log(`  - ${err.stage}: ${err.error}`);
      });
    }
    
    console.log('=' .repeat(50));
    
    return summary;
    
  } catch (error) {
    console.error('\n❌ FATAL ERROR:', error.message);
    console.error(error.stack);
    
    summary.errors.push({
      stage: 'fatal',
      error: error.message
    });
    summary.duration = `${Math.round((Date.now() - startTime) / 1000)}s`;
    
    throw error;
  }
}

/**
 * Health check endpoint for monitoring
 */
async function healthCheck() {
  try {
    // Check database connection
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );
    
    const { error } = await supabase
      .from('cases')
      .select('count')
      .limit(1)
      .single();
    
    if (error) throw error;
    
    // Check OpenAI API key
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OpenAI API key not configured');
    }
    
    return { status: 'healthy', timestamp: new Date().toISOString() };
    
  } catch (error) {
    return { 
      status: 'unhealthy', 
      error: error.message,
      timestamp: new Date().toISOString() 
    };
  }
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  // Check for health check mode
  if (process.argv.includes('--health')) {
    healthCheck()
      .then(result => {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.status === 'healthy' ? 0 : 1);
      });
  } else {
    // Run the nightly crawl
    runNightlyCrawl()
      .then(summary => {
        console.log('\n✅ Nightly crawl completed successfully');
        process.exit(0);
      })
      .catch(error => {
        console.error('\n❌ Nightly crawl failed:', error.message);
        process.exit(1);
      });
  }
}

// Export for use in other modules
export { runNightlyCrawl, healthCheck, NIGHTLY_CONFIG };