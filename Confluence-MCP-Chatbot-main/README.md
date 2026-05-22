# Atlassian Teams Bot

An AI-powered Microsoft Teams chatbot that connects to your Jira and Confluence accounts using Personal Access Tokens (PATs). Users open the bot in Teams, paste their PAT, and immediately start chatting with Jira and Confluence in plain English — no installation, no setup on their side.

---

## Table of Contents

- [Org-wide Deployment](#org-wide-deployment-everyone-uses-it-with-zero-install) ← **Start here for production**
- [Local Development](#local-development)
- [Using the Bot](#using-the-bot)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Environment Variables](#environment-variables)

---

## Org-wide Deployment (everyone uses it with zero install)

Deploy once → publish to Teams → your entire org can use it immediately. No one installs anything.

### What you need

| Requirement | Notes |
|---|---|
| Azure subscription | Free account works — [azure.com/free](https://azure.com/free) |
| Azure CLI | `winget install Microsoft.AzureCLI` |
| Docker Desktop | Running locally for the initial build |
| GitHub PAT | For the free AI model tier (GitHub Models) |

### Step 1 — Generate your secrets

```powershell
# Encryption key (run once, save the output)
-join ((1..16) | ForEach-Object { '{0:x}' -f (Get-Random 16) })
```

### Step 2 — Run the deployment script

```powershell
az login   # log in to Azure first

.\deploy\azure-deploy.ps1 `
    -ResourceGroup  "atlassian-bot-rg" `
    -Location       "eastus" `
    -RegistryName   "mycompanybotacr" `
    -EncryptionKey  "paste-the-key-from-step-1" `
    -AiApiKey       "your-github-pat"
```

The script builds both Docker images, pushes them to Azure Container Registry, and deploys them to **Azure Container Apps**. At the end it prints your public HTTPS URL — something like:

```
Bot public URL:      https://teams-bot.nicename-abc123.eastus.azurecontainerapps.io
Messaging endpoint:  https://teams-bot.nicename-abc123.eastus.azurecontainerapps.io/api/messages
```

### Step 3 — Register an Azure Bot (one-time)

1. [Azure Portal](https://portal.azure.com) → **Create a resource** → search **Azure Bot**
2. Bot handle: anything (e.g. `atlassian-teams-bot`)
3. App type: **Multi-tenant**
4. Create a new **Microsoft App ID** (auto-generated)
5. Under **Configuration** → set Messaging endpoint to the `/api/messages` URL from Step 2
6. Under **Channels** → enable **Microsoft Teams**
7. Copy the **App ID** and generate an **App Password** (Client secret)

### Step 4 — Wire the bot credentials back in

```powershell
.\deploy\update-secrets.ps1 `
    -MsAppId       "your-azure-bot-app-id" `
    -MsAppPassword "your-azure-bot-app-password"
```

### Step 5 — Publish the Teams app to your org

```powershell
# Patch the manifest with your App ID and create the zip
.\deploy\package-teams-app.ps1 -AppId "your-azure-bot-app-id"
# Creates atlassian-teams-bot.zip in the current directory
```

Then upload to your org:
1. Go to [Teams Admin Center](https://admin.teams.microsoft.com)
2. **Apps** → **Manage apps** → **Upload new app**
3. Upload `atlassian-teams-bot.zip`

### Step 6 (Optional) — Auto-install for all users

To pin the bot in everyone's Teams sidebar automatically without them having to search for it:

1. Teams Admin Center → **Setup policies** → **Global (Org-wide default)**
2. Under **Installed apps** → **Add apps** → search for your bot → **Add**
3. Under **Pinned apps** → **Add apps** → add it there too
4. **Save**

Within a few hours all users in your org will see the bot pinned in their Teams sidebar. They open it, paste their Jira PAT, and they're ready.

### Estimated cost

| Resource | Tier | Monthly cost |
|---|---|---|
| Azure Container Apps (2 containers) | Consumption | ~$0–5 (scales to zero on idle) |
| Azure Container Registry | Basic | ~$5 |
| Azure Bot Service | F0 (free) | $0 |
| AI (GitHub Models) | Free tier | $0 |
| **Total** | | **~$5–10/month** |

---

## Local Development

### Prerequisites

| Tool | Version |
|---|---|
| Python | ≥ 3.10 |
| uv | latest (`pip install uv`) |
| Node.js | ≥ 20 |
| ngrok | any |

### Step 1 — Install dependencies

```bash
git clone https://github.com/shivshankarsingh19/Confluence-MCP-Chatbot.git
cd Confluence-MCP-Chatbot

uv sync --frozen          # Python (mcp-atlassian)
cd teams-bot
npm install               # Node.js (Teams bot)
cd ..
```

### Step 2 — Configure

```bash
cp teams-bot/.env.example teams-bot/.env
```

Minimum values needed for local dev:

```env
ENCRYPTION_KEY=any-32-char-string-for-local-dev
AI_API_KEY=your-github-pat
MCP_SERVER_URL=http://localhost:3000/mcp
```

Leave `MICROSOFT_APP_ID` and `MICROSOFT_APP_PASSWORD` blank to use the **Bot Framework Emulator** for testing, or fill them in once you have an Azure Bot registration.

### Step 3 — Run both services

**Terminal 1:**
```bash
uv run mcp-atlassian --transport streamable-http --port 3000
```

**Terminal 2:**
```bash
cd teams-bot
npm run dev
```

Bot is live at `http://localhost:3978`.

### Step 4 — Test in Teams (requires ngrok)

```bash
ngrok http 3978
# Copy the https URL → Azure Bot Configuration → Messaging endpoint
```

### Running with Docker instead

```bash
cp teams-bot/.env.example teams-bot/.env  # fill in values
docker compose up --build
```

---

## Using the Bot

### First-time (per user)

The bot greets every new user with a form:

1. **Jira URL** — e.g. `https://yourcompany.atlassian.net`
2. **Jira PAT** — your Personal Access Token
3. **Confluence URL** — optional, same domain as Jira usually
4. **Confluence PAT** — optional

**Generating a PAT:**
- Jira/Confluence Cloud: Profile → Security → **Create and manage API tokens**
- Jira/Confluence Server/DC: Profile → **Personal Access Tokens**

After submitting, the bot validates the token, shows your detected permissions and accessible projects, and you're ready.

### Commands

| Command | What it does |
|---|---|
| `/help` | Show available commands |
| `/reconnect` | Re-enter credentials (e.g. after token expiry) |
| `/disconnect` | Clear your session |

### Example queries

```
Show my open Jira tickets
Create a bug: payment gateway fails on checkout in project ENG
What's blocking the current sprint?
Assign ENG-412 to me and move it to In Progress
Search Confluence for our onboarding guide
Summarize everything that changed in project OPS this week
List all high-priority bugs across all projects
Create a Confluence page: "Q3 Release Notes"
```

---

## Architecture

```
Your Org (Microsoft Teams)
         │
         │  HTTPS · Bot Framework
         ▼
┌────────────────────────────────┐
│         teams-bot              │  Node.js 20 · Express · port 3978
│                                │
│  TeamsBot   ActivityHandler    │  Auth state machine + Adaptive Cards
│  PATValidator                  │  Direct Jira/Confluence REST validation
│  CredentialStore               │  AES-256-GCM encrypted, 8h TTL per user
│  AIOrchestrator                │  OpenAI-compatible, agentic tool loop
│  MCPClient                     │  JSON-RPC/SSE with per-request BYOT headers
└──────────────┬─────────────────┘
               │  HTTP (internal) · BYOT headers
               ▼
┌────────────────────────────────┐
│       mcp-atlassian            │  Python 3.10+ · FastMCP · port 3000
│       stateless HTTP mode      │
│                                │
│  72 MCP tools                  │  Jira + Confluence (Cloud + Server/DC)
│  UserTokenMiddleware           │  Reads BYOT headers per request
└──────────────┬─────────────────┘
               │
               ▼
      Atlassian REST APIs
```

**Key design — one server, many users:**
Each request carries the user's own credentials as HTTP headers. The MCP server never stores credentials — it reads them per request and calls Atlassian on behalf of that user. One deployed instance safely serves your entire org simultaneously.

---

## Project Structure

```
Confluence-MCP-Chatbot/
│
├── src/mcp_atlassian/           # Atlassian MCP server (Python)
│   ├── jira/                    # 21 Jira tool mixins
│   ├── confluence/              # 8 Confluence tool mixins
│   ├── models/                  # Pydantic v2 data models
│   ├── servers/                 # FastMCP + BYOT middleware
│   ├── preprocessing/           # ADF/Storage → Markdown
│   └── utils/                   # Auth, SSL, logging
│
├── teams-bot/                   # Teams bot (Node.js / TypeScript)
│   └── src/
│       ├── bot/teamsBot.ts      # ActivityHandler + auth state machine
│       ├── auth/
│       │   ├── patValidator.ts  # validate_pat_identity (Jira + Confluence REST)
│       │   └── credentialStore.ts   # AES-256-GCM encrypted per-user sessions
│       ├── ai/orchestrator.ts   # AI + agentic tool-calling loop
│       ├── mcp/mcpClient.ts     # JSON-RPC/SSE MCP client (BYOT)
│       ├── utils/               # AES encryption, safe logger
│       ├── types/               # TypeScript interfaces
│       └── index.ts             # Express entry point
│
├── teams-app/
│   └── manifest.json            # Teams App Package manifest
│
├── deploy/
│   ├── azure-deploy.ps1         # One-shot Azure deployment script
│   ├── update-secrets.ps1       # Update bot credentials post-deploy
│   └── package-teams-app.ps1   # Create Teams app zip for Admin Center
│
├── docker-compose.yml           # Local / self-hosted compose stack
├── PRODUCTION.md                # Cleanup guide + HA scaling notes
├── Dockerfile                   # mcp-atlassian container
└── pyproject.toml               # Python project (uv managed)
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MICROSOFT_APP_ID` | Prod only | — | Azure Bot App ID |
| `MICROSOFT_APP_PASSWORD` | Prod only | — | Azure Bot App Password |
| `ENCRYPTION_KEY` | Yes | — | 32-char key for AES-256-GCM session encryption |
| `AI_API_KEY` | Yes | — | API key for AI backend |
| `AI_ENDPOINT` | No | GitHub Models | OpenAI-compatible API base URL |
| `AI_MODEL` | No | `gpt-4o-mini` | Model name |
| `MCP_SERVER_URL` | No | `http://localhost:3000/mcp` | mcp-atlassian endpoint |
| `PORT` | No | `3978` | Teams bot port |

### AI backend options (all free tier)

| Provider | `AI_ENDPOINT` | Cost |
|---|---|---|
| **GitHub Models** | `https://models.inference.ai.azure.com` | Free |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<dep>` | Free trial |
| Azure AI Foundry | `https://<endpoint>.services.ai.azure.com/models` | Free serverless |

---

## Production / Scaling Notes

See [PRODUCTION.md](PRODUCTION.md) for:
- Which development files to remove before deploying
- Replacing in-memory state with Azure Cosmos DB + Redis for HA
- Security hardening checklist
