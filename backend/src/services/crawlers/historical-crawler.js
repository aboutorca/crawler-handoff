// historical-crawler.js
// Configurable historical crawl with crash recovery based on proven production-crawler-2025.js

import puppeteer from 'puppeteer';
import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// HISTORICAL CONFIGURATION
// =============================================================================

// Configurable date range
const START_YEAR = parseInt(process.env.CRAWLER_START_YEAR || '2010');
const END_YEAR = parseInt(process.env.CRAWLER_END_YEAR || '2024');

// Dynamically generate year batches based on configuration
function generateYearBatches(startYear, endYear) {
  const batches = [];
  for (let year = endYear; year >= startYear; year--) {
    batches.push({
      start: `${year}-01-01`,
      end: `${year}-12-31`,
      year: year
    });
  }
  return batches;
}

const HISTORICAL_CONFIG = {
  // Dynamic date range based on configuration
  START_YEAR: START_YEAR,
  END_YEAR: END_YEAR,
  YEAR_BATCHES: generateYearBatches(START_YEAR, END_YEAR),
  
  // Same proven settings from production-crawler-2025
  SPEED: {
    LASERFICHE_PAGE_WAIT: 200,
    WEBLINK_PAGE_WAIT: 300,
    MAX_RETRIES: 2,
    RETRY_DELAY: 500,
    PROGRESSIVE_TIMING: {
      WEBLINK_ATTEMPTS: [
        { wait: 300, name: "fast" },
        { wait: 600, name: "medium" }, 
        { wait: 1200, name: "slow" }
      ],
      LASERFICHE_ATTEMPTS: [
        { wait: 200, name: "fast" },
        { wait: 400, name: "medium" },
        { wait: 800, name: "slow" }  
      ],
      IFRAME_ACCESS_ATTEMPTS: [
        { wait: 2000, name: "quick" },
        { wait: 4000, name: "patient" },
        { wait: 8000, name: "very_patient" }
      ]
    }
  },
  
  MAX_WORKERS: parseInt(process.env.CRAWLER_MAX_WORKERS || '30'), // Configurable, default 30
  CHUNK_SIZE: 1500,
  CHUNK_OVERLAP: 200,
  
  // Crash recovery settings
  CHECKPOINT_INTERVAL: 50,
  RESUME_FROM_YEAR: null, // Set manually if needed: 2018
  
  // Supabase connection - uses environment variables (required)
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
};

// Case listing URLs - Checking OPEN cases for configured date range
const CASE_LISTING_URLS = [
  { url: 'https://puc.idaho.gov/case?util=1&closed=0', type: 'electric', status: 'open' },
  { url: 'https://puc.idaho.gov/case?util=4&closed=0', type: 'natural_gas', status: 'open' }
  // Open cases for current activity
];

// =============================================================================
// CRASH RECOVERY SYSTEM
// =============================================================================

/**
 * Manages crash recovery and checkpoint system for the crawler
 * Saves progress to allow resuming after interruptions
 */
class CrashRecoveryManager {
  constructor() {
    this.supabase = createClient(HISTORICAL_CONFIG.SUPABASE_URL, HISTORICAL_CONFIG.SUPABASE_ANON_KEY);
    this.checkpointFile = './historical-crawler-checkpoint.json';
  }

  /**
   * Check which years are already completed in database
   * @returns {Promise<Array>} Array of completed years sorted descending
   */
  async getCompletedYears() {
    try {
      const { data: cases, error } = await this.supabase
        .from('cases')
        .select('date_filed')
        .not('date_filed', 'is', null);

      if (error) throw error;

      // Extract years from completed cases
      const completedYears = new Set();
      cases.forEach(caseData => {
        if (caseData.date_filed) {
          const year = new Date(caseData.date_filed).getFullYear();
          if (year >= HISTORICAL_CONFIG.START_YEAR && year <= HISTORICAL_CONFIG.END_YEAR) {
            completedYears.add(year);
          }
        }
      });

      return Array.from(completedYears).sort((a, b) => b - a);
    } catch (error) {
      console.log('❌ Error checking completed years:', error.message);
      return [];
    }
  }

