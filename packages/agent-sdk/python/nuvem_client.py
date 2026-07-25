"""Minimal read-only, model-neutral Nuvem BYOA client.

The caller supplies one local callback:
  agentkit_header(extension) -> str

This deliberately never accepts or uploads a private key.
Execution is intentionally available only in the TypeScript SDK, which performs
the complete local plan/calldata validation before asking its signer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from threading import RLock
from typing import Any, Callable
import secrets
import time
import requests


class NuvemError(RuntimeError):
    pass


@dataclass
class NuvemClient:
    gateway_url: str
    agent_id: str
    agentkit_header: Callable[[dict[str, Any]], str]
    token: str | None = None
    token_expires_at: float = 0
    _session_lock: RLock = field(default_factory=RLock, init=False, repr=False)

    @staticmethod
    def _body(response: requests.Response) -> dict[str, Any]:
        try:
            body = response.json()
        except ValueError as exc:
            raise NuvemError(f"HTTP_{response.status_code}: gateway returned a non-JSON response") from exc
        if not isinstance(body, dict):
            raise NuvemError(f"HTTP_{response.status_code}: gateway returned an invalid response")
        return body

    def _ensure_session(self) -> None:
        if self.token and self.token_expires_at > time.time() + 30:
            return
        self.connect()

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        session: bool = False,
        extra: dict[str, str] | None = None,
        idempotency_key: str | None = None,
        retry_session: bool = True,
    ) -> dict[str, Any]:
        if session:
            self._ensure_session()
        headers = {**(extra or {})}
        if method == "POST":
            headers["Idempotency-Key"] = idempotency_key or secrets.token_hex(16)
        if session:
            headers["Authorization"] = f"Bearer {self.token}"
        response = requests.request(
            method,
            f"{self.gateway_url.rstrip('/')}{path}",
            json=payload,
            headers=headers,
            timeout=20,
        )
        body = self._body(response)
        error = body.get("error", {}) if isinstance(body.get("error"), dict) else {}
        code = str(error.get("code", response.status_code))
        if session and retry_session and response.status_code == 401 and code in {"SESSION_EXPIRED", "SESSION_REQUIRED"}:
            with self._session_lock:
                self.token = None
                self.token_expires_at = 0
            self._ensure_session()
            return self._request(
                method,
                path,
                payload,
                session=True,
                extra=extra,
                idempotency_key=headers.get("Idempotency-Key"),
                retry_session=False,
            )
        if not response.ok:
            raise NuvemError(f"{code}: {error.get('message', 'gateway error')}")
        return body

    def _post(self, path: str, payload: dict[str, Any], session: bool = False, extra: dict[str, str] | None = None) -> dict[str, Any]:
        return self._request("POST", path, payload, session=session, extra=extra)

    def connect(self) -> None:
        with self._session_lock:
            if self.token and self.token_expires_at > time.time() + 30:
                return
            challenge = self._post("/v1/agent-sessions/challenge", {"agentId": self.agent_id})["agentkit"]
            header = self.agentkit_header(challenge)
            session = self._post("/v1/agent-sessions", {"agentId": self.agent_id}, extra={"X-AgentKit": header})
            token = session.get("token")
            expires_at = session.get("expiresAt")
            try:
                expiry = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00")).timestamp()
            except (TypeError, ValueError) as exc:
                raise NuvemError("INVALID_SESSION: gateway returned an invalid expiry") from exc
            if not token or expiry <= time.time():
                raise NuvemError("INVALID_SESSION: gateway returned an expired session")
            self.token = str(token)
            self.token_expires_at = expiry

    def context(self) -> dict[str, Any]:
        return self._request(
            "GET",
            f"/v1/agents/{self.agent_id}/context",
            session=True,
        )

    def quote(self, proposal: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
        provenance = context["provenance"]
        return self._post(
            f"/v1/agents/{self.agent_id}/quotes",
            {
                **proposal,
                "contextDeploymentId": provenance["deploymentId"],
                "contextBlockNumber": provenance["blockNumber"],
            },
            session=True,
        )
