"""Servidor falso do contexto compartilhado das conversas (/api/assistant/conversations), em memoria. Nenhuma rede.

Imita o contrato da API (services/assistantConversationService.js + rotas): dono pelo JWT (token), conversa,
version otimista (expectedVersion; 0 = nenhum vivo), prazo (TTL renovado a cada gravacao), validacao das duas formas
de estado e recusa de conteudo sensivel. Substitui o ConversationStateClient dentro do MessageAgent.

Ganchos: fail_before[metodo] = excecao (falha antes do servidor); lose_response[metodo] = excecao (aplica e a
resposta se perde); offset avanca o relogio (segundos); before_apply[metodo] = funcao chamada antes de aplicar
(para colocar duas mensagens lado a lado).

ConversationStateRepository / ScopedConversationState: fachada so de teste, com a interface antiga, que le e grava
direto no servidor falso, como um terceiro (ex.: estado antigo/forjado no banco). Gravar por ela sobe o version.
"""

import copy
import json
import os
import re
import time
from unittest.mock import patch

from flowly_assistant.api_client import APIError
from flowly_assistant.operations_client import MIN_SECRET_LENGTH, NOT_CONFIGURED_REPLY, OPERATIONS_SECRET_ENV

TEST_SECRET = "segredo-de-teste-" + "t" * 32
STATE_MAX_BYTES = 32 * 1024
KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,39}$")
COMMAND_KEY = re.compile(r"^[a-z][a-z_]{0,39}$")
OBJECT_ID = re.compile(r"^[a-f0-9]{24}$")
JWT = re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", re.I)
TASK_KEYS = {"_id", "descricao", "status", "urgencia", "dataEntrega", "equipe", "user"}


def _text(value, limit=2000):
    return isinstance(value, str) and len(value) <= limit


def _ref(value):
    if value is None or _text(value, 200):
        return True
    return isinstance(value, dict) and set(value) <= {"nome"} and (value.get("nome") is None or _text(value["nome"], 200))


def _task(task):
    return (isinstance(task, dict) and set(task) <= TASK_KEYS and (task.get("_id") == "" or bool(OBJECT_ID.match(str(task.get("_id")))))
            and (task.get("descricao") is None or _text(task["descricao"]))
            and (task.get("status") is None or _text(task["status"], 40))
            and (task.get("urgencia") is None or _text(task["urgencia"], 20))
            and (task.get("dataEntrega") is None or _text(task["dataEntrega"], 40)) and _ref(task.get("equipe")) and _ref(task.get("user")))


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _strings(item)


MEMORY_LABELS = ("prioridade", "foco", "objetivo", "meta")


def _memory_ok(state):
    facts = state.get("facts")
    return (set(state) <= {"mode", "facts"} and state.get("mode") == "conversation_memory" and isinstance(facts, list)
            and len(facts) <= 5 and len({f.get("label") for f in facts if isinstance(f, dict)}) == len(facts)
            and all(isinstance(f, dict) and set(f) == {"label", "text"} and f["label"] in MEMORY_LABELS
                    and isinstance(f["text"], str) and f["text"].strip() and len(f["text"]) <= 300 for f in facts))


def state_refusal(state, memory=False):
    """Mesmas regras de normalizeState (Node): None = aceito; senao o codigo da recusa. memory = chave
    reservada "<conversa>:memoria" (so a forma conversation_memory, e ela nunca fora dessa chave)."""
    if not isinstance(state, dict):
        return "state_invalid"
    if len(json.dumps(state, ensure_ascii=False).encode("utf-8")) > STATE_MAX_BYTES:
        return "state_too_large"
    if memory:
        ok = _memory_ok(state)
    elif "mode" in state:
        ok = (set(state) <= {"mode", "tasks", "selected_task_id"} and state["mode"] == "task_selection"
              and isinstance(state.get("tasks"), list) and len(state["tasks"]) <= 10 and all(_task(t) for t in state["tasks"])
              and (state.get("selected_task_id") in (None, "") or bool(OBJECT_ID.match(str(state.get("selected_task_id"))))))
    else:
        params, missing = state.get("params"), state.get("missing")
        ok = (set(state) <= {"command_key", "params", "missing"} and isinstance(state.get("command_key"), str)
              and bool(COMMAND_KEY.match(state["command_key"])) and isinstance(params, dict) and len(params) <= 40
              and all(KEY.match(str(k)) and _text(v) for k, v in params.items())
              and isinstance(missing, list) and len(missing) <= 20 and all(isinstance(m, str) and KEY.match(m) for m in missing))
    if not ok:
        return "state_invalid"
    if any(JWT.search(s) or UUID.search(s) for s in _strings(state)):
        return "state_sensitive"
    return None


