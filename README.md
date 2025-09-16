# Idaho PUC Document Crawler - Enterprise Deployment Guide

## 🚀 Quick Start (5 Minutes)

```bash
# 1. Clone and setup
git clone [repository-url]
cd crawler-handoff

# 2. Run setup script
chmod +x setup.sh
./setup.sh

# 3. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 4. Test the crawler
cd backend
CRAWLER_START_YEAR=2024 CRAWLER_END_YEAR=2024 CRAWLER_MAX_WORKERS=2 \
node src/services/crawlers/historical-crawler.js
```

## 📋 System Requirements

### Minimum Requirements
- **CPU**: 4 cores
- **RAM**: 4GB (2GB minimum)
- **Storage**: 10GB free space
- **Network**: Stable internet (50-100 Mbps recommended)
- **OS**: Linux (Ubuntu 20.04+), macOS, or Windows with WSL2

### Software Dependencies
- **Node.js**: v18+ (v20 recommended)
- **npm**: v8+
- **Chrome/Chromium**: Latest stable (auto-installed by Puppeteer)
- **Docker**: Optional for containerized deployment

## 📦 What's Included

```
crawler-handoff/
├── backend/                           # Application code
│   ├── package.json                  # Node.js dependencies
│   ├── scheduler-config.ini          # Scheduler configuration
│   └── src/services/                 # Service modules
│       ├── crawlers/                 # Core crawler modules
│       │   ├── historical-crawler.js # Bulk historical data (2,732 lines)
│       │   ├── nightly-crawler.js    # Daily incremental updates (233 lines)
│       │   ├── index.js              # Module exports
│       │   └── docs/                 # Comprehensive documentation
│       └── embeddings.js             # OpenAI embedding service
├── migrations/                        # Database migrations
│   └── 001_initial_schema.sql       # Supabase database schema
├── .env.example                      # Environment template
├── Dockerfile                        # Container configuration
├── docker-compose.yml                # Multi-service orchestration
├── setup.sh                          # Automated setup script
└── README.md                         # This file
```

## 🔧 Installation Methods

### Method 1: Automated Script (Recommended)
```bash
./setup.sh
```
This script will:
- Check system requirements
- Install Node.js dependencies
- Create necessary directories
- Set up environment file
- Verify configuration

### Method 2: Manual Installation
```bash
# 1. Navigate to backend directory
cd backend

# 2. Install dependencies
npm install

# 3. Create directories
mkdir -p data logs

# 4. Copy configuration (from root)
cd ..
cp .env.example .env

# 5. Edit .env with your credentials
nano .env
```

### Method 3: Docker Deployment
```bash
# 1. Build the image
docker-compose build

# 2. Run historical crawler
docker-compose run historical-crawler

# 3. Run nightly updates
docker-compose run nightly-crawler
```

## ⚙️ Configuration

### Required Environment Variables
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-key-here
OPENAI_API_KEY=sk-your-openai-key
```

### Optional Settings
```bash
# Date range for historical crawling
CRAWLER_START_YEAR=2010  # Default: 2010
CRAWLER_END_YEAR=2024    # Default: 2024

# Performance tuning
CRAWLER_MAX_WORKERS=30    # Parallel Chrome instances (default: 30)
NIGHTLY_MAX_WORKERS=5     # For scheduled runs (default: 5)

# Feature flags
SKIP_EMBEDDINGS=false     # Skip OpenAI embedding generation
```

## 🗄️ Database Setup

### 1. Create Supabase Project
1. Sign up at [supabase.com](https://supabase.com)
2. Create new project
3. Note your project URL and anon key

### 2. Initialize Schema
```sql
-- In Supabase SQL Editor, run:
-- migrations/001_initial_schema.sql
```

This creates:
- `cases` - Utility case information
- `documents` - Document metadata
- `document_chunks` - Text chunks with embeddings
- Supporting tables and indexes

### 3. Enable Extensions
```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
```

## 🏃 Running the Crawler

### Test Run (Minimal Data)
```bash
# Navigate to backend and crawl 2024 only with 2 workers
cd backend
CRAWLER_START_YEAR=2024 CRAWLER_END_YEAR=2024 CRAWLER_MAX_WORKERS=2 \
node src/services/crawlers/historical-crawler.js
```

### Full Historical Crawl
```bash
# Navigate to backend and process 2010-2024 (15 years of data)
cd backend
node src/services/crawlers/historical-crawler.js
```

### Nightly Updates (Scheduled)
```bash
# Navigate to backend and check for new documents in open cases
cd backend
node src/services/crawlers/nightly-crawler.js
```

### Health Check
```bash
# Navigate to backend and verify system connectivity
cd backend
node src/services/crawlers/nightly-crawler.js --health
```

## 📊 Performance Metrics

| Metric | Value | Notes |
|--------|-------|-------|
| **Success Rate** | 99.5% | With retry system |
| **Processing Speed** | ~450 docs/40 min | 30 workers |
| **Memory Usage** | 3-4GB | 30 Chrome instances |
| **Network Bandwidth** | 50-100 Mbps | Peak processing |
| **Typical Runtime** | 6-8 hours | Full 15-year crawl |

## 🔄 Production Deployment

### Using Cron (Linux/macOS)
```bash
# Add to crontab for daily 2 AM run
0 2 * * * cd /path/to/crawler-handoff/backend && node src/services/crawlers/nightly-crawler.js >> logs/nightly.log 2>&1
```

### Using Windows Task Scheduler
```xml
<!-- Create scheduled task for daily updates -->
<Action>
  <Exec>
    <Command>node</Command>
    <Arguments>src/services/crawlers/nightly-crawler.js</Arguments>
    <WorkingDirectory>C:\path\to\crawler-handoff\backend</WorkingDirectory>
  </Exec>
