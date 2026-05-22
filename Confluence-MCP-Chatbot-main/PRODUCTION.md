# Production Deployment Guide

## Repository Cleanup for Production

The following directories and files exist for development/OSS purposes and should be
removed (or excluded via `.dockerignore`) before deploying to production.

### Remove entirely

| Path | Reason |
|---|---|
| `tests/` | Full pytest suite — dev-only, ~95 files |
| `scripts/` | OAuth setup wizard and doc-generation scripts |
| `.github/` | CI/CD workflows, issue templates, funding config |
| `docs/` | Mintlify documentation site source |
| `helm/` | Kubernetes Helm charts (replace with your own if needed) |
| `.devcontainer/` | VS Code dev container config |
| `.pre-commit-config.yaml` | Pre-commit hooks (dev tooling) |
| `CONTRIBUTING.md` | Open-source contribution guide |
| `SECURITY.md` | Open-source security policy |
| `smithery.yaml` | Smithery registry manifest |
| `AGENTS.md` / `CLAUDE.md` | LLM agent documentation |
| `.worktreeinclude` | Git worktree config |

### Simplify or replace

| Path | Action |
|---|---|
| `README.md` | Replace with your enterprise-specific README |
| `.env.example` | Keep but remove irrelevant auth examples |
| `Dockerfile` | Keep as-is — already production-ready |

### Keep untouched

| Path | Why |
|---|---|
| `src/mcp_atlassian/` | Core library — the MCP server |
| `pyproject.toml` | Python project definition |
| `uv.lock` | Reproducible dependency lockfile |
| `.dockerignore` | Prevents dev artifacts from entering image |
| `.gitignore` | Standard ignores |

---

## Production Folder Structure

```
project-root/
├── src/mcp_atlassian/          # MCP server library (unchanged)
├── teams-bot/                  # Teams bot (Node.js / TypeScript)
│   ├── src/
│   │   ├── bot/teamsBot.ts     # Bot Framework activity handler
│   │   ├── auth/
│   │   │   ├── patValidator.ts # validate_pat_identity tool
│   │   │   └── credentialStore.ts
│   │   ├── ai/orchestrator.ts  # AI + tool-calling loop
│   │   ├── mcp/mcpClient.ts    # MCP HTTP client (BYOT)
│   │   ├── utils/
│   │   ├── types/
│   │   ├── config.ts
│   │   └── index.ts
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── .env
├── teams-app/                  # Teams App Package
│   ├── manifest.json
│   ├── color.png               # 192×192 color icon
│   └── outline.png             # 32×32 outline icon
├── Dockerfile                  # mcp-atlassian container
├── docker-compose.yml          # Compose both services
├── pyproject.toml
└── uv.lock
```

---

## Deployment Steps

### 1. Register the Azure Bot

1. Go to [Azure Portal](https://portal.azure.com) → Create a resource → **Azure Bot**
2. Create a **Multi-tenant** bot with a new Microsoft App ID
3. Under **Channels**, enable **Microsoft Teams**
4. Copy `App ID` and `App Password` into `teams-bot/.env`

### 2. Configure the AI backend (Free Tier)

**GitHub Models (recommended — truly free):**
```
AI_ENDPOINT=https://models.inference.ai.azure.com
AI_API_KEY=<your GitHub PAT with models:read scope>
AI_MODEL=gpt-4o-mini
```

**Azure OpenAI (free $200 trial credit):**
```
AI_ENDPOINT=https://<resource>.openai.azure.com/openai/deployments/<deployment>
AI_API_KEY=<Azure OpenAI key>
AI_MODEL=gpt-4o-mini
```

### 3. Generate the encryption key

```bash
openssl rand -hex 16
# Copy output → ENCRYPTION_KEY in teams-bot/.env
```

### 4. Start with Docker Compose

```bash
cp teams-bot/.env.example teams-bot/.env
# Fill in values, then:
docker compose up --build -d
```

### 5. Expose the bot endpoint

The teams-bot listens on port **3978** at `/api/messages`.
For Azure App Service or VM deployment, set the messaging endpoint in Azure Bot to:
```
https://<your-domain>/api/messages
```

For local testing, use [ngrok](https://ngrok.com):
```bash
ngrok http 3978
# Set the HTTPS URL as the messaging endpoint in Azure Bot
```

### 6. Package and sideload the Teams app

1. Add your `App ID` to both `id` and `bots[0].botId` fields in `teams-app/manifest.json`
2. Add PNG icons: `color.png` (192×192) and `outline.png` (32×32)
3. Zip the three files: `manifest.json`, `color.png`, `outline.png`
4. In Teams → Apps → Upload a custom app → upload the zip

---

## Architecture Overview

```
Microsoft Teams (user)
        │
        │ HTTPS / Bot Framework
        ▼
┌───────────────────┐
│   teams-bot       │  Node.js 20 + Express
│   port 3978       │
│                   │
│  ┌─────────────┐  │
│  │ TeamsBot    │  │  ActivityHandler — routes messages
│  └──────┬──────┘  │
│         │         │
│  ┌──────▼──────┐  │
│  │ PATValidator│  │  validate_pat_identity (direct REST)
│  └─────────────┘  │
│                   │
│  ┌─────────────┐  │
│  │CredStore    │  │  AES-256-GCM encrypted, in-memory
│  └─────────────┘  │
│                   │
│  ┌─────────────┐  │
│  │ Orchestrator│  │  OpenAI-compatible API + tool loop
│  └──────┬──────┘  │
└─────────┼─────────┘
          │ HTTP JSON-RPC
          │ BYOT headers
          ▼
┌───────────────────┐
│  mcp-atlassian    │  Python 3.13 + FastMCP
│  port 3000        │  Stateless HTTP mode
│                   │
│  72 MCP tools     │  Jira + Confluence
│  BYOT middleware  │  Per-request credential injection
└─────────┬─────────┘
          │
          ▼
   Atlassian REST APIs
   (Jira + Confluence)
```

---

## Security Notes

- PATs are encrypted with AES-256-GCM using a per-deployment key before in-memory storage
- The encryption key is derived with scrypt to resist brute-force
- Credentials never appear in logs (masked automatically)
- Sessions expire after 8 hours automatically
- BYOT headers are validated by mcp-atlassian's middleware (SSRF protection included)
- For HA deployments: replace `MemoryStorage` with Azure Cosmos DB and `Map` in `credentialStore.ts` with Redis

## Scaling for Production HA

| Component | Current | HA Replacement |
|---|---|---|
| Bot state | `MemoryStorage` | `CosmosDbPartitionedStorage` (`botbuilder-azure`) |
| Credential store | `Map` (in-memory) | Redis with `ioredis` |
| Session TTL | Local `setInterval` | Redis TTL natively |
| mcp-atlassian | Single container | Multiple replicas (stateless HTTP — safe) |