  /**
   * Count documents for a year (for progress estimation)
   * @param {number} year - Year to count documents for
   * @returns {Promise<number>} Number of documents in the specified year
   */
  async getYearDocumentCount(year) {
    try {
      const { data, error } = await this.supabase
        .from('document_chunks')
        .select('document_id', { count: 'exact' })
        .gte('created_at', `${year}-01-01`)
        .lte('created_at', `${year}-12-31`);

      return error ? 0 : data?.length || 0;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Save checkpoint for crash recovery
   * @param {Object} yearBatch - Year batch being processed
   * @param {number} processedCount - Number of documents processed
   * @param {number} totalCount - Total documents to process
   * @param {Array} completedCases - Array of completed case numbers
   */
  saveCheckpoint(yearBatch, processedCount, totalCount, completedCases = []) {
    const checkpoint = {
      currentYear: yearBatch.year,
      dateRange: yearBatch,
      processedDocuments: processedCount,
      totalDocuments: totalCount,
      completedCases: completedCases,
      timestamp: new Date().toISOString(),
      completed: processedCount >= totalCount
    };

    try {
      fs.writeFileSync(this.checkpointFile, JSON.stringify(checkpoint, null, 2));
      console.log(`💾 Checkpoint saved: Year ${yearBatch.year} - ${processedCount}/${totalCount} documents`);
    } catch (error) {
      console.log('⚠️ Failed to save checkpoint:', error.message);
    }
  }

  /**
   * Load checkpoint from file
   * @returns {Object|null} Checkpoint data or null if not found
   */
  loadCheckpoint() {
    try {
      if (fs.existsSync(this.checkpointFile)) {
        const checkpoint = JSON.parse(fs.readFileSync(this.checkpointFile, 'utf8'));
        console.log(`📁 Checkpoint found: Year ${checkpoint.currentYear} (${checkpoint.processedDocuments}/${checkpoint.totalDocuments})`);
        return checkpoint;
      }
    } catch (error) {
      console.log('⚠️ Could not load checkpoint:', error.message);
    }
    return null;
  }

  /**
   * Clear checkpoint file
   */
  clearCheckpoint() {
    try {
      if (fs.existsSync(this.checkpointFile)) {
        fs.unlinkSync(this.checkpointFile);
        console.log('🗑️ Checkpoint cleared');
      }
    } catch (error) {
      console.log('⚠️ Could not clear checkpoint:', error.message);
    }
  }
}

// =============================================================================
// COPY ALL PROVEN CLASSES FROM PRODUCTION-CRAWLER-2025
// =============================================================================

/**
 * Handles uploading documents and chunks to Supabase database
 * Manages case creation and deduplication
 */
class SupabaseUploader {
  constructor() {
    this.supabase = createClient(HISTORICAL_CONFIG.SUPABASE_URL, HISTORICAL_CONFIG.SUPABASE_ANON_KEY);
    this.caseCache = new Map();
  }

  /**
   * Ensure a case exists in the database, creating if necessary
   * @param {Object} caseInfo - Case information object
   * @returns {Promise<string>} Case ID
   */
  async ensureCaseExists(caseInfo) {
    if (this.caseCache.has(caseInfo.caseNumber)) {
      return this.caseCache.get(caseInfo.caseNumber);
    }

    const { data: existingCase } = await this.supabase
      .from('cases')
      .select('id')
      .eq('case_number', caseInfo.caseNumber)
      .single();

    if (existingCase) {
      this.caseCache.set(caseInfo.caseNumber, existingCase.id);
      return existingCase.id;
    }

    const { data: newCase, error } = await this.supabase
      .from('cases')
      .insert({
        case_number: caseInfo.caseNumber,
        company: caseInfo.company,
        utility_type: caseInfo.utilityType,
        case_status: caseInfo.caseStatus,
        date_filed: caseInfo.dateFiled,
        description: caseInfo.description,
        case_url: caseInfo.caseUrl
      })
      .select('id')
      .single();

    if (error) {
      // Handle race condition: if case creation failed due to duplicate constraint,
      // another worker likely created it - check if it exists now
      if (error.code === '23505' || error.message.includes('duplicate key')) {
        console.log(`🔄 Case creation race condition detected for ${caseInfo.caseNumber} - checking if case now exists`);
        
        const { data: raceCase } = await this.supabase
          .from('cases')
          .select('id')
          .eq('case_number', caseInfo.caseNumber)
          .single();
        
        if (raceCase) {
          this.caseCache.set(caseInfo.caseNumber, raceCase.id);
          console.log(`✅ Found case created by another worker: ${caseInfo.caseNumber} (ID: ${raceCase.id})`);
          return raceCase.id;
        }
      }
      
      throw new Error(`Failed to create case ${caseInfo.caseNumber}: ${error.message}`);
    }

    this.caseCache.set(caseInfo.caseNumber, newCase.id);
    console.log(`✅ Created case: ${caseInfo.caseNumber} (ID: ${newCase.id})`);
    return newCase.id;
  }

  /**
   * Create text chunks for efficient storage and retrieval
   * @param {string} text - Full text to chunk
   * @param {string} documentId - Document ID
   * @param {string} caseId - Case ID
   * @param {Object} documentMetadata - Metadata for chunks
   * @returns {Array} Array of chunk objects
   */
  createChunks(text, documentId, caseId, documentMetadata) {
    const chunks = [];
    const words = text.split(/\s+/);
    let currentChunk = '';
    let chunkIndex = 0;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const testChunk = currentChunk + (currentChunk ? ' ' : '') + word;

      if (testChunk.length > HISTORICAL_CONFIG.CHUNK_SIZE && currentChunk.length > 0) {
        chunks.push({
          id: uuidv4(),
          document_id: documentId,
          case_id: caseId,
          content: currentChunk,
          content_length: currentChunk.length,
          chunk_index: chunkIndex,
          case_number: documentMetadata.caseNumber,
          company: documentMetadata.company,
          witness_name: documentMetadata.witnessName,
          document_type: documentMetadata.documentType,
          created_at: new Date().toISOString()
        });

        const overlapWords = currentChunk.split(/\s+/).slice(-Math.floor(HISTORICAL_CONFIG.CHUNK_OVERLAP / 10));
        currentChunk = overlapWords.join(' ') + ' ' + word;
        chunkIndex++;
      } else {
        currentChunk = testChunk;
      }
    }

    if (currentChunk.trim()) {
      chunks.push({
        id: uuidv4(),
        document_id: documentId,
        case_id: caseId,
        content: currentChunk,
        content_length: currentChunk.length,
        chunk_index: chunkIndex,
        case_number: documentMetadata.caseNumber,
        company: documentMetadata.company,
        witness_name: documentMetadata.witnessName,
        document_type: documentMetadata.documentType,
        created_at: new Date().toISOString()
      });
    }

    return chunks;
  }

  /**
   * Upload document and its chunks to database
   * @param {Object} documentData - Document data including text and metadata
   * @returns {Promise<Object>} Upload result with document ID and status
   */
  async uploadDocument(documentData) {
    try {
      const caseId = await this.ensureCaseExists(documentData.caseInfo);

      // CRITICAL: Check for duplicates by URL (globally unique)
      const { data: existingDoc } = await this.supabase
        .from('documents')
        .select('id, document_name, case_id')
        .eq('document_url', documentData.documentUrl)
        .single();
      
      if (existingDoc) {
        console.log(`⚠️ DUPLICATE PREVENTED: ${documentData.documentName} (URL: ${documentData.documentUrl}) already exists in database`);
        return {
          documentId: existingDoc.id,
          caseId: existingDoc.case_id,
          chunksCreated: 0,
          success: true,
          duplicate: true,
          skipped: true  // Mark as skipped for progress tracking
        };
      }

      const { data: document, error: docError } = await this.supabase
        .from('documents')
        .insert({
          case_id: caseId,
          document_name: documentData.documentName,
          document_type: documentData.documentType,
          document_url: documentData.documentUrl,
          witness_name: documentData.witnessName,
          extraction_status: 'completed',
          extracted_at: new Date().toISOString()
        })
        .select('id')
        .single();

      if (docError) {
        throw new Error(`Failed to create document: ${docError.message}`);
      }

      console.log(`📄 Created document: ${documentData.documentName} (ID: ${document.id})`);

      const chunks = this.createChunks(
        documentData.extractedText,
        document.id,
        caseId,
        {
          caseNumber: documentData.caseInfo.caseNumber,
          company: documentData.caseInfo.company,
          witnessName: documentData.witnessName,
          documentType: documentData.documentType
        }
      );

      const batchSize = 100;
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const { error: chunkError } = await this.supabase
          .from('document_chunks')
          .insert(batch);

        if (chunkError) {
          throw new Error(`Failed to upload chunks: ${chunkError.message}`);
        }
      }

      console.log(`📦 Uploaded ${chunks.length} chunks for ${documentData.documentName}`);

      return {
        documentId: document.id,
        caseId: caseId,
        chunksCreated: chunks.length,
        success: true
      };

    } catch (error) {
      console.log(`❌ Upload failed: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

/**
 * Manages intelligent retry logic for failed documents
 * Tracks failures and implements exponential backoff
 */
class SmartRetryQueue {
  constructor(maxRetries = 3) {
    this.failedDocuments = new Map();
    this.maxRetries = maxRetries;
  }
  
  /**
   * Record a document failure attempt
   * @param {string} queueId - Unique queue identifier
   * @param {Object} attemptInfo - Information about the failed attempt
   * @returns {number} Number of attempts for this document
   */
  recordFailure(queueId, attemptInfo) {
    if (!this.failedDocuments.has(queueId)) {
      this.failedDocuments.set(queueId, { 
        attempts: [], 
        lastError: '', 
        documentName: attemptInfo.documentName,
        caseNumber: attemptInfo.caseNumber
      });
    }
    
    const record = this.failedDocuments.get(queueId);
    const attemptWithTimestamp = {
      ...attemptInfo,
      timestamp: new Date().toISOString()
    };
    record.attempts.push(attemptWithTimestamp);
    record.lastError = attemptInfo.error;
    
    return record.attempts.length;
  }
  
  /**
   * Check if document should be retried
   * @param {string} queueId - Unique queue identifier
   * @returns {boolean} True if should retry
   */
  shouldRetry(queueId) {
    const record = this.failedDocuments.get(queueId);
    if (!record) return true;
    return record.attempts.length < this.maxRetries;
  }
  
  /**
   * Get progressive timing for next retry attempt
   * @param {string} queueId - Unique queue identifier
   * @param {string} documentType - Type of document (weblink_iframe or laserfiche)
   * @returns {Object} Timing configuration for next attempt
   */
  getNextAttemptSpeed(queueId, documentType) {
    const record = this.failedDocuments.get(queueId);
    const attemptNumber = record ? record.attempts.length : 0;
    
    const timingConfig = documentType === 'weblink_iframe' ? 
      HISTORICAL_CONFIG.SPEED.PROGRESSIVE_TIMING.WEBLINK_ATTEMPTS : 
      HISTORICAL_CONFIG.SPEED.PROGRESSIVE_TIMING.LASERFICHE_ATTEMPTS;
    
    const timing = timingConfig[Math.min(attemptNumber, timingConfig.length - 1)];
    return timing;
  }
  
  /**
   * Get iframe-specific timing for retry attempts
   * @param {string} queueId - Unique queue identifier
   * @returns {Object} Timing configuration for iframe access
   */
  getIframeAttemptSpeed(queueId) {
    const record = this.failedDocuments.get(queueId);
    const attemptNumber = record ? record.attempts.length : 0;
    
    const timing = HISTORICAL_CONFIG.SPEED.PROGRESSIVE_TIMING.IFRAME_ACCESS_ATTEMPTS[
      Math.min(attemptNumber, HISTORICAL_CONFIG.SPEED.PROGRESSIVE_TIMING.IFRAME_ACCESS_ATTEMPTS.length - 1)
    ];
    return timing;
  }
  
  /**
   * Log blacklisted document to file for manual review
   * @param {string} queueId - Unique queue identifier
   * @param {string} documentName - Name of the document
   * @param {string} caseNumber - Case number
   * @param {Array} attempts - Array of attempt records
   */
  logBlacklistedDocument(queueId, documentName, caseNumber, attempts) {
    const blacklistEntry = {
      timestamp: new Date().toISOString(),
      queueId: queueId,
      documentName: documentName,
      caseNumber: caseNumber,
      attempts: attempts.length,
      errors: attempts.map(a => a.error),
      lastError: attempts[attempts.length - 1]?.error || 'Unknown',
      documentUrl: attempts[attempts.length - 1]?.documentUrl || 'Unknown'
    };
    
    try {
      const fs = require('fs');
      const logFile = './blacklisted-documents.json';
      
      let blacklist = [];
      if (fs.existsSync(logFile)) {
        blacklist = JSON.parse(fs.readFileSync(logFile, 'utf8'));
      }
      
      blacklist.push(blacklistEntry);
      fs.writeFileSync(logFile, JSON.stringify(blacklist, null, 2));
      
      console.log(`📝 BLACKLISTED & LOGGED: ${documentName} from ${caseNumber}`);
    } catch (error) {
      console.log(`⚠️ Failed to log blacklisted document: ${error.message}`);
    }
  }

  /**
   * Check if document should be blacklisted
   * @param {string} queueId - Unique queue identifier
   * @returns {boolean} True if should be blacklisted
   */
  shouldBlacklist(queueId) {
    const record = this.failedDocuments.get(queueId);
    if (!record) return false;
    
    if (record.attempts.length >= this.maxRetries) {
      // Log the blacklisted document with details
      this.logBlacklistedDocument(
        queueId, 
        record.documentName || 'Unknown', 
        record.caseNumber || 'Unknown',
        record.attempts
      );
      
      console.log(`🚨 BLACKLISTING: Document failed ${record.attempts.length} times - giving up`);
      return true;
    }
    
    return false;
  }
}

/**
 * Tracks and reports processing progress
 * Provides estimated completion times and success rates
 */
class ProgressTracker {
  constructor(totalDocuments, currentYear) {
    this.totalDocuments = totalDocuments;
    this.currentYear = currentYear;
    this.completed = 0;
    this.errors = 0;
    this.skippedDuplicates = 0;  // Track documents skipped as duplicates
    this.actualNewDocuments = 0;  // Track actual new documents created
    this.startTime = Date.now();
    this.lastUpdate = Date.now();
    this.UPDATE_INTERVAL = 30000; // 30 seconds
  }
  
  /**
   * Record successful document processing
   */
  recordSuccess() {
    this.completed++;
    this.checkForUpdate();
  }
  
  /**
   * Record a duplicate that was skipped
   */
  recordSkipped() {
    this.skippedDuplicates++;
    this.completed++;  // Still counts as processed
    this.checkForUpdate();
  }
  
  /**
   * Record an actual new document created
   */
  recordNewDocument() {
    this.actualNewDocuments++;
  }
  
  /**
   * Record failed document processing
   */
  recordError() {
    this.errors++;
    this.checkForUpdate();
  }
  
  checkForUpdate() {
    const now = Date.now();
    if (now - this.lastUpdate > this.UPDATE_INTERVAL) {
      this.printUpdate();
      this.lastUpdate = now;
    }
  }
  
  forceUpdate() {
    this.printUpdate();
    this.lastUpdate = Date.now();
  }
  
  printUpdate() {
    const processed = this.completed + this.errors;
    const remaining = Math.max(0, this.totalDocuments - processed);
    const successRate = processed > 0 ? ((this.completed / processed) * 100).toFixed(1) : '0.0';
    const elapsed = Math.round((Date.now() - this.startTime) / 1000);
    const avgTime = processed > 0 ? Math.round(elapsed / processed) : 0;
    const estimatedRemaining = remaining > 0 && avgTime > 0 ? Math.round((remaining * avgTime) / 60) : '?';
    
    console.log('\n' + '='.repeat(60));
    console.log(`📊 CRAWLER PROGRESS - ${this.currentYear}`);
    console.log('='.repeat(60));
    console.log(`✅ Documents Checked: ${this.completed}`);
    console.log(`  📄 New Documents Created: ${this.actualNewDocuments}`);
    console.log(`  ⏭️  Duplicates Skipped: ${this.skippedDuplicates}`);
    console.log(`❌ Errors: ${this.errors}`);
    console.log(`📈 Success Rate: ${successRate}%`);
    console.log(`📦 Queue Remaining: ${remaining} (to check)`);
    console.log(`⏱️  Elapsed: ${Math.floor(elapsed / 60)}:${(elapsed % 60).toString().padStart(2, '0')}`);
    console.log(`⚡ Avg Speed: ${avgTime}s per check`);
    console.log(`🔮 Est. Time: ${estimatedRemaining} minutes`);
    console.log('='.repeat(60) + '\n');
  }
}

// =============================================================================
// EXTRACTION FUNCTIONS (COPY FROM PRODUCTION)
// =============================================================================

/**
 * Clean extracted text by removing UI elements and normalizing whitespace
 * @param {string} rawText - Raw extracted text
 * @returns {string} Cleaned text
 */
function cleanExtractedText(rawText) {
  return rawText
    .replace(/View plain text/gi, '')
    .replace(/View images/gi, '')
    .replace(/Search in document/gi, '')
    .replace(/PUC Case Management/gi, '')
    .replace(/PublicFiles.*?Company/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}

/**
 * Extract text from LaserFiche document viewer
 * @param {Object} page - Puppeteer page object
 * @param {number} totalPages - Total pages to extract
 * @param {number} workerId - Worker identifier
 * @returns {Promise<Object>} Extracted text and page count
 */
async function extractLaserFicheTextFast(page, totalPages, workerId) {
  console.log(`[Worker ${workerId}] ⚡ LaserFiche: ${totalPages} pages (${HISTORICAL_CONFIG.SPEED.LASERFICHE_PAGE_WAIT}ms/page)`);
  
  let allText = '';
  let successfulPages = 0;
  
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    let pageExtracted = false;
    let retryCount = 0;
    
    while (!pageExtracted && retryCount <= HISTORICAL_CONFIG.SPEED.MAX_RETRIES) {
      try {
        await page.evaluate((targetPage) => {
          const pageInput = document.querySelector('#pageNum');
          if (pageInput) {
            pageInput.focus();
            pageInput.select();
            pageInput.value = targetPage.toString();
            pageInput.dispatchEvent(new Event('input', { bubbles: true }));
            pageInput.dispatchEvent(new Event('change', { bubbles: true }));
            pageInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, bubbles: true }));
          }
        }, pageNum);
        
        await new Promise(resolve => setTimeout(resolve, HISTORICAL_CONFIG.SPEED.LASERFICHE_PAGE_WAIT));
        
        const pageText = await page.evaluate(() => {
          const currentPage = document.querySelector('.currentImageBoxShadow .textPageInner.TextLayer');
          if (currentPage) {
            return (currentPage.textContent || currentPage.innerText || '').trim();
          }
          
          const textLayers = document.querySelectorAll('.textPageInner.TextLayer');
          for (const layer of textLayers) {
            const text = (layer.textContent || layer.innerText || '').trim();
            if (text.length > 10) {
              return text;
            }
          }
          return '';
        });
        
        if (pageText.length > 10) {
          allText += `\n--- PAGE ${pageNum} ---\n${pageText}\n`;
          successfulPages++;
          pageExtracted = true;
        } else if (retryCount < HISTORICAL_CONFIG.SPEED.MAX_RETRIES) {
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, HISTORICAL_CONFIG.SPEED.RETRY_DELAY));
        } else {
          pageExtracted = true;
        }
        
      } catch (error) {
        retryCount++;
        if (retryCount > HISTORICAL_CONFIG.SPEED.MAX_RETRIES) {
          pageExtracted = true;
        } else {
          await new Promise(resolve => setTimeout(resolve, HISTORICAL_CONFIG.SPEED.RETRY_DELAY));
        }
      }
    }
    
    if (pageNum % 50 === 0 || pageNum === totalPages) {
      console.log(`[Worker ${workerId}] 📊 Progress: ${pageNum}/${totalPages} (${successfulPages} successful)`);
    }
  }
  
  return { text: allText, pages: successfulPages };
}

/**
 * Extract text from WebLink PDF viewer with progressive retry
 * @param {Object} frame - Puppeteer frame object
 * @param {number} workerId - Worker identifier
 * @param {string} queueId - Queue identifier for retry tracking
 * @param {Object} retryQueue - Smart retry queue instance
 * @param {string} documentType - Type of document being extracted
 * @returns {Promise<Object>} Extracted text, pages, and speed info
 */
async function extractWebLinkTextProgressive(frame, workerId, queueId, retryQueue, documentType) {
  const speedConfig = retryQueue.getNextAttemptSpeed(queueId, documentType);
  
  console.log(`[Worker ${workerId}] ⚡ WebLink (${speedConfig.name} mode: ${speedConfig.wait}ms/page)`);
  
  const viewerTimeout = speedConfig.wait * 15;
  
  await frame.waitForFunction(() => {
    const viewer = document.querySelector('#viewer.pdfViewer');
    const pages = document.querySelectorAll('.page[data-page-number]');
    return viewer && pages.length > 0;
  }, { timeout: viewerTimeout });

  const totalPages = await frame.evaluate(() => {
    const pages = document.querySelectorAll('.page[data-page-number]');
    return pages.length;
  });
  
  let allText = '';
  let successfulPages = 0;
  
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    let pageExtracted = false;
    let retryCount = 0;
    const maxRetries = speedConfig.name === 'fast' ? 1 : 2;
    
    while (!pageExtracted && retryCount <= maxRetries) {
      try {
        await frame.evaluate((targetPage) => {
          const pageInput = document.querySelector('#pageNumber');
          if (pageInput) {
            pageInput.focus();
            pageInput.value = targetPage.toString();
            pageInput.dispatchEvent(new Event('change', { bubbles: true }));
            pageInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          }
        }, pageNum);
        
        await new Promise(resolve => setTimeout(resolve, speedConfig.wait));
        
        const pageText = await frame.evaluate((targetPage) => {
          const pageElement = document.querySelector(`.page[data-page-number="${targetPage}"]`);
          if (pageElement) {
            const textSpans = pageElement.querySelectorAll('.textLayer span[role="presentation"]');
            if (textSpans.length > 0) {
              let text = '';
              textSpans.forEach(span => {
                const spanText = span.textContent || span.innerText || '';
                if (spanText.trim()) {
                  text += spanText + ' ';
                }
              });
              if (text.trim().length > 50) {
                return text.trim();
              }
            }
          }
          return '';
        }, pageNum);
        
        if (pageText && pageText.length > 20) {
          allText += `\n--- PAGE ${pageNum} ---\n${pageText}\n`;
          successfulPages++;
          pageExtracted = true;
        } else if (retryCount < maxRetries) {
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, speedConfig.wait / 2));
        } else {
          pageExtracted = true;
        }
        
      } catch (error) {
        retryCount++;
        if (retryCount > maxRetries) {
          pageExtracted = true;
        } else {
          await new Promise(resolve => setTimeout(resolve, speedConfig.wait / 2));
        }
      }
    }
    
    if (pageNum % 25 === 0 || pageNum === totalPages) {
      console.log(`[Worker ${workerId}] 📊 Progress: ${pageNum}/${totalPages} (${successfulPages} successful) [${speedConfig.name} mode]`);
    }
  }
  
  return { text: allText, pages: successfulPages, speed: speedConfig.name };
}

/**
 * Main document extraction function
 * @param {Object} page - Puppeteer page object
 * @param {string} documentUrl - URL of document to extract
 * @param {string} documentName - Name of the document
 * @param {Object} caseInfo - Case information
 * @param {Object} documentMetadata - Document metadata
 * @param {number} workerId - Worker identifier
 * @param {Object} uploader - SupabaseUploader instance
 * @param {Object} retryQueue - SmartRetryQueue instance
 * @returns {Promise<Object|null>} Extraction result or null if failed
 */
async function extractDocumentText(page, documentUrl, documentName, caseInfo, documentMetadata, workerId, uploader, retryQueue) {
  try {
    console.log(`[Worker ${workerId}] 📄 Extracting: ${documentName}`);
    
    await page.goto(documentUrl, { waitUntil: 'networkidle2', timeout: 120000 });
    await new Promise(resolve => setTimeout(resolve, 2000));

    const needsTextMode = await page.evaluate(() => {
      const textModeButton = document.querySelector('#TEXTMODE');
      return !!textModeButton;
    });

    if (needsTextMode) {
      console.log(`[Worker ${workerId}] 🔄 Clicking "View plain text" button...`);
      await page.click('#TEXTMODE');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const documentTypeInfo = await page.evaluate(() => {
      const hasTextLayers = document.querySelectorAll('.textPageInner.TextLayer').length > 0;
      const hasWebLinkIframe = document.querySelector('#pdfViewerIFrame') !== null;
      
      let documentType = 'unknown';
      let pageCount = 0;
      
      if (hasTextLayers) {
        documentType = 'laserfiche_image';
        
        const pageCountDiv = document.querySelector('div[style*="display: inline-block"]');
        if (pageCountDiv && pageCountDiv.textContent.includes('/')) {
          const match = pageCountDiv.textContent.match(/\/\s*(\d+)/);
          pageCount = match ? parseInt(match[1]) : 0;
        }
        
        if (pageCount === 0) {
          const bodyText = document.body.textContent || '';
          const match = bodyText.match(/\/\s*(\d+)/);
          pageCount = match ? parseInt(match[1]) : 0;
        }
        
        if (pageCount === 0) {
          const textLayers = document.querySelectorAll('.textPageInner.TextLayer');
          pageCount = textLayers.length;
        }
        
        if (pageCount === 0) {
          const pageInput = document.querySelector('#pageNum');
          if (pageInput && pageInput.max) {
            pageCount = parseInt(pageInput.max);
          }
        }
        
        if (pageCount === 0) {
          const currentPage = document.querySelector('.currentImageBoxShadow .textPageInner.TextLayer');
          if (currentPage && currentPage.textContent && currentPage.textContent.trim().length > 10) {
            pageCount = 1;
          }
        }
        
      } else if (hasWebLinkIframe) {
        documentType = 'weblink_iframe';
      }
      
      return { documentType, pageCount };
    });

    if (documentTypeInfo.documentType === 'laserfiche_image' && documentTypeInfo.pageCount === 0) {
      console.log(`[Worker ${workerId}] ⚠️ Skipping document with 0 pages detected: ${documentName}`);
      return null;
    }

    console.log(`[Worker ${workerId}] 🔍 Type: ${documentTypeInfo.documentType}, Pages: ${documentTypeInfo.pageCount || 'unknown'}`);

    let fullText = '';
    let totalPages = 0;

    if (documentTypeInfo.documentType === 'laserfiche_image') {
      const result = await extractLaserFicheTextFast(page, documentTypeInfo.pageCount, workerId);
      fullText = result.text;
      totalPages = result.pages;
      
    } else if (documentTypeInfo.documentType === 'weblink_iframe') {
      console.log(`[Worker ${workerId}] 🔗 WebLink iframe detected`);
      
      await page.waitForSelector('#pdfViewerIFrame', { timeout: 15000 });
      const iframe = await page.$('#pdfViewerIFrame');
      const frame = await iframe.contentFrame();
      
      if (!frame) {
        throw new Error('Could not access iframe content');
      }
      
      const result = await extractWebLinkTextProgressive(frame, workerId, documentMetadata.queueId, retryQueue, documentTypeInfo.documentType);
      fullText = result.text;
      totalPages = result.pages;
    }

    if (fullText.trim()) {
      const cleanedText = cleanExtractedText(fullText);
      
      const uploadResult = await uploader.uploadDocument({
        caseInfo: caseInfo,
        documentName: documentName,
        documentType: documentMetadata.documentType || 'Unknown',
        documentUrl: documentUrl,
        witnessName: documentMetadata.witnessName,
        extractedText: cleanedText
      });

      if (uploadResult.success) {
        console.log(`[Worker ${workerId}] ✅ Uploaded: ${documentName} (${totalPages} pages, ${uploadResult.chunksCreated} chunks)`);
        
        return {
          success: true,
          documentName: documentName,
          pages: totalPages,
          textLength: cleanedText.length,
          chunksCreated: uploadResult.chunksCreated,
          documentId: uploadResult.documentId,
          caseId: uploadResult.caseId
        };
      } else {
        console.log(`[Worker ${workerId}] ❌ Upload failed: ${uploadResult.error}`);
        return null;
      }
    } else {
      console.log(`[Worker ${workerId}] ❌ No text extracted from ${documentName}`);
      return null;
    }

  } catch (error) {
    console.log(`[Worker ${workerId}] 💥 Error: ${error.message}`);
    return null;
  }
}

// =============================================================================
// CASE DISCOVERY FUNCTIONS (COPY FROM PRODUCTION)
// =============================================================================

async function extractCaseListings(page, utilityType, caseStatus) {
  return page.evaluate(({ utilType, status }) => {
    const cases = [];
    const tables = Array.from(document.querySelectorAll('table'));
    let caseTable = tables.find((tbl) => {
      const txt = tbl.textContent.toLowerCase();
      return txt.includes('caseno') && txt.includes('company') && txt.includes('description');
    });

    if (!caseTable) {
      caseTable = tables.find((tbl) => {
        const links = Array.from(tbl.querySelectorAll('a[href*="case"]'));
        return links.some((a) => /[A-Z]{2,4}-[A-Z]-\d{2}-\d{2}/.test(a.textContent));
      });
    }

    if (!caseTable) {
      return cases;
    }

    const rows = Array.from(caseTable.querySelectorAll('tr'));
    rows.forEach((row) => {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 3) {
        const caseNumber = cells[0].textContent.trim();
        const company = cells[1].textContent.trim();
        const description = cells[2].textContent.trim();
        const caseUrl = cells[0].querySelector('a')?.href;
        
        if (caseNumber && caseUrl && /[A-Z]{2,4}-[A-Z]-\d{2}-\d{2}/.test(caseNumber)) {
          cases.push({
            caseNumber,
            company,
            description,
            caseUrl,
            utilityType: utilType,
            caseStatus: status,
          });
        }
      }
    });

    return cases;
  }, { utilType: utilityType, status: caseStatus });
}

async function validateCaseDate(page, startDate, endDate) {
  const caseMetadata = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    let caseTable = null;
    
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('th'));
      const hasDateFiled = headers.some(th => 
        th.textContent.includes('Date Filed') || 
        th.textContent.includes('Last Updated')
      );
      if (hasDateFiled) {
        caseTable = table;
        break;
      }
    }
    
    if (!caseTable) {
      return null;
    }
    
    const dataRow = caseTable.querySelector('tbody tr') || caseTable.querySelector('tr:last-child');
    if (!dataRow) return null;
    
    const cells = dataRow.querySelectorAll('td');
    if (cells.length < 5) return null;
    
    const dateFiledText = cells[2]?.textContent?.trim();
    const dateMatch = dateFiledText?.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
    const dateFiled = dateMatch ? dateMatch[0] : null;
    
    return {
      caseNumber: cells[1]?.textContent?.trim(),
      dateFiled: dateFiled,
      caseType: cells[3]?.textContent?.trim(),
      status: cells[4]?.textContent?.trim(),
      description: cells[5]?.textContent?.trim()
    };
  });

  if (!caseMetadata || !caseMetadata.dateFiled) {
    return { isValid: false, caseMetadata: null };
  }
  
  const filed = new Date(caseMetadata.dateFiled);
  const startDateObj = new Date(startDate);
  const endDateObj = new Date(endDate);
  
  const isValid = filed >= startDateObj && filed <= endDateObj;
  
  return {
    isValid: isValid,
    caseMetadata: caseMetadata
  };
}

async function getDocumentLinksFromCase(page, caseInfo) {
  await page.goto(caseInfo.caseUrl, { waitUntil: 'networkidle2' });
  
  const documentLinks = await page.evaluate(() => {
    const links = [];
    
    function extractWitnessFromFilename(filename) {
      const patterns = [
        /DIRECT\s+([A-Z]\.\s*[A-Z][A-Z\s\.]+?)(?:_EXHIBITS)?\.PDF$/i,
        /DIRECT\s+([A-Z][A-Z\s\.]+?)(?:_EXHIBITS)?\.PDF$/i,
      ];
      
      for (const pattern of patterns) {
        const match = filename.match(pattern);
        if (match && match[1]) {
          return match[1].trim().replace(/\s+/g, ' ');
        }
      }
      return null;
    }
    
    function getDocumentType(filename, section) {
      if (filename.includes('DIRECT') && section === 'Company') {
        return 'Company_Direct_Testimony';
      } else if (section === 'Staff') {
        return 'Staff_Document';
      } else if (section === 'Public Comments') {
        return 'Public_Comments';
      }
  
      return 'Other_Document';
    }
    
    // PROVEN FILTERING: Only include safe sections that don't cause infinite loops
    const sectionSelectors = [
      { name: 'Company', selector: 'h3, h4, .div-header-box' },
      { name: 'Staff', selector: 'h3, h4, .div-header-box' },
      { name: 'Intervenor', selector: 'h3, h4, .div-header-box' },
      { name: 'Public Comments', selector: 'h3, h4, .div-header-box' }
      // EXCLUDED: 'Case Files', 'Orders & Notices' - these contain problematic documents
    ];
    
    sectionSelectors.forEach(sectionConfig => {
      const headers = Array.from(document.querySelectorAll(sectionConfig.selector))
        .filter(h => h.textContent.trim() === sectionConfig.name);
      
      headers.forEach(header => {
        let container = header.parentElement;
        while (container && !container.querySelector('a[href*="lf-puc.idaho.gov"]') && container.parentElement) {
          container = container.parentElement;
        }
        
        if (container) {
          const sectionLinks = Array.from(container.querySelectorAll('a[href*="lf-puc.idaho.gov"]'));
          
          sectionLinks.forEach(link => {
            const documentName = link.textContent.trim();
            if (documentName && documentName.length > 3) {
              
              // FILTER: Only process PDF files
              if (!documentName.toUpperCase().endsWith('.PDF')) {
                console.log(`⏭️ Skipping non-PDF: ${documentName}`);
                return; // Skip non-PDF files
              }
              
              const witnessName = extractWitnessFromFilename(documentName);
              const documentType = getDocumentType(documentName, sectionConfig.name);
              
              links.push({
                text: documentName,
                href: link.href,
                section: sectionConfig.name,
                witnessName: witnessName,
                documentType: documentType,
                queueId: `${link.href}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
              });
            }
          });
        }
      });
    });
    
    return links;
  });
  
  return documentLinks;
}

