"""Cliente HTTP das confirmacoes compartilhadas (/api/assistant/operations da API Flowly).

So comunicacao: nao decide nada sobre o fluxo da conversa (isso fica para a integracao do MessageAgent).

Seguranca:
- Destino: so a URL da API do ambiente (validated_api_base_url) + caminho fixo /assistant/operations. Nenhum
  metodo publico aceita URL ou caminho livre; operationId e conferido (UUID v4) antes de entrar no caminho.
- Credenciais: o JWT do usuario (Authorization) e o segredo interno ASSISTANT_OPERATIONS_SECRET, lido SO do
  ambiente, enviado SO para estas rotas, em X-Assistant-Operations-Secret. Ausente ou curto: nada e enviado.
- Redirecionamentos nao sao seguidos (levariam o segredo, um cabecalho proprio, a outro destino).
- Nada e registrado em log: nem JWT, nem segredo, nem claimToken ou idempotencyKey.
- Chave de escritas (FLOWLY_ASSISTANT_WRITES_ENABLED) desligada: create e claim recusam antes da rede (sem novas
  confirmacoes nem execucoes). current, result, complete, retry e cancel continuam, para consultar e encerrar.

Erros: APIError estruturado (status_code, code, retry_after, category, may_have_executed, operation). Timeout ou
falha de rede nunca significam "nada mudou".
"""

from __future__ import annotations

import os
import re
from typing import Any, Dict, Optional

import requests

from flowly_assistant.api_client import APIError, _header, _retry_after_seconds
from flowly_assistant.api_config import validated_api_base_url
from flowly_assistant.commands import WRITES_DISABLED_REPLY, assistant_writes_enabled

OPERATIONS_SECRET_ENV = "ASSISTANT_OPERATIONS_SECRET"
OPERATIONS_SECRET_HEADER = "X-Assistant-Operations-Secret"
MIN_SECRET_LENGTH = 43  # igual a API: 32 bytes aleatorios em base64url
OPERATIONS_PATH = "/assistant/operations"
DEFAULT_TIMEOUT_SEC = 10.0
MAX_TIMEOUT_SEC = 30.0

UUID_V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
CONVERSATION_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")
WRITE_COMMANDS = frozenset({
    "create_team", "create_task", "add_comment", "add_subtask", "assign_to_me", "update_status", "timer",
})
OUTCOMES = frozenset({"completed", "failed", "unknown"})
NOT_CONFIGURED_REPLY = "As confirmações compartilhadas não estão configuradas. Nada foi alterado."


def _operations_secret() -> str:
    secret = str(os.getenv(OPERATIONS_SECRET_ENV) or "").strip()
    if len(secret) < MIN_SECRET_LENGTH:
        raise APIError(NOT_CONFIGURED_REPLY, kind="not_configured", code="assistant_operations_not_configured")
    return secret


def _invalid(what: str) -> APIError:
    return APIError(f"Pedido inválido para as operações do assistente: {what}.", kind="invalid_request")


