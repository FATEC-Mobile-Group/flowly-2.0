"""Chave temporaria fail-closed das escritas do assistente (FLOWLY_ASSISTANT_WRITES_ENABLED).

Desligada (ausente, vazia ou qualquer valor diferente de true/1/yes/on): nenhum POST, PUT ou DELETE sai do
assistente, por nenhum caminho: frase direta, perguntas pendentes, resumo ja preparado, "confirmar", selecao de
tarefa, metodos do cliente HTTP. Consultas, autenticacao e permissoes seguem iguais.
Ligada: o fluxo de resumo + confirmacao continua valendo. /assist nunca escreve, nos dois modos.

A API do Flowly e simulada e a rede real e bloqueada: nenhum dado real e lido ou alterado.
"""

import json
import os
import unittest
from unittest.mock import patch
from urllib.parse import urlparse

from test_command_safety import (
    BACKLOG_TASKS,
    CONVERSATION_ID,
    TASKS,
    TEAM_ID,
    USERS_BY_TOKEN,
    AssistantFlowTestCase,
    FakeFlowlyAPI,
    FakeRequest,
)
import function  # noqa: E402
from flowly_assistant import api_client  # noqa: E402
from flowly_assistant.api_client import APIError, FlowlyAPIClient  # noqa: E402
from flowly_assistant.assistant_core import message_agent, rest_assistant  # noqa: E402
from flowly_assistant.assistant_core.rest_assistant import RestAssistant  # noqa: E402
from flowly_assistant.commands import (  # noqa: E402
    WRITES_DISABLED_REPLY,
    WRITES_ENABLED_ENV,
    assistant_writes_enabled,
    get_commands,
)
from flowly_assistant.storage.conversation_state import (  # noqa: E402
    ConversationStateRepository,
    ScopedConversationState,
)

RELATORIO = TASKS[0]["_id"]
STATUS_PHRASE = "mudar status da tarefa relatório final para concluído"
# Frases diretas e completas de cada escrita (as mesmas que, com a chave ligada, levam ao resumo).
DIRECT_WRITES = (
    ("token-admin", "criar equipe marketing", "create_team"),
    ("token-user", "atribuir para mim a tarefa relatório final da equipe alfa", "assign_to_me"),
    ("token-user", STATUS_PHRASE, "update_status"),
    ("token-user", "iniciar cronômetro da tarefa relatório final", "timer"),
    ("token-user", "comentar na tarefa relatório final dizendo revisar amanhã", "add_comment"),
    ("token-user", "criar subtarefa revisar números na tarefa relatório final", "add_subtask"),
)
# Inicio de fluxos com perguntas.
WRITE_STARTS = (("token-admin", "criar equipe"), ("token-admin", "criar tarefa"), ("token-user", "mudar status"),
                ("token-user", "cronômetro"), ("token-user", "adicionar comentário"), ("token-user", "adicionar subtarefa"))


def set_writes(value):
    """None remove a variavel (padrao); o patch.dict do setUp restaura o ambiente no fim."""
    if value is None:
        os.environ.pop(WRITES_ENABLED_ENV, None)
    else:
        os.environ[WRITES_ENABLED_ENV] = value


class WritesDisabledTestCase(AssistantFlowTestCase):
    def setUp(self):
        super().setUp()
        env = patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        set_writes(None)  # padrao seguro: ausente = desligada

    def assert_disabled(self, payload, status):
        self.assertEqual(status, 403, payload)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"], "assistant_writes_disabled")
        self.assertFalse(payload["action_executed"])
        self.assertEqual(payload["reply_text"], WRITES_DISABLED_REPLY)
        self.assertEqual(payload["tts"]["text"], WRITES_DISABLED_REPLY)
        self.assertNotIn("Confirme", payload["reply_text"])