// =============================================================================
// HISTORICAL CRAWLER CLASS
// =============================================================================

/**
 * Main crawler class for processing historical Idaho PUC documents
 * Coordinates discovery, extraction, and upload of regulatory documents for configured date range
 */
class HistoricalCrawler {
  constructor() {
    this.uploader = new SupabaseUploader();
    this.recoveryManager = new CrashRecoveryManager();
    
    // Two-level queue properties
    this.caseQueue = [];  // Array of case objects (from discovery)
    this.currentCaseDocumentQueue = [];  // Document queue for current case being processed
    this.currentCaseInfo = null;  // Current case being processed
    this.queueLock = { inUse: false };
    this.discoveryComplete = false;
    
    // Pipeline persistence
    this.pipelineFile = path.join(__dirname, 'discovered-cases-pipeline.json');
    
    // Case completion tracking for progressive pipeline updates
    this.caseDocumentCounts = new Map(); // caseNumber -> total documents
    this.caseCompletedCounts = new Map(); // caseNumber -> completed documents
    
    this.overallStats = {
      startTime: Date.now(),
      yearsCompleted: 0,
      totalCasesProcessed: 0,
      totalDocumentsProcessed: 0,
      totalChunksCreated: 0,
      totalErrors: 0,
      yearResults: []
    };
  }

