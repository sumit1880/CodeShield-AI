# Refactoring Summary: LangGraph.js & LangChain.js Migration

## 1. What Changed

### Orchestration Layer -> LangGraph.js (`@langchain/langgraph`)
- **StateGraph Architecture**: The hand-written `while` loop in `AnalysisOrchestrator` was replaced with a compiled `StateGraph` in `backend/src/graph/`.
- **State Annotation & Merging (`src/graph/state.ts`)**: State is managed via `AnalysisGraphAnnotation` with pure reducers:
  - `candidateFindings`: dedupes findings by `title + file + lineStart` and re-indexes sequentially (`finding-1`, `finding-2`, etc.).
  - `classifiedFindings`: merged by ID map.
  - `verifiedById`: plain Record object (`Record<string, VerificationResult>`) merged by key, avoiding JSON serialization issues.
  - `knowledge`, `evidence`, `actionsTaken`: append-only history reducers.
  - `nextAction`: transient planner action, cleared when consumed.
  - `finalized`: terminal packed findings object.
- **Dedicated Nodes (`src/graph/nodes/`)**:
  - `manager.node.ts`: generates next action against `managerDecisionSchema`. Gracefully catches schema validation errors and defaults to `FINISH`.
  - `detect.node.ts`: combines source code with Semgrep findings.
  - `classify.node.ts`: classifies candidates against curated `KNOWN_CWE_IDS`.
  - `verify.node.ts`: verifies findings with reason tracking and false positive prevention.
  - `reanalyze.node.ts`: re-evaluates UNCERTAIN findings after gathering context.
  - `rag.node.ts`: invokes vector retriever.
  - `code-search.node.ts`: project text search.
  - `code-analyze.node.ts`: targeted snippet extractor.
  - `semgrep.node.ts`: dynamic Semgrep invocation.
  - `finalize.node.ts`: formats CONFIRMED, UNCERTAIN, and UNVERIFIED findings; discards REJECTED findings; ensures unverified findings are never upgraded to CONFIRMED.
- **Conditional Routing (`src/graph/router.ts`)**:
  - `routeFromManager`: prioritizes abort signal -> safety limits (iterations, tool calls, deadline) -> deterministic forced Classify -> deterministic forced Verify -> manager's chosen action -> finalize.
  - `routeFromWorker`: prioritizes abort signal -> safety limits -> forced Classify cascade -> forced Verify cascade -> return to manager.

### LLM Plumbing -> LangChain.js (`@langchain/core`, `@langchain/google-genai`, `@langchain/openai`)
- **Standardized Chat Models (`src/llm/factory.ts`)**: Replaced custom `LlmService` with LangChain `BaseChatModel`. Integrated `ChatGoogleGenerativeAI` for Gemini/Gemini2 and `ChatOpenAI` with custom `baseURL` for Grok (xAI) and Llama endpoints.
- **Provider-Error Fallback Isolation (`LangChainFallbackRouter`)**: Preserved the exact Gemini -> Grok -> Llama fallback chain, but isolated fallback exclusively to provider-side errors (HTTP 429 rate limit, AI timeout, 5xx outages). Zod validation errors and client errors never trigger provider fallback.
- **Structured Output & Bounded Repair (`src/llm/structured-output.ts`)**: Replaced `generateStructured` with `generateStructuredWithModel`. Validates responses against Zod schemas; on failure, performs exactly one repair attempt with the specific validation error and previous response before throwing `ApiError(ErrorCode.INVALID_AI_RESPONSE)`.
- **ChatPromptTemplates (`src/prompts/`)**: Converted inline prompt strings to `ChatPromptTemplate` using `SystemMessage` objects to prevent JSON syntax conflicts with template variables. Preserved random nonce delimiters (`<code_nonce> ... </code_nonce>`) for prompt-injection defense.
- **Prisma pgvector Retriever (`src/services/rag/prisma-retriever.ts`)**: Wrapped PostgreSQL cosine similarity queries in a LangChain-compatible retriever class with graceful degradation to empty results on error.
- **Testing (`src/llm/fake-chat-model.ts`)**: Created a scriptable `FakeChatModel` extending `BaseChatModel` supporting response queuing, delays, and abort signals without real LLM network calls.

---

## 2. What Was Deliberately Left Alone & Why

- **Public API & Contracts**: `POST /api/analyze`, `POST /api/analyze/upload`, and `GET /health` remain 100% backward compatible in request and response shapes.
- **Frontend**: Vite/React frontend was untouched; all findings, severity badges, and partial status indicators continue to function identically.
- **Semgrep Service**: Remained an external CLI process runner with strict argument sanitation.
- **ZIP Handling & Security Limits**: Zip slip prevention, symlink rejection, byte/file count limits, and temp directory workspaces (`withTempDir`) preserved unchanged.
- **Authentication & Security Middleware**: Google ID token verification (`google-auth-library`), IP rate limiter, and concurrency limiter kept intact.
- **Prisma & Database Schema**: PostgreSQL schema and pgvector tables untouched.

---

## 3. Known Limitations & Trade-offs

- **Graph Compilation Overhead**: Compiling the LangGraph StateGraph on each analysis takes ~20-30ms. For tests with aggressive global timeouts (e.g. 50ms), deadline checks must account for compilation time.
- **Local Semgrep on Windows**: Semgrep binary is not natively installed in the local Windows test environment (3 Semgrep-specific tests fail locally, which is expected and documented; tests pass in Docker/Linux CI).
- **In-Memory Checkpointing**: Currently using ephemeral in-memory state suitable for single-instance free-tier deployment without requiring Redis or external task brokers.