class SwitchValueTests(unittest.TestCase):
    def test_only_explicit_true_values_enable_writes(self):
        with patch.dict(os.environ):
            for value, expected in ((None, False), ("", False), ("false", False), ("0", False), ("no", False),
                                    ("off", False), ("desligado", False), ("talvez", False), (" true ", True),
                                    ("TRUE", True), ("1", True), ("yes", True), ("on", True)):
                with self.subTest(value=value):
                    set_writes(value)
                    self.assertIs(assistant_writes_enabled(), expected)


class DisabledMessagesTests(WritesDisabledTestCase):
    def test_direct_complete_writes_are_refused_without_summary_or_state(self):
        for token, phrase, key in DIRECT_WRITES:
            with self.subTest(phrase=phrase):
                payload, status = self.send(token, phrase)
                self.assert_disabled(payload, status)
                self.assertEqual(payload["command"]["key"], key)
                self.assertIsNone(self.pending(token))
        self.assert_no_writes()

    def test_flows_with_questions_are_refused_before_the_first_question(self):
        for token, phrase in WRITE_STARTS:
            with self.subTest(phrase=phrase):
                payload, status = self.send(token, phrase)
                self.assert_disabled(payload, status)
                self.assertIsNone(self.pending(token))
        self.assert_no_writes()

    def test_client_params_do_not_bypass_the_switch(self):
        body = {"conversationId": CONVERSATION_ID, "content": "mudar status",
                "params": {"task_id": RELATORIO, "status": "concluido"}}
        raw, status, _ = function.flowly_http(FakeRequest("/api/v1/messages", body, "token-user"))
        self.assert_disabled(json.loads(raw), status)
        self.assert_no_writes()

    def test_pending_question_opened_before_the_switch_is_turned_off(self):
        set_writes("true")
        self.send("token-admin", "criar equipe")
        self.assertEqual(self.pending("token-admin")["missing"], ["nome"])
        set_writes(None)
        payload, status = self.send("token-admin", "Marketing")
        self.assert_disabled(payload, status)
        self.assertIsNone(self.pending("token-admin"))
        self.assert_no_writes()

    def test_summary_prepared_before_the_switch_is_turned_off_never_executes(self):
        for answer in ("confirmar", "sim, confirmo", "cancelar", "listar equipes"):
            with self.subTest(answer=answer):
                set_writes("true")
                payload, _status = self.send("token-user", STATUS_PHRASE)
                self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation")
                set_writes("false")
                payload, status = self.send("token-user", answer)
                self.assert_disabled(payload, status)
                self.assertIsNone(self.pending("token-user"))
                payload, _status = self.send("token-user", "confirmar")  # nada guardado para executar
                self.assertFalse(payload["action_executed"])
        self.assert_no_writes()

    def test_task_selection_cannot_assign_but_keeps_reading(self):
        self.api.backlog = BACKLOG_TASKS
        for steps in (("atribuir a 3 para mim",), ("3", "atribuir para mim"), ("3", "detalhes", "pegar essa tarefa")):
            with self.subTest(steps=steps):
                ScopedConversationState(ConversationStateRepository(), USERS_BY_TOKEN["token-user"]["_id"]).clear(CONVERSATION_ID)
                self.send("token-user", "backlog")
                for step in steps:
                    payload, status = self.send("token-user", step)
                self.assert_disabled(payload, status)
                # A lista continua: ainda da para ver detalhes.
                self.assertEqual(self.pending("token-user")["mode"], "task_selection")
                payload, status = self.send("token-user", "detalhes")
                self.assertEqual(status, 200, payload)
                self.assertTrue(payload["action_executed"])
        self.assert_no_writes()

    def test_reads_and_safe_replies_are_unchanged(self):
        for token, phrase, key in (("token-user", "meu perfil", "me"), ("token-user", "minhas tarefas", "my_tasks"),
                                   ("token-admin", "listar equipes", "list_teams"),
                                   ("token-admin", "minhas equipes", "my_teams")):
            with self.subTest(phrase=phrase):
                ScopedConversationState(ConversationStateRepository(), USERS_BY_TOKEN[token]["_id"]).clear(CONVERSATION_ID)
                payload, status = self.send(token, phrase)
                self.assertEqual(status, 200, payload)
                self.assertEqual(payload["command"]["key"], key)
                self.assertTrue(payload["action_executed"])
        # Pergunta, negacao, exclusao e "confirmar" sem nada pendente respondem como antes.
        self.assertIn("pergunta", self.send("token-admin", "como criar equipe marketing")[0]["reply_text"])
        self.assertEqual(self.send("token-admin", "excluir tarefa relatório final")[0]["error"], "command_disabled")
        self.assertIn("Não há nenhuma operação", self.send("token-admin", "confirmar")[0]["reply_text"])
        self.assert_no_writes()

    def test_authentication_is_still_checked_first(self):
        payload, status = self.send("token-invalido", "criar equipe marketing")
        self.assertEqual((status, payload["error"]), (401, "unauthorized"))
        self.assert_no_writes()

    def test_legacy_assist_route_stays_blocked_in_both_modes(self):
        for value in (None, "true"):
            with self.subTest(enabled=value):
                set_writes(value)
                raw, status, _ = function.flowly_http(FakeRequest(
                    "/assist", {"utterance": STATUS_PHRASE, "params": {"task_id": RELATORIO, "status": "concluido"}},
                    "token-user"))
                self.assertEqual((status, json.loads(raw)["error"]), (403, "write_requires_confirmation"))
        self.assert_no_writes()

    def test_rest_assistant_prepare_and_execute_refuse_when_disabled(self):
        assistant = RestAssistant(api_base_url="https://api.flowly.test/api", token="token-admin")
        create_team = next(c for c in get_commands() if c.key == "create_team")
        for call in (assistant.prepare_write, assistant.execute_prepared):
            with self.subTest(call=call.__name__):
                payload, status = call(create_team, {"nome": "Marketing"})
                self.assertEqual((status, payload["error"]), (403, "assistant_writes_disabled"))
        self.assert_no_writes()


