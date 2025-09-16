# Idaho PUC Document Crawlers

## Overview

This directory contains web crawlers designed to systematically extract, process, and store regulatory documents from the Idaho Public Utilities Commission (PUC) website. The crawlers handle both historical data collection and ongoing document discovery.

## Architecture

### Core Components

```
crawlers/
├── historical-crawler.js   # Bulk historical document processing (configurable date range)
├── nightly-crawler.js     # Scheduled crawler for new documents (Railway cron job)
├── index.js               # Module exports and convenience wrappers
└── info.md               # This documentation
```

### High-Level Flow

1. **Discovery Phase**: Crawlers navigate the Idaho PUC website to find cases within specified date ranges
2. **Document Queue Building**: For each case, identify all relevant PDF documents
3. **Parallel Processing**: Deploy multiple workers (30 by default) to extract text from documents
4. **Text Processing**: Clean and chunk extracted text for efficient storage
5. **Database Storage**: Store cases, documents, and text chunks in Supabase (PostgreSQL)

## Dependencies

### Required npm Packages
```json
{
  "puppeteer": "^21.0.0",      // Browser automation for web scraping
  "@supabase/supabase-js": "^2.0.0",  // Database client
  "uuid": "^9.0.0",            // Unique ID generation
  "dotenv": "^16.0.0"          // Environment variable management
}
```

### System Requirements
- **Chrome/Chromium**: Puppeteer requires a Chrome installation
- **Node.js**: v18+ recommended for ES modules support
- **Memory**: ~4GB RAM minimum (30 parallel Chrome instances)
- **Network**: Stable internet connection for web scraping

## Environment Variables

```bash
# Required Database Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key-here
# OR
SUPABASE_SERVICE_ROLE_KEY=your-service-key-here

# Optional Crawler Configuration
CRAWLER_START_YEAR=2010  # Default: 2010
CRAWLER_END_YEAR=2024    # Default: 2024

# Nightly Crawler Configuration (Optional)
NIGHTLY_MAX_WORKERS=5      # Reduced workers for nightly runs (default: 5)
SKIP_EMBEDDINGS=false      # Skip embedding generation if true (default: false)
```

## How It Works

### 1. Case Discovery
The crawler starts by visiting Idaho PUC case listing pages:
- Electric utility cases: `https://puc.idaho.gov/case?util=1&closed=0`
- Natural gas cases: `https://puc.idaho.gov/case?util=4&closed=0`

It navigates through pagination (up to 45 pages for electric, 4 for gas) and validates each case against the configured date range.

### 2. Document Identification
For each valid case, the crawler:
- Navigates to the case detail page
- Identifies document sections (Company, Staff, Intervenor, Public Comments)
- Filters for PDF documents only
- Extracts witness names from filenames when possible
- Prioritizes Company Direct Testimony documents

### 3. Text Extraction
The crawler handles two types of PDF viewers:
- **LaserFiche**: Server-rendered PDFs with text layers
- **WebLink**: Client-rendered PDFs in iframes

For each document:
- Navigate to the document URL
- Detect viewer type
- Extract text page by page
- Handle pagination and loading delays
- Clean extracted text (remove UI elements)

### 4. Text Chunking
Documents are split into overlapping chunks for vector database storage:
- **Chunk Size**: 1500 characters
- **Overlap**: 200 characters
- Preserves context across chunk boundaries
- Maintains metadata (case number, witness, document type)

### 5. Database Storage

#### Schema Structure:
```sql
cases
├── id (UUID)
├── case_number (e.g., "IPC-E-24-01")
├── company
├── utility_type
├── case_status
├── date_filed
├── description
└── case_url

documents
├── id (UUID)
├── case_id (FK)
├── document_name
├── document_type
├── document_url
├── witness_name
├── extraction_status
└── extracted_at

document_chunks
├── id (UUID)
├── document_id (FK)
├── case_id (FK)
├── content (text)
├── content_length
├── chunk_index
├── case_number
├── company
├── witness_name
├── document_type
└── created_at
```

## Key Features & Design Decisions

### Parallel Processing (30 Workers)
- **Why**: Maximizes throughput while avoiding rate limits
- **How**: Each worker operates independently with its own Chrome instance
- **Benefit**: Processes ~450 documents in 40 minutes

### Progressive Retry System
- **Why**: PDFs load at different speeds depending on size/complexity
- **How**: Three speed modes (fast/medium/slow) with increasing wait times
- **Benefit**: 99.5% success rate without unnecessary delays

### Duplicate Prevention
- **Database Level**: Unique constraints on case_number and document_name
- **Application Level**: Check before insert to avoid wasted processing
- **Pipeline Tracking**: Remember processed documents across sessions

### Crash Recovery
- **Checkpoint System**: Saves progress every 50 documents
- **Pipeline Persistence**: Discovered cases saved to JSON file
- **Resume Capability**: Can restart from last known state

### Smart Blacklisting
- **Why**: Some documents consistently fail (corrupted, protected, etc.)
- **How**: After 3 failed attempts, document is blacklisted
- **Benefit**: Prevents infinite retry loops, logs for manual review

### Two-Level Queue Architecture
```
Discovery Thread → Case Queue → Document Queue → Workers
                      ↓              ↓
                  [Case 1]      [Doc1, Doc2, Doc3]
                  [Case 2]      [Doc4, Doc5]
                  [Case 3]      [Doc6, Doc7, Doc8]
```
- **Why**: Enables real-time processing while discovery continues
- **How**: Discovery adds cases to queue, workers pull documents
- **Benefit**: No idle workers waiting for discovery to complete

## Running the Crawler

