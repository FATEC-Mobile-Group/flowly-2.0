"""Etapa 6A.3: contexto das conversas compartilhado pela API (sem arquivo local em /tmp).

Parte 1: ConversationStateClient no nivel HTTP (requests.request simulado): destino, credenciais, corpo, versao.
Parte 2: MessageAgent com o servidor falso do contexto (tests/fake_conversations.py) e o das confirmacoes.
Cada mensagem HTTP cria um MessageAgent novo (como instancias diferentes do assistente): nada fica em memoria
entre mensagens, so no servidor. Numeracao (N) = item da lista de testes prioritarios da etapa.
"""

import json
import os
import unittest
from unittest.mock import patch

from test_command_safety import (
    BACKLOG_TASKS,
    CONVERSATION_ID,
    TASKS,
    USERS_BY_TOKEN,
    AssistantFlowTestCase,
    FakeRequest,
)
from test_operations_client import BASE, SECRET, TOKEN, FakeHttp, FakeResponse
import function  # noqa: E402
from fake_conversations import state_refusal  # noqa: E402
from flowly_assistant import operations_client  # noqa: E402
from flowly_assistant.api_client import APIError  # noqa: E402
from flowly_assistant.assistant_core.message_agent import (  # noqa: E402
    CONTEXT_CONFLICT_REPLY,
    CONTEXT_DISCARDED_REPLY,
    CONTEXT_UNAVAILABLE_REPLY,
)
from flowly_assistant.commands import WRITES_DISABLED_REPLY, WRITES_ENABLED_ENV  # noqa: E402
from flowly_assistant.conversation_client import ConversationStateClient  # noqa: E402
from flowly_assistant.operations_client import OPERATIONS_SECRET_HEADER  # noqa: E402
from flowly_assistant.storage.conversation_state import (  # noqa: E402
    ConversationStateRejected,
    SharedConversationState,
)

RELATORIO = TASKS[0]["_id"]
STATUS_PHRASE = "mudar status da tarefa relatório final para concluído"
ADMIN = USERS_BY_TOKEN["token-admin"]["_id"]
USER = USERS_BY_TOKEN["token-user"]["_id"]


# ---------------------------------------------------------------------------------------------------------------
# Parte 1: cliente HTTP
# ---------------------------------------------------------------------------------------------------------------
class ConversationClientHttpTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {"FLOWLY_API_BASE_URL": BASE, "ASSISTANT_OPERATIONS_SECRET": SECRET})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(WRITES_ENABLED_ENV, None)  # o contexto nao depende da chave de escritas
        self.http = FakeHttp()
        target = patch.object(operations_client.requests, "request", self.http)
        target.start()
        self.addCleanup(target.stop)
        self.client = ConversationStateClient(TOKEN)

    def test_current_save_and_clear_use_fixed_routes_credentials_and_exact_bodies(self):
        context = {"conversationId": "web", "version": 3, "state": {"command_key": "create_team", "params": {}, "missing": ["nome"]},
                   "expiresAt": "2026-11-21T12:15:00.000Z", "updatedAt": "2026-11-21T12:00:00.000Z"}
        self.http.push(FakeResponse(200, {"ok": True, "context": context}),
                       FakeResponse(200, {"ok": True, "context": {**context, "version": 4}}),
                       FakeResponse(200, {"ok": True, "cleared": True}),
                       FakeResponse(200, {"ok": True, "cleared": False}))
        self.assertEqual(self.client.current(conversation_id="web"), context)
        self.client.save(conversation_id="web", expected_version=3, state=context["state"])
        self.assertTrue(self.client.clear(conversation_id="web", expected_version=4))
        self.assertFalse(self.client.clear(conversation_id="web"))
        methods = [(c["method"], c["url"]) for c in self.http.calls]
        self.assertEqual(methods, [("GET", f"{BASE}/assistant/conversations/current"),
                                   ("PUT", f"{BASE}/assistant/conversations/current"),
                                   ("POST", f"{BASE}/assistant/conversations/current/clear"),
                                   ("POST", f"{BASE}/assistant/conversations/current/clear")])
        self.assertEqual(self.http.calls[0]["params"], {"conversationId": "web"})
        self.assertEqual(self.http.calls[1]["json"], {"conversationId": "web", "expectedVersion": 3, "state": context["state"]})
        self.assertEqual(self.http.calls[2]["json"], {"conversationId": "web", "expectedVersion": 4})
        self.assertEqual(self.http.calls[3]["json"], {"conversationId": "web"})  # standby: incondicional
        for call in self.http.calls:
            self.assertEqual(call["headers"]["Authorization"], f"Bearer {TOKEN}")
            self.assertEqual(call["headers"][OPERATIONS_SECRET_HEADER], SECRET)
            self.assertIs(call["allow_redirects"], False)
            self.assertLessEqual(call["timeout"], 30)
            self.assertNotIn("userId", json.dumps(call["json"] or {}))

    def test_10_secret_missing_or_short_sends_nothing(self):
        for value in ("", "curto"):
            with self.subTest(secret=value), patch.dict(os.environ, {"ASSISTANT_OPERATIONS_SECRET": value}):
                with self.assertRaises(APIError) as caught:
                    self.client.current(conversation_id="web")
                self.assertEqual(caught.exception.kind, "not_configured")
        self.assertEqual(self.http.calls, [])

    def test_invalid_inputs_are_refused_before_the_network(self):
        for call in (lambda: self.client.current(conversation_id="com espaço"),
                     lambda: self.client.save(conversation_id="web", expected_version=-1, state={}),
                     lambda: self.client.save(conversation_id="web", expected_version=True, state={}),
                     lambda: self.client.save(conversation_id="web", expected_version=1, state=["x"]),
                     lambda: self.client.clear(conversation_id="web", expected_version="1")):
            with self.assertRaises(APIError) as caught:
                call()
            self.assertEqual(caught.exception.kind, "invalid_request")
        self.assertEqual(self.http.calls, [])

    def test_conflict_redirect_and_server_errors_are_structured(self):
        self.http.push(FakeResponse(409, {"ok": False, "code": "context_version_conflict", "version": 5}),
                       FakeResponse(302, None, headers={"Location": "https://outro.test"}),
                       FakeResponse(503, {"ok": False, "code": "context_indexes_missing"}))
        with self.assertRaises(APIError) as conflict:
            self.client.save(conversation_id="web", expected_version=4, state={})
        self.assertEqual((conflict.exception.status_code, conflict.exception.code), (409, "context_version_conflict"))
        with self.assertRaises(APIError) as redirect:
            self.client.current(conversation_id="web")
        self.assertEqual(redirect.exception.kind, "redirect")
        with self.assertRaises(APIError) as down:
            self.client.current(conversation_id="web")
        self.assertEqual((down.exception.status_code, down.exception.code), (503, "context_indexes_missing"))
        self.assertNotIn(SECRET, str(conflict.exception) + str(redirect.exception) + str(down.exception))


