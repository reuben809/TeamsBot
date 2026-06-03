import axios, { AxiosError } from 'axios';
import { UserCredentials, ValidationResult } from '../types';
import { logger } from '../utils/logger';

interface JiraMyselfResponse {
  accountId: string;
  displayName: string;
  emailAddress: string;
  active: boolean;
}

interface JiraPermissionsResponse {
  permissions: {
    BROWSE_PROJECTS?: { havePermission: boolean };
    CREATE_ISSUES?: { havePermission: boolean };
    ADMINISTER?: { havePermission: boolean };
  };
}

interface JiraProjectsResponse {
  values: Array<{ key: string; name: string }>;
  total: number;
}

interface ConfluenceCurrentUserResponse {
  accountId: string;
  displayName: string;
  email?: string;
}

interface ConfluenceSpacesResponse {
  results: Array<{ key: string; name: string }>;
}

function bearerHeaders(pat: string): Record<string, string> {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function isAxiosError(err: unknown): err is AxiosError {
  return axios.isAxiosError(err);
}

export async function validatePatIdentity(creds: UserCredentials): Promise<ValidationResult> {
  const result: ValidationResult = { valid: false };
  const jiraBase = creds.jiraUrl.replace(/\/$/, '');
  const headers = bearerHeaders(creds.jiraPat);

  // --- Jira validation (required) ---
  try {
    const { data: me } = await axios.get<JiraMyselfResponse>(
      `${jiraBase}/rest/api/3/myself`,
      { headers, timeout: 12_000 }
    );

    result.user = {
      displayName: me.displayName,
      email: me.emailAddress,
      accountId: me.accountId,
    };

    const { data: perms } = await axios.get<JiraPermissionsResponse>(
      `${jiraBase}/rest/api/3/mypermissions?permissions=BROWSE_PROJECTS,CREATE_ISSUES,ADMINISTER`,
      { headers, timeout: 12_000 }
    );

    const p = perms.permissions;
    result.permissions = {
      browseProjects: p.BROWSE_PROJECTS?.havePermission ?? false,
      createIssues: p.CREATE_ISSUES?.havePermission ?? false,
      admin: p.ADMINISTER?.havePermission ?? false,
      confluenceRead: false,
      confluenceWrite: false,
    };

    const { data: projects } = await axios.get<JiraProjectsResponse>(
      `${jiraBase}/rest/api/3/project/search?maxResults=10&orderBy=name`,
      { headers, timeout: 12_000 }
    );

    result.accessibleProjects = projects.values.map((pr) => pr.key);
    result.valid = true;
  } catch (err) {
    if (isAxiosError(err)) {
      const status = err.response?.status;
      if (status === 401) {
        return { valid: false, error: 'Invalid Jira PAT — token rejected (401 Unauthorized). Please generate a fresh token.' };
      }
      if (status === 403) {
        return { valid: false, error: 'Jira PAT is valid but your account lacks required permissions (403 Forbidden).' };
      }
      if (status === 404) {
        return { valid: false, error: `Jira URL not found. Check that "${creds.jiraUrl}" is correct.` };
      }
      logger.error('Jira validation failed', err.message);
      return { valid: false, error: `Cannot reach Jira at "${creds.jiraUrl}": ${err.message}` };
    }
    return { valid: false, error: `Unexpected error during Jira validation: ${String(err)}` };
  }

  // --- Confluence validation (optional) ---
  if (creds.confluenceUrl && creds.confluencePat) {
    // Strip any trailing /wiki so we never produce a double /wiki/wiki/... path.
    // Cloud users sometimes include /wiki in the URL they paste; this normalizes both cases.
    const confBase = creds.confluenceUrl.replace(/\/$/, '').replace(/\/wiki$/, '');
    const confHeaders = bearerHeaders(creds.confluencePat);

    try {
      const { data: me } = await axios.get<ConfluenceCurrentUserResponse>(
        `${confBase}/wiki/rest/api/user/current`,
        { headers: confHeaders, timeout: 12_000 }
      );

      if (me.accountId) {
        result.permissions!.confluenceRead = true;
        result.permissions!.confluenceWrite = true;
      }

      const { data: spaces } = await axios.get<ConfluenceSpacesResponse>(
        `${confBase}/wiki/rest/api/space?limit=5&type=global`,
        { headers: confHeaders, timeout: 12_000 }
      );

      result.confluenceSpaces = spaces.results.map((s) => s.key);
    } catch (err) {
      if (isAxiosError(err) && err.response?.status === 401) {
        logger.warn('Confluence PAT rejected — continuing with Jira-only access');
        result.permissions!.confluenceRead = false;
        result.permissions!.confluenceWrite = false;
      } else {
        logger.warn('Confluence validation failed (non-fatal)', isAxiosError(err) ? err.message : String(err));
      }
    }
  }

  return result;
}
