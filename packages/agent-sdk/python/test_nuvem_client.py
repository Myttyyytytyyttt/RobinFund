from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.modules.setdefault("requests", SimpleNamespace(request=lambda *args, **kwargs: None))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from nuvem_client import NuvemClient, NuvemError


class FakeResponse:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self._body = body
        self.ok = 200 <= status_code < 300

    def json(self) -> dict:
        return self._body


class NuvemClientSessionTests(unittest.TestCase):
    def test_auto_connects_and_retries_one_expired_session_with_same_idempotency_key(self) -> None:
        expiry = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()
        responses = iter(
            [
                FakeResponse(200, {"agentkit": {"version": "0.2"}}),
                FakeResponse(200, {"token": "token-1", "expiresAt": expiry}),
                FakeResponse(401, {"error": {"code": "SESSION_EXPIRED", "message": "expired"}}),
                FakeResponse(200, {"agentkit": {"version": "0.2"}}),
                FakeResponse(200, {"token": "token-2", "expiresAt": expiry}),
                FakeResponse(200, {"executionPlan": {"quoteId": "quote-1"}}),
            ]
        )
        calls: list[tuple[str, str, dict[str, str]]] = []

        def request(method: str, url: str, **kwargs):
            calls.append((method, url, kwargs["headers"]))
            return next(responses)

        client = NuvemClient(
            "https://gateway.example",
            "0xagent",
            lambda _: "signed-agentkit-header",
        )
        with patch("nuvem_client.requests.request", request):
            result = client.quote(
                {"tokenIn": "0xin"},
                {"provenance": {"deploymentId": "deployment-1", "blockNumber": 10}},
            )

        quote_calls = [call for call in calls if call[1].endswith("/quotes")]
        self.assertEqual(result["executionPlan"]["quoteId"], "quote-1")
        self.assertEqual(len(quote_calls), 2)
        self.assertEqual(
            quote_calls[0][2]["Idempotency-Key"],
            quote_calls[1][2]["Idempotency-Key"],
        )
        self.assertEqual(quote_calls[1][2]["Authorization"], "Bearer token-2")

    def test_rejects_invalid_session_expiry(self) -> None:
        responses = iter(
            [
                FakeResponse(200, {"agentkit": {"version": "0.2"}}),
                FakeResponse(200, {"token": "token-1", "expiresAt": "not-a-date"}),
            ]
        )
        client = NuvemClient(
            "https://gateway.example",
            "0xagent",
            lambda _: "signed-agentkit-header",
        )
        with patch("nuvem_client.requests.request", lambda *args, **kwargs: next(responses)):
            with self.assertRaisesRegex(NuvemError, "INVALID_SESSION"):
                client.connect()


if __name__ == "__main__":
    unittest.main()
