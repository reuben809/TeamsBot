import OpenAI from 'openai';
import { config } from '../config';
import { UserCredentials, ConversationMessage, MCPTool } from '../types';
import { listMCPTools, callMCPTool } from '../mcp/mcpClient';
import { logger } from '../utils/logger';

const openai = new OpenAI({
  apiKey: config.AI_API_KEY,
  baseURL: config.AI_ENDPOINT,
  defaultHeaders: { 'api-version': '2024-12-01-preview' },
});

const SYSTEM_PROMPT = `You are an expert Atlassian assistant embedded inside Microsoft Teams.
You have direct access to the user's Jira and Confluence accounts via tools.

Your capabilities:
- Search, create, update, and manage Jira issues, sprints, and boards
- Navigate projects, epics, and user stories
- Search and manage Confluence pages, spaces, and comments
- Answer questions about project status, blockers, and team activity

Guidelines:
- Be concise and professional
- Format responses using markdown (bold, bullets, code blocks)
- Always show Jira issue keys (e.g., ENG-123) when referencing issues
- When listing multiple items, use bullet points
- If a request is ambiguous, make a reasonable assumption and proceed
- Today's date: ${new Date().toISOString().split('T')[0]}`;

function mcpToolsToOpenAI(tools: MCPTool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? t.name,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

export async function processUserMessage(
  userMessage: string,
  history: ConversationMessage[],
  creds: UserCredentials
): Promise<string> {
  // Fetch tools per-request so they reflect current auth state
  const mcpTools = await listMCPTools(creds);
  const tools = mcpToolsToOpenAI(mcpTools);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  let response = await openai.chat.completions.create({
    model: config.AI_MODEL,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined,
    max_tokens: 2048,
    temperature: 0.2,
  });

  // Agentic loop — handle sequential tool calls until the model stops
  let iterations = 0;
  while (response.choices[0].finish_reason === 'tool_calls' && iterations < 5) {
    iterations++;
    const assistantMsg = response.choices[0].message;
    messages.push(assistantMsg);

    const toolCalls = assistantMsg.tool_calls ?? [];
    const toolResults: OpenAI.ChatCompletionMessageParam[] = [];

    for (const call of toolCalls) {
      let toolResult: string;
      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        toolResult = await callMCPTool(creds, call.function.name, args);
      } catch (err) {
        toolResult = `Error: ${(err as Error).message}`;
        logger.error(`Tool call failed [${call.function.name}]`, (err as Error).message);
      }

      toolResults.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolResult,
      });
    }

    messages.push(...toolResults);

    response = await openai.chat.completions.create({
      model: config.AI_MODEL,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      max_tokens: 2048,
      temperature: 0.2,
    });
  }

  return response.choices[0].message.content ?? 'Sorry, I could not generate a response.';
}
