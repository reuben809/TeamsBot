import {
  ActivityHandler,
  ConversationState,
  UserState,
  TurnContext,
  CardFactory,
  MessageFactory,
  StatePropertyAccessor,
} from 'botbuilder';
import { AuthState, UserSession, ValidationResult } from '../types';
import { validatePatIdentity } from '../auth/patValidator';
import { storeCredentials, getCredentials, clearCredentials } from '../auth/credentialStore';
import { processUserMessage } from '../ai/orchestrator';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Adaptive Card — credential collection form
// ---------------------------------------------------------------------------

const CREDENTIAL_CARD = {
  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
  type: 'AdaptiveCard',
  version: '1.3',
  body: [
    {
      type: 'TextBlock',
      text: '🔐 Connect Your Atlassian Account',
      weight: 'Bolder',
      size: 'Large',
      wrap: true,
      color: 'Accent',
    },
    {
      type: 'TextBlock',
      text: 'Your credentials are encrypted at rest and never appear in logs.',
      wrap: true,
      spacing: 'Small',
      isSubtle: true,
    },
    {
      type: 'TextBlock',
      text: 'Jira (Required)',
      weight: 'Bolder',
      spacing: 'Medium',
    },
    {
      type: 'Input.Text',
      id: 'jiraUrl',
      label: 'Jira URL',
      placeholder: 'https://yourcompany.atlassian.net',
      isRequired: true,
    },
    {
      type: 'Input.Text',
      id: 'jiraPat',
      label: 'Jira Personal Access Token',
      placeholder: 'Your PAT (hidden)',
      isRequired: true,
      style: 'password',
    },
    {
      type: 'TextBlock',
      text: 'Confluence (Optional)',
      weight: 'Bolder',
      spacing: 'Medium',
    },
    {
      type: 'Input.Text',
      id: 'confluenceUrl',
      label: 'Confluence URL',
      placeholder: 'https://yourcompany.atlassian.net (or leave blank)',
    },
    {
      type: 'Input.Text',
      id: 'confluencePat',
      label: 'Confluence Personal Access Token',
      placeholder: 'Leave blank to skip Confluence',
      style: 'password',
    },
  ],
  actions: [
    {
      type: 'Action.Submit',
      title: '🚀 Connect',
      style: 'positive',
      data: { action: 'submit_credentials' },
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSuccess(r: ValidationResult): string {
  const u = r.user!;
  const p = r.permissions!;
  const projects = (r.accessibleProjects ?? []).slice(0, 8).join(', ') || 'None found';
  const spaces = (r.confluenceSpaces ?? []).slice(0, 5).join(', ') || 'N/A';

  const permRow = (label: string, ok: boolean) => `${ok ? '✅' : '❌'} ${label}`;

  return [
    '✅ **Authentication Successful!**',
    '',
    `**Welcome, ${u.displayName}** (${u.email})`,
    '',
    '**Permissions detected:**',
    permRow('Browse Projects', p.browseProjects),
    permRow('Create Issues', p.createIssues),
    permRow('Admin Access', p.admin),
    permRow('Confluence Read', p.confluenceRead),
    permRow('Confluence Write', p.confluenceWrite),
    '',
    `**Accessible Projects:** ${projects}`,
    p.confluenceRead ? `**Confluence Spaces:** ${spaces}` : '',
    '',
    'You can now chat with me in plain English. Try:',
    '• *"Show my open Jira tickets"*',
    '• *"Create a bug for login failure in project ENG"*',
    '• *"Summarize today\'s sprint blockers"*',
    '• *"Search Confluence for onboarding guide"*',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

const HELP_TEXT = `**Available commands:**
• \`/disconnect\` — Clear your credentials and start over
• \`/reconnect\` — Re-enter credentials (useful after token expiry)
• \`/help\` — Show this message

**Or ask me anything in plain English!**
Examples:
• *"Show all open bugs in project ENG"*
• *"Create a story: Implement dark mode"*
• *"What issues are blocking the current sprint?"*
• *"Find the Confluence page about deployment steps"*`;

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export class AtlassianTeamsBot extends ActivityHandler {
  private readonly conversationState: ConversationState;
  private readonly userState: UserState;
  private readonly sessionProp: StatePropertyAccessor<UserSession>;

  constructor(conversationState: ConversationState, userState: UserState) {
    super();
    this.conversationState = conversationState;
    this.userState = userState;
    this.sessionProp = userState.createProperty<UserSession>('atlassianSession');

    // Greet new members
    this.onMembersAdded(async (ctx, next) => {
      for (const member of ctx.activity.membersAdded ?? []) {
        if (member.id !== ctx.activity.recipient.id) {
          await this.sendCredentialCard(ctx);
        }
      }
      await next();
    });

    this.onMessage(async (ctx, next) => {
      await this.dispatch(ctx);
      await next();
    });
  }

  // -------------------------------------------------------------------------
  // Public run override — persists state after every turn
  // -------------------------------------------------------------------------

  override async run(ctx: TurnContext): Promise<void> {
    await super.run(ctx);
    await this.conversationState.saveChanges(ctx, false);
    await this.userState.saveChanges(ctx, false);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async getSession(ctx: TurnContext): Promise<UserSession> {
    let session = await this.sessionProp.get(ctx);
    if (!session) {
      session = { authState: AuthState.UNAUTHENTICATED, history: [] };
      await this.sessionProp.set(ctx, session);
    }

    // Sync in-memory store with session state (handles expiry)
    const userId = ctx.activity.from.id;
    if (session.authState === AuthState.AUTHENTICATED && !getCredentials(userId)) {
      session.authState = AuthState.UNAUTHENTICATED;
      session.validationResult = undefined;
      session.history = [];
      logger.info(`Session expired for user ${userId}`);
    }

    return session;
  }

  private async sendCredentialCard(ctx: TurnContext): Promise<void> {
    const card = CardFactory.adaptiveCard(CREDENTIAL_CARD);
    await ctx.sendActivity(
      MessageFactory.attachment(
        card,
        'Welcome! Please connect your Atlassian account to get started.'
      )
    );
  }

  private async sendTyping(ctx: TurnContext): Promise<void> {
    const typingActivity = MessageFactory.text('');
    typingActivity.type = 'typing';
    await ctx.sendActivity(typingActivity);
  }

  // -------------------------------------------------------------------------
  // Turn dispatcher
  // -------------------------------------------------------------------------

  private async dispatch(ctx: TurnContext): Promise<void> {
    const userId = ctx.activity.from.id;
    const session = await this.getSession(ctx);

    // Adaptive Card submit (credential form)
    const value = ctx.activity.value as Record<string, string> | undefined;
    if (value && ('jiraUrl' in value || 'jiraPat' in value)) {
      await this.handleCredentialSubmit(ctx, session, value, userId);
      return;
    }

    const text = (ctx.activity.text ?? '').trim();
    if (!text) return;

    // Slash commands
    switch (text.toLowerCase()) {
      case '/help':
        await ctx.sendActivity(HELP_TEXT);
        return;

      case '/disconnect':
      case '/logout':
        clearCredentials(userId);
        session.authState = AuthState.UNAUTHENTICATED;
        session.validationResult = undefined;
        session.history = [];
        await this.sessionProp.set(ctx, session);
        await ctx.sendActivity('Your credentials have been cleared. Please reconnect when ready.');
        await this.sendCredentialCard(ctx);
        return;

      case '/reconnect':
      case '/connect':
        session.authState = AuthState.UNAUTHENTICATED;
        await this.sessionProp.set(ctx, session);
        await this.sendCredentialCard(ctx);
        return;
    }

    // If not authenticated, show the card
    if (session.authState !== AuthState.AUTHENTICATED) {
      await ctx.sendActivity(
        'Please connect your Atlassian account first to use the assistant.'
      );
      await this.sendCredentialCard(ctx);
      return;
    }

    // Authenticated — route through AI
    await this.handleChat(ctx, session, text, userId);
  }

  // -------------------------------------------------------------------------
  // Credential submission handler
  // -------------------------------------------------------------------------

  private async handleCredentialSubmit(
    ctx: TurnContext,
    session: UserSession,
    value: Record<string, string>,
    userId: string
  ): Promise<void> {
    const jiraUrl = (value.jiraUrl ?? '').trim().replace(/\/$/, '');
    const jiraPat = (value.jiraPat ?? '').trim();
    const confluenceUrl = (value.confluenceUrl ?? '').trim().replace(/\/$/, '') || undefined;
    const confluencePat = (value.confluencePat ?? '').trim() || undefined;

    if (!jiraUrl || !jiraPat) {
      await ctx.sendActivity('⚠️ Jira URL and Jira PAT are required. Please try again.');
      await this.sendCredentialCard(ctx);
      return;
    }

    // Basic URL sanity check
    if (!jiraUrl.startsWith('http')) {
      await ctx.sendActivity('⚠️ Jira URL must start with https:// — please try again.');
      await this.sendCredentialCard(ctx);
      return;
    }

    session.authState = AuthState.VALIDATING;
    await this.sessionProp.set(ctx, session);
    await this.sendTyping(ctx);
    await ctx.sendActivity('🔍 Validating your credentials…');

    const creds = { jiraUrl, jiraPat, confluenceUrl, confluencePat };

    try {
      const result = await validatePatIdentity(creds);

      if (!result.valid) {
        session.authState = AuthState.UNAUTHENTICATED;
        await this.sessionProp.set(ctx, session);
        await ctx.sendActivity(
          `❌ **Authentication failed**\n\n${result.error ?? 'Unknown error'}\n\nPlease check your credentials and try again.`
        );
        await this.sendCredentialCard(ctx);
        return;
      }

      storeCredentials(userId, creds);
      session.authState = AuthState.AUTHENTICATED;
      session.validationResult = result;
      session.history = [];
      await this.sessionProp.set(ctx, session);
      await ctx.sendActivity(formatSuccess(result));
    } catch (err) {
      logger.error('Error during credential validation', (err as Error).message);
      session.authState = AuthState.UNAUTHENTICATED;
      await this.sessionProp.set(ctx, session);
      await ctx.sendActivity(
        '❌ An unexpected error occurred during validation. Please try again or contact your admin.'
      );
    }
  }

  // -------------------------------------------------------------------------
  // Authenticated chat handler
  // -------------------------------------------------------------------------

  private async handleChat(
    ctx: TurnContext,
    session: UserSession,
    text: string,
    userId: string
  ): Promise<void> {
    const creds = getCredentials(userId);
    if (!creds) {
      session.authState = AuthState.UNAUTHENTICATED;
      session.history = [];
      await this.sessionProp.set(ctx, session);
      await ctx.sendActivity('⏰ Your session has expired. Please reconnect.');
      await this.sendCredentialCard(ctx);
      return;
    }

    await this.sendTyping(ctx);

    try {
      const reply = await processUserMessage(text, session.history, creds);

      // Maintain a rolling 20-exchange history window
      session.history.push({ role: 'user', content: text });
      session.history.push({ role: 'assistant', content: reply });
      if (session.history.length > 40) {
        session.history = session.history.slice(-40);
      }
      await this.sessionProp.set(ctx, session);

      await ctx.sendActivity(reply);
    } catch (err) {
      logger.error('AI orchestrator error', (err as Error).message);
      await ctx.sendActivity(
        '⚠️ I encountered an error processing your request. Please try again.'
      );
    }
  }
}
