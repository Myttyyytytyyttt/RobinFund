"""Minimal model-neutral Nuvem BYOA client.

The caller supplies two local callbacks:
  agentkit_header(extension) -> str
  sign_typed_data(typed_data) -> str

This deliberately never accepts or uploads a private key.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable
import secrets
import requests


class NuvemError(RuntimeError):
    pass


@dataclass
class NuvemClient:
    gateway_url: str
    agent_id: str
    agentkit_header: Callable[[dict[str, Any]], str]
    sign_typed_data: Callable[[dict[str, Any]], str]
    token: str | None = None

    def _post(self, path: str, payload: dict[str, Any], session: bool = False, extra: dict[str, str] | None = None) -> dict[str, Any]:
        headers = {"Idempotency-Key": secrets.token_hex(16), **(extra or {})}
        if session:
            if not self.token:
                raise NuvemError("connect() must be called first")
            headers["Authorization"] = f"Bearer {self.token}"
        response = requests.post(f"{self.gateway_url.rstrip('/')}{path}", json=payload, headers=headers, timeout=20)
        body = response.json()
        if not response.ok:
            error = body.get("error", {})
            raise NuvemError(f"{error.get('code', response.status_code)}: {error.get('message', 'gateway error')}")
        return body

    def connect(self) -> None:
        challenge = self._post("/v1/agent-sessions/challenge", {"agentId": self.agent_id})["agentkit"]
        header = self.agentkit_header(challenge)
        session = self._post("/v1/agent-sessions", {"agentId": self.agent_id}, extra={"X-AgentKit": header})
        self.token = session["token"]

    def context(self) -> dict[str, Any]:
        if not self.token:
            raise NuvemError("connect() must be called first")
        response = requests.get(
            f"{self.gateway_url.rstrip('/')}/v1/agents/{self.agent_id}/context",
            headers={"Authorization": f"Bearer {self.token}"},
            timeout=20,
        )
        if not response.ok:
            raise NuvemError(response.text)
        return response.json()

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

    def sign_and_submit(self, quote: dict[str, Any], expected_chain: int, expected_fund: str, expected_controller: str) -> dict[str, Any]:
        plan, intent, typed = quote["executionPlan"], quote["intent"], quote["typedData"]
        if int(plan["chainId"]) != expected_chain or int(typed["domain"]["chainId"]) != expected_chain:
            raise NuvemError("wrong chain")
        if plan["fund"].lower() != expected_fund.lower() or intent["fund"].lower() != expected_fund.lower():
            raise NuvemError("wrong Fund recipient")
        if plan["controller"].lower() != expected_controller.lower() or typed["domain"]["verifyingContract"].lower() != expected_controller.lower():
            raise NuvemError("wrong controller")
        if intent["executionHash"].lower() != plan["executionHash"].lower():
            raise NuvemError("execution hash mismatch")
        if int(intent["minAmountOut"]) != int(plan["minAmountOut"]):
            raise NuvemError("minOut mismatch")
        signature = self.sign_typed_data(typed)
        return self._post(
            "/v1/intents",
            {"quoteId": plan["quoteId"], "intent": intent, "signature": signature},
            session=True,
        )