class FakeConversationServer:
    def __init__(self, owner_of):
        self.owner_of = owner_of  # token -> ownerId (como a API: a identidade vem do JWT)
        self.rows = {}
        self.calls = []
        self.offset = 0.0
        self.ttl = 900
        self.fail_before = {}
        self.lose_response = {}
        self.before_apply = {}
        self.require_secret = True

    def now(self):
        return time.time() + self.offset

    def view(self, conv, row, with_state=True):
        out = {"conversationId": conv, "version": row["version"], "expiresAt": row["expiresAt"], "updatedAt": row["updatedAt"]}
        if with_state:
            out["state"] = copy.deepcopy(row["state"])
        return out

    def live(self, owner, conv):
        row = self.rows.get((owner, conv))
        return row if row and row["expiresAt"] > self.now() else None

    def dispatch(self, name, token, apply):
        self.calls.append(name)
        if self.require_secret and len(str(os.getenv(OPERATIONS_SECRET_ENV) or "").strip()) < MIN_SECRET_LENGTH:
            raise APIError(NOT_CONFIGURED_REPLY, kind="not_configured", code="assistant_operations_not_configured")
        if name in self.fail_before:
            raise self.fail_before.pop(name)
        owner = self.owner_of(token)
        if owner is None:
            raise APIError("HTTP 401 nas conversas do assistente: erro", kind="http", status_code=401)
        hook = self.before_apply.pop(name, None)
        if hook:
            hook()
        result = apply(owner)
        if name in self.lose_response:
            raise self.lose_response.pop(name)
        return result

    @staticmethod
    def refuse(status, code, **extra):
        return APIError(f"HTTP {status} nas conversas do assistente: {code}", kind="http", status_code=status, code=code)

    def current(self, token, conv):
        def apply(owner):
            row = self.live(owner, conv)
            return self.view(conv, row) if row else None
        return self.dispatch("current", token, apply)

    def save(self, token, conv, expected, state):
        def apply(owner):
            refusal = state_refusal(state, memory=conv.endswith(":memoria"))
            if refusal:
                raise self.refuse(400, refusal)
            row, live = self.rows.get((owner, conv)), self.live(owner, conv)
            if (live and live["version"] != expected) or (not live and expected != 0):
                raise self.refuse(409, "context_version_conflict")
            t = self.now()
            version = (row["version"] + 1) if row else 1
            self.rows[(owner, conv)] = {"version": version, "state": copy.deepcopy(state), "expiresAt": t + self.ttl, "updatedAt": t}
            return self.view(conv, self.rows[(owner, conv)], with_state=False)
        return self.dispatch("save", token, apply)

    def clear(self, token, conv, expected=None):
        def apply(owner):
            row, live = self.rows.get((owner, conv)), self.live(owner, conv)
            if expected is None:
                return self.rows.pop((owner, conv), None) is not None
            if expected == 0:
                if live:
                    raise self.refuse(409, "context_version_conflict")
                return self.rows.pop((owner, conv), None) is not None
            if row and row["version"] == expected:
                del self.rows[(owner, conv)]
                return True
            if live:
                raise self.refuse(409, "context_version_conflict")
            return False
        return self.dispatch("clear", token, apply)

    # --- acesso direto (terceiro / banco), sem validacao -------------------------------------------------------
    def put_raw(self, owner, conv, state):
        row, t = self.rows.get((owner, conv)), self.now()
        self.rows[(owner, conv)] = {"version": (row["version"] + 1) if row else 1, "state": copy.deepcopy(state),
                                    "expiresAt": t + self.ttl, "updatedAt": t}

    def get_raw(self, owner, conv):
        row = self.live(owner, conv)
        return copy.deepcopy(row["state"]) if row else None


class FakeConversationClient:
    """Mesma interface publica do ConversationStateClient, falando com FakeConversationClient.server."""

    server = None

    def __init__(self, token, *, timeout_sec=5.0):
        self.token = token
        self.timeout_sec = timeout_sec

    def current(self, *, conversation_id):
        return self.server.current(self.token, conversation_id)

    def save(self, *, conversation_id, expected_version, state):
        return self.server.save(self.token, conversation_id, expected_version, state)

    def clear(self, *, conversation_id, expected_version=None):
        return self.server.clear(self.token, conversation_id, expected_version)


class ConversationStateRepository:
    """Fachada de teste (interface antiga): o 'repositorio' e o servidor falso atual."""

    def __init__(self, path=None):
        self.server = FakeConversationClient.server

    def get(self, conversation_id):
        """Estado sem dono (chave global): nunca existe no contexto compartilhado."""
        return next((row["state"] for (owner, conv), row in self.server.rows.items() if not owner and conv == conversation_id), None)


class ScopedConversationState:
    """Fachada de teste: le/grava direto no servidor falso para um dono, como um terceiro (estado antigo/forjado)."""

    def __init__(self, repository, owner_id):
        self.server = repository.server
        self.owner_id = owner_id

    def get(self, conversation_id):
        return self.server.get_raw(self.owner_id, conversation_id)

    def save(self, conversation_id, state):
        self.server.put_raw(self.owner_id, conversation_id, state)

    def clear(self, conversation_id):
        self.server.rows.pop((self.owner_id, conversation_id), None)


def install(testcase, owner_by_token, *, secret=True):
    """Liga o servidor falso ao MessageAgent (e ao standby) num TestCase; devolve o servidor.

    secret=False: nao define o segredo interno no ambiente (o falso dispensa a conferencia), para testes que
    precisam do segredo ausente em outras partes (ex.: confirmacoes nao configuradas)."""
    from flowly_assistant.assistant_core import message_agent

    server = FakeConversationServer(lambda token: (owner_by_token.get(token) or {}).get("_id"))
    server.require_secret = secret
    FakeConversationClient.server = server
    targets = [patch.object(message_agent, "ConversationStateClient", FakeConversationClient)]
    if secret:
        targets.append(patch.dict(os.environ, {OPERATIONS_SECRET_ENV: os.getenv(OPERATIONS_SECRET_ENV) or TEST_SECRET}))
    for target in targets:
        target.start()
        testcase.addCleanup(target.stop)
    return server
