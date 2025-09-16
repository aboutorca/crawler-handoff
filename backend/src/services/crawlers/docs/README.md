# Crawler Documentation

This folder contains comprehensive documentation for the Idaho PUC Document Crawler system.

## 📚 Available Documents

### For IT/Management Review
- **[CRAWLER_OVERVIEW.md](./CRAWLER_OVERVIEW.md)** - Executive summary with architecture diagrams, security features, and compliance information

### For Technical Teams  
- **[CODE_WALKTHROUGH.md](./CODE_WALKTHROUGH.md)** - Detailed code analysis with line-by-line references and actual code snippets

### For Developers
- **[info.md](./info.md)** - Complete implementation guide including setup, configuration, troubleshooting, and maintenance

## 🎯 Quick Navigation

| Audience | Document | Purpose |
|----------|----------|---------|
| IT Security Team | [CRAWLER_OVERVIEW.md](./CRAWLER_OVERVIEW.md) | Review security, compliance, and resource usage |
| Technical Architects | [CODE_WALKTHROUGH.md](./CODE_WALKTHROUGH.md) | Understand implementation patterns and code structure |
| DevOps Engineers | [info.md](./info.md) | Deploy, configure, and maintain the crawler |
| Developers | All documents | Full system understanding |

## 📁 Crawler Files

The actual crawler implementation is in the parent directory:
- `../historical-crawler.js` - Main crawler for bulk historical data (2,732 lines)
- `../nightly-crawler.js` - Scheduled crawler for daily updates (226 lines)  
- `../index.js` - Module exports and convenience wrappers (45 lines)

## 🚀 Quick Start

```bash
# Test the crawler locally
CRAWLER_MAX_WORKERS=2 node ../historical-crawler.js

# Run nightly crawler
node ../nightly-crawler.js

# Health check
node ../nightly-crawler.js --health
```

## 📊 Key Metrics

- **Success Rate**: 99.5% with retry system
- **Processing Speed**: ~450 documents in 40 minutes
- **Resource Usage**: 3-4GB RAM with 30 workers
- **Database**: PostgreSQL via Supabase
- **Text Extraction**: Puppeteer with Chrome