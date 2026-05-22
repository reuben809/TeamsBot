import * as dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  MicrosoftAppId: optional('MICROSOFT_APP_ID'),
  MicrosoftAppPassword: optional('MICROSOFT_APP_PASSWORD'),
  PORT: parseInt(optional('PORT', '3978'), 10),
  ENCRYPTION_KEY: required('ENCRYPTION_KEY'),
  AI_ENDPOINT: optional('AI_ENDPOINT', 'https://models.inference.ai.azure.com'),
  AI_API_KEY: required('AI_API_KEY'),
  AI_MODEL: optional('AI_MODEL', 'gpt-4o-mini'),
  MCP_SERVER_URL: optional('MCP_SERVER_URL', 'http://localhost:3000/mcp'),
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),
} as const;