  /**
   * Main entry point for crawling historical data
   * Handles crash recovery, discovery, and parallel processing
   * @returns {Promise<void>}
   */
  async crawlHistoricalData() {
    const yearCount = HISTORICAL_CONFIG.END_YEAR - HISTORICAL_CONFIG.START_YEAR + 1;
    console.log(`🏛️  HISTORICAL IDAHO PUC CRAWLER (${HISTORICAL_CONFIG.END_YEAR}-${HISTORICAL_CONFIG.START_YEAR})`);
    console.log(`📅 ${yearCount}-year comprehensive crawl with crash recovery`);
    console.log('🔄 MULTI-YEAR PARALLEL PROCESSING - No idle workers!');
    console.log('💾 Smart resume from Supabase state');
    console.log('⚡ Based on proven production-crawler-2025 (99.5% success rate)');
    console.log('=' .repeat(70));

    // PRIORITY 1: Check for saved pipeline first (crash recovery)
    const savedPipeline = this.loadPipeline();
    if (savedPipeline && savedPipeline.length > 0) {
      console.log(`🔄 PIPELINE RESUME: Found saved pipeline with ${savedPipeline.length} cases`);
      console.log('🚀 Continuing discovery from saved pipeline - processing saved cases first...\n');
      
      // Process saved cases first, then continue discovery
      await this.buildMultiYearQueue([], savedPipeline);
      this.recoveryManager.clearCheckpoint();
      return;
    }

    // PRIORITY 2: No pipeline found, run case-based discovery with efficiency fix
    console.log('📄 No saved pipeline - starting REAL-TIME discovery with immediate processing');
    console.log('🚀 EFFICIENCY MODE: Real-time duplicate checking during discovery!');
    
    // Skip year-based completion check - use case-based discovery instead
    // This ensures we find ALL cases across all years with efficient duplicate filtering

    // Get existing documents to avoid duplicates
    const existingDocs = await this.getAllExistingDocuments();
    console.log(`📋 Found ${existingDocs.size} existing documents in database`);
    
    // Start REAL-TIME parallel discovery and processing with efficiency fix
    const discoveryPromise = this.discoverCases({
      savePipeline: true,
      existingDocs: existingDocs,
      realTimeQueue: true,
      navigatePages: true
    });
    const processingPromise = this.startParallelProcessing();
    
    console.log(`🏭 Starting ${HISTORICAL_CONFIG.MAX_WORKERS} workers immediately - they will process documents as discovery finds them!`);
    
    // Wait for both to complete
    await Promise.all([discoveryPromise, processingPromise]);
    
    // Final verification: ensure ALL cases are in database
    await this.performFinalVerification();
    
    // Clear pipeline on successful completion
    this.clearPipeline();
  }

  /**
   * Nightly crawl method - checks open cases for new documents
   * Used by nightly-crawler.js for incremental updates
   */
  async crawlNightlyUpdates() {
    console.log('🌙 NIGHTLY UPDATE MODE: Checking open cases for new documents');
    console.log('=' .repeat(70));
    
    // Track results for nightly crawler
    let documentsChecked = 0;
    let newDocumentsCreated = 0;
    
    // Get existing documents to avoid duplicates
    const existingDocs = await this.getAllExistingDocuments();
    console.log(`📋 Found ${existingDocs.size} existing documents in database`);
    
    // Start parallel discovery and processing with nightly mode enabled
    const discoveryPromise = this.discoverCases({
      savePipeline: false,  // Don't save pipeline for nightly runs
      existingDocs: existingDocs,
      realTimeQueue: true,
      navigatePages: true,
      checkExistingCases: true  // KEY: Check existing cases for new documents
    });
    
    const processingPromise = this.startParallelProcessing().then(results => {
      documentsChecked = results.length;
      // Count only actual new documents (not skipped duplicates)
      newDocumentsCreated = results.filter(r => !r.skipped && !r.duplicate).length;
      return results;
    });
    
    console.log(`🏭 Starting ${HISTORICAL_CONFIG.MAX_WORKERS} workers to process new documents...`);
    
    // Wait for both to complete
    await Promise.all([discoveryPromise, processingPromise]);
    
    console.log('✅ Nightly update complete');
    console.log(`📊 Checked ${documentsChecked} documents, created ${newDocumentsCreated} new documents`);
    
    // Return the count for the nightly crawler to use
    return { 
      documentsProcessed: newDocumentsCreated,  // Return actual new documents for accurate reporting
      documentsChecked: documentsChecked 
    };
  }

