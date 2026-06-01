"""Tests for role-based context loading and injection."""

import importlib

import pytest

from mcp_atlassian.servers import context_loader


@pytest.fixture(autouse=True)
def _clear_caches(monkeypatch):
    """Ensure each test starts with a clean lru_cache and env."""
    for var in ("MCP_USER_ROLE", "MCP_CONTEXTS_DIR", "MCP_CONTEXT_INJECT_TOOLSETS"):
        monkeypatch.delenv(var, raising=False)
    context_loader.load_role_context.cache_clear()
    yield
    context_loader.load_role_context.cache_clear()


def _write_contexts(tmp_path):
    (tmp_path / "default.md").write_text("# Default\nbase rules", encoding="utf-8")
    (tmp_path / "developer.md").write_text("# Developer\ndev rules", encoding="utf-8")
    return tmp_path


def test_load_role_context_reads_named_role(tmp_path, monkeypatch):
    _write_contexts(tmp_path)
    monkeypatch.setenv("MCP_CONTEXTS_DIR", str(tmp_path))
    monkeypatch.setenv("MCP_USER_ROLE", "developer")
    assert context_loader.load_role_context().splitlines()[0] == "# Developer"


def test_load_role_context_falls_back_to_default(tmp_path, monkeypatch):
    _write_contexts(tmp_path)
    monkeypatch.setenv("MCP_CONTEXTS_DIR", str(tmp_path))
    assert context_loader.load_role_context("ghost").splitlines()[0] == "# Default"


def test_load_role_context_empty_when_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("MCP_CONTEXTS_DIR", str(tmp_path))  # empty dir
    assert context_loader.load_role_context("anything") == ""


def test_role_name_normalised(tmp_path, monkeypatch):
    (tmp_path / "scrum-master.md").write_text("# SM", encoding="utf-8")
    (tmp_path / "default.md").write_text("# Default", encoding="utf-8")
    monkeypatch.setenv("MCP_CONTEXTS_DIR", str(tmp_path))
    assert context_loader.load_role_context("Scrum Master").splitlines()[0] == "# SM"


def test_get_inject_toolsets_default():
    assert context_loader.get_inject_toolsets() == {"jira_issues", "jira_worklog"}


def test_get_inject_toolsets_override(monkeypatch):
    monkeypatch.setenv("MCP_CONTEXT_INJECT_TOOLSETS", "jira_issues, , foo")
    assert context_loader.get_inject_toolsets() == {"jira_issues", "foo"}


def test_get_inject_toolsets_empty_string(monkeypatch):
    monkeypatch.setenv("MCP_CONTEXT_INJECT_TOOLSETS", "")
    assert context_loader.get_inject_toolsets() == set()


def test_inject_context_appends_block():
    out = context_loader.inject_context_into_description("Base.", "RULES")
    assert out.startswith("Base.")
    assert "BEHAVIORAL CONTEXT:" in out
    assert "RULES" in out


def test_inject_context_truncates():
    out = context_loader.inject_context_into_description("Base.", "abcdef", max_chars=3)
    assert "abc" in out
    assert "abcd" not in out


def test_inject_context_empty_context_passthrough():
    assert context_loader.inject_context_into_description("Base.", "") == "Base."


def test_inject_context_handles_none_description():
    out = context_loader.inject_context_into_description(None, "RULES")
    assert out.startswith("\n\n---")
    assert "RULES" in out


def test_module_importable():
    """Smoke check that the module imports cleanly."""
    importlib.reload(context_loader)
