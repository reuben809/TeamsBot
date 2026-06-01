"""Role-based context loading for AI clients that read tool descriptions.

Some MCP clients (notably GitHub Copilot) do not surface ``@mcp.prompt()``
prompts to the model.  To make behavioural guidance available to those
clients we load a role-specific Markdown file and inject it into the
descriptions of the workflow-relevant tools when they are listed.

Configuration (environment variables):

* ``MCP_USER_ROLE``        Role name; selects ``contexts/<role>.md``
                            (default: ``default``).
* ``MCP_CONTEXTS_DIR``     Override the directory holding the context files
                            (default: ``<repo-root>/contexts``).
* ``MCP_CONTEXT_INJECT_TOOLSETS``
                            Comma-separated toolset names whose tools receive
                            the injected context (default:
                            ``jira_issues,jira_worklog``).
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger("mcp-atlassian.servers.context_loader")

DEFAULT_INJECT_TOOLSETS = {"jira_issues", "jira_worklog"}
MAX_CONTEXT_CHARS = 1500


def _contexts_dir() -> Path:
    """Resolve the directory containing role context Markdown files."""
    override = os.getenv("MCP_CONTEXTS_DIR")
    if override:
        return Path(override).expanduser()
    # context_loader.py -> servers -> mcp_atlassian -> src -> <repo root>
    return Path(__file__).resolve().parents[3] / "contexts"


@lru_cache(maxsize=8)
def load_role_context(role: str | None = None) -> str:
    """Load the context Markdown for the active role.

    Args:
        role: Explicit role name. When ``None`` the ``MCP_USER_ROLE`` env var
            is used, falling back to ``"default"``.

    Returns:
        The context text, or an empty string if no context file is found.
    """
    resolved_role = (role or os.getenv("MCP_USER_ROLE", "default")).lower()
    resolved_role = resolved_role.strip().replace(" ", "-")
    base = _contexts_dir()

    ctx_file = base / f"{resolved_role}.md"
    if not ctx_file.exists():
        if resolved_role != "default":
            logger.info(
                "Role context '%s' not found in %s; falling back to default.",
                resolved_role,
                base,
            )
        ctx_file = base / "default.md"

    if not ctx_file.exists():
        logger.debug("No context file found in %s.", base)
        return ""

    try:
        return ctx_file.read_text(encoding="utf-8").strip()
    except OSError as e:
        logger.warning("Failed to read context file %s: %s", ctx_file, e)
        return ""


def get_inject_toolsets() -> set[str]:
    """Return the set of toolset names whose tools receive injected context."""
    raw = os.getenv("MCP_CONTEXT_INJECT_TOOLSETS")
    if raw is None:
        return set(DEFAULT_INJECT_TOOLSETS)
    names = {token.strip() for token in raw.split(",") if token.strip()}
    return names


def inject_context_into_description(
    base_description: str | None,
    context: str,
    max_chars: int = MAX_CONTEXT_CHARS,
) -> str:
    """Append role context to a tool description.

    Args:
        base_description: The tool's existing description (may be ``None``).
        context: The role context text to append.
        max_chars: Maximum number of context characters to include.

    Returns:
        The combined description. If ``context`` is empty the base description
        is returned unchanged.
    """
    base = base_description or ""
    if not context:
        return base
    truncated = context[:max_chars]
    return f"{base}\n\n---\nBEHAVIORAL CONTEXT:\n{truncated}\n---"
