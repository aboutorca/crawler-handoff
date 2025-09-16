#!/bin/bash

# Idaho PUC Document Crawler - Installation Script
# This script sets up the crawler environment and dependencies

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Print colored output
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Banner
echo "=============================================="
echo "Idaho PUC Document Crawler - Installation"
echo "=============================================="
echo ""

# Check for required tools
print_info "Checking system requirements..."

# Check Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v)
    print_success "Node.js found: $NODE_VERSION"

    # Check minimum version (v18)
    REQUIRED_VERSION=18
    CURRENT_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$CURRENT_VERSION" -lt "$REQUIRED_VERSION" ]; then
        print_error "Node.js version 18 or higher is required. Current: $NODE_VERSION"
        exit 1
    fi
else
    print_error "Node.js is not installed. Please install Node.js 18+ first."
    echo "Download from: https://nodejs.org/"
    exit 1
fi

# Check npm
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm -v)
    print_success "npm found: v$NPM_VERSION"
else
    print_error "npm is not installed."
    exit 1
fi

# Check Docker (optional)
if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version)
    print_success "Docker found: $DOCKER_VERSION"
    DOCKER_AVAILABLE=true
else
    print_warning "Docker not found. Docker deployment will not be available."
    DOCKER_AVAILABLE=false
fi

echo ""
print_info "Setting up crawler environment..."

# Create necessary directories
mkdir -p data logs
print_success "Created data and logs directories"

# Check if .env exists
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        print_info "Creating .env from .env.example..."
        cp .env.example .env
        print_warning "Please edit .env and add your API keys and configuration"
        print_warning "Required: SUPABASE_URL, SUPABASE_ANON_KEY, OPENAI_API_KEY"
    else
        print_error ".env.example not found. Please create .env manually."
    fi
else
    print_success ".env file already exists"
fi

# Install Node dependencies
echo ""
print_info "Installing Node.js dependencies..."
print_info "This may take a few minutes as Puppeteer downloads Chromium..."

# Install dependencies in backend directory
cd backend
npm install
print_success "Node.js dependencies installed"

# Check Chrome/Chromium installation
echo ""
print_info "Checking Chrome/Chromium installation..."
if command -v google-chrome &> /dev/null || command -v chromium-browser &> /dev/null; then
    print_success "Chrome/Chromium found"
else
    print_warning "Chrome/Chromium not detected. Puppeteer will use its bundled version."
fi

# Database setup instructions
echo ""
echo "=============================================="
echo "Database Setup Instructions"
echo "=============================================="
echo ""
print_info "To set up your Supabase database:"
echo "1. Create a new Supabase project at https://supabase.com"
echo "2. Go to SQL Editor in your Supabase dashboard"
echo "3. Run the SQL script: migrations/001_initial_schema.sql"
echo "4. Copy your project URL and anon key to the .env file"
echo ""

# Docker setup (if available)
if [ "$DOCKER_AVAILABLE" = true ]; then
    echo "=============================================="
    echo "Docker Setup (Optional)"
    echo "=============================================="
    echo ""
    print_info "To run with Docker:"
    echo "1. Build the image: docker-compose build"
    echo "2. Run historical crawler: docker-compose run historical-crawler"
    echo "3. Run nightly crawler: docker-compose run nightly-crawler"
    echo ""
fi

# Test commands
echo "=============================================="
echo "Quick Start Commands"
echo "=============================================="
echo ""
print_success "Installation complete! Here are some commands to get started:"
echo ""
echo "# Test with minimal data (2024 only, 2 workers):"
echo "cd backend && CRAWLER_START_YEAR=2024 CRAWLER_END_YEAR=2024 CRAWLER_MAX_WORKERS=2 node src/services/crawlers/historical-crawler.js"
echo ""
echo "# Run nightly crawler:"
echo "cd backend && node src/services/crawlers/nightly-crawler.js"
echo ""
echo "# Check crawler health:"
echo "cd backend && node src/services/crawlers/nightly-crawler.js --health"
echo ""
echo "# Full historical crawl (2010-2024):"
echo "cd backend && node src/services/crawlers/historical-crawler.js"
echo ""

# Verify environment
echo "=============================================="
echo "Environment Check"
echo "=============================================="
echo ""

# Check if required env vars are set
if [ -f .env ]; then
    source .env

    if [ -z "$SUPABASE_URL" ]; then
        print_warning "SUPABASE_URL is not set in .env"
    else
        print_success "SUPABASE_URL is configured"
    fi

    if [ -z "$SUPABASE_ANON_KEY" ] && [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
        print_warning "SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY must be set in .env"
    else
        print_success "Supabase authentication is configured"
    fi

    if [ -z "$OPENAI_API_KEY" ]; then
        print_warning "OPENAI_API_KEY is not set (required for nightly crawler embeddings)"
    else
        print_success "OpenAI API key is configured"
    fi
fi

echo ""
print_success "Setup complete! Remember to configure your .env file before running."
echo ""
echo "For detailed documentation, see backend/src/services/crawlers/docs/"
echo "=============================================="