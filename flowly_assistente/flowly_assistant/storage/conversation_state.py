"""Contexto das conversas do assistente, compartilhado entre instancias pela API do Flowly.

Antes: um arquivo JSON local (/tmp em container), invisivel para outras instancias e sem controle de concorrencia.
Agora a API e a dona do contexto (AssistantConversation): este modulo so adapta o contrato HTTP a interface que o
MessageAgent ja usava (get / save / clear por conversationId), sem nenhum fallback local.

Concorrencia: o contexto e lido UMA vez por mensagem (load) e o version lido acompanha cada save/clear desta
mensagem (expectedVersion). Se outra mensagem gravou antes, a API recusa e este modulo levanta
ConversationStateConflict: nada e sobrescrito e a camada de conversa pede para repetir a resposta.

Falhas: API fora, segredo ausente, resposta invalida -> ConversationStateUnavailable (fail-closed: nada que dependa
do contexto continua). Estado guardado com formato desconhecido -> descartado (limpeza condicional, melhor esforco),
nunca interpretado; was_discarded() avisa a camada de conversa.

O contexto nunca guarda JWT, segredo interno ou chaves de idempotencia, e nunca autoriza uma escrita: toda escrita
continua exigindo a confirmacao compartilhada (AssistantOperation).
"""

from __future__ import annotations

import copy
from typing import Any, Dict, Iterable, Optional, Tuple

from flowly_assistant.api_client import APIError
from flowly_assistant.conversation_client import VERSION_CONFLICT_CODE, ConversationStateClient

MAX_SELECTABLE_TASKS = 10


class ConversationStateUnavailable(Exception):
    """O contexto compartilhado nao pode ser lido ou gravado agora (nada que dependa dele deve continuar)."""


class ConversationStateConflict(Exception):
    """Outra mensagem gravou o contexto desta conversa depois da leitura: nada foi sobrescrito."""


class ConversationStateRejected(Exception):
    """A API recusou o conteudo (longo demais, formato inesperado ou com credencial): nada foi gravado."""

    REJECTED_CODES = frozenset({"state_invalid", "state_too_large", "state_sensitive"})

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _is_text_map(value: Any) -> bool:
    return isinstance(value, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in value.items())


def is_known_state(state: Any) -> bool:
    """Formas que o MessageAgent sabe continuar com seguranca. Qualquer outra e descartada sem interpretacao."""
    if not isinstance(state, dict):
        return False
    mode = state.get("mode")
    if mode == "task_selection":
        tasks = state.get("tasks")
        return isinstance(tasks, list) and len(tasks) <= MAX_SELECTABLE_TASKS and all(isinstance(t, dict) for t in tasks)
    if mode == "write_confirmation":
        return True  # confirmacao local antiga: o MessageAgent a reconhece so para descarta-la (nunca executa)
    if mode is not None:
        return False
    missing = state.get("missing")
    return (isinstance(state.get("command_key"), str) and _is_text_map(state.get("params"))
            and isinstance(missing, list) and all(isinstance(m, str) for m in missing))


def _contains(value: Any, needles: Tuple[str, ...]) -> bool:
    if isinstance(value, str):
        return any(needle in value for needle in needles)
    if isinstance(value, dict):
        return any(_contains(k, needles) or _contains(v, needles) for k, v in value.items())
    if isinstance(value, list):
        return any(_contains(item, needles) for item in value)
    return False


