/**
 * Idaho PUC Document Crawlers
 * 
 * This module provides different crawler implementations for the Idaho PUC website:
 * - historical-crawler: Processes historical documents with configurable date range
 * - nightly-crawler: Processes new documents from all open cases daily
 */

// Import crawler modules
import { HistoricalCrawler } from './historical-crawler.js';
import { runNightlyCrawl, healthCheck } from './nightly-crawler.js';

// Convenience method to run historical crawler
export const runHistoricalCrawler = async (options = {}) => {
  const {
    startYear = 2010,
    endYear = 2024,
    batchSize = 100,
    maxWorkers = 30
  } = options;
  
  console.log(`Starting historical crawler for years ${startYear}-${endYear}`);
  
  // Create and run historical crawler
  const crawler = new HistoricalCrawler();
  return crawler.crawlHistoricalData();
};

// Method to run nightly crawler
export const runNightlyCrawler = async (options = {}) => {
  console.log('Starting nightly crawler for all open cases');
  return runNightlyCrawl();
};

// Health check for monitoring
export const checkCrawlerHealth = async () => {
  return healthCheck();
};

// Default export for backward compatibility
export default {
  runHistoricalCrawler,
  runNightlyCrawler,
  checkCrawlerHealth
};