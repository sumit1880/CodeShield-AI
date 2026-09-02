-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Enums
CREATE TYPE "Severity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');
CREATE TYPE "VerificationStatus" AS ENUM ('CONFIRMED', 'REJECTED');
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "SourceType" AS ENUM ('PASTE', 'ZIP');

-- Analysis
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "sourceType" "SourceType" NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Analysis_codeHash_idx" ON "Analysis"("codeHash");
CREATE INDEX "Analysis_createdAt_idx" ON "Analysis"("createdAt");

-- Finding
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT,
    "cweId" TEXT NOT NULL,
    "cweName" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "file" TEXT NOT NULL,
    "function" TEXT,
    "lineStart" INTEGER NOT NULL,
    "lineEnd" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "verificationStatus" "VerificationStatus" NOT NULL,
    "verificationReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Finding_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "Analysis"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Finding_analysisId_idx" ON "Finding"("analysisId");

-- KnowledgeDocument
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- KnowledgeChunk (embedding uses pgvector; dimension 768 matches typical
-- text embedding models, adjust if EMBEDDING_MODEL produces a different size)
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(768),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "KnowledgeChunk_documentId_idx" ON "KnowledgeChunk"("documentId");

-- Approximate nearest-neighbor index for similarity search.
-- ivfflat requires ANALYZE after data is loaded for good performance.
CREATE INDEX "KnowledgeChunk_embedding_idx" ON "KnowledgeChunk" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100);
