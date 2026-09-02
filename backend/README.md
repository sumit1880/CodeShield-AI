CodeShield AI

CodeShield AI is a security analysis tool for finding common vulnerabilities in source code and small project archives.

The project combines Semgrep for static analysis with a small LLM-based analysis pipeline. The LLM is used to interpret findings, assign CWE information, explain the issue, and review the result before it is returned.

This is a B.Tech project / prototype, so the focus is on having a clear and testable analysis pipeline rather than building a production-scale security platform.

What it does

Accepts source code directly or as a ZIP project

Runs Semgrep without executing the submitted code

Extracts relevant code around reported findings

Uses security-related reference material through a PostgreSQL + pgvector knowledge base

Runs three analysis stages:

Detection

Classification and localization

Verification

Returns severity, confidence, CWE, location, explanation, and remediation

Validates LLM responses before using them

Applies limits and checks when handling ZIP uploads

How the analysis works

Source code / ZIP
       |
       v
   Input checks
       |
       v
     Semgrep
       |
       v
 Relevant code context
       |
       +------------------+
       |                  |
       v                  v
 Security knowledge    Semgrep results
       |                  |
       +--------+---------+
                |
                v
          Detection agent
                |
                v
       Classification agent
                |
                v
        Verification agent
                |
                v
        Final findings
                |
                v
            PostgreSQL

The three agents are coordinated by the analysis orchestrator. They do not call each other directly.

Tech stack

Backend

Node.js

TypeScript

Express

Prisma

PostgreSQL

pgvector

Semgrep

Google Gemini

Zod

Jest / Supertest

Frontend

The frontend will provide the interface for submitting code/projects and viewing analysis results.

Repository structure

CodeShield-AI/
├── backend/
│   ├── prisma/
│   ├── semgrep-rules/
│   ├── src/
│   ├── tests/
│   ├── Dockerfile
│   ├── package.json
│   └── ...
│
├── frontend/
│   └── ...
│
└── README.md

Backend API

Analyze source code

POST /api/analyze
Content-Type: application/json

Example:

{
  "language": "javascript",
  "code": "const query = 'SELECT * FROM users WHERE id=' + req.query.id;"
}

Analyze a ZIP project

POST /api/analyze/upload?language=auto
Content-Type: multipart/form-data

Upload the project as the file field.

When language=auto, the backend uses file extensions to determine the language.

Health check

GET /health

Running the backend locally

Go to the backend directory:

cd backend

Install dependencies:

npm install

Create the environment file:

cp .env.example .env

Set the required values in .env, including the database connection and Gemini API key.

Run the Prisma setup:

npx prisma generate
npx prisma migrate deploy
npx prisma db seed

Install Semgrep separately and make sure it is available on PATH.

Start the development server:

npm run dev

For a production build:

npm run build
npm start

Environment variables

The main configuration is kept in .env.example.

Important variables include:

DATABASE_URL
GEMINI_API_KEY
GEMINI_MODEL
EMBEDDING_MODEL
CORS_ORIGIN
SEMGREP_PATH
AI_REQUEST_TIMEOUT_MS
AI_MAX_RETRIES

Limits for code and ZIP uploads are configurable as well.

Do not commit .env or API keys.

Security considerations

The backend treats submitted projects as untrusted input.

Source code is scanned; it is not executed or compiled.

Semgrep is started with an argument array rather than a shell command.

ZIP extraction checks for path traversal and size/file-count limits.

Temporary workspaces are removed after analysis.

Raw submitted source is not kept as permanent analysis data.

AI responses are validated with Zod before being used.

Request and upload limits are configurable.

Testing

Run:

npm test

The test suite covers input validation, Semgrep integration, AI response validation, the analysis pipeline, ZIP extraction checks, and API behavior.

The LLM is mocked in tests, so a real Gemini API key is not required for the test suite.

Current scope

The custom Semgrep rules currently cover:

JavaScript

TypeScript

Python

The security knowledge base contains starter material for common issues such as SQL injection, XSS, command injection, path traversal, SSRF, hardcoded credentials, weak cryptography, and insecure deserialization.

The project is still a prototype. Detection quality depends on the source code, Semgrep coverage, the available security knowledge, and the LLM response.

License

This project is currently intended as an academic project.
