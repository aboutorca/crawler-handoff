# Idaho PUC Document Crawler - Technical Overview

## Executive Summary

The Idaho PUC Document Crawler is an automated system that systematically extracts publicly available regulatory documents from the Idaho Public Utilities Commission website (https://puc.idaho.gov). The crawler respects website resources through rate limiting, parallel processing controls, and progressive retry mechanisms.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    CRAWLER ARCHITECTURE                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. DISCOVERY PHASE                                          │
│     ├── Navigate to PUC case listings                       │
│     ├── Filter by date range (configurable)                 │
│     └── Queue valid cases for processing                    │
│                           ▼                                  │
│  2. DOCUMENT IDENTIFICATION                                  │
│     ├── Visit each case detail page                         │
│     ├── Identify PDF documents by category                  │
│     └── Build document processing queue                     │
│                           ▼                                  │
│  3. PARALLEL EXTRACTION (30 workers max)                    │
│     ├── Launch Chrome instances via Puppeteer               │
│     ├── Navigate to document URLs                           │
│     └── Extract text from PDF viewers                       │
│                           ▼                                  │
│  4. TEXT PROCESSING                                         │
│     ├── Clean extracted text                                │
│     ├── Split into 1500-char chunks                         │
│     └── Maintain 200-char overlap                           │
│                           ▼                                  │
│  5. DATABASE STORAGE                                        │
│     ├── Store in PostgreSQL (Supabase)                      │
│     ├── Prevent duplicates via constraints                  │
│     └── Track extraction status                             │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### 1. HistoricalCrawler Class (Main Orchestrator)
- **Location**: `backend/src/services/crawlers/historical-crawler.js`
- **Lines**: 1193-2732
- **Purpose**: Coordinates the entire crawling pipeline
- **Key Methods**:
  - `crawlHistoricalData()` - Main entry point
  - `discoverCasesFromListing()` - Finds cases to process
  - `extractDocumentsFromCase()` - Identifies documents in each case

### 2. SupabaseUploader Class (Database Interface)
- **Lines**: 217-848
- **Purpose**: Handles all database operations
- **Features**:
  - Duplicate prevention
  - Transaction safety
  - Race condition handling
  - Batch operations for efficiency

### 3. DocumentExtractor Class (PDF Text Extraction)
- **Lines**: 851-1190
- **Purpose**: Extracts text from various PDF viewer types
- **Handles**:
  - LaserFiche viewer (server-rendered PDFs)
  - WebLink viewer (client-rendered PDFs)
  - Progressive retry with increasing wait times

### 4. CrashRecoveryManager Class (Resilience)
- **Lines**: 95-214
- **Purpose**: Enables resuming after interruptions
- **Features**:
  - Checkpoint saving every 50 documents
  - Pipeline state persistence
  - Blacklist management for problematic documents

## Security & Compliance Features

### Rate Limiting & Resource Management
```javascript
// Configurable worker pool (Line 67)
MAX_WORKERS: 30,  // Can be reduced via environment variables

// Progressive timing for slow-loading documents (Lines 49-64)
PROGRESSIVE_TIMING: {
  WEBLINK_ATTEMPTS: [
    { wait: 300, name: "fast" },
    { wait: 600, name: "medium" }, 
    { wait: 1200, name: "slow" }
  ]
}
```

### Authentication & Data Security
- **No hardcoded credentials** - All sensitive data via environment variables
- **Database credentials**: Stored in `SUPABASE_URL` and `SUPABASE_ANON_KEY`
- **Row-level security**: Utilizes Supabase's built-in RLS policies
- **No session hijacking**: Each worker maintains independent browser session

### Respectful Web Scraping
```javascript
// Delay between page navigations (Lines 44-47)
LASERFICHE_PAGE_WAIT: 200,  // milliseconds
WEBLINK_PAGE_WAIT: 300,      // milliseconds
MAX_RETRIES: 2,              // Limit retry attempts
RETRY_DELAY: 500,            // Wait between retries
```

## Resource Utilization

### Memory Management
- **Typical usage**: 3-4GB RAM with 30 workers
- **Per worker**: ~100-150MB (Chrome instance + Node.js)
- **Automatic cleanup**: Browsers closed after each document

### Network Usage
- **Bandwidth**: 50-100 Mbps during peak processing
- **Concurrent connections**: Maximum 30 (configurable)
- **Request spacing**: Built-in delays prevent overwhelming server

### Performance Metrics
- **Document processing rate**: ~450 documents in 40 minutes
- **Success rate**: 99.5% with retry system
- **Page extraction speed**: 1-2 seconds per PDF page
- **Database write speed**: ~100 documents/minute

## Error Handling & Recovery

### Three-Tier Retry System
1. **Fast attempt**: Minimal wait times
2. **Medium attempt**: Increased timeouts for slow servers
3. **Slow attempt**: Maximum patience for complex documents

### Blacklisting System
```javascript
// After 3 failures, document is blacklisted (Lines 1594-1610)
if (error.retryCount >= 3) {
  this.blacklistDocument(documentUrl);
  // Document logged for manual review
}
```

### Duplicate Prevention
- **Database level**: Unique constraints on `case_number` and `document_name`
- **Application level**: Pre-check before processing
- **Race condition handling**: Graceful handling of parallel insert conflicts

## Configuration & Deployment

### Environment Variables
```bash
# Required
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-key-here

# Optional
CRAWLER_START_YEAR=2010  # Default: 2010
CRAWLER_END_YEAR=2024    # Default: 2024
CRAWLER_MAX_WORKERS=30   # Default: 30
```

### Running the Crawler
```bash
# Standard execution (2010-2024)
node backend/src/services/crawlers/historical-crawler.js

# Custom date range
CRAWLER_START_YEAR=2020 CRAWLER_END_YEAR=2024 node historical-crawler.js

# Reduced workers for lighter load
CRAWLER_MAX_WORKERS=10 node historical-crawler.js
```

## Database Schema

```sql
-- Cases table (stores utility case information)
cases (
  id UUID PRIMARY KEY,
  case_number TEXT UNIQUE,  -- e.g., "IPC-E-24-01"
  company TEXT,
  utility_type TEXT,
  case_status TEXT,
  date_filed DATE,
  description TEXT,
  case_url TEXT
)

-- Documents table (stores document metadata)
documents (
  id UUID PRIMARY KEY,
  case_id UUID REFERENCES cases(id),
  document_name TEXT,
  document_type TEXT,
  document_url TEXT UNIQUE,
  witness_name TEXT,
  extraction_status TEXT,
  extracted_at TIMESTAMP
)

-- Document chunks table (stores processed text)
document_chunks (
  id UUID PRIMARY KEY,
  document_id UUID REFERENCES documents(id),
  case_id UUID REFERENCES cases(id),
  content TEXT,
  content_length INTEGER,
  chunk_index INTEGER,
  metadata JSONB
)
```

## Compliance & Legal Considerations

1. **Public Data Only**: Crawler only accesses publicly available documents
2. **No Authentication Bypass**: Does not attempt to access restricted content
3. **Robots.txt Compliance**: Respects website directives
4. **User-Agent Identification**: Clearly identifies as automated crawler
5. **Rate Limiting**: Prevents server overload through controlled request rates

## Monitoring & Maintenance

### Health Checks
- Database connectivity verification
- Chrome/Puppeteer availability check
- Disk space monitoring for checkpoints

### Logging
- Detailed progress reporting
- Error tracking with context
- Blacklist documentation for review

### Recovery Procedures
1. **On crash**: Run again - automatically resumes from checkpoint
2. **On network failure**: Progressive retry handles temporary issues
3. **On database error**: Transaction rollback prevents partial data

## Contact & Support

For questions about this crawler:
- **Technical Implementation**: Review code comments in historical-crawler.js
- **Database Schema**: See migrations in `/supabase/migrations/`
- **Deployment**: Check Railway configuration documentation

---

*This crawler is designed to be respectful of website resources while efficiently gathering public regulatory documents for research purposes.*