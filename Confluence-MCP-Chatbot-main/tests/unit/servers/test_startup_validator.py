"""Tests for startup credential validation."""

from unittest.mock import MagicMock, patch

import pytest
from requests.exceptions import HTTPError
from requests.models import Response

from mcp_atlassian.servers.startup_validator import (
    log_stdio_startup_validation,
    validate_jira_stdio_credentials,
)


def test_validate_jira_stdio_credentials_not_configured():
    """Verify that None is returned when Jira is not configured."""
    with patch("mcp_atlassian.jira.JiraConfig.from_env") as mock_from_env:
        # Simulate not configured URL/auth
        mock_config = MagicMock()
        mock_config.url = None
        mock_config.is_auth_configured.return_value = False
        mock_from_env.return_value = mock_config

        result = validate_jira_stdio_credentials()
        assert result is None


def test_validate_jira_stdio_credentials_config_error():
    """Verify that None is returned if JiraConfig.from_env raises an exception."""
    with patch("mcp_atlassian.jira.JiraConfig.from_env", side_effect=ValueError("missing env")):
        result = validate_jira_stdio_credentials()
        assert result is None


def test_validate_jira_stdio_credentials_success():
    """Verify that credentials check returns valid state on success."""
    with patch("mcp_atlassian.jira.JiraConfig.from_env") as mock_from_env, \
         patch("mcp_atlassian.jira.JiraFetcher") as mock_fetcher_cls:

        mock_config = MagicMock()
        mock_config.url = "https://jira.example.com"
        mock_config.is_auth_configured.return_value = True
        mock_from_env.return_value = mock_config

        mock_fetcher = MagicMock()
        mock_fetcher.jira.myself.return_value = {
            "displayName": "Jane Doe",
            "emailAddress": "jane@example.com",
            "key": "jane_key",
        }
        mock_fetcher_cls.return_value = mock_fetcher

        result = validate_jira_stdio_credentials()
        assert result == {
            "valid": True,
            "user": {
                "displayName": "Jane Doe",
                "email": "jane@example.com",
                "key": "jane_key",
            },
        }


def test_validate_jira_stdio_credentials_http_error():
    """Verify HTTPError is caught and details are extracted."""
    response = Response()
    response.status_code = 401
    response.reason = "Unauthorized"
    response._content = b'{"message": "Invalid token"}'

    http_error = HTTPError("Unauthorized error", response=response)

    with patch("mcp_atlassian.jira.JiraConfig.from_env") as mock_from_env, \
         patch("mcp_atlassian.jira.JiraFetcher") as mock_fetcher_cls:

        mock_config = MagicMock()
        mock_config.url = "https://jira.example.com"
        mock_config.is_auth_configured.return_value = True
        mock_from_env.return_value = mock_config

        mock_fetcher = MagicMock()
        mock_fetcher.jira.myself.side_effect = http_error
        mock_fetcher_cls.return_value = mock_fetcher

        result = validate_jira_stdio_credentials()
        assert result is not None
        assert result["valid"] is False
        assert "HTTP 401" in result["error"]
        assert '{"message": "Invalid token"}' in result["error"]


def test_validate_jira_stdio_credentials_generic_exception():
    """Verify generic exception fallback."""
    with patch("mcp_atlassian.jira.JiraConfig.from_env") as mock_from_env, \
         patch("mcp_atlassian.jira.JiraFetcher") as mock_fetcher_cls:

        mock_config = MagicMock()
        mock_config.url = "https://jira.example.com"
        mock_config.is_auth_configured.return_value = True
        mock_from_env.return_value = mock_config

        mock_fetcher = MagicMock()
        mock_fetcher.jira.myself.side_effect = ConnectionError("host unreachable")
        mock_fetcher_cls.return_value = mock_fetcher

        result = validate_jira_stdio_credentials()
        assert result is not None
        assert result["valid"] is False
        assert "host unreachable" in result["error"]


def test_log_stdio_startup_validation_success():
    """Test log_stdio_startup_validation logs successfully on valid credentials."""
    with patch("mcp_atlassian.servers.startup_validator.validate_jira_stdio_credentials") as mock_val, \
         patch("mcp_atlassian.servers.startup_validator.logger") as mock_logger:

        mock_val.return_value = {
            "valid": True,
            "user": {
                "displayName": "Jane Doe",
                "email": "jane@example.com",
            },
        }

        log_stdio_startup_validation()
        mock_logger.info.assert_called_once_with(
            "[stdio] Authenticated to Jira as: %s (%s)",
            "Jane Doe",
            "jane@example.com",
        )


def test_log_stdio_startup_validation_failure():
    """Test log_stdio_startup_validation logs warning on invalid credentials."""
    with patch("mcp_atlassian.servers.startup_validator.validate_jira_stdio_credentials") as mock_val, \
         patch("mcp_atlassian.servers.startup_validator.logger") as mock_logger:

        mock_val.return_value = {
            "valid": False,
            "error": "HTTP 401 - Unauthorized",
        }

        log_stdio_startup_validation()
        mock_logger.warning.assert_called_once_with(
            "[stdio] Jira credential validation failed: %s",
            "HTTP 401 - Unauthorized",
        )
