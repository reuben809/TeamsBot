"""Diagnostic tools for verifying authentication and surfacing role context.

These tools let an AI client (e.g. GitHub Copilot over stdio) confirm *who* it
is authenticated as and *what* it is allowed to do before running sensitive
workflows, and to read the active behavioural context on demand.
"""

import json
import logging
from typing import Annotated

from fastmcp import Context, FastMCP
from pydantic import Field

from mcp_atlassian.servers.context_loader import load_role_context
from mcp_atlassian.servers.dependencies import get_jira_fetcher

logger = logging.getLogger(__name__)


def register_pat_tools(mcp: FastMCP) -> None:
    """Register identity/permission/context diagnostic tools on ``mcp``."""

    @mcp.tool(
        tags={"jira", "read", "toolset:jira_users"},
        annotations={"title": "Validate Identity", "readOnlyHint": True},
    )
    async def pat_validate_identity(
        ctx: Context,
        include_permissions: Annotated[
            bool,
            Field(
                description=(
                    "(Optional) When true, also include the user's permission "
                    "matrix in the response."
                ),
            ),
        ] = False,
    ) -> str:
        """Validate the configured Jira credentials and return the current user.

        Call this before sensitive operations to confirm the identity the server
        is authenticated as.

        Returns:
            JSON string with ``valid`` and, on success, a ``user`` object
            (and ``permissions`` when ``include_permissions`` is true).
        """
        try:
            jira = await get_jira_fetcher(ctx)
            details = jira.get_current_user_details()
        except Exception as e:  # noqa: BLE001 - surface as structured result
            return json.dumps({"valid": False, "error": str(e)}, ensure_ascii=False)

        user = {
            "displayName": details.get("displayName"),
            "email": details.get("emailAddress"),
            "key": details.get("key")
            or details.get("accountId")
            or details.get("name"),
        }
        result: dict = {"valid": True, "user": user}
        if include_permissions:
            try:
                result["permissions"] = jira.get_current_user_permissions()
            except Exception as e:  # noqa: BLE001 - non-fatal extra info
                result["permissions_error"] = str(e)
        return json.dumps(result, indent=2, ensure_ascii=False)

    @mcp.tool(
        tags={"jira", "read", "toolset:jira_users"},
        annotations={"title": "Validate Permissions", "readOnlyHint": True},
    )
    async def pat_validate_permissions(
        ctx: Context,
        project_key: Annotated[
            str | None,
            Field(
                description=(
                    "(Optional) Project key to scope the permission check "
                    "(e.g. 'PROJ')."
                ),
            ),
        ] = None,
    ) -> str:
        """Return the current user's Jira permission matrix.

        Useful to check whether the user holds permissions such as
        ``CREATE_ISSUES`` or ``WORK_ON_ISSUES`` before attempting a workflow.

        Returns:
            JSON string with ``valid`` and, on success, a ``permissions`` map.
        """
        try:
            jira = await get_jira_fetcher(ctx)
            permissions = jira.get_current_user_permissions(project_key=project_key)
        except Exception as e:  # noqa: BLE001 - surface as structured result
            return json.dumps({"valid": False, "error": str(e)}, ensure_ascii=False)

        return json.dumps(
            {"valid": True, "permissions": permissions},
            indent=2,
            ensure_ascii=False,
        )

    @mcp.tool(
        tags={"jira", "read", "toolset:jira_users"},
        annotations={"title": "Get Active Context", "readOnlyHint": True},
    )
    async def get_active_context(
        ctx: Context,
        role: Annotated[
            str | None,
            Field(
                description=(
                    "(Optional) Role name to load (e.g. 'developer'). "
                    "Defaults to the server's configured MCP_USER_ROLE."
                ),
            ),
        ] = None,
    ) -> str:
        """Return the role-based behavioural context (instructions).

        Mirrors the ``MCP_USER_ROLE`` configured for the server so a client can
        recite or follow the active workflow guidance.

        Returns:
            The role context Markdown, or a note if none is configured.
        """
        context = load_role_context(role)
        if not context:
            return "No role context is configured for this server."
        return context
