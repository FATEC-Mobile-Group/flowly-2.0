"""Compreensao natural basica e memoria curta da conversa (homologacao de 2026-11-22).

As tres mensagens reais que voltaram com "Mensagem recebida. Nao identifiquei uma acao imediata.":
  1. "Minha prioridade de hoje é revisar a apresentação do Flowly. Não crie tarefas."
  2. "Qual foi a prioridade que acabei de mencionar?"
  3. "Agora liste as tarefas que já tenho cadastradas."
A memoria fica num documento proprio ("<conversa>:memoria") do contexto compartilhado e nunca cria, confirma,
cancela ou executa nada. Servidores simulados; rede real bloqueada.
"""

import os
import unittest
from unittest.mock import patch

from test_command_safety import CONVERSATION_ID, TASKS, USERS_BY_TOKEN, AssistantFlowTestCase
from flowly_assistant.api_client import APIError  # noqa: E402
from flowly_assistant.assistant_core.message_agent import FALLBACK_REPLY, TASK_HELP_REPLY  # noqa: E402
from flowly_assistant.command_parser import CommandParser  # noqa: E402
from flowly_assistant.commands import WRITES_ENABLED_ENV  # noqa: E402
from flowly_assistant.storage.conversation_memory import asked_fact_label, extract_stated_fact  # noqa: E402

MSG_1 = "Minha prioridade de hoje é revisar a apresentação do Flowly. Não crie tarefas."
MSG_2 = "Qual foi a prioridade que acabei de mencionar?"
MSG_3 = "Agora liste as tarefas que já tenho cadastradas."
PRIORITY = "revisar a apresentação do Flowly"
USER = USERS_BY_TOKEN["token-user"]["_id"]
ADMIN = USERS_BY_TOKEN["token-admin"]["_id"]
OLD_FALLBACK = "Mensagem recebida. Não identifiquei uma ação imediata."


class NaturalConversationTestCase(AssistantFlowTestCase):
    def memory(self, owner=USER, conversation_id=CONVERSATION_ID):
        row = self.conversations.rows.get((owner, f"{conversation_id}:memoria"))
        return row["state"] if row and row["expiresAt"] > self.conversations.now() else None

    def task_reads(self):
        return [call for call in self.api.calls if call[:2] == ("GET", "/tarefas/minhas")]

    def assert_nothing_changed(self):
        self.assert_no_writes()
        self.assertEqual((self.ops.ops, self.ops.calls.count("claim")), ([], 0))


class HomologationMessagesTests(NaturalConversationTestCase):
    def test_the_three_real_messages_in_the_same_conversation(self):
        payload, status = self.send("token-user", MSG_1)
        self.assertEqual(status, 201, payload)
        self.assertFalse(payload["action_executed"])
        self.assertEqual(payload["conversation"]["status"], "noted")
        self.assertIn(f'"{PRIORITY}"', payload["reply_text"])
        self.assertIn("Não criei nem alterei nada", payload["reply_text"])
        self.assertNotEqual(payload["reply_text"], OLD_FALLBACK)
        self.assertEqual(self.memory(), {"mode": "conversation_memory", "facts": [{"label": "prioridade", "text": PRIORITY}]})
        self.assertIsNone(self.pending("token-user"))  # nada de comando pendente

        payload, status = self.send("token-user", MSG_2)
        self.assertEqual(status, 201, payload)
        self.assertFalse(payload["action_executed"])
        self.assertIn(PRIORITY, payload["reply_text"])
        self.assertIn("Você mencionou", payload["reply_text"])

        payload, status = self.send("token-user", MSG_3)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["command"]["key"], "my_tasks")
        self.assertTrue(payload["action_executed"])
        self.assertIn(TASKS[0]["descricao"], payload["reply_text"])
        self.assertEqual(len(self.task_reads()), 1)
        self.assert_nothing_changed()

    def test_message_one_never_creates_a_task_even_with_the_writes_switch_on(self):
        self.send("token-user", MSG_1)
        self.send("token-user", "confirmar")
        self.assert_nothing_changed()
        self.assertEqual(self.ops.calls.count("create"), 0)