class SharedConversationState:
    """get/save/clear do contexto de UMA pessoa (a do JWT), por conversationId, sobre a API."""

    def __init__(self, client: ConversationStateClient, *, forbidden_values: Iterable[str] = ()) -> None:
        self._client = client
        self._loaded: Dict[str, Tuple[int, Optional[Dict[str, Any]]]] = {}
        self._discarded: set[str] = set()
        self._unavailable: set[str] = set()
        # Valores que nunca podem ir para o contexto (o JWT desta requisicao, o segredo interno).
        self._forbidden = tuple(str(v) for v in forbidden_values if v and len(str(v)) >= 8)

    # --- leitura -------------------------------------------------------------------------------------------

    def load(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        """Le o contexto (uma vez por mensagem) e guarda o version para as gravacoes seguintes."""
        try:
            context = self._client.current(conversation_id=conversation_id)
        except APIError:
            # Modo degradado desta mensagem: get() devolve None; save/clear recusam (nada depende do contexto).
            self._unavailable.add(conversation_id)
            raise ConversationStateUnavailable("contexto indisponivel") from None
        if context is None:
            self._loaded[conversation_id] = (0, None)
            return None
        version = context.get("version") if isinstance(context, dict) else None
        if isinstance(version, bool) or not isinstance(version, int) or version < 1 \
                or context.get("conversationId") != conversation_id:
            raise ConversationStateUnavailable("contexto com metadados invalidos")
        state = context.get("state")
        if not is_known_state(state):
            # Corrompido ou de outro formato: nunca interpretado. Limpa se ainda for o mesmo (melhor esforco).
            self._discarded.add(conversation_id)
            self._loaded[conversation_id] = (version, None)
            try:
                self._client.clear(conversation_id=conversation_id, expected_version=version)
                self._loaded[conversation_id] = (0, None)
            except APIError:
                pass  # continua com o version lido: a proxima gravacao so entra se ninguem mudou nada
            return None
        self._loaded[conversation_id] = (version, copy.deepcopy(state))
        return copy.deepcopy(state)

    def was_discarded(self, conversation_id: str) -> bool:
        return conversation_id in self._discarded

    def _entry(self, conversation_id: str) -> Tuple[int, Optional[Dict[str, Any]]]:
        if conversation_id in self._unavailable:
            raise ConversationStateUnavailable("contexto indisponivel nesta mensagem")
        if conversation_id not in self._loaded:
            self.load(conversation_id)
        return self._loaded[conversation_id]

    def get(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        if conversation_id in self._unavailable:
            return None  # consultas diretas seguem; nada e interpretado como resposta a uma pergunta
        state = self._entry(conversation_id)[1]
        return copy.deepcopy(state) if state is not None else None

    # --- escrita (sempre condicionada ao version lido) -----------------------------------------------------

    def save(self, conversation_id: str, state: Dict[str, Any]) -> None:
        if not isinstance(state, dict) or not is_known_state(state) or state.get("mode") == "write_confirmation":
            raise ConversationStateRejected("state_invalid")
        if self._forbidden and _contains(state, self._forbidden):
            raise ConversationStateRejected("state_sensitive")  # nunca chega a rede
        version, _state = self._entry(conversation_id)
        try:
            context = self._client.save(conversation_id=conversation_id, expected_version=version, state=state)
        except APIError as exc:
            if exc.code == VERSION_CONFLICT_CODE:
                raise ConversationStateConflict("contexto alterado por outra mensagem") from None
            if exc.status_code == 400 and exc.code in ConversationStateRejected.REJECTED_CODES:
                raise ConversationStateRejected(exc.code) from None
            raise ConversationStateUnavailable("contexto indisponivel") from None
        new_version = context.get("version") if isinstance(context, dict) else None
        if isinstance(new_version, bool) or not isinstance(new_version, int) or new_version <= version:
            raise ConversationStateUnavailable("resposta de gravacao invalida")
        self._loaded[conversation_id] = (new_version, copy.deepcopy(state))

    def clear(self, conversation_id: str) -> None:
        version, state = self._entry(conversation_id)
        if version == 0 and state is None:
            return  # nada vivo foi lido: nada a limpar (sem chamada)
        try:
            self._client.clear(conversation_id=conversation_id, expected_version=version)
        except APIError as exc:
            if exc.code == VERSION_CONFLICT_CODE:
                raise ConversationStateConflict("contexto alterado por outra mensagem") from None
            raise ConversationStateUnavailable("contexto indisponivel") from None
        self._loaded[conversation_id] = (0, None)

    def clear_unconditional(self, conversation_id: str) -> bool:
        """Standby: a pessoa saiu da conversa; remove o que houver. True = limpeza confirmada pela API."""
        try:
            self._client.clear(conversation_id=conversation_id)
        except APIError:
            return False
        self._loaded[conversation_id] = (0, None)
        return True
