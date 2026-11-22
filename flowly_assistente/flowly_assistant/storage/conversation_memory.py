"""Memoria curta da conversa: fatos ditos explicitamente pela pessoa ("minha prioridade de hoje e X").

Fica num documento proprio do contexto compartilhado (API AssistantConversation), na chave reservada
"<conversationId>:memoria": mesmo dono (JWT), TTL, version otimista e limites do contexto, mas SEPARADO do estado de
comandos pendentes. So guarda texto informativo com rotulos fixos; nunca cria, confirma, cancela ou executa nada.

Reconhecimento deterministico (sem IA externa):
- afirmacao: "minha/meu <rotulo> [de hoje|do dia|para hoje|principal|da semana] e/sera <valor>", fora de pergunta;
- pergunta de recuperacao: o rotulo + "qual/lembra/o que/mencionei/falei/disse...".
"""

from __future__ import annotations

import copy
import re
import unicodedata
from typing import Any, Dict, Iterable, Optional, Tuple

from flowly_assistant.api_client import APIError
from flowly_assistant.conversation_client import VERSION_CONFLICT_CODE, ConversationStateClient
from flowly_assistant.storage.conversation_state import (
    ConversationStateConflict,
    ConversationStateRejected,
    ConversationStateUnavailable,
)

MEMORY_SUFFIX = ":memoria"
MAX_CONVERSATION_ID = 120
MEMORY_LABELS = ("prioridade", "foco", "objetivo", "meta")
MAX_FACTS = 5
MAX_FACT_TEXT = 300
MIN_FACT_TEXT = 3

_STATEMENT_RE = re.compile(
    r"\b(?:minha|meu)\s+(?P<label>prioridade|foco|objetivo|meta)"
    r"(?:\s+(?:de\s+hoje|do\s+dia|para\s+hoje|pra\s+hoje|principal|da\s+semana))?"
    r"\s+(?:é|e|eh|será|sera|vai\s+ser)\s+(?P<value>[^.!?;\n]+)",
    re.IGNORECASE,
)
_RECALL_WORDS = frozenset({
    "qual", "quais", "lembra", "lembrar", "lembrou", "mencionei", "mencionar", "mencionou", "falei", "disse",
    "repete", "repita",
})
# A pergunta precisa se referir ao que a PROPRIA pessoa disse ("minha", "acabei de mencionar"), e nao a uma
# tarefa ("qual a prioridade da tarefa X?" nao e lembranca da conversa).
_SELF_WORDS = frozenset({"minha", "meu", "eu", "acabei", "mencionei", "mencionar", "falei", "disse", "lembra"})


def _plain(text: str) -> list[str]:
    ascii_text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii")
    return re.findall(r"[a-z0-9]+", ascii_text.lower())


def _label_of(word: str) -> Optional[str]:
    plain = "".join(_plain(word))
    return plain if plain in MEMORY_LABELS else None


def extract_stated_fact(text: str) -> Optional[Tuple[str, str]]:
    """(rotulo, valor) de uma afirmacao explicita, ou None. Pergunta nunca e afirmacao."""
    content = str(text or "").strip()
    if not content or content.rstrip().endswith("?"):
        return None
    found = _STATEMENT_RE.search(content)
    if not found:
        return None
    value = found.group("value").strip().strip("\"'“”‘’ ").strip()
    if not MIN_FACT_TEXT <= len(value) <= MAX_FACT_TEXT:
        return None
    if (_plain(value)[:1] or [""])[0] in ("qual", "quais"):
        return None  # "minha prioridade e qual" e pergunta mal pontuada
    return _label_of(found.group("label")), value


def asked_fact_label(text: str) -> Optional[str]:
    """Rotulo perguntado ("qual foi a prioridade que acabei de mencionar?"), ou None."""
    if extract_stated_fact(text):
        return None
    words = _plain(text)
    labels = [w for w in words if w in MEMORY_LABELS]
    if not labels:
        return None
    asks = bool(set(words) & _RECALL_WORDS) or " o que " in f" {' '.join(words)} " or str(text or "").strip().endswith("?")
    return labels[0] if asks and set(words) & _SELF_WORDS else None