class ListingParaphraseTests(unittest.TestCase):
    def test_direct_requests_for_own_tasks(self):
        parser = CommandParser(threshold=78)
        for phrase in (MSG_3, "quais tarefas tenho?", "Quais tarefas eu tenho?", "mostre minhas tarefas",
                       "me mostra as tarefas que tenho", "liste minhas tarefas",
                       "consegue listar minhas tarefas?", "quais são as minhas tarefas", "exiba as tarefas que tenho"):
            with self.subTest(phrase=phrase):
                match = parser.match(phrase)
                self.assertIsNotNone(match)
                self.assertEqual(match.command.key, "my_tasks")
        # Com "hoje", a consulta passou a ser a das tarefas de hoje (somente leitura, ver test_task_queries.py).
        self.assertEqual(parser.match("que tarefas tenho hoje?").command.key, "tasks_today")

    def test_help_questions_negations_and_statements_are_not_listings(self):
        parser = CommandParser(threshold=78)
        for phrase in ("você consegue me ajudar a organizar minhas tarefas?", "como vejo minhas tarefas?",
                       "me ajuda a priorizar minhas tarefas", "não quero ver minhas tarefas", "Não crie tarefas.", MSG_1, MSG_2):
            with self.subTest(phrase=phrase):
                self.assertIsNone(parser.match(phrase))

    def test_existing_task_phrases_keep_their_commands(self):
        parser = CommandParser(threshold=78)
        for phrase, key in (("listar tarefas", "list_tasks"), ("listar as tarefas", "list_tasks"),
                            ("liste todas as tarefas", "list_tasks"), ("ver as tarefas", "my_tasks"),
                            ("backlog", "backlog"), ("minhas tarefas", "my_tasks")):
            with self.subTest(phrase=phrase):
                self.assertEqual(parser.match(phrase).command.key, key)


class FactRecognitionTests(unittest.TestCase):
    def test_statements_and_recall_questions(self):
        self.assertEqual(extract_stated_fact(MSG_1), ("prioridade", PRIORITY))
        self.assertEqual(extract_stated_fact("Meu foco do dia é terminar o relatório!"), ("foco", "terminar o relatório"))
        self.assertEqual(extract_stated_fact("minha meta da semana será entregar o MVP"), ("meta", "entregar o MVP"))
        self.assertEqual(extract_stated_fact('meu objetivo é "fechar o sprint"'), ("objetivo", "fechar o sprint"))
        for question in ("qual é minha prioridade?", "minha prioridade é qual?", "Qual foi a prioridade de hoje?",
                         "minha prioridade é", "não sei qual é a prioridade"):
            with self.subTest(question=question):
                self.assertIsNone(extract_stated_fact(question))
        self.assertEqual(asked_fact_label(MSG_2), "prioridade")
        self.assertEqual(asked_fact_label("qual é minha meta?"), "meta")
        self.assertEqual(asked_fact_label("você lembra do meu foco?"), "foco")
        self.assertIsNone(asked_fact_label("qual a prioridade da tarefa relatório?"))  # tarefa, nao a conversa
        self.assertIsNone(asked_fact_label("minhas tarefas"))


class MemoryBehaviourTests(NaturalConversationTestCase):
    def test_paraphrased_facts_are_kept_per_label_and_replaced(self):
        self.send("token-user", "meu foco do dia é terminar o relatório")
        self.send("token-user", "minha prioridade é estudar")
        self.send("token-user", "minha prioridade de hoje é revisar a apresentação")
        payload, _status = self.send("token-user", "qual é minha prioridade?")
        self.assertIn('"revisar a apresentação"', payload["reply_text"])
        payload, _status = self.send("token-user", "você lembra do meu foco?")
        self.assertIn('"terminar o relatório"', payload["reply_text"])
        self.assertEqual(len(self.memory()["facts"]), 2)
        self.assert_nothing_changed()

    def test_unknown_fact_is_never_invented(self):
        payload, status = self.send("token-user", MSG_2)
        self.assertEqual(status, 201)
        self.assertIn("Não tenho nenhuma prioridade registrada nesta conversa", payload["reply_text"])
        self.assertNotIn(PRIORITY, payload["reply_text"])

    def test_conversations_and_users_are_isolated(self):
        self.send("token-user", MSG_1)
        payload, _status = self.send("token-user", MSG_2, conversation_id="outra-conversa")
        self.assertIn("Não tenho nenhuma prioridade", payload["reply_text"])
        payload, _status = self.send("token-admin", MSG_2)  # mesmo conversationId, outra pessoa
        self.assertIn("Não tenho nenhuma prioridade", payload["reply_text"])
        self.assertIsNone(self.memory(ADMIN))

    def test_memory_expires_with_the_context_ttl(self):
        self.send("token-user", MSG_1)
        self.conversations.offset = self.conversations.ttl + 1
        payload, _status = self.send("token-user", MSG_2)
        self.assertIn("Não tenho nenhuma prioridade", payload["reply_text"])

    def test_statement_citing_a_command_is_only_noted(self):
        payload, _status = self.send("token-admin", "Minha prioridade é criar tarefa relatório semanal")
        self.assertEqual(payload["conversation"]["status"], "noted")
        self.assertIsNone(self.pending("token-admin"))
        self.assert_nothing_changed()
        self.assertEqual(self.ops.calls.count("create"), 0)

    def test_negative_alone_and_unknown_messages_get_a_useful_fallback(self):
        for phrase, expected in (("Não crie tarefas.", TASK_HELP_REPLY), ("bom dia", FALLBACK_REPLY),
                                 ("você consegue me ajudar a organizar minhas tarefas?", TASK_HELP_REPLY)):
            with self.subTest(phrase=phrase):
                payload, status = self.send("token-user", phrase)
                self.assertEqual((status, payload["reply_text"]), (201, expected))
                self.assertFalse(payload["action_executed"])
        self.assertEqual(self.task_reads(), [])
        self.assertIsNone(self.memory())
        self.assert_nothing_changed()

    def test_memory_does_not_interfere_with_pending_flows_or_confirmations(self):
        self.send("token-user", MSG_1)
        payload, _status = self.send("token-user", "mudar status da tarefa relatório final para concluído")
        self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation")
        payload, _status = self.send("token-user", MSG_2)  # pergunta durante a confirmacao: nada executa
        self.assertFalse(payload["action_executed"])
        self.assertEqual(self.ops.ops[-1]["status"], "pending")
        self.assertEqual(self.ops.calls.count("claim"), 0)
        self.assert_no_writes()