class EnabledModeTests(AssistantFlowTestCase):
    """Chave ligada: o fluxo de resumo e confirmacao ja implementado continua funcionando."""

    def test_prepare_and_confirm_writes_exactly_once(self):
        payload, _status = self.send("token-user", STATUS_PHRASE)
        self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation")
        self.assert_no_writes()
        payload, _status = self.send("token-user", "confirmar")
        self.assertTrue(payload["action_executed"], payload["reply_text"])
        self.assertEqual(self.api.writes(), [("PUT", f"/tarefas/{RELATORIO}/status", {"status": "concluido"})])


class FakeHttp:
    """Servidor falso no nivel de requests.request: exercita o FlowlyAPIClient.request de verdade."""

    def __init__(self):
        self.api = FakeFlowlyAPI()
        self.api.backlog = BACKLOG_TASKS

    def __call__(self, method, url, headers=None, params=None, json=None, timeout=None):
        token = (headers or {}).get("Authorization", "").removeprefix("Bearer ")
        path = urlparse(url).path.removeprefix("/api")
        client = type("C", (), {"token": token})()
        try:
            body = self.api(client, method, path, json=json)
            status = 200
        except APIError as exc:
            body, status = {"erro": str(exc)}, 401
        return type("R", (), {"status_code": status, "headers": {"content-type": "application/json"},
                              "json": lambda self, b=body: b, "text": ""})()


