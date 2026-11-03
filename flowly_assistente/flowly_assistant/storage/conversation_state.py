from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional


class ConversationStateRepository:
    """Small file-backed state store for multi-turn command completion."""

    def __init__(self, path: str | None = None) -> None:
        default_path = os.getenv("FLOWLY_CONVERSATION_STORE", "data/conversation_state.json")
        self.path = Path(path or default_path)
        if not self.path.is_absolute():
            self.path = Path(__file__).resolve().parents[3] / self.path
        self.ttl_seconds = int(os.getenv("FLOWLY_CONVERSATION_TTL_SEC", "900"))

    def get(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        data = self._read()
        item = data.get(conversation_id)
        if not item:
            return None
        if time.time() - float(item.get("updated_at", 0)) > self.ttl_seconds:
            data.pop(conversation_id, None)
            self._write(data)
            return None
        return item

    def save(self, conversation_id: str, state: Dict[str, Any]) -> None:
        data = self._read()
        data[conversation_id] = {**state, "updated_at": time.time()}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._write(data)

    def clear(self, conversation_id: str) -> None:
        data = self._read()
        data.pop(conversation_id, None)
        self._write(data)

    def _read(self) -> Dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _write(self, data: Dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


class ScopedConversationState:
    """Isola o estado por usuário autenticado: o conversationId do cliente nunca é chave global."""

    def __init__(self, repository: ConversationStateRepository, owner_id: str) -> None:
        self.repository = repository
        self.owner_id = owner_id

    def _key(self, conversation_id: str) -> str:
        return f"{self.owner_id}:{conversation_id}"

    def get(self, conversation_id: str) -> Optional[Dict[str, Any]]:
        return self.repository.get(self._key(conversation_id))

    def save(self, conversation_id: str, state: Dict[str, Any]) -> None:
        self.repository.save(self._key(conversation_id), state)

    def clear(self, conversation_id: str) -> None:
        self.repository.clear(self._key(conversation_id))

