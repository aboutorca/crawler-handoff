-- Production-Matching Schema for Test Supabase Instance
-- This exactly matches your production database structure
-- Run this in your TEST Supabase SQL editor after creating the project

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector"; -- For embedding column
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For text search

-- ============================================================================
-- CASES TABLE
-- ============================================================================
CREATE TABLE cases (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    case_number text NOT NULL,
    company text NOT NULL,
    utility_type text NOT NULL,
    case_status text NOT NULL,
    date_filed date,
    description text,
    case_url text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT cases_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- DOCUMENTS TABLE
-- ============================================================================
CREATE TABLE documents (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    case_id uuid,
    document_name text NOT NULL,
    document_type text,
    document_url text NOT NULL,
    witness_name text,
    extraction_status text DEFAULT 'pending'::text,
    extracted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT documents_pkey PRIMARY KEY (id),
    CONSTRAINT documents_case_id_fkey FOREIGN KEY (case_id) 
        REFERENCES cases(id) ON DELETE CASCADE
);

-- ============================================================================
-- DOCUMENT_CHUNKS TABLE
-- ============================================================================
CREATE TABLE document_chunks (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    document_id uuid,
    case_id uuid,
    content text NOT NULL,
    content_length integer NOT NULL,
    chunk_index integer NOT NULL,
    page_number integer,
    search_vector tsvector,
    structured_data jsonb,
    case_number text NOT NULL,
    company text NOT NULL,
    witness_name text,
    document_type text,
    created_at timestamp with time zone DEFAULT now(),
    embedding vector(2000), -- OpenAI text-embedding-3-large dimension
    CONSTRAINT document_chunks_pkey PRIMARY KEY (id),
    CONSTRAINT document_chunks_document_id_fkey FOREIGN KEY (document_id) 
        REFERENCES documents(id) ON DELETE CASCADE,
    CONSTRAINT document_chunks_case_id_fkey FOREIGN KEY (case_id) 
        REFERENCES cases(id) ON DELETE CASCADE
);

-- ============================================================================
-- CHAT_MESSAGES TABLE (For the UI/Chat functionality)
-- ============================================================================
CREATE TABLE chat_messages (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    session_id text,
    message_type text,
    message text NOT NULL,
    response jsonb,
    citations jsonb,
    confidence text,
    chunks_searched integer,
    response_time_ms integer,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT chat_messages_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- USER_SESSIONS TABLE (For tracking user sessions)
-- ============================================================================
CREATE TABLE user_sessions (
    id uuid DEFAULT uuid_generate_v4() NOT NULL,
    session_id text NOT NULL,
    user_context jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    last_active_at timestamp with time zone DEFAULT now(),
    total_messages integer DEFAULT 0,
    session_duration_minutes integer,
    research_topic text,
    user_role text,
    timeframe text,
    purpose text,
    user_id uuid,
    CONSTRAINT user_sessions_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- USER_PROFILES TABLE
-- ============================================================================
CREATE TABLE user_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    usage_intent text NOT NULL,
    completed_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT user_profiles_pkey PRIMARY KEY (id)
);

-- ============================================================================
-- CREATE INDEXES FOR PERFORMANCE
-- ============================================================================

-- Cases indexes
CREATE INDEX idx_cases_case_number ON cases(case_number);
CREATE INDEX idx_cases_company ON cases(company);
CREATE INDEX idx_cases_utility_type ON cases(utility_type);
CREATE INDEX idx_cases_case_status ON cases(case_status);
CREATE INDEX idx_cases_date_filed ON cases(date_filed);

-- Documents indexes
CREATE INDEX idx_documents_case_id ON documents(case_id);
CREATE INDEX idx_documents_extraction_status ON documents(extraction_status);
CREATE INDEX idx_documents_document_type ON documents(document_type);

-- Document chunks indexes
CREATE INDEX idx_chunks_document_id ON document_chunks(document_id);
CREATE INDEX idx_chunks_case_id ON document_chunks(case_id);
CREATE INDEX idx_chunks_case_number ON document_chunks(case_number);
CREATE INDEX idx_chunks_company ON document_chunks(company);
CREATE INDEX idx_chunks_witness_name ON document_chunks(witness_name);
CREATE INDEX idx_chunks_search_vector ON document_chunks USING gin(search_vector);
CREATE INDEX idx_chunks_structured_data ON document_chunks USING gin(structured_data);

-- Chat messages indexes
CREATE INDEX idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX idx_chat_messages_created_at ON chat_messages(created_at);

-- User sessions indexes
CREATE INDEX idx_user_sessions_session_id ON user_sessions(session_id);
CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_created_at ON user_sessions(created_at);

-- User profiles indexes
CREATE INDEX idx_user_profiles_user_id ON user_profiles(user_id);

-- ============================================================================
-- VECTOR SEARCH INDEXES (IVFFlat for Production Performance)
-- ============================================================================

-- Main vector similarity index using IVFFlat with 375 lists
-- This is optimized for ~100k+ vectors with sub-100ms query performance
CREATE INDEX idx_document_chunks_embedding_production
  ON document_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 375);

-- Supporting indexes for filtered vector search
CREATE INDEX idx_document_chunks_case_embedding
  ON document_chunks (case_id)
  WHERE embedding IS NOT NULL;

CREATE INDEX idx_document_chunks_company_embedding
  ON document_chunks (company)
  WHERE embedding IS NOT NULL;

-- ============================================================================
-- CREATE UNIQUE CONSTRAINTS
-- ============================================================================

-- Ensure case numbers are unique
CREATE UNIQUE INDEX unique_case_number ON cases(case_number);

-- Ensure documents are unique per case
CREATE UNIQUE INDEX unique_document_per_case ON documents(case_id, document_name);

-- ============================================================================
-- CREATE FULL-TEXT SEARCH FUNCTION
-- ============================================================================

-- Function to update search_vector
CREATE OR REPLACE FUNCTION update_search_vector()
RETURNS trigger AS $$
BEGIN
    NEW.search_vector := 
        setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.case_number, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.company, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.witness_name, '')), 'C') ||
        setweight(to_tsvector('english', COALESCE(NEW.document_type, '')), 'D');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update search_vector