class OperationsClient:
    """create, current, result, claim, complete, retry e cancel das confirmacoes compartilhadas."""

    def __init__(self, token: str, *, timeout_sec: float = DEFAULT_TIMEOUT_SEC) -> None:
        self._token = str(token or "").strip()
        try:
            timeout = float(timeout_sec)
        except (TypeError, ValueError):
            timeout = DEFAULT_TIMEOUT_SEC
        self.timeout_sec = min(max(timeout, 1.0), MAX_TIMEOUT_SEC)

    def __repr__(self) -> str:  # nunca mostra o token
        return f"OperationsClient(timeout_sec={self.timeout_sec})"

    # --- validacao local (antes de qualquer rede) -------------------------------------------------------------

    @staticmethod
    def _conversation(value: Any) -> str:
        if not isinstance(value, str) or not CONVERSATION_ID.match(value):
            raise _invalid("conversationId")
        return value

    @staticmethod
    def _uuid(value: Any, what: str) -> str:
        if not isinstance(value, str) or not UUID_V4.match(value):
            raise _invalid(what)
        return value

    @staticmethod
    def _result(value: Any) -> Optional[Dict[str, Any]]:
        if value is None:
            return None
        if not isinstance(value, dict):
            raise _invalid("result")
        return value

    # --- transporte ------------------------------------------------------------------------------------------

    def _send(self, method: str, path: str, *, params: Optional[dict] = None, body: Optional[dict] = None,
              expect: str = "operation") -> Any:
        if not self._token:
            raise APIError("Token obrigatório.", kind="invalid_request", code="missing_token")
        secret = _operations_secret()
        try:
            base = validated_api_base_url()
        except ValueError:
            raise APIError(NOT_CONFIGURED_REPLY, kind="not_configured", code="api_url_invalid") from None
        url = f"{base}{OPERATIONS_PATH}{path}"
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            OPERATIONS_SECRET_HEADER: secret,
        }
        is_write = method != "GET"
        try:
            resp = requests.request(method, url, headers=headers, params=params, json=body,
                                    timeout=self.timeout_sec, allow_redirects=False)
        except requests.Timeout:
            # Sem o texto da excecao (pode trazer a URL); a operacao pode ter mudado no servidor.
            raise APIError("Timeout ao chamar as operações do assistente.", kind="timeout", method=method,
                           may_have_executed=is_write) from None
        except requests.RequestException:
            raise APIError("Erro de rede ao chamar as operações do assistente.", kind="network", method=method,
                           may_have_executed=is_write) from None

        status = int(getattr(resp, "status_code", 0) or 0)
        if 300 <= status < 400:
            raise APIError("Redirecionamento recusado nas operações do assistente.", kind="redirect",
                           status_code=status, method=method, may_have_executed=is_write)
        try:
            payload = resp.json()
        except Exception:
            payload = None
        if status >= 400:
            data = payload if isinstance(payload, dict) else {}
            code = data.get("code") if isinstance(data.get("code"), str) else None
            operation = data.get("operation") if isinstance(data.get("operation"), dict) else None
            raise APIError(
                f"HTTP {status} nas operações do assistente: {code or 'erro'}",
                kind="http", status_code=status, code=code, retry_after=_retry_after_seconds(resp),
                replayed=(_header(resp, "Idempotency-Replayed") or "").lower() == "true",
                method=method, operation=operation,
                # 5xx numa transicao nao prova que nada mudou (falha depois de gravar, ou gateway).
                may_have_executed=is_write and status >= 500,
            )
        if not isinstance(payload, dict) or payload.get("ok") is not True or expect not in payload:
            raise APIError("Resposta inválida das operações do assistente.", kind="invalid_response",
                           status_code=status, method=method, may_have_executed=is_write)
        return payload[expect]

    # --- contrato ----------------------------------------------------------------------------------------------

    def create(self, *, conversation_id: str, command_key: str, params: Dict[str, Any], summary: str) -> Dict[str, Any]:
        """POST / -> operacao publica (pending). 409 conversation_busy traz a operacao ativa em exc.operation."""
        if not assistant_writes_enabled():
            raise APIError(WRITES_DISABLED_REPLY, kind="writes_disabled")
        if command_key not in WRITE_COMMANDS:
            raise _invalid("commandKey")
        if not isinstance(params, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in params.items()):
            raise _invalid("params")
        if not isinstance(summary, str) or not summary.strip():
            raise _invalid("summary")
        body = {"conversationId": self._conversation(conversation_id), "commandKey": command_key,
                "params": dict(params), "summary": summary}
        return self._send("POST", "", body=body)

    def current(self, *, conversation_id: str) -> Optional[Dict[str, Any]]:
        """GET /current -> operacao mais recente da conversa (publica) ou None."""
        return self._send("GET", "/current", params={"conversationId": self._conversation(conversation_id)})

    def result(self, *, operation_id: str, conversation_id: str) -> Dict[str, Any]:
        """GET /:id/result -> operacao terminal (publica); 409 operation_not_terminal enquanto ativa."""
        operation_id = self._uuid(operation_id, "operationId")
        return self._send("GET", f"/{operation_id}/result",
                          params={"conversationId": self._conversation(conversation_id)})

    def claim(self, *, operation_id: str, conversation_id: str) -> Dict[str, Any]:
        """POST /:id/claim -> resposta PRIVADA (params, idempotencyKey, claimToken, leaseUntil, recovery).

        A idempotencyKey devolvida e a da operacao: a mesma em toda tentativa e recuperacao; o cliente nunca gera
        outra. Nao guarde o retorno em log.
        """
        if not assistant_writes_enabled():
            raise APIError(WRITES_DISABLED_REPLY, kind="writes_disabled")
        operation_id = self._uuid(operation_id, "operationId")
        return self._send("POST", f"/{operation_id}/claim",
                          body={"conversationId": self._conversation(conversation_id)}, expect="claim")

    def complete(self, *, operation_id: str, conversation_id: str, claim_token: str, outcome: str,
                 result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """POST /:id/complete (completed | failed | unknown) pelo detentor do claim atual."""
        operation_id = self._uuid(operation_id, "operationId")
        if outcome not in OUTCOMES:
            raise _invalid("outcome")
        body: Dict[str, Any] = {"conversationId": self._conversation(conversation_id),
                                "claimToken": self._uuid(claim_token, "claimToken"), "outcome": outcome}
        clean = self._result(result)
        if clean is not None:
            body["result"] = clean
        return self._send("POST", f"/{operation_id}/complete", body=body)

    def retry(self, *, operation_id: str, conversation_id: str, claim_token: str,
              result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """POST /:id/retry: desfecho inconclusivo; a operacao volta para recuperacao com a MESMA chave."""
        operation_id = self._uuid(operation_id, "operationId")
        body: Dict[str, Any] = {"conversationId": self._conversation(conversation_id),
                                "claimToken": self._uuid(claim_token, "claimToken")}
        clean = self._result(result)
        if clean is not None:
            body["result"] = clean
        return self._send("POST", f"/{operation_id}/retry", body=body)

    def cancel(self, *, operation_id: str, conversation_id: str) -> Dict[str, Any]:
        """POST /:id/cancel: so pending dentro do prazo (409 operation_in_progress depois do claim)."""
        operation_id = self._uuid(operation_id, "operationId")
        return self._send("POST", f"/{operation_id}/cancel", body={"conversationId": self._conversation(conversation_id)})
