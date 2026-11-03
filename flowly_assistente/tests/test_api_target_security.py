import os
import sys
import types
import unittest
from unittest.mock import patch

# The security tests do not perform network calls. This lightweight fallback lets
# them run in a checkout where the optional runtime requirements are not installed.
if "requests" not in sys.modules:
    try:
        import requests  # noqa: F401
    except ModuleNotFoundError:
        sys.modules["requests"] = types.SimpleNamespace(
            Timeout=TimeoutError,
            RequestException=RuntimeError,
            request=lambda *args, **kwargs: None,
        )

from flowly_assistant.assistant_core.message_agent import get_admin_insights
from flowly_assistant.assistant_core.rest_assistant import assistant_from_http_body


class ApiTargetSecurityTests(unittest.TestCase):
    @patch.dict(os.environ, {"FLOWLY_API_BASE_URL": "https://api.flowly.test/api"}, clear=False)
    def test_assistant_ignores_api_url_from_request_body(self):
        assistant = assistant_from_http_body(
            {"api_url": "https://attacker.invalid/steal"},
            "secret-access-token",
        )

        self.assertEqual(assistant.api.base_url, "https://api.flowly.test/api")

    @patch("flowly_assistant.assistant_core.message_agent.AnalyticsRepository")
    @patch("flowly_assistant.assistant_core.message_agent.FlowlyAPIClient")
    @patch.dict(os.environ, {"FLOWLY_API_BASE_URL": "https://api.flowly.test/api"}, clear=False)
    def test_admin_insights_ignores_api_url_from_request_body(self, client_class, repository_class):
        client_class.return_value.me.return_value = {"tipo": "admin"}
        repository_class.return_value.aggregate.return_value = {}

        payload, status = get_admin_insights(
            "secret-access-token",
            {"api_base_url": "https://attacker.invalid/steal"},
        )

        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        client_class.assert_called_once_with(
            base_url="https://api.flowly.test/api",
            token="secret-access-token",
        )


if __name__ == "__main__":
    unittest.main()
