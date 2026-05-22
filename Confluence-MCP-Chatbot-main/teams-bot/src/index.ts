import express from 'express';
import { BotFrameworkAdapter, MemoryStorage, ConversationState, UserState } from 'botbuilder';
import { AtlassianTeamsBot } from './bot/teamsBot';
import { config } from './config';
import { logger } from './utils/logger';

// ---------------------------------------------------------------------------
// Bot Framework adapter
// ---------------------------------------------------------------------------

const adapter = new BotFrameworkAdapter({
  appId: config.MicrosoftAppId || undefined,
  appPassword: config.MicrosoftAppPassword || undefined,
});

adapter.onTurnError = async (context, error) => {
  logger.error('Unhandled bot turn error', (error as Error).message);
  try {
    await context.sendActivity('An unexpected error occurred. Please try again.');
  } catch {
    // Ignore send failures during error handling
  }
};

// ---------------------------------------------------------------------------
// State storage — swap MemoryStorage for CosmosDB/Redis in production
// ---------------------------------------------------------------------------

const storage = new MemoryStorage();
const conversationState = new ConversationState(storage);
const userState = new UserState(storage);

const bot = new AtlassianTeamsBot(conversationState, userState);

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Teams sends activities here
app.post('/api/messages', async (req, res) => {
  await adapter.processActivity(req, res, async (context) => {
    await bot.run(context);
  });
});

// Health probe — used by docker-compose and Azure App Service
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(config.PORT, () => {
  logger.info(`Atlassian Teams Bot listening on port ${config.PORT}`);
  logger.info(`MCP server URL: ${config.MCP_SERVER_URL}`);
  logger.info(`AI model: ${config.AI_MODEL} @ ${config.AI_ENDPOINT}`);
});
