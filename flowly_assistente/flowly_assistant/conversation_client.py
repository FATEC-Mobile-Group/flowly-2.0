"""Cliente HTTP do contexto compartilhado das conversas (/api/assistant/conversations da API Flowly).

Mesmo transporte das confirmacoes compartilhadas (operations_client._InternalAPIClient): destino fixo da API do
ambiente, JWT do usuario + segredo interno ASSISTANT_OPERATIONS_SECRET, sem redirecionamento, erros estruturados
(APIError) e nada registrado em log. Nao depende da chave de escritas: o contexto guarda conversa, nao autoriza nada.

Contrato:
  current(conversation_id)                         -> {conversationId, version, state, expiresAt, updatedAt} | None
  save(conversation_id, expected_version, state)   -> {conversationId, version, expiresAt, updatedAt}
  clear(conversation_id, expected_version=None)    -> bool (havia algo para limpar)
expected_version: o version lido (0 = nao havia contexto vivo). 409 context_version_conflict = outro pedido gravou
depois da leitura; nada foi sobrescrito. clear sem expected_version e incondicional (standby).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from flowly_assistant.operations_client import _InternalAPIClient, _invalid

CONVERSATIONS_PATH = "/assistant/conversations"
DEFAULT_TIMEOUT_SEC = 5.0
VERSION_CONFLICT_CODE = "context_version_conflict"
MAX_VERSION = 10**9


class ConversationStateClient(_InternalAPIClient):
    BASE_PATH = CONVERSATIONS_PATH
    LABEL = "conversas do assistente"

    def __init__(self, token: str, *, timeout_sec: float = DEFAULT_TIMEOUT_SEC) -> None:
        super().__init__(token, timeout_sec=timeout_sec)

    @staticmethod
    def _version(value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_VERSION:
            raise _invalid("expectedVersion")
        return value

    def current(self, *, conversation_id: str) -> Optional[Dict[str, Any]]:
        return self._send("GET", "/current", params={"conversationId": self._conversation(conversation_id)},
                          expect="context")

    def save(self, *, conversation_id: str, expected_version: int, state: Dict[str, Any]) -> Dict[str, Any]:
        if not isinstance(state, dict):
            raise _invalid("state")
        return self._send("PUT", "/current", body={
            "conversationId": self._conversation(conversation_id),
            "expectedVersion": self._version(expected_version),
            "state": state,
        }, expect="context")

    def clear(self, *, conversation_id: str, expected_version: Optional[int] = None) -> bool:
        body: Dict[str, Any] = {"conversationId": self._conversation(conversation_id)}
        if expected_version is not None:
            body["expectedVersion"] = self._version(expected_version)
        return bool(self._send("POST", "/current/clear", body=body, expect="cleared"))
