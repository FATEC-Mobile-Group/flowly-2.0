"""Continuidade da conversa com uma lista de tarefas aberta.

Uma nova listagem de leitura ("ver minhas atividades", "listar tarefas", "e as atrasadas?") substitui a lista
anterior; acompanhamentos ("detalhes da tarefa 1", "e quais sao as mais urgentes?") continuam na lista atual;
pedido que mistura listagem geral e numero de tarefa pergunta antes. Nenhuma escrita, permissoes inalteradas.

API e contexto compartilhado simulados (sem rede, banco ou dado real).
"""

from datetime import datetime, timezone
from unittest.mock import patch

from test_read_responses import PROFILES, ReadResponseTestCase, make_task  # noqa: F401
from fake_conversations import ConversationStateRepository, ScopedConversationState

from flowly_assistant import task_queries
from flowly_assistant.api_client import APIError, FlowlyAPIClient
from flowly_assistant.assistant_core import message_agent

CONV = "voice-continuidade-1"
INVALID_SELECTION = "Não identifiquei uma única tarefa"


class ListingContextTests(ReadResponseTestCase):
    def setUp(self):
        super().setUp()
        clock = patch.object(task_queries, "_now", lambda: datetime(2026, 12, 5, 15, tzinfo=timezone.utc))
        clock.start()
        self.addCleanup(clock.stop)

    def say(self, content, token="token-user", conversation_id=CONV):
        return self.send(token, content, conversation_id)

    def selection(self, token="token-user", conversation_id=CONV):
        state = ScopedConversationState(ConversationStateRepository(), PROFILES[token]["_id"]).get(conversation_id)
        return [t["descricao"] for t in (state or {}).get("tasks", [])] if state else None

    def detail_calls(self):
        return [path for _m, path in self.api.calls if path.endswith("/detalhes")]

    def test_new_listing_replaces_open_list_instead_of_invalid_selection(self):
        payload, status = self.say("listar tarefas")
        self.assertEqual((status, payload["command"]["key"]), (200, "my_tasks"))
        for phrase in ("ver minhas atividades", "mostrar minhas tarefas", "quais tarefas tenho?", "listar tarefas", "backlog"):
            with self.subTest(phrase=phrase):
                payload, status = self.say(phrase)
                self.assertEqual(status, 200, payload)
                self.assertTrue(payload["ok"], payload)
                self.assertNotIn(INVALID_SELECTION, payload["reply_text"])
                self.assertTrue(payload["reply_text"].startswith("Encontrei 12 tarefas."), payload["reply_text"])
                self.assertEqual(payload["conversation"]["status"], "browsing_tasks")

    def test_period_queries_and_summary_after_a_listing(self):
        self.say("listar tarefas")
        for phrase, key in (("quais são minhas tarefas de hoje?", "tasks_today"), ("e as atrasadas?", "tasks_overdue"),
                            ("como está meu dia?", "tasks_summary"), ("mostre minhas pendências", "tasks_pending")):
            with self.subTest(phrase=phrase):
                payload, status = self.say(phrase)
                self.assertEqual((status, payload["command"]["key"]), (200, key), payload)
                self.assertNotIn(INVALID_SELECTION, payload["reply_text"])

    def test_follow_ups_keep_using_the_current_list(self):
        self.say("listar tarefas")
        payload, status = self.say("detalhes da tarefa 1")
        self.assertEqual(status, 200, payload)
        self.assertIn("Atividade 01", payload["reply_text"])
        self.assertEqual(self.detail_calls(), [f"/tarefas/{make_task(1)['_id']}/detalhes"])

        self.say("listar tarefas")
        task_calls = lambda: [p for _m, p in self.api.calls if p.startswith("/tarefas")]  # noqa: E731
        calls_before = len(task_calls())
        payload, _ = self.say("e quais são as mais urgentes?")
        self.assertIn("urgência alta", payload["reply_text"])
        self.assertEqual(len(task_calls()), calls_before)  # sem nova consulta de tarefas
        self.assertFalse(payload["action_executed"])

    def test_old_list_is_not_reused_after_a_new_listing(self):
        self.say("listar tarefas")
        self.api.tasks = [make_task(30), make_task(31)]
        self.say("ver minhas atividades")
        self.assertEqual(self.selection(), ["Atividade 30", "Atividade 31"])
        self.say("detalhes da tarefa 2")
        self.assertEqual(self.detail_calls(), [f"/tarefas/{make_task(31)['_id']}/detalhes"])

        # Nova lista vazia: a selecao anterior deixa de valer.
        self.api.tasks = []
        payload, _ = self.say("minhas tarefas")
        self.assertEqual(payload["reply_text"], "Não encontrei tarefas para listar.")
        self.assertIsNone(self.selection())

    def test_listing_with_a_task_number_asks_instead_of_guessing(self):
        self.say("listar tarefas")
        payload, status = self.say("listar tarefas 2")
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["reply_text"], message_agent.AMBIGUOUS_LISTING_REPLY)
        self.assertFalse(payload["action_executed"])
        self.assertEqual(len(self.selection()), 10)  # lista atual mantida
        self.assertEqual(self.detail_calls(), [])

    def test_admin_keeps_general_listing_and_failed_query_keeps_the_list(self):
        payload, _ = self.say("listar tarefas", token="token-admin", conversation_id="admin-conv")
        self.assertEqual(payload["command"]["key"], "list_tasks")
        payload, _ = self.say("listar tarefas", token="token-admin", conversation_id="admin-conv")
        self.assertEqual((payload["ok"], payload["command"]["key"]), (True, "list_tasks"))
        payload, status = self.say("minhas tarefas", token="token-admin", conversation_id="admin-conv")
        self.assertEqual((payload["ok"], status), (False, 403))
        self.assertEqual(len(self.selection("token-admin", "admin-conv")), 10)

    def test_selections_are_not_shared_between_users(self):
        self.say("listar tarefas")
        self.assertIsNone(self.selection("token-admin"))
        payload, _ = self.say("a 1", token="token-admin")
        self.assertNotIn("Atividade 01", payload["reply_text"])
        self.assertEqual(self.detail_calls(), [])

    def test_pending_write_confirmation_is_never_executed_by_a_listing(self):
        ScopedConversationState(ConversationStateRepository(), PROFILES["token-user"]["_id"]).save(
            CONV, {"mode": "write_confirmation", "command_key": "assign_to_me", "params": {"task_id": make_task(1)["_id"]}},
        )
        payload, _ = self.say("listar tarefas")
        self.assertIn("Nada foi alterado", payload["reply_text"])
        payload, _ = self.say("confirmar")
        self.assertIn("Nada foi alterado", payload["reply_text"])
        # Depois de uma nova lista, pedir escrita continua barrado pela chave (desligada nos testes).
        self.say("listar tarefas")
        payload, _ = self.say("atribuir a tarefa 1 para mim")
        self.assertFalse(payload["action_executed"])

    def test_api_failure_is_not_reported_as_no_tasks_and_keeps_the_list(self):
        self.say("listar tarefas")
        original = FlowlyAPIClient.request

        def failing(client, method, path, **kwargs):
            if path == "/tarefas/minhas":
                raise APIError("HTTP 503 em GET /tarefas/minhas: indisponível", kind="http", status_code=503)
            return original(client, method, path, **kwargs)

        with patch.object(FlowlyAPIClient, "request", failing):
            payload, _ = self.say("ver minhas atividades")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["reply_text"], message_agent.TASK_QUERY_UNAVAILABLE_REPLY)
        self.assertNotIn("Não encontrei", payload["reply_text"])
        self.assertEqual(len(self.selection()), 10)

    def test_shared_context_unavailable_allows_only_direct_reads(self):
        self.say("listar tarefas")
        down = APIError("HTTP 503 nas conversas", kind="http", status_code=503, code="database_unavailable")
        self.conversations.fail_before["current"] = down
        payload, status = self.say("ver minhas atividades")
        self.assertEqual(status, 200, payload)
        self.assertNotIn("options", payload.get("conversation") or {})
        self.conversations.fail_before["current"] = down
        payload, status = self.say("detalhes da tarefa 1")
        self.assertEqual(status, 503)
        self.assertFalse(payload["action_executed"])
