"""Startup credential validation for local (stdio) transport.

GitHub Copilot and other desktop clients launch the server over ``stdio``,
which bypasses the HTTP ``UserTokenMiddleware``.  In that mode credentials come
from environment variables.  This module performs a best-effort identity check
at startup so misconfigured tokens surface immediately in the logs rather than
on the first tool call.

The check reuses :class:`JiraConfig` / :class:`JiraFetcher` so it honours the
configured auth type, SSL settings, and proxies — no raw requests, no
duplicated auth logic.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("mcp-atlassian.servers.startup_validator")


def validate_jira_stdio_credentials() -> dict[str, Any] | None:
    """Validate env-var Jira credentials for stdio transport.

    Returns:
        ``None`` if Jira is not configured (nothing to validate).
        Otherwise a dict ``{"valid": bool, ...}``: on success it includes a
        ``"user"`` dict; on failure an ``"error"`` string.
    """
    # Imported lazily to avoid import-time side effects and circular imports.
    from mcp_atlassian.jira import JiraConfig, JiraFetcher

    try:
        config = JiraConfig.from_env()
    except Exception as e:  # noqa: BLE001 - startup diagnostics only
        logger.debug("Jira not configured for stdio validation: %s", e)
        return None

    if not config.url or not config.is_auth_configured():
        return None

    try:
        fetcher = JiraFetcher(config=config)
        myself = fetcher.jira.myself()
        if not isinstance(myself, dict):
            return {"valid": False, "error": "Unexpected response from Jira myself()"}
        user = {
            "displayName": myself.get("displayName"),
            "email": myself.get("emailAddress"),
            "key": myself.get("key") or myself.get("accountId") or myself.get("name"),
        }
        return {"valid": True, "user": user}
    except Exception as e:  # noqa: BLE001 - startup diagnostics only
        logger.warning("Jira PAT validation at startup failed: %s", e)
        return {"valid": False, "error": str(e)}


def log_stdio_startup_validation() -> None:
    """Run the Jira credential check and log a friendly summary.

    Safe to call unconditionally; it is a no-op when Jira is not configured.
    """
    result = validate_jira_stdio_credentials()
    if result is None:
        return
    if result.get("valid"):
        user = result.get("user", {})
        logger.info(
            "[stdio] Authenticated to Jira as: %s (%s)",
            user.get("displayName") or "unknown",
            user.get("email") or user.get("key") or "no-email",
        )
    else:
        logger.warning(
            "[stdio] Jira credential validation failed: %s",
            result.get("error", "unknown error"),
        )