</Action>
```

### Using Docker + Ofelia
```yaml
# scheduler-config.ini
[job-exec "nightly-crawler"]
schedule = 0 2 * * *
container = idaho-puc-nightly-crawler
command = node src/services/crawlers/nightly-crawler.js
```

## 🚨 Monitoring & Troubleshooting

### Common Issues

#### "SUPABASE_URL environment variable is not set"
- Solution: Ensure `.env` file exists and contains valid credentials

#### High Memory Usage
```bash
# Reduce worker count
cd backend
CRAWLER_MAX_WORKERS=10 node src/services/crawlers/historical-crawler.js
```

#### Documents Failing to Extract
- Check `data/blacklisted-documents.json` for patterns
- Increase timeouts in crawler configuration
- Verify network stability

#### Duplicate Key Errors
- Normal during parallel processing
- Crawler handles these automatically
- Check logs for "race condition detected"

### Log Files
```bash
# View recent crawler activity
tail -f logs/crawler.log

# Check for errors
grep ERROR logs/crawler.log

# Monitor in real-time
watch -n 1 'tail -20 logs/crawler.log'
```

### Health Monitoring
```bash
# Manual health check
curl http://localhost:3000/health

# Automated monitoring (example with cron)
*/5 * * * * curl -f http://localhost:3000/health || echo "Crawler unhealthy" | mail -s "Alert" admin@company.com
```

## 📈 Scaling Considerations

### Vertical Scaling
- Increase `CRAWLER_MAX_WORKERS` for faster processing
- Each worker needs ~100-150MB RAM
- Monitor CPU usage (target <80%)

### Horizontal Scaling
- Deploy multiple instances with different year ranges
- Use database transactions to prevent conflicts
- Consider queue-based architecture for large scale

### Rate Limiting
- Idaho PUC: No explicit limits, crawler self-throttles
- OpenAI: 3,000 requests/min (Tier 1)
- Supabase: Check your plan limits

## 🔐 Security Best Practices

1. **Credentials**: Never commit `.env` to version control
2. **Network**: Use VPN for production deployments
3. **Database**: Enable Row Level Security (RLS) in Supabase
4. **Monitoring**: Set up alerts for unusual activity
5. **Updates**: Keep dependencies updated monthly

## 📚 Additional Documentation

- **[Technical Overview](backend/src/services/crawlers/docs/CRAWLER_OVERVIEW.md)** - Architecture and design
- **[Code Walkthrough](backend/src/services/crawlers/docs/CODE_WALKTHROUGH.md)** - Line-by-line analysis
- **[Developer Guide](backend/src/services/crawlers/docs/info.md)** - Implementation details

## 🤝 Support & Maintenance

### Daily Operations
1. Monitor health endpoint
2. Check log files for errors
3. Verify new documents in database
4. Review blacklisted documents weekly

### Weekly Maintenance
1. Clear old checkpoint files
2. Analyze performance metrics
3. Update blacklist patterns
4. Test disaster recovery

### Monthly Tasks
1. Update dependencies
2. Review crawler efficiency
3. Optimize database indexes
4. Backup configuration

## 📄 License

MIT License - See LICENSE file for details

## 🚀 Next Steps

1. **Configure Environment**: Edit `.env` with your credentials
2. **Setup Database**: Run schema in Supabase
3. **Test Crawler**: Run with 2024 data only
4. **Schedule Updates**: Configure cron/scheduler
5. **Monitor Health**: Set up alerting

---

**Need Help?** Check the [comprehensive documentation](backend/src/services/crawlers/docs/) or review the [troubleshooting guide](#-monitoring--troubleshooting).