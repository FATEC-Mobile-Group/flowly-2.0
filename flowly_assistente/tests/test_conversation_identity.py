"""DC-01 — identidade e estado de conversa vinculados ao usuário autenticado.

A API do Flowly é simulada: o /users/me falso devolve a identidade de cada token.
Nenhuma rede, banco ou usuário real é utilizado.
"""

import json
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

# Mesmo fallback dos demais testes: permite rodar sem as dependências opcionais.
for _module in ("requests", "dotenv"):
    try:
        __import__(_module)
    except ModuleNotFoundError:
        sys.modules[_module] = types.SimpleNamespace(
            Timeout=TimeoutError,
            RequestException=RuntimeError,
            request=lambda *args, **kwargs: None,
            load_dotenv=lambda *args, **kwargs: None,
        )

import function  # noqa: E402
from flowly_assistant.api_client import APIError, FlowlyAPIClient  # noqa: E402
from flowly_assistant.assistant_core import message_agent  # noqa: E402
from flowly_assistant.storage.analytics_repository import AnalyticsRepository  # noqa: E402
from flowly_assistant.storage.conversation_state import (  # noqa: E402
    ConversationStateRepository,
    ScopedConversationState,
)

USERS_BY_TOKEN = {
    "token-A": {"_id": "user-A", "nome": "Usuario A", "tipo": "user"},
    "token-B": {"_id": "user-B", "nome": "Usuario B", "tipo": "user"},
}
CONVERSATION_ID = "voice-compartilhado-1767225600000"
TEAM_A = "aaaaaaaaaaaaaaaaaaaaaaaa"
TEAM_B = "64b7f0c2a1b2c3d4e5f60718"
TEAMS_BY_TOKEN = {
    "token-A": [{"_id": TEAM_A, "nome": "Equipe Alfa"}],
    "token-B": [{"_id": TEAM_B, "nome": "Equipe Beta"}],
}


def fake_me(client):
    if client.token not in USERS_BY_TOKEN:
        raise APIError("HTTP 401 em GET /users/me: Token inválido")
    return USERS_BY_TOKEN[client.token]


def fake_request(client, method, path, **kwargs):
    if method == "GET" and path == "/equipes/minhas":
        return TEAMS_BY_TOKEN[client.token]
    if method == "GET" and path.startswith("/equipes/") and path.endswith("/membros"):
        return []
    raise AssertionError(f"Chamada inesperada à API: {method} {path}")


class FakeRequest:
    def __init__(self, path, body, token=None):
        self.method = "POST"
        self.path = path
        self._body = body
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}

    def get_json(self, silent=True):
        return self._body


class ConversationIdentityTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = patch.dict(
            os.environ,
            {
                "FLOWLY_CONVERSATION_STORE": os.path.join(tmp.name, "state.json"),
                "FLOWLY_API_BASE_URL": "https://api.flowly.test/api",
            },
        )
        env.start()
        self.addCleanup(env.stop)

        self.events = []
        for target, replacement in (
            (patch.object(FlowlyAPIClient, "me", fake_me), None),
            (patch.object(FlowlyAPIClient, "request", fake_request), None),
            (
                patch.object(
                    message_agent.AnalyticsQueue,
                    "publish_message",
                    lambda queue, event: self.events.append(event) or {"queued": True},
                ),
                None,
            ),
        ):
            target.start()
            self.addCleanup(target.stop)

        self.repository = ConversationStateRepository()

    def state_of(self, user_id, conversation_id=CONVERSATION_ID):
        return ScopedConversationState(ConversationStateRepository(), user_id).get(conversation_id)

    def send(self, token, content, **extra):
        body = {"conversationId": CONVERSATION_ID, "content": content, **extra}
        raw, status, _headers = function.flowly_http(FakeRequest("/api/v1/messages", body, token))
        return json.loads(raw), status

    def standby(self, token=None, conversation_id=CONVERSATION_ID):
        raw, status, _headers = function.flowly_http(
            FakeRequest("/standby", {"conversationId": conversation_id}, token)
        )
        return json.loads(raw), status

    # A / F — userId falsificado e analytics
    def test_forged_user_id_in_body_is_ignored_for_identity_and_analytics(self):
        payload, status = self.send("token-A", "criar tarefa", userId="user-B", user_id="user-B")

        self.assertLess(status, 400, payload)
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0]["userId"], "user-A")
        self.assertIsNotNone(self.state_of("user-A"))
        self.assertIsNone(self.state_of("user-B"))

    def test_invalid_token_is_rejected_before_state_and_analytics(self):
        ScopedConversationState(self.repository, "user-B").save(
            CONVERSATION_ID, {"command_key": "create_team", "params": {}, "missing": ["nome"]}
        )

        payload, status = self.send("token-invalido", "Equipe Invasora", userId="user-B")

        self.assertEqual(status, 401)
        self.assertEqual(payload["error"], "unauthorized")
        self.assertEqual(self.events, [])
        self.assertEqual(self.state_of("user-B")["params"], {})

    # B — conversas isoladas
    def test_same_conversation_id_keeps_independent_states(self):
        self.send("token-A", "criar tarefa")
        self.send("token-B", "criar equipe")

        self.assertEqual(self.state_of("user-A")["command_key"], "create_task")
        self.assertEqual(self.state_of("user-B")["command_key"], "create_team")
        self.assertIsNone(self.repository.get(CONVERSATION_ID))

    # C — continuidade da conversa
    def test_pending_command_of_a_cannot_be_continued_by_b(self):
        self.send("token-A", "criar tarefa")
        state_before = self.state_of("user-A")

        payload, _status = self.send("token-B", "relatorio")

        state_after = self.state_of("user-A")
        self.assertEqual(state_after["params"], state_before["params"])
        self.assertEqual(state_after["missing"], state_before["missing"])
        self.assertNotEqual((payload.get("conversation") or {}).get("status"), "awaiting_params")
        self.assertIsNone(self.state_of("user-B"))

    def test_same_user_continues_own_pending_command(self):
        self.send("token-A", "criar tarefa")

        payload, _status = self.send("token-A", "relatorio")

        state = self.state_of("user-A")
        self.assertTrue(state["params"].get("nome"))
        self.assertEqual(state["missing"][0], "descricao")
        self.assertEqual(payload["conversation"]["id"], CONVERSATION_ID)
        self.assertEqual(payload["conversation"]["status"], "awaiting_params")

    def test_task_list_of_a_is_not_exposed_to_b(self):
        ScopedConversationState(self.repository, "user-A").save(
            CONVERSATION_ID,
            {"mode": "task_selection", "tasks": [{"_id": "t1", "descricao": "Relatorio confidencial"}]},
        )

        payload_b, _status = self.send("token-B", "primeira")
        payload_a, _status = self.send("token-A", "primeira")

        self.assertNotIn("Relatorio confidencial", payload_b["reply_text"])
        self.assertIn("Relatorio confidencial", payload_a["reply_text"])

    def test_cancel_clears_only_own_state(self):
        self.send("token-A", "criar tarefa")
        ScopedConversationState(self.repository, "user-B").save(
            CONVERSATION_ID,
            {"mode": "task_selection", "tasks": [{"_id": "t2", "descricao": "Tarefa de B"}]},
        )

        payload, _status = self.send("token-B", "sair")

        self.assertEqual(payload["conversation"]["status"], "cancelled")
        self.assertIsNone(self.state_of("user-B"))
        self.assertIsNotNone(self.state_of("user-A"))

    # D — standby sem autenticação
    def test_standby_without_token_is_rejected(self):
        self.send("token-A", "criar tarefa")

        payload, status = self.standby(token=None)

        self.assertEqual(status, 401)
        self.assertFalse(payload["ok"])
        self.assertIsNotNone(self.state_of("user-A"))

    def test_standby_with_invalid_token_is_rejected(self):
        self.send("token-A", "criar tarefa")

        payload, status = self.standby(token="token-invalido")

        self.assertEqual(status, 401)
        self.assertEqual(payload["error"], "unauthorized")
        self.assertIsNotNone(self.state_of("user-A"))

    # E — standby entre usuários
    def test_standby_of_b_does_not_clear_conversation_of_a(self):
        self.send("token-A", "criar tarefa")
        self.send("token-B", "criar equipe")

        _payload, status = self.standby(token="token-B")

        self.assertEqual(status, 200)
        self.assertIsNone(self.state_of("user-B"))
        self.assertIsNotNone(self.state_of("user-A"))

    def test_standby_of_own_conversation_keeps_response_contract(self):
        self.send("token-A", "criar tarefa")

        payload, status = self.standby(token="token-A")

        self.assertEqual(status, 200)
        self.assertEqual(
            payload,
            {
                "ok": True,
                "status": "standby",
                "reply_text": "Assistente em standby.",
                "tts": {"enabled": False, "language": "pt-BR", "text": "Assistente em standby."},
            },
        )
        self.assertIsNone(self.state_of("user-A"))

    # Contexto de equipe e canal no analytics
    def persisted_document(self, event):
        """Documento que o AnalyticsRepository gravaria no MongoDB (bson simulado)."""
        repository = AnalyticsRepository.__new__(AnalyticsRepository)
        collection = types.SimpleNamespace(calls=[])
        collection.update_one = lambda flt, update, upsert: collection.calls.append(update)
        repository._collection = lambda: collection
        fake_object_id = lambda value: f"ObjectId({value})" if value and len(value) == 24 else None
        with patch.object(AnalyticsRepository, "_object_id", lambda repo, value: fake_object_id(value)):
            repository._save_to_mongodb(event, {"sentiment": "negativo"})
        return collection.calls[0]["$set"]

    def test_forged_team_fields_in_body_are_ignored(self):
        self.send("token-A", "odeio essa equipe", teamId=TEAM_B, teamName="Equipe de B")

        event = self.events[-1]
        self.assertIsNone(event["teamId"])
        self.assertIsNone(event["teamName"])
        self.assertNotIn("teamId", self.persisted_document(event))

    def test_channel_id_with_object_id_is_not_used_as_team(self):
        self.send("token-A", "odeio essa equipe", channelId=TEAM_B)

        event = self.events[-1]
        self.assertEqual(event["channelId"], "web")
        document = self.persisted_document(event)
        self.assertEqual(document["channelId"], "web")
        self.assertNotIn("teamId", document)

    def test_legitimate_channel_id_is_preserved(self):
        self.send("token-A", "oi", channelId="voice-assistant")

        self.assertEqual(self.events[-1]["channelId"], "voice-assistant")
        self.assertEqual(self.persisted_document(self.events[-1])["channelId"], "voice-assistant")

    def test_team_of_authenticated_user_is_resolved_by_name(self):
        self.send("token-A", "membros da equipe alfa")

        event = self.events[-1]
        self.assertEqual(event["teamId"], TEAM_A)
        self.assertEqual(event["teamName"], "Equipe Alfa")
        self.assertEqual(self.persisted_document(event)["teamId"], f"ObjectId({TEAM_A})")

    def test_object_id_of_own_team_in_content_is_accepted(self):
        self.send("token-A", f"membros da equipe {TEAM_A}")

        self.assertEqual(self.events[-1]["teamId"], TEAM_A)
        self.assertEqual(self.events[-1]["teamName"], "Equipe Alfa")

    def test_object_id_of_foreign_team_in_content_is_ignored(self):
        self.send("token-A", f"membros da equipe {TEAM_B}")

        event = self.events[-1]
        self.assertIsNone(event["teamId"])
        self.assertIsNone(event["teamName"])
        self.assertNotIn("teamId", self.persisted_document(event))

    def test_all_forged_fields_together_keep_authenticated_identity(self):
        self.send(
            "token-A",
            "odeio essa equipe",
            userId="user-B",
            user_id="user-B",
            teamId=TEAM_B,
            team_id=TEAM_B,
            teamName="Equipe de B",
            team_name="Equipe de B",
            channelId=TEAM_B,
        )

        event = self.events[-1]
        self.assertEqual(event["userId"], "user-A")
        self.assertIsNone(event["teamId"])
        self.assertIsNone(event["teamName"])
        self.assertEqual(event["channelId"], "web")
        document = self.persisted_document(event)
        self.assertEqual(document["userId"], "user-A")
        self.assertNotIn("teamId", document)
        self.assertIsNone(document["teamName"])


if __name__ == "__main__":
    unittest.main()
