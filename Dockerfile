# Idaho PUC Document Crawler - Docker Container
# Node.js 20 with Puppeteer and Chrome dependencies

FROM node:20-slim

# Install Chrome dependencies and utilities
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY backend/package.json ./package.json
COPY backend/package-lock.json* ./

# Install dependencies (including Puppeteer which will download Chrome)
RUN npm ci --only=production

# Copy backend application files
COPY backend/src ./src

# Copy database migrations
COPY migrations ./migrations

# Copy .env file if it exists (for consistency with local development)
# Note: docker-compose.yml also loads env vars via env_file directive
COPY .env* ./

# Create data directory for checkpoints and logs
RUN mkdir -p /app/data /app/logs

# Set Puppeteer to use installed Chrome
ENV PUPPETEER_SKIP_DOWNLOAD=false
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Install Chrome stable
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Add non-root user for security
RUN groupadd -r crawler && useradd -r -g crawler -G audio,video crawler \
    && chown -R crawler:crawler /app

USER crawler

# Expose port if running nightly crawler with health check endpoint
EXPOSE 3000

# Default command - can be overridden
CMD ["node", "src/services/crawlers/historical-crawler.js"]

# Alternative commands (uncomment as needed):
# CMD ["node", "src/services/crawlers/nightly-crawler.js"]
# CMD ["node", "src/services/crawlers/nightly-crawler.js", "--health"]