def memory_key(conversation_id: str) -> Optional[str]:
    key = f"{conversation_id}{MEMORY_SUFFIX}"
    return key if len(key) <= MAX_CONVERSATION_ID else None


def _valid_facts(state: Any) -> Optional[Dict[str, str]]:
    if not isinstance(state, dict) or state.get("mode") != "conversation_memory" or set(state) - {"mode", "facts"}:
        return None
    facts = state.get("facts")
    if not isinstance(facts, list) or len(facts) > MAX_FACTS:
        return None
    out: Dict[str, str] = {}
    for fact in facts:
        if not isinstance(fact, dict) or set(fact) != {"label", "text"} or fact["label"] not in MEMORY_LABELS \
                or not isinstance(fact["text"], str) or not fact["text"].strip() or fact["label"] in out:
            return None
        out[fact["label"]] = fact["text"]
    return out


class ConversationMemory:
    """Fatos da conversa de UMA pessoa (a do JWT), na chave reservada de memoria."""

    def __init__(self, client: ConversationStateClient, *, forbidden_values: Iterable[str] = ()) -> None:
        self._client = client
        self._forbidden = tuple(str(v) for v in forbidden_values if v and len(str(v)) >= 8)

    def _read(self, conversation_id: str) -> Tuple[int, Dict[str, str]]:
        key = memory_key(conversation_id)
        if key is None:
            raise ConversationStateUnavailable("conversa sem espaco para memoria")
        try:
            context = self._client.current(conversation_id=key)
        except APIError:
            raise ConversationStateUnavailable("memoria indisponivel") from None
        if context is None:
            return 0, {}
        version = context.get("version") if isinstance(context, dict) else None
        if isinstance(version, bool) or not isinstance(version, int) or version < 1 or context.get("conversationId") != key:
            raise ConversationStateUnavailable("memoria com metadados invalidos")
        facts = _valid_facts(context.get("state"))
        if facts is None:
            raise ConversationStateUnavailable("memoria com formato desconhecido")  # nunca interpretada
        return version, facts

    def facts(self, conversation_id: str) -> Dict[str, str]:
        return copy.deepcopy(self._read(conversation_id)[1])

    def remember(self, conversation_id: str, label: str, text: str) -> None:
        """Guarda (ou substitui) um fato. Conflito de versao nao sobrescreve nada."""
        if label not in MEMORY_LABELS or not MIN_FACT_TEXT <= len(text) <= MAX_FACT_TEXT:
            raise ConversationStateRejected("state_invalid")
        if self._forbidden and any(value in text for value in self._forbidden):
            raise ConversationStateRejected("state_sensitive")  # nunca chega a rede
        version, facts = self._read(conversation_id)
        facts.pop(label, None)
        facts[label] = text
        ordered = list(facts.items())[-MAX_FACTS:]
        state = {"mode": "conversation_memory", "facts": [{"label": k, "text": v} for k, v in ordered]}
        try:
            self._client.save(conversation_id=memory_key(conversation_id), expected_version=version, state=state)
        except APIError as exc:
            if exc.code == VERSION_CONFLICT_CODE:
                raise ConversationStateConflict("memoria alterada por outra mensagem") from None
            if exc.status_code == 400 and exc.code in ConversationStateRejected.REJECTED_CODES:
                raise ConversationStateRejected(exc.code) from None
            raise ConversationStateUnavailable("memoria indisponivel") from None

    def clear_unconditional(self, conversation_id: str) -> bool:
        key = memory_key(conversation_id)
        if key is None:
            return True
        try:
            self._client.clear(conversation_id=key)
        except APIError:
            return False
        return True
