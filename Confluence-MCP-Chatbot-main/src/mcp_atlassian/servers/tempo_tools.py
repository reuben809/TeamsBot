"""Tempo Timesheets tools for Jira Server/Data Center.

Registers tools that log time directly into Tempo via the internal
``/rest/tempo-timesheets/4/`` API, reusing the authenticated Jira session.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Annotated

from fastmcp import Context, FastMCP
from pydantic import Field

from mcp_atlassian.servers.dependencies import get_jira_fetcher
from mcp_atlassian.utils.decorators import check_write_access

logger = logging.getLogger(__name__)

ISSUE_KEY_PATTERN = r"^[A-Z][A-Z0-9_]+-\d+$"
DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"


def register_tempo_tools(mcp: FastMCP) -> None:
    """Register Tempo tools on the given FastMCP instance."""

    @mcp.tool(
        tags={"jira", "write", "toolset:jira_worklog"},
        annotations={"title": "Log Time in Tempo", "destructiveHint": True},
    )
    @check_write_access
    async def tempo_log_time(
        ctx: Context,
        issue_key: Annotated[
            str,
            Field(
                description="Jira issue key to log against (e.g. 'PROJ-123').",
                pattern=ISSUE_KEY_PATTERN,
            ),
        ],
        time_spent_seconds: Annotated[
            int,
            Field(
                description=(
                    "Time spent in seconds (1h = 3600, 30m = 1800, 1d = 28800)."
                ),
                gt=0,
            ),
        ],
        description: Annotated[
            str,
            Field(description="(Optional) Worklog comment."),
        ] = "",
        start_date: Annotated[
            str | None,
            Field(
                description=(
                    "(Optional) Date the work started in 'YYYY-MM-DD' format. "
                    "Defaults to today."
                ),
                pattern=DATE_PATTERN,
            ),
        ] = None,
    ) -> str:
        """Log time directly into the Tempo Timesheet (Jira Server/Data Center).

        Args:
            ctx: The FastMCP context.
            issue_key: The Jira issue key to log against.
            time_spent_seconds: Time spent, in seconds.
            description: Optional worklog comment.
            start_date: Optional 'YYYY-MM-DD' start date (defaults to today).

        Returns:
            JSON string confirming the logged time and the timesheet URL.

        Raises:
            ValueError: If in read-only mode or the Jira client is unavailable.
        """
        jira = await get_jira_fetcher(ctx)
        effective_date = start_date or datetime.now(tz=timezone.utc).strftime(
            "%Y-%m-%d"
        )

        # Resolve the current user as the Tempo worker. Best-effort: if it
        # cannot be determined, Tempo defaults to the authenticated user.
        try:
            worker = jira.get_current_user_account_id()
        except Exception as e:  # noqa: BLE001 - non-fatal; fall back to default
            logger.debug("Could not resolve Tempo worker, using default: %s", e)
            worker = None

        worklog = jira.add_tempo_worklog(
            issue_key=issue_key,
            time_spent_seconds=time_spent_seconds,
            start_date=effective_date,
            comment=description,
            worker=worker,
        )

        hours = round(time_spent_seconds / 3600, 2)
        base_url = str(jira.config.url).rstrip("/")
        timesheet_url = f"{base_url}/secure/Tempo.jspa#/my-work/timesheet"

        result = {
            "message": f"Successfully logged {hours} hours to {issue_key}.",
            "issue_key": issue_key,
            "time_spent_seconds": time_spent_seconds,
            "date": effective_date,
            "timesheet_url": timesheet_url,
            "worklog": worklog,
        }
        return json.dumps(result, indent=2, ensure_ascii=False)