# ---------------------------------------------------------------------------------------------------------------
# Parte 2: MessageAgent com o contexto compartilhado
# ---------------------------------------------------------------------------------------------------------------
class SharedContextTestCase(AssistantFlowTestCase):
    def row(self, owner=ADMIN, conversation_id=CONVERSATION_ID):
        return self.conversations.rows.get((owner, conversation_id))

    def send_to(self, token, content, conversation_id=CONVERSATION_ID, **body):
        body = {"conversationId": conversation_id, "content": content, "channelId": "voice-assistant", **body}
        raw, status, _headers = function.flowly_http(FakeRequest("/api/v1/messages", body, token))
        return json.loads(raw), status

    def standby(self, token, conversation_id=CONVERSATION_ID):
        raw, status, _headers = function.flowly_http(FakeRequest("/standby", {"conversationId": conversation_id}, token))
        return json.loads(raw), status


class ContinuityTests(SharedContextTestCase):
    def test_01_question_from_instance_a_answered_on_instance_b(self):
        payload, _status = self.send("token-admin", "criar equipe")  # instancia A
        self.assertEqual(payload["conversation"]["status"], "awaiting_params")
        self.assertEqual(self.row()["state"], {"command_key": "create_team", "params": {}, "missing": ["nome"]})
        self.assertFalse(os.path.exists(os.environ["FLOWLY_CONVERSATION_STORE"]))  # nada local
        payload, _status = self.send("token-admin", "Marketing")  # instancia B
        self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation", payload)
        self.assertIsNone(self.row())  # coleta encerrada: a confirmacao fica em AssistantOperation
        self.assertEqual(self.ops.ops[-1]["params"], {"nome": "Marketing"})
        self.assert_no_writes()

    def test_02_task_selection_is_kept_between_instances(self):
        self.api.backlog = BACKLOG_TASKS
        self.send("token-user", "backlog")
        state = self.row(USER)["state"]
        self.assertEqual((state["mode"], len(state["tasks"])), ("task_selection", 10))
        payload, _status = self.send("token-user", "3")
        self.assertEqual(payload["conversation"]["status"], "awaiting_task_action", payload)
        self.assertEqual(self.row(USER)["state"]["selected_task_id"], BACKLOG_TASKS[2]["_id"])
        payload, _status = self.send("token-user", "detalhes")
        self.assertTrue(payload["action_executed"], payload)
        self.assertIn(BACKLOG_TASKS[2]["descricao"], payload["reply_text"])
        self.assert_no_writes()

    def test_03_two_users_with_the_same_conversation_id_do_not_share(self):
        self.send("token-admin", "criar equipe")
        self.send("token-user", "criar subtarefa")
        self.assertEqual(self.row(ADMIN)["state"]["command_key"], "create_team")
        self.assertEqual(self.row(USER)["state"]["command_key"], "add_subtask")
        self.send("token-user", "Marketing")  # resposta de outra pessoa: nunca vira o nome da equipe do admin
        self.assertEqual(self.row(ADMIN)["state"], {"command_key": "create_team", "params": {}, "missing": ["nome"]})
        self.assertEqual(self.ops.ops, [])
        self.assert_no_writes()

    def test_04_two_conversations_of_the_same_user_are_independent(self):
        self.send_to("token-admin", "criar equipe", "conversa-a")
        self.send_to("token-admin", "criar tarefa", "conversa-b")
        self.assertEqual(self.row(ADMIN, "conversa-a")["state"]["command_key"], "create_team")
        self.assertEqual(self.row(ADMIN, "conversa-b")["state"]["command_key"], "create_task")
        self.send_to("token-admin", "Marketing", "conversa-a")
        self.assertIsNone(self.row(ADMIN, "conversa-a"))
        self.assertEqual(self.row(ADMIN, "conversa-b")["state"]["missing"][0], "nome")


