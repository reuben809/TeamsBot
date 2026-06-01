"""Module for Jira worklog operations."""

import logging
import re
from typing import Any

from ..models import JiraWorklog
from ..models.jira.adf import adf_to_text
from ..utils import parse_date
from .client import JiraClient

logger = logging.getLogger("mcp-jira")


class WorklogMixin(JiraClient):
    """Mixin for Jira worklog operations."""

    def _parse_time_spent(self, time_spent: str) -> int:
        """
        Parse time spent string into seconds.

        Args:
            time_spent: Time spent string (e.g. 1h 30m, 1d, etc.)

        Returns:
            Time spent in seconds
        """
        # Base case for direct specification in seconds
        if time_spent.endswith("s"):
            try:
                return int(time_spent[:-1])
            except ValueError:
                pass

        total_seconds = 0
        time_units = {
            "w": 7 * 24 * 60 * 60,  # weeks to seconds
            "d": 24 * 60 * 60,  # days to seconds
            "h": 60 * 60,  # hours to seconds
            "m": 60,  # minutes to seconds
        }

        # Regular expression to find time components like 1w, 2d, 3h, 4m.
        # Allow decimals (Jira accepts "1.5h") by capturing digits and dots.
        pattern = r"([\d.]+)([wdhm])"
        matches = re.findall(pattern, time_spent)

        for value, unit in matches:
            # Parse as float to support fractional units, then floor to int
            # seconds. Skip malformed values like "1.5.5" rather than crash.
            try:
                seconds = int(float(value) * time_units[unit])
            except ValueError:
                continue
            total_seconds += seconds

        if total_seconds == 0:
            # If we couldn't parse anything, try using the raw value
            try:
                return int(float(time_spent))  # Convert to float first, then to int
            except ValueError:
                # If all else fails, default to 60 seconds (1 minute)
                logger.warning(
                    f"Could not parse time: {time_spent}, defaulting to 60 seconds"
                )
                return 60

        return total_seconds

    def add_worklog(
        self,
        issue_key: str,
        time_spent: str,
        comment: str | None = None,
        started: str | None = None,
        original_estimate: str | None = None,
        remaining_estimate: str | None = None,
    ) -> dict[str, Any]:
        """
        Add a worklog entry to a Jira issue.

        Args:
            issue_key: The issue key (e.g. 'PROJ-123')
            time_spent: Time spent (e.g. '1h 30m', '3h', '1d')
            comment: Optional comment for the worklog
            started: Optional ISO8601 date time string for when work began
            original_estimate: Optional new value for the original estimate
            remaining_estimate: Optional new value for the remaining estimate

        Returns:
            Response data if successful

        Raises:
            Exception: If there's an error adding the worklog
        """
        try:
            # Convert time_spent string to seconds
            time_spent_seconds = self._parse_time_spent(time_spent)

            # Convert Markdown comment to Jira format if provided
            if comment:
                comment = self._markdown_to_jira(comment)

            # Step 1: Update original estimate if provided (separate API call)
            original_estimate_updated = False
            if original_estimate:
                try:
                    fields = {"timetracking": {"originalEstimate": original_estimate}}
                    self.jira.edit_issue(issue_id_or_key=issue_key, fields=fields)
                    original_estimate_updated = True
                    logger.info(f"Updated original estimate for issue {issue_key}")
                except Exception as e:  # noqa: BLE001 - Intentional fallback with logging
                    logger.error(
                        f"Failed to update original estimate for issue {issue_key}: "
                        f"{str(e)}"
                    )
                    # Continue with worklog creation even if estimate update fails

            # Step 2: Prepare worklog data
            worklog_data: dict[str, Any] = {"timeSpentSeconds": time_spent_seconds}
            if comment:
                worklog_data["comment"] = comment
            if started:
                worklog_data["started"] = started

            # Step 3: Prepare query parameters for remaining estimate
            params = {}
            remaining_estimate_updated = False
            if remaining_estimate:
                params["adjustEstimate"] = "new"
                params["newEstimate"] = remaining_estimate
                remaining_estimate_updated = True

            # Step 4: Add the worklog with remaining estimate adjustment
            if isinstance(worklog_data.get("comment"), dict) and self.config.is_cloud:
                result = self._post_api3(
                    f"issue/{issue_key}/worklog",
                    data=worklog_data,
                    params=params or None,
                )
            else:
                base_url = self.jira.resource_url("issue")
                url = f"{base_url}/{issue_key}/worklog"
                result = self.jira.post(url, data=worklog_data, params=params)
            if not isinstance(result, dict):
                msg = f"Unexpected return value type from `jira.post`: {type(result)}"
                logger.error(msg)
                raise TypeError(msg)

            # Format and return the result
            comment_raw = result.get("comment", "")
            comment_text = (
                adf_to_text(comment_raw)
                if isinstance(comment_raw, dict)
                else comment_raw
            )
            return {
                "id": result.get("id"),
                "comment": self._clean_text(comment_text or ""),
                "created": str(parse_date(result.get("created", ""))),
                "updated": str(parse_date(result.get("updated", ""))),
                "started": str(parse_date(result.get("started", ""))),
                "time_spent": result.get("timeSpent", ""),
                "time_spent_seconds": result.get("timeSpentSeconds", 0),
                "author": result.get("author", {}).get("displayName", "Unknown"),
                "original_estimate_updated": original_estimate_updated,
                "remaining_estimate_updated": remaining_estimate_updated,
            }
        except Exception as e:
            logger.error(f"Error adding worklog to issue {issue_key}: {str(e)}")
            raise Exception(f"Error adding worklog: {str(e)}") from e

    def add_tempo_worklog(
        self,
        issue_key: str,
        time_spent_seconds: int,
        start_date: str,
        comment: str = "",
        worker: str | None = None,
        billable_seconds: int | None = None,
    ) -> dict[str, Any]:
        """Log time directly to Tempo Timesheets on Jira Server/Data Center.

        Uses the internal ``/rest/tempo-timesheets/4/worklogs`` endpoint via the
        already-authenticated Jira session, so no separate Tempo token is needed.

        Args:
            issue_key: The issue key to log against (e.g. 'PROJ-123').
            time_spent_seconds: Time spent in seconds.
            start_date: Date the work started, formatted as 'YYYY-MM-DD'.
            comment: Optional worklog comment (plain text).
            worker: Optional Tempo worker key. When omitted, Tempo attributes
                the worklog to the authenticated user.
            billable_seconds: Optional billable seconds; defaults to time_spent.

        Returns:
            The created Tempo worklog as returned by the API.

        Raises:
            Exception: If the Tempo worklog cannot be created.
        """
        try:
            payload: dict[str, Any] = {
                "originTaskId": issue_key,
                "issue": {"key": issue_key},
                "timeSpentSeconds": time_spent_seconds,
                "billableSeconds": (
                    billable_seconds
                    if billable_seconds is not None
                    else time_spent_seconds
                ),
                "started": start_date,
                "dateStarted": start_date,
                "comment": comment,
            }
            # Tempo's worker defaults to the authenticated user when omitted;
            # callers that know the worker key (e.g. logging on behalf of
            # another user) can pass it explicitly.
            if worker is not None:
                payload["worker"] = worker

            base_url = str(self.config.url).rstrip("/")
            url = f"{base_url}/rest/tempo-timesheets/4/worklogs"

            # self.jira._session carries the configured auth (PAT/OAuth/basic),
            # SSL settings, and proxies.
            response = self.jira._session.post(
                url, json=payload, timeout=self.config.timeout
            )
            response.raise_for_status()

            result = response.json()
            # Tempo may return a single object or a list of created worklogs.
            if isinstance(result, list):
                return result[0] if result else {}
            if isinstance(result, dict):
                return result
            return {"raw": result}
        except Exception as e:
            logger.error(f"Error adding Tempo worklog to {issue_key}: {str(e)}")
            raise Exception(f"Failed to log time in Tempo: {str(e)}") from e

    def get_worklog(self, issue_key: str) -> dict[str, Any]:
        """
        Get the worklog data for an issue.

        Args:
            issue_key: The issue key (e.g. 'PROJ-123')

        Returns:
            Raw worklog data from the API
        """
        try:
            return self.jira.worklog(issue_key)  # type: ignore[attr-defined]
        except Exception as e:
            logger.warning(f"Error getting worklog for {issue_key}: {e}")
            return {"worklogs": []}

    def get_worklog_models(self, issue_key: str) -> list[JiraWorklog]:
        """
        Get all worklog entries for an issue as JiraWorklog models.

        Args:
            issue_key: The issue key (e.g. 'PROJ-123')

        Returns:
            List of JiraWorklog models
        """
        worklog_data = self.get_worklog(issue_key)
        result: list[JiraWorklog] = []

        if "worklogs" in worklog_data and worklog_data["worklogs"]:
            for log_data in worklog_data["worklogs"]:
                worklog = JiraWorklog.from_api_response(log_data)
                result.append(worklog)

        return result

    def get_worklogs(self, issue_key: str) -> list[dict[str, Any]]:
        """
        Get all worklog entries for an issue.

        Args:
            issue_key: The issue key (e.g. 'PROJ-123')

        Returns:
            List of worklog entries

        Raises:
            Exception: If there's an error getting the worklogs
        """
        try:
            result = self.jira.issue_get_worklog(issue_key)
            if not isinstance(result, dict):
                msg = f"Unexpected return value type from `jira.issue_get_worklog`: {type(result)}"
                logger.error(msg)
                raise TypeError(msg)

            # Process the worklogs
            worklogs = []
            for worklog in result.get("worklogs", []):
                worklogs.append(
                    {
                        "id": worklog.get("id"),
                        "comment": self._clean_text(worklog.get("comment", "")),
                        "created": str(parse_date(worklog.get("created", ""))),
                        "updated": str(parse_date(worklog.get("updated", ""))),
                        "started": str(parse_date(worklog.get("started", ""))),
                        "time_spent": worklog.get("timeSpent", ""),
                        "time_spent_seconds": worklog.get("timeSpentSeconds", 0),
                        "author": worklog.get("author", {}).get(
                            "displayName", "Unknown"
                        ),
                    }
                )

            return worklogs
        except Exception as e:
            logger.error(f"Error getting worklogs for issue {issue_key}: {str(e)}")
            raise Exception(f"Error getting worklogs: {str(e)}") from e