### Historical Crawler (Bulk Processing)
```bash
# Default: 2010-2024 (15 years)
node historical-crawler.js

# Custom date range (25 years)
CRAWLER_START_YEAR=2000 CRAWLER_END_YEAR=2024 node historical-crawler.js

# Recent data only (5 years)
CRAWLER_START_YEAR=2020 CRAWLER_END_YEAR=2024 node historical-crawler.js
```

### Nightly Crawler (Scheduled Updates)
```bash
# Test locally
node backend/src/services/crawlers/nightly-crawler.js

# With custom workers
NIGHTLY_MAX_WORKERS=3 node backend/src/services/crawlers/nightly-crawler.js

# Skip embeddings (just crawl)
SKIP_EMBEDDINGS=true node backend/src/services/crawlers/nightly-crawler.js

# Health check
node backend/src/services/crawlers/nightly-crawler.js --health
```

### From Application Code
```javascript
const { historicalCrawler } = require('./crawlers');

// Run with default settings
await historicalCrawler.run();

// Or with custom options
await historicalCrawler.run({
  startYear: 2020,
  endYear: 2024,
  maxWorkers: 15,
  batchSize: 50
});
```

## Performance Metrics

Based on production runs:
- **Document Processing**: ~1-2 seconds per page
- **Success Rate**: 99.5% (with retry system)
- **Throughput**: ~450 documents in 40 minutes
- **Memory Usage**: ~3-4GB with 30 workers
- **Network**: ~50-100 Mbps during peak processing

## Troubleshooting

### Common Issues

#### "SUPABASE_URL environment variable is not set" or "supabaseUrl is required"
- **Most common cause:** The `.env` file must be in the `backend` directory, not the project root
- Ensure `.env` file exists in `backend/` directory: `ls backend/.env`
- If your `.env` is in the root, copy it: `cp .env backend/.env`
- Verify environment variables are loaded with `dotenv` (already configured in crawlers)

#### High Memory Usage
- Reduce `MAX_WORKERS` configuration (default: 30)
- Monitor with: `ps aux | grep chromium`

#### Documents Failing to Extract
- Check `blacklisted-documents.json` for patterns
- Verify PDF viewer detection logic
- Increase timeout values for slow networks

#### Duplicate Key Errors
- Normal during parallel processing (race conditions)
- Crawler handles these automatically
- Check logs for "race condition detected" messages

#### Pagination Function Errors
- **Issue**: `window.pagePSFGrid is not a function` errors on single-page results
- **Solution**: The crawler now includes defensive checks to verify pagination functions exist before calling them
- **Impact**: These errors are safely ignored and don't affect document extraction

### Debug Mode
Enable verbose logging by modifying console.log statements or adding:
```javascript
const DEBUG = process.env.DEBUG === 'true';
if (DEBUG) console.log('Detailed info...');
```

## Maintenance & Extension

### Adding New State PUCs
The modular design supports extension to other states:

1. Create state-specific discovery methods
2. Implement PDF viewer handlers for state's system
3. Map to common document schema
4. Reuse 90% of processing logic

### Nightly Crawler (Implemented)
Production-ready crawler for incremental updates via Railway cron jobs:
- Checks ALL open cases on Idaho PUC website
- Automatically skips documents already in database (duplicate detection)
- Runs with 5 workers by default (configurable)
- Generates embeddings for new chunks after crawling
- Properly exits after completion (Railway cron requirement)

#### Railway Cron Configuration
In your Railway dashboard, configure a cron job with:
- **Schedule**: `0 2 * * *` (2 AM UTC daily)
- **Command**: `node backend/src/services/crawlers/nightly-crawler.js`
- **Timezone**: UTC (adjust schedule accordingly)

The crawler will:
1. Check all open cases for new documents
2. Process only documents not in database
3. Generate embeddings for new chunks
4. Exit cleanly for Railway's cron system

## Security Considerations

- **No Hardcoded Credentials**: All sensitive data in environment variables
- **Service Role Keys**: Use for server-side operations only
- **Rate Limiting**: Respect website resources with delays
- **Error Handling**: Graceful failures without exposing internals

## Architecture Decisions

### Why Puppeteer over Simple HTTP Requests?
- Idaho PUC uses JavaScript-rendered content
- PDF viewers require browser environment
- Dynamic pagination and AJAX calls
- Session management for document access

### Why Supabase/PostgreSQL?
- Vector search capabilities for AI/ML
- JSONB support for flexible metadata
- Row-level security for multi-tenant future
- Built-in REST API for frontend access

### Why 1500 Character Chunks?
- Optimal for embedding models (512-2048 token range)
- Balances context preservation vs. retrieval precision
- Allows ~300 words per chunk with overlap

### Why Not Use PDF Libraries Directly?
- Idaho PUC PDFs are behind authentication
- Viewer-specific rendering requirements
- Browser environment handles all edge cases
- Visual verification possible for debugging

## Future Enhancements

- **Incremental Updates**: Nightly crawler for new documents
- **Multi-State Support**: Extend to other PUC websites
- **ML Integration**: Generate embeddings during extraction
- **Monitoring Dashboard**: Real-time progress tracking
- **API Endpoints**: RESTful access to crawler operations
- **Queue System**: Redis/RabbitMQ for distributed processing

## Contributing

When modifying the crawler:
1. Maintain the 99.5% success rate
2. Document any new PDF viewer types
3. Update this documentation
4. Test with small date ranges first
5. Monitor memory usage with large batches

## Support

For issues or questions:
- Check `blacklisted-documents.json` for problematic documents
- Review checkpoint files for crash recovery state
- Examine pipeline JSON for discovery progress
- Monitor Supabase logs for database errors
