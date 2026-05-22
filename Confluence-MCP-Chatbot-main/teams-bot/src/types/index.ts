export enum AuthState {
  UNAUTHENTICATED = 'unauthenticated',
  AWAITING_CREDENTIALS = 'awaiting_credentials',
  VALIDATING = 'validating',
  AUTHENTICATED = 'authenticated',
}

export interface UserCredentials {
  jiraUrl: string;
  jiraPat: string;
  confluenceUrl?: string;
  confluencePat?: string;
}

export interface ValidationResult {
  valid: boolean;
  user?: {
    displayName: string;
    email: string;
    accountId: string;
  };
  permissions?: {
    browseProjects: boolean;
    createIssues: boolean;
    admin: boolean;
    confluenceRead: boolean;
    confluenceWrite: boolean;
  };
  accessibleProjects?: string[];
  confluenceSpaces?: string[];
  error?: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface UserSession {
  authState: AuthState;
  validationResult?: ValidationResult;
  history: ConversationMessage[];
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface MCPCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}