CREATE TRIGGER update_search_vector_trigger
BEFORE INSERT OR UPDATE ON document_chunks
FOR EACH ROW
EXECUTE FUNCTION update_search_vector();

-- ============================================================================
-- VECTOR SIMILARITY FUNCTIONS
-- ============================================================================

-- Helper function to calculate cosine similarity
CREATE OR REPLACE FUNCTION cosine_similarity(a vector, b vector)
RETURNS float
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
  RETURN 1 - (a <=> b);
END;
$$;

-- Main function to find similar document chunks using vector similarity
CREATE OR REPLACE FUNCTION find_similar_chunks(
  query_embedding vector(2000),
  similarity_threshold float DEFAULT 0.7,
  max_results int DEFAULT 50,
  start_year int DEFAULT NULL,
  end_year int DEFAULT NULL,
  target_company text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  case_number text,
  company text,
  document_name text,
  content text,
  similarity_score float,
  year_filed int,
  date_filed date
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.id,
    dc.case_number,
    dc.company,
    d.document_name,
    dc.content,
    (1 - (dc.embedding <=> query_embedding)) as similarity_score,
    EXTRACT(YEAR FROM c.date_filed)::int as year_filed,
    c.date_filed
  FROM document_chunks dc
  JOIN documents d ON dc.document_id = d.id
  JOIN cases c ON dc.case_id = c.id
  WHERE dc.embedding IS NOT NULL
    -- Pre-filter by date using actual date column (more efficient than EXTRACT)
    AND (start_year IS NULL OR c.date_filed >= make_date(start_year, 1, 1))
    AND (end_year IS NULL OR c.date_filed <= make_date(end_year, 12, 31))
    -- Pre-filter by company before expensive vector operations
    AND (target_company IS NULL OR dc.company ILIKE '%' || target_company || '%')
    -- Vector similarity threshold using native operator
    AND (dc.embedding <=> query_embedding) <= (1 - similarity_threshold)
  ORDER BY dc.embedding <=> query_embedding
  LIMIT max_results;
END;
$$;

-- ============================================================================
-- GRANT PERMISSIONS
-- ============================================================================

GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO postgres;

-- ============================================================================
-- HELPER VIEWS (Optional but useful)
-- ============================================================================

-- View for crawler statistics
CREATE OR REPLACE VIEW crawler_statistics AS
SELECT 
    COUNT(DISTINCT c.id) as total_cases,
    COUNT(DISTINCT d.id) as total_documents,
    COUNT(DISTINCT ch.id) as total_chunks,
    SUM(CASE WHEN d.extraction_status = 'completed' THEN 1 ELSE 0 END) as completed_documents,
    SUM(CASE WHEN d.extraction_status = 'failed' THEN 1 ELSE 0 END) as failed_documents,
    SUM(CASE WHEN d.extraction_status = 'pending' THEN 1 ELSE 0 END) as pending_documents,
    MAX(c.created_at) as last_crawl_date
FROM cases c
LEFT JOIN documents d ON c.id = d.case_id
LEFT JOIN document_chunks ch ON d.id = ch.document_id;

-- View for case summaries
CREATE OR REPLACE VIEW case_summaries AS
SELECT 
    c.id,
    c.case_number,
    c.company,
    c.utility_type,
    c.case_status,
    c.date_filed,
    COUNT(DISTINCT d.id) as document_count,
    COUNT(DISTINCT ch.id) as chunk_count,
    MAX(d.extracted_at) as last_extraction
FROM cases c
LEFT JOIN documents d ON c.id = d.case_id
LEFT JOIN document_chunks ch ON c.id = ch.case_id
GROUP BY c.id, c.case_number, c.company, c.utility_type, c.case_status, c.date_filed;

-- ============================================================================
-- SUCCESS MESSAGE
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE 'Production-matching schema created successfully!';
    RAISE NOTICE 'Tables created: cases, documents, document_chunks, chat_messages, user_sessions, user_profiles';
    RAISE NOTICE 'Vector search configured: 2000-dimensional embeddings with IVFFlat index (375 lists)';
    RAISE NOTICE 'All indexes and constraints applied including vector similarity search';
    RAISE NOTICE 'Full-text search and vector similarity functions configured';
    RAISE NOTICE 'Database ready for crawler with enterprise-grade vector search performance';
END $$;