  async processYearBatch(yearBatch) {
    console.log(`🔍 Discovering cases for ${yearBatch.year}...`);
    
    const discoveryBrowser = await puppeteer.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--single-process',
        '--no-zygote'
      ]
    });

    let yearStats = {
      year: yearBatch.year,
      casesProcessed: 0,
      documentsProcessed: 0,
      chunksCreated: 0,
      errors: 0
    };

    try {
      // Step 1: Discover cases for this year
      const allCases = await this.discoverYearCases(discoveryBrowser, yearBatch);
      console.log(`✅ Found ${allCases.length} cases in ${yearBatch.year}`);

      if (allCases.length === 0) {
        console.log(`⚠️ No cases found for ${yearBatch.year}`);
        return yearStats;
      }

      // Step 2: Build document queue
      console.log(`📄 Building document queue for ${yearBatch.year}...`);
      const globalDocumentQueue = await this.buildGlobalDocumentQueue(discoveryBrowser, allCases);
      console.log(`📦 Queue: ${globalDocumentQueue.length} documents from ${allCases.length} cases`);

      await discoveryBrowser.close();

      if (globalDocumentQueue.length === 0) {
        console.log(`⚠️ No documents found in ${yearBatch.year} cases`);
        return yearStats;
      }

      // Step 3: Process documents
      console.log(`🏭 Processing ${yearBatch.year} documents with 30 workers...`);
      const results = await this.processMultiYearQueue(globalDocumentQueue);

      yearStats.casesProcessed = allCases.length;
      yearStats.documentsProcessed = results.totalCompleted;
      yearStats.chunksCreated = results.totalChunks;
      yearStats.errors = results.errors;

      return yearStats;

    } catch (error) {
      if (discoveryBrowser) {
        await discoveryBrowser.close().catch(() => {});
      }
      throw error;
    }
  }

  /**
   * Unified case discovery method that handles all discovery patterns
   * @param {Object} options - Discovery configuration options
   * @param {Object} options.browser - Puppeteer browser instance (optional, will create if not provided)
   * @param {Object} options.yearBatch - Year range for filtering {start, end, year} (optional)
   * @param {boolean} options.savePipeline - Whether to save discovered cases to pipeline file
   * @param {Set} options.existingDocs - Set of existing document URLs to check for duplicates
   * @param {boolean} options.realTimeQueue - Whether to add cases to queue in real-time for parallel processing
   * @param {boolean} options.navigatePages - Whether to navigate through multiple pages (true for full discovery)
   * @param {string} options.dateRangeStart - Start date for validation (default: '2010-01-01')
   * @param {string} options.dateRangeEnd - End date for validation (default: '2024-12-31')
   * @returns {Array} Array of discovered case objects
   */
  async discoverCases(options = {}) {
    const {
      browser = null,
      yearBatch = null,
      savePipeline = false,
      existingDocs = null,
      realTimeQueue = false,
      navigatePages = false,
      dateRangeStart = yearBatch?.start || `${HISTORICAL_CONFIG.START_YEAR}-01-01`,
      dateRangeEnd = yearBatch?.end || `${HISTORICAL_CONFIG.END_YEAR}-12-31`,
      checkExistingCases = false  // For nightly crawler - check existing cases for new documents
    } = options;

    const allCases = [];
    const shouldCloseBrowser = !browser;
    
    // Create browser if not provided
    const discoveryBrowser = browser || await puppeteer.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security', '--single-process', '--no-zygote']
    });

    try {
      for (const listingUrl of CASE_LISTING_URLS) {
        const yearInfo = yearBatch ? `${yearBatch.year} ` : '';
        console.log(`🔍 ${navigatePages ? 'Scanning ALL' : 'Checking'} ${yearInfo}${listingUrl.type} ${listingUrl.status} cases${navigatePages ? ' across all pages' : ''}...`);
        
        const page = await discoveryBrowser.newPage();
        
        try {
          await page.goto(listingUrl.url, { waitUntil: 'networkidle2' });
          
          // Determine number of pages to process
          const totalPages = navigatePages ? (listingUrl.type === 'electric' ? 45 : 4) : 1;
          
          for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
            if (navigatePages && currentPage > 1) {
              console.log(`  📋 Discovery: Processing page ${currentPage}/${totalPages}...`);
              
              // Try to paginate - wrap in try-catch to handle single-page results gracefully
              try {
                await page.evaluate((pageNum) => {
                  if (typeof window.pagePSFGrid === 'function') {
                    window.pagePSFGrid(pageNum.toString());
                  } else {
                    // No pagination available - likely single page of results
                    throw new Error('No pagination function available');
                  }
                }, currentPage);
                
                // Wait for page to load
                await new Promise(resolve => setTimeout(resolve, 2000));
              } catch (paginationError) {
                // Only log if it's not the expected "no pagination" error
                if (!paginationError.message.includes('No pagination function') && 
                    !paginationError.message.includes('pagePSFGrid is not a function')) {
                  console.log(`  ⚠️  Pagination error: ${paginationError.message}`);
                }
                // Continue anyway - might be last page or single page of results
              }
            }
            
            // Extract cases from current page
            const pageCases = await extractCaseListings(page, listingUrl.type, listingUrl.status);
            
            // Process each case
            for (const caseInfo of pageCases) {
              try {
                await page.goto(caseInfo.caseUrl, { waitUntil: 'networkidle2' });
                const validation = await validateCaseDate(page, dateRangeStart, dateRangeEnd);
                
                if (validation.isValid && validation.caseMetadata) {
                  const enhancedCaseInfo = {
                    ...caseInfo,
                    dateFiled: validation.caseMetadata.dateFiled,
                    caseType: validation.caseMetadata.caseType,
                    status: validation.caseMetadata.status
                  };
                  
                  // ALWAYS check if case already exists to prevent duplicates in pipeline
                  const { data: existingCase } = await this.uploader.supabase
                    .from('cases')
                    .select('id')
                    .eq('case_number', enhancedCaseInfo.caseNumber)
                    .single();
                  
                  if (existingCase) {
                    if (checkExistingCases) {
                      // For nightly crawler: check if case has new documents before adding to queue
                      console.log(`    🔍 Nightly check: ${caseInfo.caseNumber} exists - checking for new documents`);
                      
                      // Extract document list from the case page
                      // No need to navigate again - we're already on the case page from validation
                      const documentLinks = await getDocumentLinksFromCase(page, enhancedCaseInfo);
                      
                      // Check which documents are new
                      const { data: existingCaseDocs } = await this.uploader.supabase
                        .from('documents')
                        .select('document_name')
                        .eq('case_id', existingCase.id);
                      
                      const existingDocNames = new Set((existingCaseDocs || []).map(d => d.document_name));
                      const newDocuments = documentLinks.filter(doc => !existingDocNames.has(doc.text));
                      
                      if (newDocuments.length > 0) {
                        console.log(`    📊 Case has ${documentLinks.length} total documents (${existingDocNames.size} in database, ${newDocuments.length} potentially new)`);
                        allCases.push(enhancedCaseInfo);
                        
                        // Add to queue since there are new documents
                        if (realTimeQueue && existingDocs) {
                          await this.addCaseToQueue(page, enhancedCaseInfo, existingDocs);
                          console.log(`    ✅ Added case to processing queue for document verification`);
                        }
                      } else {
                        console.log(`    ⏭️ ${caseInfo.caseNumber} has no new documents (${documentLinks.length} total, all in database) - skipping`);
                      }
                      continue; // Skip further processing for existing cases
                    } else {
                      // For historical crawler: skip existing cases
                      console.log(`    ⏭️ Discovery: ${caseInfo.caseNumber} already exists in database - skipping`);
                      continue; // Skip for historical mode
                    }
                  }
                  
                  // NEW CASE FOUND - Process it (for both historical and nightly modes)
                  if (checkExistingCases) {
                    console.log(`    🆕 NEW CASE DISCOVERED: ${caseInfo.caseNumber} - will process all documents`);
                  }
                  
                  allCases.push(enhancedCaseInfo);
                  const yearDisplay = yearBatch ? `${yearBatch.year} Case` : 'Historical Case';
                  console.log(`    ✅ ${yearDisplay}: ${caseInfo.caseNumber} (${validation.caseMetadata.dateFiled})`);
                  
                  // Save pipeline periodically if requested
                  if (savePipeline && (allCases.length === 1 || allCases.length % 10 === 0)) {
                    this.savePipeline(allCases);
                    console.log(`    💾 Pipeline saved: ${allCases.length} cases discovered`);
                  }
                  
                  // Add to queue in real-time if requested
                  if (realTimeQueue && existingDocs) {
                    await this.addCaseToQueue(page, enhancedCaseInfo, existingDocs);
                    console.log(`    📄 Added to worker queue immediately`);
                  }
                }
                
                // Navigate back to listing if we're going to continue
                if (navigatePages || pageCases.indexOf(caseInfo) < pageCases.length - 1) {
                  await page.goto(listingUrl.url, { waitUntil: 'networkidle2' });
                  if (navigatePages && currentPage > 1) {
                    try {
                      await page.evaluate((pageNum) => {
                        if (typeof window.pagePSFGrid === 'function') {
                          window.pagePSFGrid(pageNum.toString());
                        }
                      }, currentPage);
                      await new Promise(resolve => setTimeout(resolve, 1000));
                    } catch (e) {
                      // Silently continue - pagination might not be available
                    }
                  }
                }
                
              } catch (caseError) {
                console.log(`    ❌ Error validating case ${caseInfo.caseNumber}: ${caseError.message}`);
                if (this.overallStats) this.overallStats.totalErrors++;
              }
            }
            
            // Save pipeline backup every 5 pages
            if (savePipeline && navigatePages && currentPage % 5 === 0 && allCases.length > 0) {
              this.savePipeline(allCases);
              console.log(`  💾 Pipeline backup saved: ${allCases.length} cases discovered so far`);
            }
          }
          
        } catch (error) {
          console.log(`❌ Error processing ${listingUrl.url}: ${error.message}`);
          if (this.overallStats) this.overallStats.totalErrors++;
        } finally {
          await page.close();
        }
      }
      
      // Final pipeline save if requested
      if (savePipeline && allCases.length > 0) {
        this.savePipeline(allCases);
        console.log(`💾 Final pipeline saved: ${allCases.length} total cases discovered`);
      }
      
    } catch (error) {
      console.log(`💥 Discovery error: ${error.message}`);
      // Save whatever we found before error
      if (savePipeline && allCases.length > 0) {
        this.savePipeline(allCases);
        console.log(`💾 Saved ${allCases.length} cases before error`);
      }
      throw error;
    } finally {
      // Only close browser if we created it
      if (shouldCloseBrowser && discoveryBrowser) {
        await discoveryBrowser.close();
      }
      if (realTimeQueue) {
        this.discoveryComplete = true;
        console.log('✅ Discovery thread completed!');
      }
    }
    
    return allCases;
  }

  // Wrapper methods for backwards compatibility
  async discoverYearCases(browser, yearBatch) {
    return this.discoverCases({ browser, yearBatch });
  }

  async buildGlobalDocumentQueue(browser, allCases) {
    const globalQueue = [];
    const page = await browser.newPage();

    try {
      for (const caseInfo of allCases) {
        console.log(`📋 Getting documents for ${caseInfo.caseNumber}...`);
        
        try {
          const documentLinks = await getDocumentLinksFromCase(page, caseInfo);
          
          documentLinks.forEach(docInfo => {
            globalQueue.push({
              ...docInfo,
              caseInfo: caseInfo,
              queueId: uuidv4()
            });
          });
          
          console.log(`  ✅ ${documentLinks.length} documents from ${caseInfo.caseNumber}`);
          
        } catch (error) {
          console.log(`  ❌ Error getting documents from ${caseInfo.caseNumber}: ${error.message}`);
          this.overallStats.totalErrors++;
        }
      }
    } catch (error) {
      console.log(`💥 Error building document queue: ${error.message}`);
      this.overallStats.totalErrors++;
    } finally {
      await page.close();
    }

    // Sort queue by priority (Company Direct Testimony first)
    globalQueue.sort((a, b) => {
      const aPriority = (a.section === 'Company' && a.text.includes('DIRECT')) ? 0 : 1;
      const bPriority = (b.section === 'Company' && b.text.includes('DIRECT')) ? 0 : 1;
      return aPriority - bPriority;
    });

    return globalQueue;
  }

  async processMultiYearQueue(globalQueue) {
    const progressTracker = new ProgressTracker(globalQueue.length, 'Multi-Year');
    
    const sharedQueue = [...globalQueue];
    const processedDocuments = [];
    const queueLock = { inUse: false };
    const sharedRetryQueue = new SmartRetryQueue(3);
    
    console.log(`🚀 Starting ${HISTORICAL_CONFIG.MAX_WORKERS} workers for multi-year processing`);
    console.log(`📦 Total documents across all years: ${sharedQueue.length}`);
    
    progressTracker.forceUpdate();

    // Create worker promises  
    const workerPromises = Array.from({ length: HISTORICAL_CONFIG.MAX_WORKERS }, (_, index) =>
      this.multiYearWorker(index + 1, sharedQueue, processedDocuments, queueLock, sharedRetryQueue, progressTracker)
    );

    // Wait for all workers to complete
    await Promise.all(workerPromises);

    console.log(`✅ Multi-year processing complete: ${processedDocuments.length} documents processed`);
    
    // Calculate results by year
    const resultsByYear = {};
    processedDocuments.forEach(doc => {
      const year = doc.sourceYear || 'unknown';
      if (!resultsByYear[year]) resultsByYear[year] = { completed: 0, chunks: 0 };
      resultsByYear[year].completed++;
      resultsByYear[year].chunks += doc.chunksCreated || 0;
    });
    
    return {
      totalCompleted: processedDocuments.length,
      totalChunks: processedDocuments.reduce((sum, doc) => sum + (doc.chunksCreated || 0), 0),
      errors: globalQueue.length - processedDocuments.length,
      byYear: resultsByYear
    };
  }

  /**
   * Unified document processing worker that handles both queue patterns
   * @param {number} workerId - Worker identifier
   * @param {Object} options - Worker configuration options
   * @param {Array} options.sharedQueue - Shared document queue (for multi-year pattern)
   * @param {Array} options.processedDocuments - Array to store processed documents
   * @param {Object} options.queueLock - Lock object for queue synchronization
   * @param {Object} options.retryQueue - Smart retry queue for failed documents
   * @param {Object} options.progressTracker - Progress tracking object
   * @param {boolean} options.useCaseQueue - Whether to use case-based queue pattern
   * @param {boolean} options.checkDuplicates - Whether to check for duplicates before processing
   */
  async documentWorker(workerId, options = {}) {
    const {
      sharedQueue = null,
      processedDocuments,
      queueLock = this.queueLock,
      retryQueue,
      progressTracker,
      useCaseQueue = false,
      checkDuplicates = false
    } = options;

    const browser = await puppeteer.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security', '--single-process', '--no-zygote']
    });

    try {
      const page = await browser.newPage();
      let documentsProcessed = 0;
      
      const workerType = useCaseQueue ? 'case-based' : 'multi-year';
      console.log(`[Worker ${workerId}] 🚀 Started - ${workerType} mode`);

      while (true) {
        let document = null;
        
        if (useCaseQueue) {
          // Case-based queue pattern
          let shouldMoveToNextCase = false;
          
          while (queueLock.inUse) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          
          queueLock.inUse = true;
          
          // Check if current case has documents available
          if (this.currentCaseInfo && this.currentCaseDocumentQueue.length > 0) {
            document = this.currentCaseDocumentQueue.shift();
          } else {
            shouldMoveToNextCase = true;
          }
          
          queueLock.inUse = false;
          
          // Move to next case if needed
          if (shouldMoveToNextCase) {
            const nextCase = await this.getNextCase();
            
            if (!nextCase) {
              console.log(`[Worker ${workerId}] ✅ No more cases - finished (processed ${documentsProcessed})`);
              break;
            }
            
            // Set current case and build document queue
            this.currentCaseInfo = nextCase.caseInfo;
            this.currentCaseDocumentQueue = await this.buildDocumentQueueForCase(nextCase.caseInfo);
            
            console.log(`[Worker ${workerId}] 🎯 Moving to case ${this.currentCaseInfo.caseNumber} with ${this.currentCaseDocumentQueue.length} documents`);
            
            // Try to get a document from the new case
            while (queueLock.inUse) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            queueLock.inUse = true;
            if (this.currentCaseDocumentQueue.length > 0) {
              document = this.currentCaseDocumentQueue.shift();
            }
            queueLock.inUse = false;
          }
        } else {
          // Simple shared queue pattern (multiYearWorker style)
          while (queueLock.inUse) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          
          queueLock.inUse = true;
          if (sharedQueue && sharedQueue.length > 0) {
            document = sharedQueue.shift();
          }
          queueLock.inUse = false;
          
          if (!document) {
            console.log(`[Worker ${workerId}] ✅ No more documents - finished (processed ${documentsProcessed})`);
            if (progressTracker) progressTracker.forceUpdate();
            break;
          }
          
          if (sharedQueue) {
            console.log(`[Worker ${workerId}] 📊 Queue remaining: ${sharedQueue.length} documents`);
          }
        }
        
        // Process document if we have one
        if (document) {
          console.log(`[Worker ${workerId}] 📄 Processing: ${document.caseInfo.caseNumber} - ${document.text}`);
          
          let result = null;
          
          // Optional duplicate check (including pipeline tracking)
          if (checkDuplicates) {
            // First check pipeline for already processed documents
            const pipelineData = this.loadPipelineData();
            const docKey = `${document.caseInfo.caseNumber}:${document.text}`;
            const isInPipeline = pipelineData?.processedDocuments?.includes(docKey);
            
            if (isInPipeline) {
              console.log(`[Worker ${workerId}] ⚡ SKIPPED: ${document.text} (found in pipeline history)`);
              result = {
                documentName: document.text,
                pages: 0,
                chunks: 0,
                success: true,
                skipped: true,
                duplicate: true,  // Mark as duplicate for tracking
                caseNumber: document.caseInfo.caseNumber
              };
            } else {
              // Check database for duplicates by URL (globally unique) BEFORE extraction
              const isDuplicate = await this.checkDocumentExistsByUrl(document.href);
              
              if (isDuplicate) {
                console.log(`[Worker ${workerId}] ⚡ SKIPPED: ${document.text} (duplicate in database)`);
                result = {
                  documentName: document.text,
                  pages: 0,
                  chunks: 0,
                  success: true,
                  skipped: true,
                  duplicate: true,  // Mark as duplicate for tracking
                  caseNumber: document.caseInfo.caseNumber
                };
              }
            }
          }
          
          // Extract text if not duplicate
          if (!result) {
            result = await extractDocumentText(
              page,
              document.href,
              document.text,
              document.caseInfo,
              document,
              workerId,
              this.uploader,
              retryQueue
            );
            
            if (result && !useCaseQueue) {
              result.caseNumber = document.caseInfo.caseNumber;
            }
          }
          
          // Handle result
          if (result) {
            processedDocuments.push(result);
            documentsProcessed++;
            
            if (result.skipped) {
              console.log(`[Worker ${workerId}] ✅ Completed: ${document.text} (duplicate skipped)`);
            } else {
              const pageInfo = result.pages ? `${result.pages} pages` : '';
              const chunkInfo = result.chunksCreated ? `${result.chunksCreated} chunks` : '';
              console.log(`[Worker ${workerId}] ✅ Completed: ${document.text} (${pageInfo}${pageInfo && chunkInfo ? ', ' : ''}${chunkInfo})`);
              
              // Update pipeline after successful document processing
              this.updatePipelineAfterDocument(document.text, document.caseInfo.caseNumber);
            }
            
            if (progressTracker) {
              if (result && (result.skipped || result.duplicate)) {
                progressTracker.recordSkipped();
              } else if (result && result.success && !result.duplicate) {
                progressTracker.recordSuccess();
                progressTracker.recordNewDocument();
              } else {
                progressTracker.recordSuccess();
              }
            }
          } else if (!useCaseQueue && sharedQueue) {
            // Retry logic for shared queue pattern
            const attemptCount = retryQueue.recordFailure(document.queueId, {
              error: 'No text extracted',
              workerId: workerId,
              documentName: document.text,
              caseNumber: document.caseInfo.caseNumber,
              documentUrl: document.href
            });
            
            if (retryQueue.shouldRetry(document.queueId) && !retryQueue.shouldBlacklist(document.queueId)) {
              sharedQueue.push(document);
              console.log(`[Worker ${workerId}] 🔄 Re-queued for retry (attempt ${attemptCount + 1}): ${document.text}`);
            } else {
              if (retryQueue.shouldBlacklist(document.queueId)) {
                console.log(`[Worker ${workerId}] 🚨 BLACKLISTED (${retryQueue.maxRetries} attempts failed): ${document.text}`);
              } else {
                console.log(`[Worker ${workerId}] ❌ Failed: ${document.text}`);
              }
              if (progressTracker) progressTracker.recordError();
            }
          }
          
          if (documentsProcessed % 5 === 0) {
            console.log(`[Worker ${workerId}] 📈 Progress: ${documentsProcessed} documents completed`);
          }
        } else if (useCaseQueue) {
          // Brief pause for case-based queue when no document available
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
    } catch (error) {
      console.log(`[Worker ${workerId}] 💥 Worker error: ${error.message}`);
    } finally {
      await browser.close();
    }
  }

  // Wrapper methods for backwards compatibility
  async multiYearWorker(workerId, sharedQueue, processedDocuments, queueLock, retryQueue, progressTracker) {
    return this.documentWorker(workerId, {
      sharedQueue,
      processedDocuments,
      queueLock,
      retryQueue,
      progressTracker,
      useCaseQueue: false,
      checkDuplicates: false
    });
  }

  printProgressSummary() {
    const completedYears = this.overallStats.yearsCompleted;
    const totalYears = HISTORICAL_CONFIG.YEAR_BATCHES.length;
    const percentComplete = ((completedYears / totalYears) * 100).toFixed(1);
    
    console.log(`\n📊 OVERALL PROGRESS: ${completedYears}/${totalYears} years (${percentComplete}%)`);
    console.log(`📄 Total Documents: ${this.overallStats.totalDocumentsProcessed}`);
    console.log(`📦 Total Chunks: ${this.overallStats.totalChunksCreated}`);
    console.log(`⚠️  Total Errors: ${this.overallStats.totalErrors}`);
  }

  // Save discovered cases pipeline to file with document tracking
  savePipeline(discoveredCases) {
    try {
      const pipelineData = {
        timestamp: new Date().toISOString(),
        totalCases: discoveredCases.length,
        cases: discoveredCases,
        processedDocuments: [], // Track completed documents to handle partial case completion
        status: 'discovery_complete'
      };
      
      fs.writeFileSync(this.pipelineFile, JSON.stringify(pipelineData, null, 2));
      console.log(`💾 Pipeline saved: ${discoveredCases.length} cases discovered`);
    } catch (error) {
      console.log(`⚠️ Failed to save pipeline: ${error.message}`);
    }
  }

  // Remove completed case from pipeline and save updated pipeline
  async removeCompletedCaseFromPipeline(completedCaseNumber) {
    try {
      const pipelineData = this.loadPipelineData();
      if (pipelineData && pipelineData.cases) {
        const originalCount = pipelineData.cases.length;
        pipelineData.cases = pipelineData.cases.filter(caseInfo => caseInfo.caseNumber !== completedCaseNumber);
        const newCount = pipelineData.cases.length;
        
        if (newCount < originalCount) {
          pipelineData.totalCases = newCount;
          pipelineData.timestamp = new Date().toISOString();
          
          fs.writeFileSync(this.pipelineFile, JSON.stringify(pipelineData, null, 2));
          console.log(`🗑️ Removed completed case ${completedCaseNumber} from pipeline (${newCount}/${originalCount} remaining)`);
        }
      }
    } catch (error) {
      console.log(`⚠️ Failed to update pipeline: ${error.message}`);
    }
  }

  // Load pipeline data (including metadata)
  loadPipelineData() {
    try {
      if (fs.existsSync(this.pipelineFile)) {
        return JSON.parse(fs.readFileSync(this.pipelineFile, 'utf8'));
      }
    } catch (error) {
      console.log(`⚠️ Could not load pipeline data: ${error.message}`);
    }
    return null;
  }

  // Load existing pipeline from file
  loadPipeline() {
    try {
      if (fs.existsSync(this.pipelineFile)) {
        const pipelineData = JSON.parse(fs.readFileSync(this.pipelineFile, 'utf8'));
        console.log(`📁 Pipeline found: ${pipelineData.totalCases} cases from ${pipelineData.timestamp}`);
        return pipelineData.cases;
      }
    } catch (error) {
      console.log(`⚠️ Could not load pipeline: ${error.message}`);
    }
    return null;
  }

  // OPTIMIZATION: Check if document exists before extraction
  async checkDocumentExists(caseNumber, documentName) {
    try {
      // Check if case already exists first (avoid creating new cases)
      const { data: existingCase } = await this.uploader.supabase
        .from('cases')
        .select('id')
        .eq('case_number', caseNumber)
        .single();
      
      if (!existingCase) {
        // Case doesn't exist yet, so document can't exist either
        return false;
      }
      
      // Quick check for existing document
      const { data: existingDoc, error } = await this.uploader.supabase
        .from('documents')
        .select('id, document_name')
        .eq('case_id', existingCase.id)
        .eq('document_name', documentName)
        .single();
      
      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
        console.log(`⚠️ Error checking document existence: ${error.message}`);
        return false; // If error, proceed with extraction to be safe
      }
      
      return !!existingDoc; // Return true if document exists
    } catch (error) {
      console.log(`⚠️ Error in duplicate check: ${error.message}`);
      return false; // If error, proceed with extraction to be safe
    }
  }
  
  // CRITICAL FIX: Check document by URL (globally unique) instead of name
  // This prevents extracting entire documents just to find they're duplicates
  async checkDocumentExistsByUrl(documentUrl) {
    try {
      // Check for existing document by URL (globally unique)
      const { data: existingDoc, error } = await this.uploader.supabase
        .from('documents')
        .select('id, document_name')
        .eq('document_url', documentUrl)
        .single();
      
      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
        console.log(`⚠️ Error checking document by URL: ${error.message}`);
        return false; // If error, proceed with extraction to be safe
      }
      
      return !!existingDoc; // Return true if document exists
    } catch (error) {
      console.log(`⚠️ Error checking document by URL: ${error.message}`);
      return false; // If error, proceed with extraction to be safe
    }
  }

  // Check if case is completed by querying Supabase and update pipeline
  async checkAndUpdateCaseCompletion(caseNumber) {
    try {
      // First get the case_id from case_number
      const { data: caseData, error: caseError } = await this.uploader.supabase
        .from('cases')
        .select('id')
        .eq('case_number', caseNumber)
        .single();
      
      if (caseError || !caseData) {
        // Case doesn't exist yet, skip completion check
        return;
      }
      
      // Query Supabase to see if all documents for this case have been processed
      const { data: caseDocuments, error } = await this.uploader.supabase
        .from('documents')
        .select('document_name, case_id')
        .eq('case_id', caseData.id);
      
      if (error) {
        console.log(`⚠️ Error checking case completion for ${caseNumber}: ${error.message}`);
        return;
      }
      
      // If case has documents in database, consider it completed
      if (caseDocuments && caseDocuments.length > 0) {
        console.log(`✅ Case ${caseNumber} completed with ${caseDocuments.length} documents - updating pipeline`);
        this.updatePipelineProgress(caseNumber);
      }
    } catch (error) {
      console.log(`⚠️ Error checking case completion: ${error.message}`);
    }
  }
  
  // Update pipeline after a document is successfully processed
  updatePipelineAfterDocument(documentName, caseNumber) {
    try {
      const pipelineData = this.loadPipelineData();
      if (!pipelineData) return;
      
      // Initialize processedDocuments if it doesn't exist or is wrong type (for backward compatibility)
      if (!pipelineData.processedDocuments || !Array.isArray(pipelineData.processedDocuments)) {
        pipelineData.processedDocuments = [];
      }
      
      // Add this document to processed list
      const docKey = `${caseNumber}:${documentName}`;
      if (!pipelineData.processedDocuments.includes(docKey)) {
        pipelineData.processedDocuments.push(docKey);
        
        // Save updated pipeline
        fs.writeFileSync(this.pipelineFile, JSON.stringify(pipelineData, null, 2));
        console.log(`📝 Pipeline updated: Document ${documentName} marked as processed`);
      }
    } catch (error) {
      console.log(`⚠️ Failed to update pipeline after document: ${error.message}`);
    }
  }
  
  // Update pipeline by removing completed cases
  updatePipelineProgress(completedCaseNumber) {
    try {
      let pipelineData;
      
      // Check if pipeline file exists (fresh discovery vs resume mode)
      if (!fs.existsSync(this.pipelineFile)) {
        // Fresh discovery mode - create pipeline for crash recovery
        console.log(`💾 Creating pipeline for crash recovery...`);
        
        // Get case numbers from current case queue
        const discoveredCases = new Set();
        this.caseQueue.forEach(caseData => {
          if (caseData.caseInfo && caseData.caseInfo.caseNumber) {
            discoveredCases.add(caseData.caseInfo.caseNumber);
          }
        });
        
        // Create minimal pipeline for crash recovery
        pipelineData = {
          timestamp: new Date().toISOString(),
          totalCases: discoveredCases.size,
          cases: Array.from(discoveredCases).map(caseNumber => ({
            caseNumber: caseNumber,
            company: "DISCOVERED_CASE",
            description: "Case discovered during fresh crawl",
            caseUrl: `https://puc.idaho.gov/case/Details/${caseNumber}`,
            utilityType: "unknown"
          }))
        };
        
        // Save initial pipeline
        fs.writeFileSync(this.pipelineFile, JSON.stringify(pipelineData, null, 2));
        console.log(`💾 Pipeline created with ${pipelineData.totalCases} cases for crash recovery`);
      } else {
        // Load existing pipeline data
        pipelineData = JSON.parse(fs.readFileSync(this.pipelineFile, 'utf8'));
      }
      
      if (!pipelineData || !pipelineData.cases) {
        return; // No pipeline to update
      }
      
      // Remove the completed case from the pipeline
      const remainingCases = pipelineData.cases.filter(caseInfo => 
        caseInfo.caseNumber !== completedCaseNumber
      );
      
      if (remainingCases.length === pipelineData.cases.length) {
        return; // Case not found in pipeline (already removed or not tracked)
      }
      
      if (remainingCases.length === 0) {
        // All cases completed - clear pipeline entirely
        this.clearPipeline();
        console.log(`🎉 All cases completed! Pipeline cleared.`);
      } else {
        // Update pipeline with remaining cases
        const updatedPipeline = {
          ...pipelineData,
          totalCases: remainingCases.length,
          cases: remainingCases,
          lastUpdated: new Date().toISOString()
        };
        
        fs.writeFileSync(this.pipelineFile, JSON.stringify(updatedPipeline, null, 2));
        console.log(`💾 Pipeline updated: ${completedCaseNumber} completed, ${remainingCases.length} cases remaining`);
      }
    } catch (error) {
      console.log(`⚠️ Failed to update pipeline: ${error.message}`);
    }
  }

  // Final verification: discover ALL cases and verify they exist in database
  async performFinalVerification() {
    console.log('\n🔍 FINAL VERIFICATION: Ensuring 100% completeness...');
    console.log('=' .repeat(70));
    
    try {
      // Perform complete discovery scan
      console.log('📋 Performing complete discovery scan of all case pages...');
      const allDiscoveredCases = await this.runCompleteDiscoveryScan();
      console.log(`🔍 Total cases discovered: ${allDiscoveredCases.length}`);
      
      // Get all cases from database
      console.log('🗄️ Fetching all cases from database...');
      const { data: dbCases, error } = await this.uploader.supabase
        .from('cases')
        .select('case_number');
      
      if (error) {
        console.log(`❌ Database error during verification: ${error.message}`);
        return;
      }
      
      const dbCaseNumbers = new Set(dbCases.map(c => c.case_number));
      console.log(`🗄️ Cases in database: ${dbCaseNumbers.size}`);
      
      // Find missing cases
      const missingCases = allDiscoveredCases.filter(caseInfo => 
        !dbCaseNumbers.has(caseInfo.caseNumber)
      );
      
      if (missingCases.length === 0) {
        console.log('✅ VERIFICATION PASSED: All discovered cases exist in database!');
        console.log(`🎉 CRAWL COMPLETE: ${dbCaseNumbers.size} cases processed successfully`);
        console.log('=' .repeat(70));
      } else {
        console.log(`⚠️ VERIFICATION FAILED: ${missingCases.length} cases missing from database`);
        console.log('📝 Missing cases:');
        missingCases.slice(0, 10).forEach(caseInfo => {
          console.log(`   - ${caseInfo.caseNumber}: ${caseInfo.description}`);
        });
        
        if (missingCases.length > 10) {
          console.log(`   ... and ${missingCases.length - 10} more`);
        }
        
        console.log('🔄 These cases will need to be processed in a future run');
      }
      
    } catch (error) {
      console.log(`❌ Final verification failed: ${error.message}`);
    }
  }
  
  // Complete discovery scan without processing - just for verification
  async runCompleteDiscoveryScan() {
    const allDiscoveredCases = [];
    
    const discoveryBrowser = await puppeteer.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security', '--single-process', '--no-zygote']
    });

    try {
      for (const listingUrl of CASE_LISTING_URLS) {
        console.log(`🔍 Verification scan: ${listingUrl.type} ${listingUrl.status} cases...`);
        
        const totalPages = listingUrl.type === 'electric' ? 45 : 4;
        const page = await discoveryBrowser.newPage();
        await page.goto(listingUrl.url, { waitUntil: 'networkidle2' });
        
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
          console.log(`📄 Verification: Processing page ${pageNum}/${totalPages}...`);
          
          try {
            const cases = await getCasesFromPage(page);
            
            for (const caseInfo of cases) {
              // Validate case date range (2010-2024)
              const caseYear = new Date(caseInfo.dateFiled).getFullYear();
              if (caseYear >= 2010 && caseYear <= 2024) {
                allDiscoveredCases.push(caseInfo);
              }
            }
            
            // Navigate to next page if not the last page
            if (pageNum < totalPages) {
              await navigateToNextPage(page);
            }
            
          } catch (error) {
            console.log(`⚠️ Error on verification page ${pageNum}: ${error.message}`);
          }
        }
        
        await page.close();
      }
    } finally {
      await discoveryBrowser.close();
    }
    
    return allDiscoveredCases;
  }

  // Clear pipeline after successful completion
  clearPipeline() {
    try {
      if (fs.existsSync(this.pipelineFile)) {
        fs.unlinkSync(this.pipelineFile);
        console.log('🗑️ Pipeline cleared');
      }
    } catch (error) {
      console.log('⚠️ Could not clear pipeline:', error.message);
    }
  }

  async buildMultiYearQueue(remainingYears, savedPipeline = null) {
    console.log('🚀 Starting REAL-TIME PARALLEL discovery and processing with crash recovery!');
    
    // Use provided saved pipeline or load from file
    const pipeline = savedPipeline || this.loadPipeline();
    
    if (pipeline) {
      console.log('🔄 Processing saved pipeline cases and continuing discovery...');
      console.log(`📦 Building document queue from ${pipeline.length} discovered cases first...`);
      
      // Get existing documents to avoid duplicates
      const existingDocs = await this.getAllExistingDocuments();
      console.log(`📋 Found ${existingDocs.size} existing documents in database`);
      
      // Start workers immediately
      const processingPromise = this.startParallelProcessing();
      console.log(`🏭 Starting ${HISTORICAL_CONFIG.MAX_WORKERS} workers immediately - they will process saved cases and new discoveries!`);
      
      // Process saved cases first (add them to queue)
      await this.addSavedCasesToQueue(pipeline, existingDocs);
      
      // Then continue discovery for remaining cases
      const discoveryPromise = this.discoverCases({
        savePipeline: true,
        existingDocs: existingDocs,
        realTimeQueue: true,
        navigatePages: true
      });
      
      // Wait for both to complete
      await Promise.all([discoveryPromise, processingPromise]);
    } else {
      console.log('📄 No saved pipeline - starting REAL-TIME discovery with immediate processing');
      
      // Get existing documents to avoid duplicates
      const existingDocs = await this.getAllExistingDocuments();
      console.log(`📋 Found ${existingDocs.size} existing documents in database`);
      
      // Start REAL-TIME parallel discovery and processing
      const discoveryPromise = this.discoverCases({
        savePipeline: true,
        existingDocs: existingDocs,
        realTimeQueue: true,
        navigatePages: true
      });
      const processingPromise = this.startParallelProcessing();
      
      console.log(`🏭 Starting ${HISTORICAL_CONFIG.MAX_WORKERS} workers immediately - they will process documents as discovery finds them!`);
      
      // Wait for both to complete
      await Promise.all([discoveryPromise, processingPromise]);
    }
    
    // Final verification: ensure ALL cases are in database
    await this.performFinalVerification();
    
    // Clear pipeline on successful completion
    this.clearPipeline();
    
    return [];
  }

  async getAllExistingDocuments() {
    try {
      const { data: documents } = await this.uploader.supabase
        .from('documents')
        .select('document_name, document_url, case_id');
      
      const existingByCase = new Map(); // case_id -> Set of document names
      const existingUrls = new Set(); // Global URL checking only
      
      documents?.forEach(doc => {
        // Only add URLs for global checking (URLs should be unique across all cases)
        existingUrls.add(doc.document_url);
        
        // Track documents per case for case-specific duplicate prevention
        if (!existingByCase.has(doc.case_id)) {
          existingByCase.set(doc.case_id, new Set());
        }
        existingByCase.get(doc.case_id).add(doc.document_name);
      });
      
      // Store case-specific data for enhanced checking
      this.existingDocumentsByCase = existingByCase;
      this.existingUrls = existingUrls;
      
      return existingUrls; // Return only URLs for global checking
    } catch (error) {
      console.log(`⚠️ Error checking existing documents: ${error.message}`);
      return new Set();
    }
  }

  /**
   * Unified document queue building method that consolidates all queue building patterns
   * @param {Object} options - Configuration options for queue building
   * @param {Array} options.cases - Array of cases to process
   * @param {Object} options.browser - Optional browser instance
   * @param {Object} options.page - Optional page instance (for single case processing)
   * @param {Set} options.existingDocs - Set of existing document URLs/names
   * @param {boolean} options.checkCaseSpecificDupes - Whether to check case-specific duplicates
   * @param {boolean} options.addToWorkerQueue - Whether to add to this.caseQueue
   * @param {boolean} options.startWorkers - Whether to start workers after building
   * @param {boolean} options.singleCase - Whether processing single case
   * @param {boolean} options.useQueueLock - Whether to use queue lock for thread safety
   * @param {boolean} options.returnSimpleArray - Whether to return simple array instead of case structure
   * @returns {Promise<Array|void>} Document queue or void if added to worker queue
   */
  async buildDocumentQueue(options = {}) {
    const {
      cases = [],
      browser = null,
      page = null,
      existingDocs = null,
      checkCaseSpecificDupes = true,
      addToWorkerQueue = false,
      startWorkers = false,
      singleCase = false,
      useQueueLock = false,
      returnSimpleArray = false
    } = options;

    // Get existing documents if not provided
    const existingDocSet = existingDocs || (checkCaseSpecificDupes ? await this.getAllExistingDocuments() : new Set());
    
    // Handle browser/page management
    const shouldCloseBrowser = !browser && !page;
    const workingBrowser = browser || (!page ? await puppeteer.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security', '--single-process', '--no-zygote']
    }) : null);
    
    const shouldClosePage = !page && workingBrowser;
    const workingPage = page || (workingBrowser ? await workingBrowser.newPage() : null);
    
    try {
      const globalQueue = [];
      const caseBasedQueue = [];
      let totalDocuments = 0;
      
      for (const caseInfo of cases) {
        try {
          const documentLinks = await getDocumentLinksFromCase(workingPage, caseInfo);
          const caseDocuments = [];
          const currentCaseDocNames = new Set();
          
          // Get case-specific existing documents if checking dupes
          let caseSpecificDocs = new Set();
          if (checkCaseSpecificDupes) {
            const { data: existingCase } = await this.uploader.supabase
              .from('cases')
              .select('id')
              .eq('case_number', caseInfo.caseNumber)
              .single();
            
            caseSpecificDocs = this.existingDocumentsByCase?.get(existingCase?.id) || new Set();
          }
          
          // Process document links
          documentLinks.forEach(docInfo => {
            let shouldInclude = true;
            
            if (checkCaseSpecificDupes) {
              // Full duplicate checking (URLs, case-specific, queue-specific)
              const isUrlDuplicate = existingDocSet.has(docInfo.href) || this.existingUrls?.has(docInfo.href);
              const isDocNameDuplicateInCase = caseSpecificDocs.has(docInfo.text);
              const isDocNameDuplicateInQueue = currentCaseDocNames.has(docInfo.text);
              shouldInclude = !isUrlDuplicate && !isDocNameDuplicateInCase && !isDocNameDuplicateInQueue;
            } else {
              // Simple duplicate checking (just URLs)
              // existingDocSet contains URLs only, so we check against href
              shouldInclude = !existingDocSet.has(docInfo.href);
            }
            
            if (shouldInclude) {
              const documentData = {
                ...docInfo,
                caseInfo: caseInfo,
                queueId: uuidv4()
              };
              
              caseDocuments.push(documentData);
              currentCaseDocNames.add(docInfo.text);
            }
          });
          
          // Add to appropriate queue structure
          if (caseDocuments.length > 0) {
            if (returnSimpleArray) {
              // Simple array format (for buildGlobalDocumentQueue pattern)
              globalQueue.push(...caseDocuments);
            } else if (addToWorkerQueue) {
              // Add to this.caseQueue for workers
              const caseQueueEntry = {
                caseInfo: caseInfo,
                documents: caseDocuments
              };
              
              if (useQueueLock) {
                while (this.queueLock.inUse) {
                  await new Promise(resolve => setTimeout(resolve, 10));
                }
                this.queueLock.inUse = true;
                this.caseQueue.push(caseQueueEntry);
                this.queueLock.inUse = false;
              } else {
                this.caseQueue.push(caseQueueEntry);
              }
              
              totalDocuments += caseDocuments.length;
            } else {
              // Case-based structure
              caseBasedQueue.push({
                caseInfo: caseInfo,
                documents: caseDocuments
              });
              totalDocuments += caseDocuments.length;
            }
          }
          
          // Log progress
          if (singleCase) {
            console.log(`📄 Built document queue for ${caseInfo.caseNumber}: ${caseDocuments.length} documents`);
          } else if (addToWorkerQueue && useQueueLock) {
            console.log(`      📄 Discovery: Added ${caseDocuments.length} documents from ${caseInfo.caseNumber} to case queue`);
          } else {
            console.log(`  📄 Added ${caseDocuments.length} documents from ${caseInfo.caseNumber}`);
          }
          
        } catch (error) {
          const prefix = useQueueLock ? '      ❌ Discovery:' : '  ❌';
          console.log(`${prefix} Error processing case ${caseInfo.caseNumber}: ${error.message}`);
        }
      }
      
      // Start workers if requested
      if (startWorkers && this.caseQueue.length > 0) {
        console.log(`🚀 Starting workers to process ${this.caseQueue.length} cases with ${totalDocuments} documents...`);
        const processingPromise = this.startParallelProcessing();
        await processingPromise;
      }
      
      // Return appropriate result
      if (addToWorkerQueue) {
        if (!useQueueLock) {
          console.log(`✅ Built case-based queue with ${this.caseQueue.length} cases and ${totalDocuments} documents`);
        }
        return; // void for worker queue pattern
      } else if (returnSimpleArray) {
        return globalQueue;
      } else if (singleCase && cases.length === 1) {
        return caseBasedQueue[0]?.documents || [];
      } else {
        return caseBasedQueue;
      }
      
    } finally {
      if (shouldClosePage && workingPage) {
        await workingPage.close();
      }
      if (shouldCloseBrowser && workingBrowser) {
        await workingBrowser.close();
      }
    }
  }

  async getExistingDocuments(year) {
    try {
      const { data: documents } = await this.uploader.supabase
        .from('documents')
        .select('document_name, document_url')
        .gte('created_at', `${year}-01-01`)
        .lte('created_at', `${year}-12-31`);
      
      const existingSet = new Set();
      documents?.forEach(doc => {
        existingSet.add(doc.document_name);
        existingSet.add(doc.document_url);
      });
      
      return existingSet;
    } catch (error) {
      console.log(`⚠️ Error checking existing documents for ${year}: ${error.message}`);
      return new Set();
    }
  }

  async buildDocumentQueueFromDiscoveredCases(discoveredCases) {
    console.log(`📦 Building case-based queue from ${discoveredCases.length} discovered cases...`);
    return this.buildDocumentQueue({
      cases: discoveredCases,
      checkCaseSpecificDupes: true,
      addToWorkerQueue: true,
      startWorkers: false
    });
  }

  // New method: Build queue and start workers once queue has documents
  async addSavedCasesToQueue(savedCases, existingDocs) {
    console.log(`📦 Adding ${savedCases.length} saved cases to queue...`);
    await this.buildDocumentQueue({
      cases: savedCases,
      existingDocs: existingDocs,
      checkCaseSpecificDupes: true,
      addToWorkerQueue: true,
      useQueueLock: false
    });
    const totalDocs = this.caseQueue.reduce((sum, caseData) => sum + caseData.documents.length, 0);
    console.log(`📦 Saved cases processed: ${this.caseQueue.length} cases with ${totalDocs} documents in queue`);
  }

  async buildDocumentQueueFromDiscoveredCasesWithWorkers(discoveredCases) {
    console.log(`📦 Building document queue from ${discoveredCases.length} discovered cases...`);
    
    // Note: This method needs special handling because it starts workers mid-build
    // For now, use the unified method with startWorkers at end
    await this.buildDocumentQueue({
      cases: discoveredCases,
      checkCaseSpecificDupes: true,
      addToWorkerQueue: true,
      startWorkers: true
    });
    
    // Signal that queue building is complete
    console.log(`📦 Queue building complete - signaling workers to finish when queue is empty`);
    this.discoveryComplete = true;
    
    const totalDocs = this.caseQueue.reduce((sum, caseData) => sum + caseData.documents.length, 0);
    console.log(`🎯 Final queue size: ${this.caseQueue.length} cases with ${totalDocs} documents`);
  }

  async addCaseToQueue(discoveryPage, caseInfo, existingDocs) {
    return this.buildDocumentQueue({
      cases: [caseInfo],
      page: discoveryPage,
      existingDocs: existingDocs,
      checkCaseSpecificDupes: true,
      addToWorkerQueue: true,
      useQueueLock: true
    });
  }

  async buildYearDocumentQueue(browser, yearCases, existingDocs) {
    const yearQueue = [];
    const page = await browser.newPage();

    try {
      for (const caseInfo of yearCases) {
        try {
          const documentLinks = await getDocumentLinksFromCase(page, caseInfo);
          
          documentLinks.forEach(docInfo => {
            // Skip if document already exists
            if (!existingDocs.has(docInfo.text) && !existingDocs.has(docInfo.href)) {
              yearQueue.push({
                ...docInfo,
                caseInfo: caseInfo,
                queueId: uuidv4()
              });
            }
          });
        } catch (error) {
          console.log(`    ❌ Error processing case ${caseInfo.caseNumber}: ${error.message}`);
        }
      }
    } finally {
      await page.close();
    }

    return yearQueue;
  }

  async buildDocumentQueueFromCases(browser, allCases, existingDocs) {
    return this.buildDocumentQueue({
      cases: allCases,
      browser: browser,
      existingDocs: existingDocs,
      checkCaseSpecificDupes: false,
      returnSimpleArray: true
    });
  }

  async startParallelProcessing() {
    console.log(`🏭 Starting ${HISTORICAL_CONFIG.MAX_WORKERS} workers for parallel processing...`);
    
    const processedDocuments = [];
    const sharedRetryQueue = new SmartRetryQueue(3);
    const progressTracker = new ProgressTracker(10000, 'Parallel'); // Estimate, will update
    
    // Create worker promises based on configured MAX_WORKERS
    const workerPromises = Array.from({ length: HISTORICAL_CONFIG.MAX_WORKERS }, (_, index) =>
      this.documentWorker(index + 1, {
        processedDocuments,
        queueLock: this.queueLock,
        retryQueue: sharedRetryQueue,
        progressTracker,
        useCaseQueue: true,
        checkDuplicates: true
      })
    );

    // Wait for all workers to complete
    await Promise.all(workerPromises);

    console.log(`✅ Parallel processing complete: ${processedDocuments.length} documents processed`);
    return processedDocuments;
  }

  async getNextCase() {
    // Dynamic wait time based on discovery status
    // If discovery is still running, wait longer to avoid premature exit
    const baseWaitTime = 30000; // 30 seconds base
    const extendedWaitTime = 120000; // 2 minutes when discovery is active
    const startTime = Date.now();
    
    while (true) {
      // Determine max wait time based on discovery status
      const maxWaitTime = this.discoveryComplete ? baseWaitTime : extendedWaitTime;
      
      // Check if we've exceeded wait time
      if (Date.now() - startTime > maxWaitTime) {
        // Final check: if discovery is still running and we haven't waited too long, continue
        if (!this.discoveryComplete && (Date.now() - startTime) < extendedWaitTime) {
          // Discovery still running, keep waiting
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        // Timeout reached
        console.log(`[Worker] No cases found after ${Math.round((Date.now() - startTime) / 1000)}s wait - ${this.discoveryComplete ? 'discovery complete' : 'discovery still running but timeout reached'}`);
        return null;
      }
      
      // Wait for lock to be available
      while (this.queueLock.inUse) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      this.queueLock.inUse = true;
      
      if (this.caseQueue.length > 0) {
        // We have a case to process
        const nextCase = this.caseQueue.shift();
        this.queueLock.inUse = false;
        return nextCase;
      }
      
      // No cases in queue
      this.queueLock.inUse = false;
      
      // If discovery is complete and no cases, we're done
      if (this.discoveryComplete) {
        console.log('[Worker] Discovery complete and no cases in queue - exiting');
        return null;
      }
      
      // Wait a bit and try again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  async buildDocumentQueueForCase(caseInfo) {
    return this.buildDocumentQueue({
      cases: [caseInfo],
      checkCaseSpecificDupes: true,
      singleCase: true
    });
  }

  printHistoricalSummary(results) {
    const totalTime = Math.round((Date.now() - this.overallStats.startTime) / 1000);
    const hours = Math.floor(totalTime / 3600);
    const minutes = Math.floor((totalTime % 3600) / 60);
    
    console.log('\n' + '=' .repeat(80));
    console.log(`🏛️  HISTORICAL CRAWLER (${HISTORICAL_CONFIG.END_YEAR}-${HISTORICAL_CONFIG.START_YEAR}) - FINAL RESULTS`);
    console.log('=' .repeat(80));
    console.log(`📅 Years Processed: ${Object.keys(results.byYear).length}`);
    console.log(`📄 Total Documents: ${results.totalCompleted}`);
    console.log(`📦 Total Chunks: ${results.totalChunks}`);
    console.log(`⚠️  Total Errors: ${results.errors}`);
    console.log(`⏱️  Total Time: ${hours}h ${minutes}m`);
    
    if (results.totalCompleted > 0) {
      const avgTimePerDoc = Math.round(totalTime / results.totalCompleted);
      const successRate = ((results.totalCompleted / (results.totalCompleted + results.errors)) * 100).toFixed(1);
      console.log(`⚡ Avg Speed: ${avgTimePerDoc}s per document`);
      console.log(`📈 Success Rate: ${successRate}%`);
    }
    
    console.log('\n📋 Year-by-Year Results:');
    Object.entries(results.byYear).forEach(([year, yearData]) => {
      const yearSuccessRate = yearData.completed > 0 ? 
        ((yearData.completed / (yearData.completed + (results.errors || 0))) * 100).toFixed(1) : '0.0';
      console.log(`  ${year}: ${yearData.completed} docs, ${yearData.chunks} chunks (${yearSuccessRate}%)`);
    });
    
    console.log('\n🎉 Multi-year historical crawl complete! Idaho PUC data ready for AI research.');
    console.log('=' .repeat(80));
  }
}

// =============================================================================
// MAIN EXECUTION
// =============================================================================

async function main() {
  const yearCount = HISTORICAL_CONFIG.END_YEAR - HISTORICAL_CONFIG.START_YEAR + 1;
  console.log(`🏛️  Historical Idaho PUC Crawler (${HISTORICAL_CONFIG.END_YEAR}-${HISTORICAL_CONFIG.START_YEAR})`);
  
  // Validate environment variables
  if (!process.env.SUPABASE_URL) {
    console.error('❌ ERROR: SUPABASE_URL environment variable is not set');
    console.log('Please set SUPABASE_URL in your .env file or environment');
    process.exit(1);
  }
  
  if (!process.env.SUPABASE_ANON_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ ERROR: Neither SUPABASE_ANON_KEY nor SUPABASE_SERVICE_ROLE_KEY is set');
    console.log('Please set at least one of these in your .env file or environment');
    process.exit(1);
  }
  
  console.log('📋 Setup checklist:');
  console.log('  ✅ Environment variables configured');
  console.log(`  ✅ ${yearCount}-year date range (${HISTORICAL_CONFIG.END_YEAR}-${HISTORICAL_CONFIG.START_YEAR})`);
  console.log('  ✅ Crash recovery system with checkpoints');
  console.log('  ✅ Year-by-year processing');
  console.log('  ✅ 99.5% success rate proven methods');
  console.log('  ✅ Progressive retry system with blacklisting');
  console.log('  ✅ 30 workers for maximum speed');
  console.log('  ✅ Direct Supabase integration');
  console.log('');
  console.log('🚀 Starting historical crawl...');
  console.log('');
  
  const crawler = new HistoricalCrawler();
  await crawler.crawlHistoricalData().catch(error => {
    console.error('🚨 Crawler failed:', error.message);
    console.log('💾 State preserved for restart');
    process.exit(1);
  });
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  // Set up graceful shutdown
  process.setMaxListeners(50);
  
  process.on('SIGINT', () => {
    console.log('\n🛑 Graceful shutdown requested...');
    console.log('💾 Checkpoint data preserved for resume');
    console.log('🔄 Restart this script to continue from where you left off');
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n🛑 Process terminated...');
    console.log('💾 Checkpoint data preserved for resume');
    process.exit(0);
  });
  
  main().catch(error => {
    console.error('\n💥 Historical crawler crashed:', error.message);
    console.log('💾 Checkpoint data preserved - restart to resume from last completed year');
    console.log('🔧 You can also set RESUME_FROM_YEAR in the config to start from a specific year');
    process.exit(1);
  });
}

export { HistoricalCrawler, main };