class ConcurrencyTests(SharedContextTestCase):
    def test_05_12_concurrent_answers_never_lose_the_newer_state(self):
        self.send("token-admin", "criar tarefa")
        seen = {}

        def newer_message_first():
            seen["inner"], _ = self.send("token-admin", "Relatório B")  # outra instancia grava antes

        self.conversations.before_apply["save"] = newer_message_first
        payload, status = self.send("token-admin", "Relatório A")  # leu antes; grava depois
        self.assertEqual((status, payload["error"], payload["reply_text"]),
                         (409, "conversation_state_conflict", CONTEXT_CONFLICT_REPLY))
        self.assertFalse(payload["action_executed"])
        self.assertEqual(seen["inner"]["conversation"]["status"], "awaiting_params")
        self.assertEqual(self.row()["state"]["params"]["nome"], "Relatório B")  # a mais nova ficou
        self.assert_no_writes()

    def test_12_old_message_does_not_revive_a_cancelled_flow(self):
        self.send("token-admin", "criar tarefa")
        self.conversations.before_apply["save"] = lambda: self.send("token-admin", "cancelar")
        payload, status = self.send("token-admin", "Relatório A")
        self.assertEqual((status, payload["error"]), (409, "conversation_state_conflict"))
        self.assertIsNone(self.row())  # o cancelamento vale
        self.assert_no_writes()

    def test_06_cancel_removes_only_the_right_context(self):
        self.send_to("token-admin", "criar equipe", "conversa-a")
        self.send_to("token-admin", "criar tarefa", "conversa-b")
        self.send_to("token-user", "criar subtarefa", "conversa-a")
        payload, _status = self.send_to("token-admin", "cancelar", "conversa-a")
        self.assertEqual(payload["conversation"]["status"], "cancelled")
        self.assertIsNone(self.row(ADMIN, "conversa-a"))
        self.assertIsNotNone(self.row(ADMIN, "conversa-b"))
        self.assertIsNotNone(self.row(USER, "conversa-a"))

    def test_07_expired_context_is_never_continued(self):
        self.send("token-admin", "criar equipe")
        self.conversations.offset = self.conversations.ttl + 1
        payload, _status = self.send("token-admin", "Marketing")
        self.assertNotEqual((payload.get("conversation") or {}).get("status"), "awaiting_confirmation")
        self.assertEqual(self.ops.ops, [])  # a resposta solta nao virou o nome da equipe
        self.assert_no_writes()