class LastBarrierTests(unittest.TestCase):
    """Mesmo que uma verificacao de cima seja esquecida, o cliente HTTP nao envia escrita com a chave desligada."""

    def setUp(self):
        import tempfile

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = patch.dict(os.environ, {"FLOWLY_CONVERSATION_STORE": os.path.join(tmp.name, "state.json"),
                                      "FLOWLY_API_BASE_URL": "https://api.flowly.test/api"})
        env.start()
        self.addCleanup(env.stop)
        set_writes(None)
        self.http = FakeHttp()
        for target in (patch.object(api_client.requests, "request", self.http),
                       patch.object(message_agent.AnalyticsQueue, "publish_message", lambda q, e: {"queued": True})):
            target.start()
            self.addCleanup(target.stop)

    def sent_writes(self):
        return [c for c in self.http.api.calls if c[0] != "GET"]

    def test_every_write_method_of_the_client_is_refused_before_the_network(self):
        client = FlowlyAPIClient(base_url="https://api.flowly.test/api", token="token-admin")
        for name, call in (
            ("create_team", lambda: client.create_team("Marketing")),
            ("add_comment", lambda: client.add_comment(RELATORIO, "oi")),
            ("add_subtask", lambda: client.add_subtask(RELATORIO, "x")),
            ("assign_to_me", lambda: client.assign_to_me(RELATORIO)),
            ("update_status", lambda: client.update_status(RELATORIO, "concluido")),
            ("timer", lambda: client.timer(RELATORIO, "iniciar")),
            ("create_task", lambda: client.create_task(descricao="X", equipe=TEAM_ID, dataEntrega="2026-12-01", urgencia="alta")),
            ("delete_task", lambda: client.delete_task(RELATORIO)),
            ("PATCH", lambda: client.request("PATCH", f"/tarefas/{RELATORIO}", json={})),
            ("post minusculo", lambda: client.request("post", "/equipes", json={})),
        ):
            with self.subTest(name=name):
                with self.assertRaises(APIError):
                    call()
        self.assertEqual(self.http.api.calls, [])
        self.assertEqual(client.me()["tipo"], "admin")  # leitura segue

    def test_enabled_switch_lets_writes_reach_the_api_but_never_delete(self):
        set_writes("true")
        client = FlowlyAPIClient(base_url="https://api.flowly.test/api", token="token-admin")
        client.create_team("Marketing")
        with self.assertRaises(APIError):
            client.delete_task(RELATORIO)
        self.assertEqual(self.sent_writes(), [("POST", "/equipes", {"nome": "Marketing", "membros": []})])

    def test_whole_flow_with_upper_checks_forgotten_still_sends_no_write(self):
        def send(token, content):
            body = {"conversationId": CONVERSATION_ID, "content": content, "channelId": "voice-assistant"}
            raw, status, _ = function.flowly_http(FakeRequest("/api/v1/messages", body, token))
            return json.loads(raw), status

        # Confirmacoes compartilhadas simuladas, com a verificacao da chave delas tambem "esquecida": so resta a
        # barreira do cliente HTTP.
        import fake_operations
        from test_command_safety import TEST_OPERATIONS_SECRET

        fake_operations.FakeOperationsClient.server = fake_operations.FakeOperationsServer(USERS_BY_TOKEN)
        with patch.dict(os.environ, {"ASSISTANT_OPERATIONS_SECRET": TEST_OPERATIONS_SECRET}), \
                patch.object(message_agent, "OperationsClient", fake_operations.FakeOperationsClient), \
                patch.object(fake_operations, "assistant_writes_enabled", lambda: True), \
                patch.object(message_agent, "assistant_writes_enabled", lambda: True), \
                patch.object(rest_assistant, "assistant_writes_enabled", lambda: True):
            for token, steps in (("token-admin", ("criar equipe marketing", "confirmar")),
                                 ("token-user", (STATUS_PHRASE, "confirmar")),
                                 ("token-user", ("backlog", "3", "atribuir para mim"))):
                with self.subTest(steps=steps):
                    for step in steps:
                        payload, _status = send(token, step)
                    self.assertFalse(payload["action_executed"], payload)
                    self.assertIn(WRITES_DISABLED_REPLY, payload["reply_text"])
        self.assertEqual(self.sent_writes(), [])


if __name__ == "__main__":
    unittest.main()