class MemorySafetyTests(NaturalConversationTestCase):
    def test_memory_store_unavailable_fails_honestly(self):
        down = APIError("HTTP 503", kind="http", status_code=503, code="database_unavailable")
        original = self.conversations.current

        def memory_down(token, conv):
            if conv.endswith(":memoria"):
                raise down
            return original(token, conv)

        with patch.object(self.conversations, "current", memory_down):
            payload, status = self.send("token-user", MSG_1)
            self.assertEqual((status, payload["error"]), (503, "conversation_memory_unavailable"))
            self.assertIn("Não consegui guardar", payload["reply_text"])
            payload, status = self.send("token-user", MSG_2)
            self.assertEqual(status, 503)
            self.assertNotIn(PRIORITY, payload["reply_text"])
        self.assert_nothing_changed()

    def test_context_unavailable_still_allows_the_direct_listing_only(self):
        down = APIError("HTTP 503", kind="http", status_code=503, code="database_unavailable")
        for phrase, expected_status in ((MSG_1, 503), (MSG_2, 503), (MSG_3, 200)):
            with self.subTest(phrase=phrase):
                self.conversations.fail_before["current"] = down
                payload, status = self.send("token-user", phrase)
                self.assertEqual(status, expected_status, payload)
        self.assertEqual(len(self.task_reads()), 1)
        self.assert_nothing_changed()

    def test_concurrent_memory_updates_never_lose_the_newer_fact(self):
        self.send("token-user", "minha prioridade é estudar")
        self.conversations.before_apply["save"] = lambda: self.send("token-user", "minha prioridade é dormir cedo")
        payload, status = self.send("token-user", MSG_1)
        self.assertEqual((status, payload["error"]), (409, "conversation_state_conflict"))
        self.assertEqual(self.memory()["facts"], [{"label": "prioridade", "text": "dormir cedo"}])

    def test_reserved_memory_key_cannot_be_used_as_a_conversation(self):
        payload, status = self.send_raw("token-user", "minhas tarefas", conversation_id=f"{CONVERSATION_ID}:memoria")
        self.assertEqual((status, payload["error"]), (400, "invalid_conversation"))
        self.assertEqual(self.task_reads(), [])

    def test_sensitive_values_are_refused(self):
        payload, status = self.send("token-user", "minha prioridade é guardar 1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d")
        self.assertEqual((status, payload["error"]), (400, "conversation_state_rejected"))
        payload, status = self.send("token-user", f"minha prioridade é {os.environ['ASSISTANT_OPERATIONS_SECRET']}")
        self.assertEqual((status, payload["error"]), (400, "conversation_state_rejected"))
        self.assertIsNone(self.memory())

    def test_standby_clears_the_conversation_memory(self):
        self.send("token-user", MSG_1)
        self.standby_raw("token-user")
        self.assertIsNone(self.memory())
        payload, _status = self.send("token-user", MSG_2)
        self.assertIn("Não tenho nenhuma prioridade", payload["reply_text"])

    def test_kill_switch_off_keeps_memory_and_reads_working(self):
        os.environ.pop(WRITES_ENABLED_ENV, None)
        self.assertEqual(self.send("token-user", MSG_1)[0]["conversation"]["status"], "noted")
        self.assertIn(PRIORITY, self.send("token-user", MSG_2)[0]["reply_text"])
        self.assertTrue(self.send("token-user", MSG_3)[0]["action_executed"])
        self.assert_nothing_changed()

    def standby_raw(self, token):
        import json
        import function
        from test_command_safety import FakeRequest

        raw, status, _headers = function.flowly_http(FakeRequest("/standby", {"conversationId": CONVERSATION_ID}, token))
        return json.loads(raw), status


if __name__ == "__main__":
    unittest.main()