class FailClosedContextTests(SharedContextTestCase):
    def test_08_invalid_or_corrupt_state_is_discarded_not_interpreted(self):
        for state in ({"mode": "outro", "tasks": []}, {"command_key": 7, "params": {}, "missing": []},
                      {"mode": "task_selection", "tasks": "1"}, ["lista"]):
            with self.subTest(state=state):
                self.conversations.put_raw(ADMIN, CONVERSATION_ID, state)
                payload, status = self.send("token-admin", "1")
                self.assertEqual((status, payload["reply_text"]), (409, CONTEXT_DISCARDED_REPLY))
                self.assertIsNone(self.row())  # limpo (condicional ao version lido)
        payload, _status = self.send("token-admin", "listar equipes")  # depois, tudo normal
        self.assertTrue(payload["action_executed"])
        self.assert_no_writes()

    def test_08b_corrupt_metadata_fails_closed(self):
        self.send("token-admin", "criar equipe")
        self.row()["version"] = "x"
        payload, status = self.send("token-admin", "Marketing")
        self.assertEqual((status, payload["reply_text"]), (503, CONTEXT_UNAVAILABLE_REPLY))
        self.assertEqual(self.ops.ops, [])
        self.assert_no_writes()

    def test_08c_old_local_write_confirmation_never_executes(self):
        self.conversations.put_raw(USER, CONVERSATION_ID, {
            "mode": "write_confirmation", "command": "update_status", "params": {"task_id": RELATORIO, "status": "concluido"}})
        payload, _status = self.send("token-user", "confirmar")
        self.assertEqual(payload["conversation"]["status"], "cancelled")
        self.assertIsNone(self.row(USER))
        self.assertEqual(self.ops.calls.count("claim"), 0)
        self.assert_no_writes()

    def test_09_store_unavailable_allows_only_direct_reads(self):
        self.send("token-user", "criar subtarefa")  # pergunta pendente guardada
        down = APIError("HTTP 503 nas conversas do assistente: database_unavailable", kind="http", status_code=503,
                        code="database_unavailable")
        for phrase in ("Revisar números", "3", "confirmar", "cancelar", STATUS_PHRASE, "criar equipe marketing"):
            with self.subTest(phrase=phrase):
                self.conversations.fail_before["current"] = down
                payload, status = self.send("token-user", phrase)
                self.assertEqual((status, payload["reply_text"]), (503, CONTEXT_UNAVAILABLE_REPLY), payload)
                self.assertFalse(payload["action_executed"])
        self.conversations.fail_before["current"] = down
        payload, status = self.send("token-user", "minhas tarefas")
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["action_executed"])
        self.assertNotIn("options", payload.get("conversation") or {})  # sem selecao guardada, nada e oferecido
        self.assertEqual(self.row(USER)["state"]["command_key"], "add_subtask")  # a pendente nao foi tocada
        self.assertEqual((self.ops.ops, self.ops.calls.count("claim")), ([], 0))
        self.assert_no_writes()

    def test_09b_save_failure_mid_flow_executes_nothing(self):
        self.send("token-admin", "criar tarefa")
        self.conversations.fail_before["save"] = APIError("Timeout", kind="timeout", may_have_executed=True)
        payload, status = self.send("token-admin", "Relatório")
        self.assertEqual((status, payload["error"]), (503, "conversation_state_unavailable"))
        self.assertEqual(self.ops.ops, [])
        self.assert_no_writes()

    def test_10_secret_missing_or_wrong(self):
        with patch.dict(os.environ, {"ASSISTANT_OPERATIONS_SECRET": ""}):
            payload, status = self.send("token-admin", "criar equipe")
        self.assertEqual((status, payload["reply_text"]), (503, CONTEXT_UNAVAILABLE_REPLY))
        self.conversations.fail_before["current"] = APIError("HTTP 401", kind="http", status_code=401,
                                                             code="assistant_secret_invalid")
        payload, status = self.send("token-admin", "criar equipe")
        self.assertEqual(status, 503)
        self.assertEqual(self.conversations.rows, {})
        self.assert_no_writes()

    def test_11_revoked_session_touches_no_context(self):
        self.send("token-admin", "criar equipe")
        calls = len(self.conversations.calls)
        revoked = dict(USERS_BY_TOKEN)
        revoked.pop("token-admin")
        with patch.dict(USERS_BY_TOKEN, revoked, clear=True):
            payload, status = self.send("token-admin", "Marketing")
            standby, standby_status = self.standby("token-admin")
        self.assertEqual((status, standby_status), (401, 401))
        self.assertEqual(len(self.conversations.calls), calls)  # a autenticacao recusa antes do contexto
        self.assertEqual(self.row()["state"]["missing"], ["nome"])
        self.assert_no_writes()

    def test_credentials_and_keys_never_enter_the_context(self):
        self.send("token-admin", "criar tarefa")
        before = self.row()["version"]
        for answer in (f"nota {os.environ['ASSISTANT_OPERATIONS_SECRET']}", "chave 1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d",
                       "token-admin"):
            with self.subTest(answer=answer[:12]):
                payload, status = self.send("token-admin", answer)
                self.assertEqual((status, payload["error"]), (400, "conversation_state_rejected"), payload)
                self.assertFalse(payload["action_executed"])
        self.assertEqual(self.row()["version"], before)  # nada gravado
        stored = json.dumps(self.conversations.rows and {str(k): v for k, v in self.conversations.rows.items()})
        self.assertNotIn(os.environ["ASSISTANT_OPERATIONS_SECRET"], stored)
        self.assertIsNone(state_refusal(self.row()["state"]))
        adapter = SharedConversationState(None)
        with self.assertRaises(ConversationStateRejected):
            adapter.save(CONVERSATION_ID, {"mode": "write_confirmation"})  # recusado antes da rede


