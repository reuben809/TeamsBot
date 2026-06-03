/**
 * MCP HTTP client for mcp-atlassian running with FASTMCP_STATELESS_HTTP=true.
 *
 * In stateless mode each POST to the /mcp endpoint returns a single SSE frame
 * (data: <json-rpc-response>\n\n) then closes.  We parse that frame directly
 * without maintaining a persistent session.
 *
 * BYOT headers understood by mcp-atlassian's UserTokenMiddleware:
 *   X-Atlassian-Jira-Personal-Token  + X-Atlassian-Jira-Url
 *   X-Atlassian-Confluence-Personal-Token + X-Atlassian-Confluence-Url
 */

import axios, { AxiosError } from 'axios';
import { Agent as HttpAgent, type IncomingMessage } from 'http';
import { Agent as HttpsAgent } from 'https';
import { config } from '../config';
import { UserCredentials, MCPTool, MCPCallResult } from '../types';
import { logger } from '../utils/logger';

// Reuse TCP/TLS connections across the many small POSTs we make to the MCP
// server (initialize + tools/list + tools/call per turn). Without keep-alive
// each call pays a fresh TCP + TLS handshake.
const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 50 });

interface JsonRpcResponse<T = unknown> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

let seq = 0;
const nextId = () => ++seq;

function byotHeaders(creds: UserCredentials): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Atlassian-Jira-Personal-Token': creds.jiraPat,
    'X-Atlassian-Jira-Url': creds.jiraUrl,
  };
  if (creds.confluenceUrl && creds.confluencePat) {
    h['X-Atlassian-Confluence-Personal-Token'] = creds.confluencePat;
    h['X-Atlassian-Confluence-Url'] = creds.confluenceUrl;
  }
  return h;
}

function parseSseOrJson<T>(raw: string): T {
  // Try each line — SSE format is "data: <json>\n\n"
  for (const line of raw.split('\n')) {
    let candidate = line.trim();
    if (candidate.startsWith('data:')) candidate = candidate.slice(5).trim();
    if (!candidate || candidate === '[DONE]') continue;
    if (!candidate.startsWith('{')) continue;

    try {
      const msg = JSON.parse(candidate) as JsonRpcResponse<T>;
      if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
      if (msg.result !== undefined) return msg.result;
    } catch (parseErr) {
      if ((parseErr as Error).message.startsWith('MCP error')) throw parseErr;
      // Not a JSON-RPC envelope — skip
    }
  }
  throw new Error(`No valid JSON-RPC result in MCP response:\n${raw.slice(0, 300)}`);
}

async function rpc<T>(
  creds: UserCredentials,
  method: string,
  params: unknown = {}
): Promise<T> {
  const body = { jsonrpc: '2.0', id: nextId(), method, params };

  try {
    const response = await axios.post<IncomingMessage>(config.MCP_SERVER_URL, body, {
      headers: byotHeaders(creds),
      responseType: 'stream',
      timeout: 45_000,
      httpAgent,
      httpsAgent,
    });

    return await new Promise<T>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = response.data;
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => {
        try {
          resolve(parseSseOrJson<T>(Buffer.concat(chunks).toString('utf-8')));
        } catch (e) {
          reject(e);
        }
      });
    });
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const ae = err as AxiosError;
      const status = ae.response?.status;
      if (status === 401) throw new Error('MCP server rejected credentials (401). Check BYOT headers.');
      throw new Error(`MCP HTTP ${status ?? 'network'}: ${ae.message}`);
    }
    throw err;
  }
}

/** Initialize the MCP session (required by protocol before any other call). */
async function initialize(creds: UserCredentials): Promise<void> {
  await rpc(creds, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'atlassian-teams-bot', version: '1.0.0' },
  });
}

// The server advertises the same toolset to every user (BYOT only changes
// which credentials are used, not which tools exist), so the list is cacheable
// across requests. Key by service-set in case the available tools ever differ
// by whether Confluence creds are present.
interface ToolCacheEntry {
  tools: MCPTool[];
  expiresAt: number;
}
const TOOL_CACHE_TTL_MS = 30 * 60 * 1000;
const toolCache = new Map<string, ToolCacheEntry>();

function toolCacheKey(creds: UserCredentials): string {
  return creds.confluenceUrl && creds.confluencePat ? 'jira+confluence' : 'jira';
}

export async function listMCPTools(creds: UserCredentials): Promise<MCPTool[]> {
  const cacheKey = toolCacheKey(creds);
  const cached = toolCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tools;
  }

  try {
    await initialize(creds);
    const result = await rpc<{ tools: MCPTool[] }>(creds, 'tools/list', {});
    const tools = result.tools ?? [];
    logger.debug(`MCP tools/list returned ${tools.length} tools`);
    if (tools.length > 0) {
      toolCache.set(cacheKey, {
        tools,
        expiresAt: Date.now() + TOOL_CACHE_TTL_MS,
      });
    }
    return tools;
  } catch (err) {
    logger.warn('listMCPTools failed', (err as Error).message);
    return [];
  }
}

export async function callMCPTool(
  creds: UserCredentials,
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<string> {
  await initialize(creds);

  logger.info(`Calling MCP tool: ${toolName}`);
  const result = await rpc<MCPCallResult>(creds, 'tools/call', {
    name: toolName,
    arguments: toolArgs,
  });

  if (result.isError) {
    const errText = result.content.map((c) => c.text ?? '').join('\n');
    throw new Error(`Tool "${toolName}" returned error: ${errText}`);
  }

  return result.content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text!)
    .join('\n');
}