class SafetyPreservedTests(SharedContextTestCase):
    def test_13_write_confirmations_stay_in_assistant_operation(self):
        payload, _status = self.send("token-user", STATUS_PHRASE)
        self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation")
        self.assertIsNone(self.row(USER))  # o contexto nao guarda confirmacao
        self.assertEqual(self.ops.ops[-1]["status"], "pending")
        payload, _status = self.send("token-user", "confirmar")
        self.assertTrue(payload["action_executed"], payload)
        self.assertEqual(self.ops.ops[-1]["status"], "completed")
        self.assertEqual(self.ops.calls.count("claim"), 1)
        self.assertNotIn("write_confirmation", json.dumps({str(k): v for k, v in self.conversations.rows.items()}))

    def test_13b_context_never_authorizes_a_write(self):
        # Contexto forjado com todos os parametros de uma escrita: no maximo prepara a confirmacao compartilhada.
        self.conversations.put_raw(USER, CONVERSATION_ID, {
            "command_key": "update_status", "params": {"task_id": RELATORIO}, "missing": ["status"]})
        payload, _status = self.send("token-user", "concluído")
        self.assertFalse(payload["action_executed"])
        self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation", payload)
        self.assert_no_writes()

    def test_14_kill_switch(self):
        os.environ.pop(WRITES_ENABLED_ENV, None)
        payload, status = self.send("token-user", STATUS_PHRASE)
        self.assertEqual((status, payload["reply_text"]), (403, WRITES_DISABLED_REPLY))
        self.conversations.put_raw(USER, CONVERSATION_ID, {
            "command_key": "update_status", "params": {"task_id": RELATORIO}, "missing": ["status"]})
        payload, status = self.send("token-user", "concluído")
        self.assertFalse(payload["action_executed"])
        self.assertEqual((self.ops.ops, self.ops.calls.count("claim")), ([], 0))
        self.assert_no_writes()

    def test_15_read_commands_work_and_keep_their_contract(self):
        for token, phrase, key in (("token-user", "meu perfil", "me"), ("token-user", "minhas tarefas", "my_tasks"),
                                   ("token-admin", "listar equipes", "list_teams")):
            with self.subTest(phrase=phrase):
                payload, status = self.send(token, phrase)
                self.assertEqual((status, payload["command"]["key"]), (200, key))
                self.assertTrue(payload["action_executed"])
        self.assertEqual(self.row(USER)["state"]["mode"], "task_selection")
        self.assert_no_writes()

    def test_16_standby_clears_the_context_safely(self):
        self.send("token-admin", "criar equipe")
        self.send("token-user", "criar subtarefa")
        payload, status = self.standby("token-admin")
        self.assertEqual((status, payload), (200, {
            "ok": True, "status": "standby", "reply_text": "Assistente em standby.",
            "tts": {"enabled": False, "language": "pt-BR", "text": "Assistente em standby."}}))
        self.assertIsNone(self.row(ADMIN))
        self.assertIsNotNone(self.row(USER))  # so a conversa de quem pediu
        # Contexto indisponivel: standby continua, mas nao diz que limpou.
        self.conversations.fail_before["clear"] = APIError("HTTP 503", kind="http", status_code=503, code="database_unavailable")
        payload, status = self.standby("token-user")
        self.assertEqual((status, payload["context_cleared"]), (200, False))
        self.assertIn("Não consegui limpar", payload["reply_text"])
        self.assertIsNotNone(self.row(USER))
        self.assert_no_writes()

    def test_16b_standby_also_cancels_the_pending_confirmation(self):
        self.send("token-user", STATUS_PHRASE)
        self.standby("token-user")
        self.assertEqual(self.ops.ops[-1]["status"], "cancelled")
        self.send("token-user", "confirmar")
        self.assert_no_writes()


if __name__ == "__main__":
    unittest.main()
