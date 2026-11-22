"""Seguranca dos comandos do assistente: nada destrutivo por engano.

- "concluir/incluir/explicar tarefa" nunca viram exclusao;
- a exclusao pedida explicitamente e bloqueada em todas as camadas (agente, assistente REST e cliente HTTP);
- "cancelar", "sair", "não, deixa pra lá" encerram fluxos pendentes sem escrever nada;
- consultas continuam funcionando.

A API do Flowly e simulada: nenhuma rede, banco ou dado real e usado.
"""

import json
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

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
from flowly_assistant import api_client  # noqa: E402
from flowly_assistant.api_client import APIError, FlowlyAPIClient  # noqa: E402
from flowly_assistant.assistant_core import message_agent  # noqa: E402
from flowly_assistant.assistant_core.rest_assistant import RestAssistant  # noqa: E402
from flowly_assistant.command_parser import (  # noqa: E402
    CommandParser,
    Match,
    extract_status,
    extract_timer_action,
    strict_param_value,
)
from flowly_assistant.commands import DISABLED_COMMAND_REPLY, DISABLED_COMMANDS, get_commands  # noqa: E402
from fake_conversations import (  # noqa: E402
    ConversationStateRepository,
    ScopedConversationState,
)
from fake_operations import FakeOperationsClient, FakeOperationsServer  # noqa: E402
from fake_conversations import install as install_conversations  # noqa: E402

# Segredo interno so para os testes (o falso das operacoes confere o tamanho minimo, como o cliente real).
TEST_OPERATIONS_SECRET = "segredo-de-teste-" + "t" * 32

WRITE_COMMANDS = {"create_task", "create_team", "assign_to_me", "update_status", "timer", "add_comment", "add_subtask", "delete_task"}
CONVERSATION_ID = "voice-seguranca-1767225600000"
TEAM_ID = "a" * 24
TASKS = [
    {"_id": "1" * 24, "descricao": "Relatório final", "status": "pendente", "equipe": {"_id": TEAM_ID, "nome": "Equipe Alfa"}},
    {"_id": "2" * 24, "descricao": "Revisar relatório parcial", "status": "em_andamento", "equipe": {"_id": TEAM_ID, "nome": "Equipe Alfa"}},
    # Nomes com palavras de status/acao: nao podem trocar a escolha do usuario.
    {"_id": "3" * 24, "descricao": "Iniciar migração", "status": "pendente", "equipe": {"_id": TEAM_ID, "nome": "Equipe Alfa"}},
    {"_id": "4" * 24, "descricao": "Revisão concluída", "status": "pendente", "equipe": {"_id": TEAM_ID, "nome": "Equipe Alfa"}},
    {"_id": "5" * 24, "descricao": "Pendente de aprovação", "status": "em_andamento", "equipe": {"_id": TEAM_ID, "nome": "Equipe Alfa"}},
    {"_id": "6" * 24, "descricao": "Pausar deploy", "status": "pendente", "equipe": {"_id": TEAM_ID, "nome": "Equipe Alfa"}},
]
TASK_ID_BY_NAME = {task["descricao"]: task["_id"] for task in TASKS}
# Backlog com mais de 10 tarefas: o assistente guarda so as 10 primeiras como opcoes de selecao.
# Nomes sem numeros nem ordinais, para a escolha depender so do que o usuario diz.
BACKLOG_TASKS = [
    {"_id": "b" * 22 + f"{index:02d}", "descricao": name, "status": "pendente", "equipe": {"_id": TEAM_ID, "nome": "Equipe Alfa"}}
    for index, name in enumerate(
        (
            "Ajustar layout do painel", "Atualizar documentação", "Corrigir filtro de busca", "Revisar contrato fictício",
            "Testar notificações", "Organizar arquivos", "Preparar demonstração", "Configurar alertas",
            "Validar formulário", "Melhorar acessibilidade", "Traduzir mensagens", "Limpar registros antigos",
        ),
        start=1,
    )
]
# Nomes que coincidem com partes da frase: "Marketing", nomes com numero dentro e fora da lista de opcoes,
# um nome com "e" e um nome ("Login") contido em outro ("Revisar cadastro e login"), que aparece antes na lista.
NAMED_BACKLOG_TASKS = [
    {"_id": "c" * 22 + f"{index:02d}", "descricao": name, "status": "pendente", "equipe": {"_id": TEAM_ID, "nome": "Equipe Alfa"}}
    for index, name in enumerate(
        (
            "Ajustar layout do painel", "Atualizar documentação", "Corrigir filtro de busca", "Marketing", "Sprint 15",
            "Sprint 2", "Configurar alertas", "Login", "Revisar cadastro e login", "Traduzir mensagens",
            "Sprint 11", "Limpar registros antigos",
        ),
        start=1,
    )
]
USERS_BY_TOKEN = {
    "token-admin": {"_id": "d" * 24, "nome": "Admin Ficticio", "tipo": "admin"},
    "token-admin-2": {"_id": "e" * 24, "nome": "Admin Dois", "tipo": "admin"},
    "token-user": {"_id": "f" * 24, "nome": "Pessoa Ficticia", "tipo": "user"},
}


class FakeRequest:
    def __init__(self, path, body, token=None):
        self.method = "POST"
        self.path = path
        self._body = body
        self.headers = {"Authorization": f"Bearer {token}"} if token else {}

    def get_json(self, silent=True):
        return self._body


class FakeFlowlyAPI:
    """Substitui FlowlyAPIClient.request e registra cada chamada."""

    def __init__(self):
        self.calls = []
        self.backlog = []
        self.keys = []  # Idempotency-Key de cada escrita (None = sem chave)
        self.timeouts = []  # timeout do cliente HTTP em cada escrita
        self.on_write = None  # gancho opcional: chamado antes de responder a uma escrita

    def writes(self):
        return [call for call in self.calls if call[0] != "GET"]

    def __call__(self, client, method, path, **kwargs):
        self.calls.append((method.upper(), path, kwargs.get("json")))
        if method.upper() != "GET":
            self.keys.append(kwargs.get("idempotency_key"))
            self.timeouts.append(getattr(client, "timeout_sec", None))
            if self.on_write:
                hook = self.on_write
                result = hook(client, method.upper(), path, kwargs)
                if result is not None:
                    return result
        if path == "/users/me":
            if client.token not in USERS_BY_TOKEN:
                raise APIError("HTTP 401 em GET /users/me: Token inválido")
            return USERS_BY_TOKEN[client.token]
        if method == "GET" and path in ("/tarefas/minhas", "/tarefas"):
            return TASKS
        if method == "GET" and path == "/tarefas/backlog":
            return self.backlog
        if method == "GET" and path in ("/equipes/minhas", "/equipes"):
            return [{"_id": TEAM_ID, "nome": "Equipe Alfa"}]
        if method == "GET" and path.endswith("/membros"):
            return [{"_id": "f" * 24, "nome": "Pessoa Ficticia"}]
        if method == "GET" and path.endswith("/detalhes"):
            return {"tarefa": next(t for t in TASKS + self.backlog if t["_id"] == path.split("/")[2])}
        if method in ("POST", "PUT", "DELETE"):
            return {"ok": True}
        raise AssertionError(f"Chamada inesperada à API: {method} {path}")


TERMINAL_CONVERSATION_STATUSES = {"completed", "failed", "cancelled", "expired", "unknown"}


def observe_binding(bindings, key, payload):
    """Mesma regra da tela: guarda o operation_id mostrado; resultado terminal desfaz o vinculo."""
    conversation = payload.get("conversation") if isinstance(payload, dict) else None
    if not isinstance(conversation, dict):
        return
    if conversation.get("operation_id") and conversation.get("status") not in TERMINAL_CONVERSATION_STATUSES:
        bindings[key] = conversation["operation_id"]
    elif conversation.get("status") in TERMINAL_CONVERSATION_STATUSES:
        bindings.pop(key, None)


class AssistantFlowTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = patch.dict(
            os.environ,
            {
                "FLOWLY_CONVERSATION_STORE": os.path.join(tmp.name, "state.json"),
                "FLOWLY_API_BASE_URL": "https://api.flowly.test/api",
                # Estes testes cobrem o fluxo de escrita com a chave temporaria LIGADA (reativacao futura);
                # o padrao desligado e coberto em test_write_kill_switch.
                "FLOWLY_ASSISTANT_WRITES_ENABLED": "true",
                "ASSISTANT_OPERATIONS_SECRET": TEST_OPERATIONS_SECRET,
            },
        )
        env.start()
        self.addCleanup(env.stop)

        # Contexto compartilhado das conversas: servidor falso no lugar do ConversationStateClient (sem rede).
        self.conversations = install_conversations(self, USERS_BY_TOKEN)

        # Confirmacoes compartilhadas: servidor falso das operacoes no lugar do OperationsClient (sem rede).
        self.ops = FakeOperationsServer(USERS_BY_TOKEN)
        FakeOperationsClient.server = self.ops
        ops_patch = patch.object(message_agent, "OperationsClient", FakeOperationsClient)
        ops_patch.start()
        self.addCleanup(ops_patch.stop)

        self.api = FakeFlowlyAPI()
        api = self.api

        def fake_request(client, method, path, **kwargs):  # funcao: recebe o client como self
            return api(client, method, path, **kwargs)

        for target in (
            patch.object(FlowlyAPIClient, "request", fake_request),
            patch.object(message_agent.AnalyticsQueue, "publish_message", lambda queue, event: {"queued": True}),
            # Rede real proibida: se algo escapar do falso, o teste quebra.
            patch.object(api_client.requests, "request", side_effect=AssertionError("rede real chamada")),
        ):
            target.start()
            self.addCleanup(target.stop)

    def send(self, token, content, conversation_id=CONVERSATION_ID):
        """Como o navegador (Etapa 6B): reenvia o operationId do resumo mostrado nesta conversa."""
        return self.frontend_send(token, {"conversationId": conversation_id, "content": content,
                                          "channelId": "voice-assistant"})

    def send_raw(self, token, content, conversation_id=CONVERSATION_ID, **extra):
        """Cliente sem o vinculo da tela (nenhum operationId, a menos que passado em extra)."""
        body = {"conversationId": conversation_id, "content": content, "channelId": "voice-assistant", **extra}
        raw, status, _headers = function.flowly_http(FakeRequest("/api/v1/messages", body, token))
        return json.loads(raw), status

    def frontend_send(self, token, body):
        bindings = self.__dict__.setdefault("_bindings", {})
        key = (token, body.get("conversationId"))
        if "operationId" not in body and bindings.get(key):
            body = {**body, "operationId": bindings[key]}
        raw, status, _headers = function.flowly_http(FakeRequest("/api/v1/messages", body, token))
        payload = json.loads(raw)
        observe_binding(bindings, key, payload)
        return payload, status

    def pending(self, token, conversation_id=CONVERSATION_ID):
        """Fluxo pendente da conversa: o estado local (perguntas, selecao) ou, sem ele, a confirmacao compartilhada
        ativa no servidor de operacoes (no formato antigo de write_confirmation). None = nada pendente em lugar algum."""
        user_id = USERS_BY_TOKEN[token]["_id"]
        local = ScopedConversationState(ConversationStateRepository(), user_id).get(conversation_id)
        if local:
            return local
        self.ops.settle(user_id, conversation_id)
        op = self.ops.active(user_id, conversation_id)
        if not op:
            return None
        return {
            "mode": "write_confirmation", "command": op["commandKey"], "params": dict(op["params"]),
            "owner_id": op["ownerId"], "conversation_id": op["conversationId"], "operation_id": op["operationId"],
            "status": op["status"], "expires_at": op["expiresAt"] - self.ops.offset,  # no relogio real do teste
        }

    def assert_no_writes(self):
        self.assertEqual(self.api.writes(), [], f"escritas inesperadas: {self.api.writes()}")


class ParserWriteSafetyTests(unittest.TestCase):
    def setUp(self):
        self.parser = CommandParser(threshold=78)

    def key(self, utterance):
        match = self.parser.match(utterance)
        return match.command.key if match else None

    def test_concluir_incluir_explicar_tarefa_never_select_a_command(self):
        for utterance in ("concluir tarefa", "incluir tarefa", "explicar tarefa", "Concluir tarefa."):
            with self.subTest(utterance=utterance):
                self.assertIsNone(self.key(utterance))

    def test_ambiguous_write_intent_never_selects_a_write_command(self):
        for utterance in (
            "concluir tarefa relatório final",
            "terminar a tarefa",
            "exclui a tarefa relatório",
            "excluir terefa relatorio",
            "criar terefa",
            "criar tarefa criar equipe",
        ):
            with self.subTest(utterance=utterance):
                self.assertNotIn(self.key(utterance), WRITE_COMMANDS)

    def test_write_verb_without_explicit_command_does_nothing(self):
        # Sem a trava, estas caiam em consultas por semelhanca ("apagar todas tarefas" -> listar tarefas).
        for utterance in ("apagar todas tarefas", "excluir minhas terefas"):
            with self.subTest(utterance=utterance):
                self.assertIsNone(self.key(utterance))

    def test_explicit_write_phrases_still_match(self):
        expected = {
            "criar tarefa": "create_task",
            "quero criar uma tarefa": "create_task",
            "criar equipe marketing": "create_team",
            "pegar a tarefa relatorio": "assign_to_me",
            "mudar status da tarefa relatorio para concluido": "update_status",
            "marcar tarefa relatório final como concluída": "update_status",
            "pausar cronômetro": "timer",
            "adicionar comentario na tarefa relatorio dizendo ok": "add_comment",
            "criar subtarefa na tarefa relatorio": "add_subtask",
            # Reconhecida so para ser recusada com mensagem clara.
            "excluir tarefa relatório": "delete_task",
            "apagar a tarefa relatório": "delete_task",
        }
        for utterance, key in expected.items():
            with self.subTest(utterance=utterance):
                self.assertEqual(self.key(utterance), key)

    def test_read_commands_keep_their_matches(self):
        expected = {
            "minhas tarefas": "my_tasks",
            "Minhas tarefas?": "my_tasks",
            "quais são as minhas tarefas": "my_tasks",
            "minhas terefas": "my_tasks",
            "ver as tarefas": "my_tasks",
            "backlog": "backlog",
            "tarefas sem responsável": "backlog",
            "meu perfil": "me",
            "listar usuários": "list_users",
            "buscar usuario ana": "search_users",
            "minhas equipes": "my_teams",
            "quais são as minhas equipes": "my_teams",
            "membros da equipe alfa": "team_members",
            "mensagens da equipe alfa": "team_messages",
            "detalhes da tarefa relatorio": "task_details",
            "abrir tarefa relatorio": "task_details",
            "listar equipes": "list_teams",
            "listar tarefas": "list_tasks",
            "listar as tarefas": "list_tasks",
            "pensei em sair mais cedo, minhas tarefas": "my_tasks",
        }
        for utterance, key in expected.items():
            with self.subTest(utterance=utterance):
                self.assertEqual(self.key(utterance), key)


class DeleteIsNeverExecutedTests(AssistantFlowTestCase):
    def test_concluir_incluir_explicar_followed_by_task_name_never_delete(self):
        for utterance in ("concluir tarefa", "incluir tarefa", "explicar tarefa"):
            with self.subTest(utterance=utterance):
                self.send("token-admin", utterance)
                self.send("token-admin", "relatório final")
                self.assertNotIn("DELETE", [call[0] for call in self.api.calls])
                self.assert_no_writes()
                self.assertIsNone(self.pending("token-admin"))

    def test_explicit_delete_request_is_blocked_with_clear_message(self):
        for utterance in ("excluir tarefa relatório", "apagar a tarefa relatório", "deletar tarefa relatório", "excluir tarefa"):
            with self.subTest(utterance=utterance):
                payload, status = self.send("token-admin", utterance)
                self.assertEqual(status, 403)
                self.assertFalse(payload["ok"])
                self.assertEqual(payload["error"], "command_disabled")
                self.assertFalse(payload["action_executed"])
                self.assertIn("Nada foi excluído", payload["reply_text"])
                self.assertIn("Nada foi excluído", payload["tts"]["text"])
                # Sem "Qual tarefa?": nada fica pendente para a proxima frase.
                self.assertIsNone(self.pending("token-admin"))
                self.assert_no_writes()

    def test_delete_pending_state_from_before_the_fix_cannot_execute(self):
        user_id = USERS_BY_TOKEN["token-admin"]["_id"]
        ScopedConversationState(ConversationStateRepository(), user_id).save(
            CONVERSATION_ID, {"command_key": "delete_task", "params": {}, "missing": ["task_id"]}
        )
        payload, status = self.send("token-admin", "relatório final")
        self.assertEqual((status, payload["error"]), (403, "command_disabled"))
        self.assertIsNone(self.pending("token-admin"))
        self.assert_no_writes()

    def test_legacy_assist_route_blocks_delete_even_with_task_id(self):
        body = {"utterance": "excluir tarefa", "params": {"task_id": TASKS[0]["_id"]}}
        raw, status, _headers = function.flowly_http(FakeRequest("/assist", body, "token-admin"))
        payload = json.loads(raw)
        self.assertEqual((status, payload["error"]), (403, "command_disabled"))
        self.assert_no_writes()

    def test_rest_assistant_refuses_disabled_command_even_if_selected_some_other_way(self):
        delete_cmd = next(cmd for cmd in get_commands() if cmd.key == "delete_task")
        assistant = RestAssistant(api_base_url="https://api.flowly.test/api", token="token-admin")
        with self.assertRaises(APIError) as raised:
            assistant._execute(Match(command=delete_cmd, score=100, params={}), {"task_id": TASKS[0]["_id"]})
        self.assertEqual(str(raised.exception), DISABLED_COMMAND_REPLY)
        self.assert_no_writes()

    def test_disabled_commands_cover_delete_task(self):
        self.assertIn("delete_task", DISABLED_COMMANDS)


class HttpClientNeverSendsDeleteTests(unittest.TestCase):
    def test_delete_is_refused_before_any_network_call(self):
        client = FlowlyAPIClient(base_url="https://api.flowly.test/api", token="token-admin")
        with patch.object(api_client.requests, "request") as network:
            for call in (
                lambda: client.delete_task(TASKS[0]["_id"]),
                lambda: client.request("DELETE", f"/tarefas/{TASKS[0]['_id']}"),
                lambda: client.request("delete", "/tarefas/qualquer"),
                lambda: client.request(" Delete ", "/equipes/qualquer"),
            ):
                with self.assertRaises(APIError):
                    call()
            network.assert_not_called()


class CancelPendingFlowTests(AssistantFlowTestCase):
    CREATE_ANSWERS = ["Relatório semanal", "Resumo das entregas da semana", "amanhã", "alta", "Equipe Alfa"]

    def start_creation(self, answers=0, token="token-admin"):
        payload, _status = self.send(token, "criar tarefa")
        self.assertEqual(payload["conversation"]["status"], "awaiting_params")
        for answer in self.CREATE_ANSWERS[:answers]:
            payload, _status = self.send(token, answer)
            self.assertEqual(payload["conversation"]["status"], "awaiting_params")
        return payload

    def test_cancel_phrases_during_creation_never_post(self):
        for phrase in ("cancelar", "Cancelar.", "sair", "não, deixa pra lá", "deixa pra lá", "esquece", "pode cancelar"):
            with self.subTest(phrase=phrase):
                self.start_creation(answers=1)
                payload, status = self.send("token-admin", phrase)
                self.assertEqual(status, 200)
                self.assertEqual(payload["conversation"]["status"], "cancelled")
                self.assertFalse(payload["action_executed"])
                self.assertIn("Nada foi alterado", payload["reply_text"])
                self.assertIsNone(self.pending("token-admin"))
                self.assert_no_writes()

    def test_cancel_works_at_every_step_of_creation(self):
        for step in range(len(self.CREATE_ANSWERS) + 1):  # nome ... equipe e, por fim, responsavel
            with self.subTest(step=step):
                self.start_creation(answers=step)
                payload, _status = self.send("token-admin", "não, deixa pra lá")
                self.assertEqual(payload["conversation"]["status"], "cancelled")
                self.assertIsNone(self.pending("token-admin"))
                self.assert_no_writes()

    def test_after_cancel_the_next_command_runs_normally(self):
        self.start_creation(answers=2)
        self.send("token-admin", "cancelar")
        payload, status = self.send("token-admin", "listar equipes")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["command"]["key"], "list_teams")
        self.assert_no_writes()

    def test_value_that_merely_contains_a_cancel_word_is_kept(self):
        self.start_creation()
        payload, _status = self.send("token-admin", "Cancelar assinatura do fornecedor")
        self.assertEqual(payload["conversation"]["status"], "awaiting_params")
        self.assertEqual(payload["conversation"]["next_param"], "descricao")
        self.assertEqual(self.pending("token-admin")["params"]["nome"], "Cancelar assinatura do fornecedor")
        self.assert_no_writes()

    def test_plain_no_at_assignee_step_still_means_no_assignee(self):
        self.start_creation(answers=len(self.CREATE_ANSWERS))
        payload, _status = self.send("token-admin", "não")
        # "não" aqui e "sem responsável": o fluxo segue para o resumo (nao cancela) e nada e escrito antes do confirmar.
        self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation")
        self.assertIn("sem responsável", payload["reply_text"])
        self.assertEqual(self.pending("token-admin")["params"]["user"], "__none__")
        self.assert_no_writes()
        payload, _status = self.send("token-admin", "confirmar")
        self.assertTrue(payload["action_executed"], payload["reply_text"])
        self.assertNotIn("DELETE", [call[0] for call in self.api.calls])
        posts = [call for call in self.api.writes() if call[:2] == ("POST", "/tarefas")]
        self.assertEqual(len(posts), 1)
        self.assertNotIn("user", posts[-1][2])
        self.assertEqual(posts[-1][2]["equipe"], TEAM_ID)

    def test_cancel_of_one_user_does_not_touch_the_pending_creation_of_another(self):
        self.start_creation(answers=1, token="token-admin")
        payload, _status = self.send("token-admin-2", "cancelar")
        self.assertNotEqual((payload.get("conversation") or {}).get("status"), "cancelled")
        self.assertIsNotNone(self.pending("token-admin"))
        self.assertEqual(self.pending("token-admin")["params"]["nome"], "Relatório semanal")
        self.assert_no_writes()


class CancelTaskSelectionTests(AssistantFlowTestCase):
    def test_cancel_or_refusal_during_selection_never_writes(self):
        for phrase in ("cancelar", "deixa pra lá", "não, deixa pra lá", "não quero atribuir para mim", "não"):
            for select_first in (False, True):
                with self.subTest(phrase=phrase, select_first=select_first):
                    self.send("token-user", "minhas tarefas")
                    if select_first:
                        payload, _status = self.send("token-user", "segunda")
                        self.assertEqual(payload["conversation"]["status"], "awaiting_task_action")
                    payload, _status = self.send("token-user", phrase)
                    self.assertEqual(payload["conversation"]["status"], "cancelled")
                    self.assertIsNone(self.pending("token-user"))
                    self.assert_no_writes()

    def test_explicit_assignment_after_selection_still_works(self):
        self.send("token-user", "minhas tarefas")
        self.send("token-user", "segunda")
        payload, _status = self.send("token-user", "atribuir para mim")
        self.assertTrue(payload["action_executed"])
        self.assertEqual(self.api.writes(), [("PUT", f"/tarefas/{TASKS[1]['_id']}/atribuir-para-mim", None)])


# Escolhas que nao apontam para uma unica opcao da lista. Antes da correcao, com uma tarefa ja selecionada,
# "atribuir a 11 para mim" atribuia a tarefa selecionada antes (e "décima primeira" virava a primeira).
OUT_OF_RANGE_CHOICES = ("11", "12", "0", "99", "117", "atribuir a 11 para mim", "detalhes da 11", "pegar a 15 para mim")
INVALID_ORDINAL_CHOICES = (
    "sexta",
    "atribuir a sétima para mim",
    "atribuir a décima primeira para mim",
    "detalhes da vigésima",
    "atribuir a última para mim",
)
AMBIGUOUS_CHOICES = (
    "atribuir a 7 ou a 8 para mim",
    "a 7, quer dizer a 8, atribuir para mim",
    "detalhes da 2 e da 3",
    "atribuir a onze para mim",
    "atribuir a sete para mim",
    "atribuir a 7ª para mim",
)


class TaskSelectionSafetyTests(AssistantFlowTestCase):
    """Numero/ordinal invalido ou ambiguo pede nova escolha e nunca reaproveita a tarefa selecionada antes."""

    def setUp(self):
        super().setUp()
        self.api.backlog = BACKLOG_TASKS

    def browse(self, select=None):
        # Cada caso comeca do zero: sem isso, "backlog" seria lido como resposta a selecao do caso anterior.
        ScopedConversationState(ConversationStateRepository(), USERS_BY_TOKEN["token-user"]["_id"]).clear(CONVERSATION_ID)
        payload, _status = self.send("token-user", "backlog")
        self.assertEqual(payload["conversation"]["status"], "browsing_tasks")
        if select:
            payload, _status = self.send("token-user", select)
            self.assertEqual(payload["conversation"]["status"], "awaiting_task_action")

    def assert_asks_again_without_calling_the_api(self, phrase, last_option):
        before = len(self.api.calls)
        payload, status = self.send("token-user", phrase)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["conversation"]["status"], "awaiting_task_selection", payload["reply_text"])
        self.assertFalse(payload["action_executed"])
        # Informa as opcoes disponiveis, numeradas.
        self.assertIn("1. Ajustar layout do painel", payload["reply_text"])
        self.assertIn(last_option, payload["reply_text"])
        # Nenhuma chamada alem da identificacao do usuario (nem escrita, nem detalhes de outra tarefa).
        self.assertEqual([call for call in self.api.calls[before:] if call[1] != "/users/me"], [])
        # A selecao anterior foi descartada.
        self.assertNotIn("selected_task_id", self.pending("token-user"))

    def test_invalid_or_ambiguous_choice_asks_again_and_never_writes(self):
        for group, phrases in (
            ("fora do intervalo", OUT_OF_RANGE_CHOICES),
            ("ordinal invalido", INVALID_ORDINAL_CHOICES),
            ("ambigua", AMBIGUOUS_CHOICES),
        ):
            for phrase in phrases:
                for selected_before in (None, "7"):
                    with self.subTest(group=group, phrase=phrase, selected_before=selected_before):
                        self.browse(select=selected_before)
                        self.assert_asks_again_without_calling_the_api(phrase, "10. Melhorar acessibilidade")
                        # Sem nova escolha, "atribuir para mim" tambem nao escreve: so pergunta de novo.
                        payload, _status = self.send("token-user", "atribuir para mim")
                        self.assertEqual(payload["conversation"]["status"], "awaiting_task_selection")
                        self.assert_no_writes()

    def test_ordinal_or_number_beyond_a_short_list_asks_again(self):
        self.api.backlog = BACKLOG_TASKS[:3]
        for phrase in ("quinta", "atribuir a quarta para mim", "atribuir a 4 para mim"):
            with self.subTest(phrase=phrase):
                self.browse(select="2")
                self.assert_asks_again_without_calling_the_api(phrase, "3. Corrigir filtro de busca")
                self.assert_no_writes()

    def test_invalid_or_conflicting_position_never_writes_even_if_a_task_name_matches(self):
        # Antes: "a 11 da Marketing" atribuia a Marketing; "a sprint 2" atribuia a opcao 2 (outra tarefa).
        self.api.backlog = NAMED_BACKLOG_TASKS
        for phrase in (
            "atribuir a 11 da Marketing para mim",
            "detalhes da 11 da marketing",
            "atribuir a décima primeira da marketing para mim",
            "atribuir a 2 da marketing para mim",
            "atribuir a sprint 2 para mim",
            "atribuir a marketing e a sprint 15 para mim",
            "atribuir a sprint 11 para mim",
        ):
            for selected_before in (None, "7"):
                with self.subTest(phrase=phrase, selected_before=selected_before):
                    self.browse(select=selected_before)
                    self.assert_asks_again_without_calling_the_api(phrase, "10. Traduzir mensagens")
                    self.assert_no_writes()

    def test_task_names_with_numbers_still_work_when_unambiguous(self):
        self.api.backlog = NAMED_BACKLOG_TASKS
        marketing, sprint15 = NAMED_BACKLOG_TASKS[3]["_id"], NAMED_BACKLOG_TASKS[4]["_id"]
        cases = (
            (("detalhes da sprint 15",), [("GET", f"/tarefas/{sprint15}/detalhes", None)]),
            (("sprint 15", "detalhes"), [("GET", f"/tarefas/{sprint15}/detalhes", None)]),
            # Tarefa citada agora (numero ou nome): resumo com o nome e confirmacao explicita antes do PUT.
            (("atribuir a sprint 15 para mim", "confirmar"), [("PUT", f"/tarefas/{sprint15}/atribuir-para-mim", None)]),
            (("7", "atribuir a sprint 15 para mim", "confirmar"), [("PUT", f"/tarefas/{sprint15}/atribuir-para-mim", None)]),
            (("atribuir a marketing para mim", "confirmar"), [("PUT", f"/tarefas/{marketing}/atribuir-para-mim", None)]),
            # Numero e nome apontando para a mesma tarefa: sem conflito.
            (("atribuir a 4 da marketing para mim", "confirmar"), [("PUT", f"/tarefas/{marketing}/atribuir-para-mim", None)]),
            (("atribuir a 2 para mim", "confirmar"), [("PUT", f"/tarefas/{NAMED_BACKLOG_TASKS[1]['_id']}/atribuir-para-mim", None)]),
        )
        for phrases, expected in cases:
            with self.subTest(phrases=phrases):
                self.browse()
                before = len(self.api.calls)
                for phrase in phrases:
                    payload, status = self.send("token-user", phrase)
                    self.assertEqual(status, 200, payload)
                calls = [call for call in self.api.calls[before:] if call[1] != "/users/me"]
                self.assertEqual(calls, expected)

    def test_two_task_names_without_numbers_never_write(self):
        # Antes: o primeiro nome encontrado vencia ("Marketing e Configurar Alertas" atribuia a Marketing).
        self.api.backlog = NAMED_BACKLOG_TASKS
        for phrase in (
            "Atribuir Marketing e Configurar Alertas para mim",
            "atribuir marketing ou configurar alertas para mim",
            "detalhes da marketing e da configurar alertas",
            "atribuir login e revisar cadastro e login para mim",
        ):
            for selected_before in (None, "7"):
                with self.subTest(phrase=phrase, selected_before=selected_before):
                    self.browse(select=selected_before)
                    self.assert_asks_again_without_calling_the_api(phrase, "10. Traduzir mensagens")
                    self.assert_no_writes()

    def test_a_single_task_name_still_selects_that_task(self):
        self.api.backlog = NAMED_BACKLOG_TASKS
        marketing, alertas, login, cadastro = (NAMED_BACKLOG_TASKS[i]["_id"] for i in (3, 6, 7, 8))
        cases = (
            (("Marketing", "atribuir para mim"), [("PUT", f"/tarefas/{marketing}/atribuir-para-mim", None)]),
            (("Atribuir Configurar Alertas para mim", "confirmar"), [("PUT", f"/tarefas/{alertas}/atribuir-para-mim", None)]),
            (("Atribuir a 7 para mim", "confirmar"), [("PUT", f"/tarefas/{alertas}/atribuir-para-mim", None)]),
            # Nome com "e" continua uma tarefa so; antes, "Login" (antes na lista) era atribuida no lugar.
            (("atribuir revisar cadastro e login para mim", "confirmar"), [("PUT", f"/tarefas/{cadastro}/atribuir-para-mim", None)]),
            (("7", "atribuir revisar cadastro e login para mim", "confirmar"), [("PUT", f"/tarefas/{cadastro}/atribuir-para-mim", None)]),
            (("login", "detalhes"), [("GET", f"/tarefas/{login}/detalhes", None)]),
        )
        for phrases, expected in cases:
            with self.subTest(phrases=phrases):
                self.browse()
                before = len(self.api.calls)
                for phrase in phrases:
                    payload, status = self.send("token-user", phrase)
                    self.assertEqual(status, 200, payload)
                calls = [call for call in self.api.calls[before:] if call[1] != "/users/me"]
                self.assertEqual(calls, expected)

    def test_negation_and_cancel_still_win_over_an_invalid_choice(self):
        for phrase in ("não, a 11", "cancelar a 11", "não atribuir a 7 ou a 8"):
            with self.subTest(phrase=phrase):
                self.browse(select="7")
                payload, _status = self.send("token-user", phrase)
                self.assertEqual(payload["conversation"]["status"], "cancelled")
                self.assertIsNone(self.pending("token-user"))
                self.assert_no_writes()

    def test_valid_choices_still_work(self):
        task7 = BACKLOG_TASKS[6]["_id"]
        cases = (
            # (frases, chamadas esperadas apos o "backlog")
            (("7", "detalhes"), [("GET", f"/tarefas/{task7}/detalhes", None)]),
            (("7", "detalhes da 7"), [("GET", f"/tarefas/{task7}/detalhes", None)]),
            (("7", "atribuir para mim"), [("PUT", f"/tarefas/{task7}/atribuir-para-mim", None)]),
            (("atribuir a 7 para mim", "confirmar"), [("PUT", f"/tarefas/{task7}/atribuir-para-mim", None)]),
            (("atribuir a terceira para mim", "confirmar"), [("PUT", f"/tarefas/{BACKLOG_TASKS[2]['_id']}/atribuir-para-mim", None)]),
            (("10", "detalhes"), [("GET", f"/tarefas/{BACKLOG_TASKS[9]['_id']}/detalhes", None)]),
            (("configurar alertas", "detalhes"), [("GET", f"/tarefas/{BACKLOG_TASKS[7]['_id']}/detalhes", None)]),
            # Depois de uma escolha invalida, uma valida volta a funcionar normalmente.
            (("11", "7", "atribuir para mim"), [("PUT", f"/tarefas/{task7}/atribuir-para-mim", None)]),
        )
        for phrases, expected in cases:
            with self.subTest(phrases=phrases):
                self.api.calls.clear()
                self.browse()
                before = len(self.api.calls)
                for phrase in phrases:
                    payload, status = self.send("token-user", phrase)
                    self.assertEqual(status, 200, payload)
                calls = [call for call in self.api.calls[before:] if call[1] != "/users/me"]
                self.assertEqual(calls, expected)


NEGATIVE_PHRASES = (
    "Não quero criar tarefa",
    "Não crie uma tarefa",
    "Não altere o status da tarefa",
    "Não atribua essa tarefa para mim",
    "Não inicie o cronômetro",
    "Não quero excluir a tarefa",
    "Cancelar criação de tarefa",
)


class NegativePhraseTests(AssistantFlowTestCase):
    """Frase negativa nunca produz POST, PUT ou DELETE, com ou sem fluxo pendente."""

    # Fluxos de escrita interrompidos na pergunta indicada: (token, frases ate a pergunta).
    PENDING_FLOWS = {
        "status (pergunta do status)": ("token-user", ["mudar status", "relatório final"]),
        "cronometro (pergunta da acao)": ("token-user", ["cronômetro", "relatório final"]),
        "comentario (pergunta do texto)": ("token-user", ["comentar", "relatório final"]),
        "atribuir (pergunta da tarefa)": ("token-user", ["pegar tarefa", "Equipe Alfa"]),
        "criar equipe (pergunta do nome)": ("token-admin", ["criar equipe"]),
        "criar tarefa (pergunta do nome)": ("token-admin", ["criar tarefa"]),
        "criar tarefa (pergunta da urgencia)": (
            "token-admin", ["criar tarefa", "Relatório semanal", "Resumo das entregas", "amanhã"]),
        "criar tarefa (pergunta do responsavel)": (
            "token-admin", ["criar tarefa", "Relatório semanal", "Resumo das entregas", "amanhã", "alta", "Equipe Alfa"]),
    }

    def test_parser_selects_no_command_for_negative_phrases(self):
        parser = CommandParser(threshold=78)
        for phrase in NEGATIVE_PHRASES + ("nao quero criar tarefa", "NÃO CRIE UMA TAREFA."):
            with self.subTest(phrase=phrase):
                self.assertIsNone(parser.match(phrase))

    def test_negative_phrases_without_pending_flow_never_write(self):
        for token in ("token-user", "token-admin"):
            for phrase in NEGATIVE_PHRASES:
                with self.subTest(token=token, phrase=phrase):
                    payload, _status = self.send(token, phrase)
                    self.assertFalse(payload.get("action_executed"))
                    self.assertIsNone(self.pending(token))
        self.assert_no_writes()

    def test_negative_phrase_answering_a_pending_question_cancels_without_writing(self):
        for flow, (token, steps) in self.PENDING_FLOWS.items():
            for phrase in NEGATIVE_PHRASES:
                with self.subTest(flow=flow, phrase=phrase):
                    for step in steps:
                        payload, _status = self.send(token, step)
                        self.assertEqual(payload["conversation"]["status"], "awaiting_params", (step, payload))
                    payload, _status = self.send(token, phrase)
                    self.assertEqual(payload["conversation"]["status"], "cancelled", payload)
                    self.assertFalse(payload["action_executed"])
                    self.assertIsNone(self.pending(token))
                    self.assert_no_writes()

    def test_negative_phrase_during_task_selection_never_writes(self):
        for phrase in NEGATIVE_PHRASES:
            with self.subTest(phrase=phrase):
                self.send("token-user", "minhas tarefas")
                self.send("token-user", "segunda")
                payload, _status = self.send("token-user", phrase)
                self.assertEqual(payload["conversation"]["status"], "cancelled")
                self.assertIsNone(self.pending("token-user"))
                self.assert_no_writes()

    def test_negations_without_nao_never_write(self):
        # Antes executavam na hora: PUT status, PUT cronometro e POST equipe.
        phrases = (
            "nunca altere o status da tarefa relatório final para concluído",
            "jamais pausar cronômetro da tarefa relatório final",
            "nem pense em criar equipe marketing",
            "nunca criar equipe marketing",
        )
        parser = CommandParser(threshold=78)
        for token in ("token-user", "token-admin"):
            for phrase in phrases:
                with self.subTest(token=token, phrase=phrase):
                    self.assertIsNone(parser.match(phrase))
                    self.send(token, phrase)
                    self.assertIsNone(self.pending(token))
        self.assert_no_writes()

    def test_negations_without_nao_answering_a_pending_question_cancel(self):
        for token, steps, answer in (
            ("token-user", ["mudar status", "relatório final"], "nunca mude isso"),
            ("token-user", ["cronômetro", "relatório final"], "jamais"),
            ("token-admin", ["criar equipe"], "nem pensar"),
        ):
            with self.subTest(steps=steps, answer=answer):
                for step in steps:
                    self.send(token, step)
                payload, _status = self.send(token, answer)
                self.assertEqual(payload["conversation"]["status"], "cancelled")
                self.assertIsNone(self.pending(token))
        self.assert_no_writes()

    def test_value_containing_nao_cancels_by_precaution(self):
        # Falso positivo aceito: um valor legitimo com "não" encerra o fluxo; nada e escrito.
        self.send("token-admin", "criar tarefa")
        payload, _status = self.send("token-admin", "Não usar dados reais")
        self.assertEqual(payload["conversation"]["status"], "cancelled")
        self.assertIsNone(self.pending("token-admin"))
        self.assert_no_writes()

    def test_positive_answers_still_complete_the_same_flows(self):
        task = TASKS[0]["_id"]
        cases = (
            ("token-user", ["mudar status", "relatório final", "concluído", "confirmar"],
             ("PUT", f"/tarefas/{task}/status", {"status": "concluido"})),
            ("token-user", ["cronômetro", "relatório final", "iniciar", "confirmar"],
             ("PUT", f"/tarefas/{task}/cronometro", {"acao": "iniciar"})),
            ("token-admin", ["criar equipe", "Marketing", "confirmar"],
             ("POST", "/equipes", {"nome": "Marketing", "membros": []})),
        )
        for token, steps, expected_write in cases:
            with self.subTest(steps=steps):
                self.api.calls.clear()
                for step in steps:
                    payload, _status = self.send(token, step)
                self.assertTrue(payload["action_executed"], payload)
                self.assertEqual(self.api.writes(), [expected_write])


class StrictParamValueTests(unittest.TestCase):
    """status/acao/urgencia: so valores conhecidos, sem valor padrao."""

    def test_valid_answers_and_explicit_variations(self):
        expected = {
            ("status", "Concluído"): "concluido",
            ("status", "concluida"): "concluido",
            ("status", "Em andamento"): "em_andamento",
            ("status", "Pendente"): "pendente",
            ("status", "em_andamento"): "em_andamento",
            ("acao", "Iniciar"): "iniciar",
            ("acao", "começar"): "iniciar",
            ("acao", "Pausar"): "pausar",
            ("acao", "pausa"): "pausar",
            ("urgencia", "Alta"): "alta",
            ("urgencia", "urgente"): "alta",
            ("urgencia", "média"): "media",
            ("urgencia", "Media"): "media",
            ("urgencia", "baixa"): "baixa",
        }
        for (param, answer), value in expected.items():
            with self.subTest(param=param, answer=answer):
                self.assertEqual(strict_param_value(param, answer), value)

    def test_unknown_empty_or_ambiguous_answers_have_no_value(self):
        for param in ("status", "acao", "urgencia"):
            for answer in ("Hmm", "talvez", "", "   ", "asdf qwer", "?", "ok", "final"):
                with self.subTest(param=param, answer=answer):
                    self.assertIsNone(strict_param_value(param, answer))
        for param, answer in (("status", "pendente ou concluído"), ("acao", "iniciar e pausar"), ("urgencia", "alta ou baixa")):
            with self.subTest(param=param, answer=answer):
                self.assertIsNone(strict_param_value(param, answer))

    def test_initial_phrase_extraction_uses_whole_words(self):
        # Antes: "defeito"/"efeito" -> concluido e "preparar" -> pausar.
        self.assertIsNone(extract_status("mudar status da tarefa corrigir defeito"))
        self.assertIsNone(extract_status("status da tarefa efeito visual"))
        self.assertIsNone(extract_timer_action("cronômetro da tarefa preparar slides"))
        self.assertEqual(extract_status("marcar tarefa relatório final como concluída"), "concluido")
        self.assertEqual(extract_timer_action("parar cronômetro"), "pausar")


class StrictParamFlowTests(AssistantFlowTestCase):
    # (token, frases ate a pergunta, parametro, trecho das opcoes repetidas na pergunta)
    PENDING = {
        "status": ("token-user", ["mudar status", "relatório final"], "pendente, em andamento ou concluído"),
        "acao": ("token-user", ["cronômetro", "relatório final"], "iniciar ou pausar"),
        "urgencia": ("token-admin", ["criar tarefa", "Relatório semanal", "Resumo das entregas", "amanhã"], "baixa, média ou alta"),
    }

    def test_unknown_answer_keeps_the_flow_and_asks_again_without_writing(self):
        for param, (token, steps, options) in self.PENDING.items():
            for answer in ("Hmm", "talvez", "asdf qwer", "?"):
                with self.subTest(param=param, answer=answer):
                    for step in steps:
                        self.send(token, step)
                    payload, status = self.send(token, answer)
                    self.assertEqual(status, 200)
                    self.assertEqual(payload["conversation"]["status"], "awaiting_params")
                    self.assertEqual(payload["conversation"]["next_param"], param)
                    self.assertIn("Não entendi", payload["reply_text"])
                    self.assertIn(options, payload["reply_text"])
                    self.assertFalse(payload["action_executed"])
                    self.assertEqual(self.pending(token)["missing"][0], param)
                    self.assertNotIn(param, {k for k, v in self.pending(token)["params"].items() if v})
                    self.assert_no_writes()
                    self.send(token, "cancelar")

    def test_empty_answer_writes_nothing_and_keeps_the_flow(self):
        self.send("token-user", "mudar status")
        self.send("token-user", "relatório final")
        _payload, status = self.send("token-user", "")
        self.assertEqual(status, 400)
        self.assertEqual(self.pending("token-user")["missing"], ["status"])
        self.assert_no_writes()

    def test_valid_answer_after_an_unknown_one_completes(self):
        task = TASKS[0]["_id"]
        for steps, expected_write in (
            (["mudar status", "relatório final", "Hmm", "Em andamento", "confirmar"], ("PUT", f"/tarefas/{task}/status", {"status": "em_andamento"})),
            (["cronômetro", "relatório final", "talvez", "Pausar", "confirmar"], ("PUT", f"/tarefas/{task}/cronometro", {"acao": "pausar"})),
        ):
            with self.subTest(steps=steps):
                self.api.calls.clear()
                for step in steps:
                    payload, _status = self.send("token-user", step)
                self.assertTrue(payload["action_executed"], payload)
                self.assertEqual(self.api.writes(), [expected_write])
        # Urgencia valida depois de uma desconhecida: segue para a proxima pergunta (equipe), sem escrever.
        for step in self.PENDING["urgencia"][1] + ["Hmm", "média"]:
            payload, _status = self.send("token-admin", step)
        self.assertEqual(payload["conversation"]["next_param"], "equipe")
        self.assertEqual(self.pending("token-admin")["params"]["urgencia"], "media")
        self.assertEqual([w for w in self.api.writes() if w[0] == "POST"], [])

    def test_complete_command_with_unknown_or_ambiguous_value_asks_instead_of_writing(self):
        for token, phrase, param in (
            ("token-user", "mudar status da tarefa relatório final para hmm", "status"),
            ("token-user", "mudar status da tarefa relatório final para pendente e concluído", "status"),
            ("token-user", "cronômetro da tarefa relatório final talvez", "acao"),
            ("token-user", "cronômetro da tarefa preparar slides", "acao"),
        ):
            with self.subTest(phrase=phrase):
                payload, _status = self.send(token, phrase)
                self.assertEqual(payload["conversation"]["status"], "awaiting_params")
                self.assertIn(param, payload["conversation"]["missing"])
                self.send(token, "cancelar")
        self.assert_no_writes()

    def test_client_params_with_unknown_values_never_write(self):
        body = {"conversationId": CONVERSATION_ID, "content": "mudar status da tarefa relatório final", "params": {"status": "hmm"}}
        raw, _status, _headers = function.flowly_http(FakeRequest("/api/v1/messages", body, "token-user"))
        self.assertEqual(json.loads(raw)["conversation"]["next_param"], "status")
        for utterance, params, param in (
            ("mudar status da tarefa relatório final", {"status": "hmm"}, "status"),
            ("cronômetro da tarefa relatório final", {"acao": "talvez"}, "acao"),
            ("criar tarefa", {"nome": "X", "descricao": "Y", "dataEntrega": "2026-12-01", "urgencia": "xyz",
                              "equipe": TEAM_ID, "user": "__none__"}, "urgencia"),
        ):
            with self.subTest(utterance=utterance, params=params):
                token = "token-admin" if utterance == "criar tarefa" else "token-user"
                ScopedConversationState(ConversationStateRepository(), USERS_BY_TOKEN[token]["_id"]).clear(CONVERSATION_ID)
                body = {"conversationId": CONVERSATION_ID, "content": utterance, "params": params}
                raw, _status, _headers = function.flowly_http(FakeRequest("/api/v1/messages", body, token))
                self.assertEqual(json.loads(raw)["conversation"]["next_param"], param)
                # Na rota legada, sem estado nem confirmacao, nenhuma escrita chega a ser validada ou executada.
                raw, status, _headers = function.flowly_http(
                    FakeRequest("/assist", {"utterance": utterance, "params": params}, token))
                payload = json.loads(raw)
                self.assertEqual((status, payload["error"]), (403, "write_requires_confirmation"))
                self.assertIn("Nada foi alterado", payload["reply_text"])
        self.assert_no_writes()

    def test_valid_values_in_the_initial_phrase_or_params_still_write(self):
        task = TASKS[0]["_id"]
        for phrase in ("mudar status da tarefa relatório final para concluído", "iniciar cronômetro da tarefa relatório final"):
            payload, _status = self.send("token-user", phrase)
            self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation")
            self.assertFalse(payload["action_executed"], payload)
            payload, _status = self.send("token-user", "confirmar")
            self.assertTrue(payload["action_executed"], payload)
        body = {"conversationId": CONVERSATION_ID, "content": "mudar status da tarefa relatório final",
                "params": {"status": "Em andamento"}}
        payload, _status = self.frontend_send("token-user", body)
        self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation", payload)
        self.send("token-user", "confirmar")
        self.assertEqual(self.api.writes(), [
            ("PUT", f"/tarefas/{task}/status", {"status": "concluido"}),
            ("PUT", f"/tarefas/{task}/cronometro", {"acao": "iniciar"}),
            ("PUT", f"/tarefas/{task}/status", {"status": "em_andamento"}),
        ])

    def test_words_in_the_task_name_do_not_override_the_answer(self):
        # Antes: "Iniciar migração" + pausar virava PUT iniciar; "Revisão concluída" + pendente virava PUT concluido.
        for steps, expected_write in (
            (["cronômetro", "iniciar migração", "pausar", "confirmar"], ("PUT", f"/tarefas/{TASKS[2]['_id']}/cronometro", {"acao": "pausar"})),
            (["mudar status", "revisão concluída", "pendente", "confirmar"], ("PUT", f"/tarefas/{TASKS[3]['_id']}/status", {"status": "pendente"})),
        ):
            with self.subTest(steps=steps):
                self.api.calls.clear()
                for step in steps:
                    self.send("token-user", step)
                self.assertEqual(self.api.writes(), [expected_write])

    def test_cancel_and_negation_still_win_over_value_parsing(self):
        for steps, answer in (
            (["cronômetro", "relatório final"], "parar"),  # palavra de cancelamento: encerra, nao pausa
            (["mudar status", "relatório final"], "não sei"),
            (["mudar status", "relatório final"], "cancelar"),
        ):
            with self.subTest(answer=answer):
                for step in steps:
                    self.send("token-user", step)
                payload, _status = self.send("token-user", answer)
                self.assertEqual(payload["conversation"]["status"], "cancelled")
        self.assert_no_writes()


class TaskNameIsNotAValueTests(AssistantFlowTestCase):
    """Palavras de status/acao no NOME da tarefa nunca viram o novo valor."""

    def test_parser_takes_status_only_after_para_or_como_and_action_only_before_the_task(self):
        parser = CommandParser(threshold=78)
        expected = {
            "mudar status da tarefa pendente de aprovação": None,
            "atualizar status da tarefa revisão concluída": None,
            "mudar status da tarefa relatório para concluído": "concluido",
            "mudar status da tarefa relatório para em andamento": "em_andamento",
            "mudar status da tarefa pendente de aprovação para concluído": "concluido",
            "marcar tarefa revisão concluída como pendente": "pendente",
            "marcar como concluída a tarefa pendente de aprovação": "concluido",
            "mudar status da tarefa relatório para pendente e concluído": None,
            "mudar status da tarefa relatório para hmm": None,
        }
        for phrase, status in expected.items():
            with self.subTest(phrase=phrase):
                match = parser.match(phrase)
                self.assertEqual(match.command.key, "update_status")
                self.assertEqual(match.params.get("status"), status)
        for phrase, acao in {
            "cronômetro da tarefa iniciar migração": None,
            "cronômetro da tarefa pausar deploy": None,
            "iniciar cronômetro da tarefa pausar deploy": "iniciar",
            "pausar cronômetro da tarefa iniciar migração": "pausar",
            "pausar cronômetro": "pausar",
        }.items():
            with self.subTest(phrase=phrase):
                match = parser.match(phrase)
                self.assertEqual(match.command.key, "timer")
                self.assertEqual(match.params.get("acao"), acao)

    def test_task_names_with_status_or_action_words_ask_instead_of_writing(self):
        for phrase, param in (
            ("mudar status da tarefa pendente de aprovação", "status"),
            ("atualizar status da tarefa revisão concluída", "status"),
            ("cronômetro da tarefa iniciar migração", "acao"),
            ("cronômetro da tarefa pausar deploy", "acao"),
        ):
            with self.subTest(phrase=phrase):
                payload, _status = self.send("token-user", phrase)
                self.assertEqual(payload["conversation"]["status"], "awaiting_params")
                self.assertEqual(payload["conversation"]["next_param"], param)
                self.send("token-user", "cancelar")
        self.assert_no_writes()

    def test_after_asking_the_named_task_gets_the_value_the_user_chose(self):
        for steps, expected_write in (
            (["mudar status da tarefa pendente de aprovação", "concluído", "confirmar"],
             ("PUT", f"/tarefas/{TASK_ID_BY_NAME['Pendente de aprovação']}/status", {"status": "concluido"})),
            (["atualizar status da tarefa revisão concluída", "em andamento", "confirmar"],
             ("PUT", f"/tarefas/{TASK_ID_BY_NAME['Revisão concluída']}/status", {"status": "em_andamento"})),
            (["cronômetro da tarefa iniciar migração", "pausar", "confirmar"],
             ("PUT", f"/tarefas/{TASK_ID_BY_NAME['Iniciar migração']}/cronometro", {"acao": "pausar"})),
            (["cronômetro da tarefa pausar deploy", "iniciar", "confirmar"],
             ("PUT", f"/tarefas/{TASK_ID_BY_NAME['Pausar deploy']}/cronometro", {"acao": "iniciar"})),
        ):
            with self.subTest(steps=steps):
                self.api.calls.clear()
                for step in steps:
                    payload, _status = self.send("token-user", step)
                self.assertTrue(payload["action_executed"], payload)
                self.assertEqual(self.api.writes(), [expected_write])

    def test_explicit_new_value_in_the_initial_phrase_still_writes(self):
        for phrase, expected_write in (
            ("mudar status da tarefa relatório para concluído",
             ("PUT", f"/tarefas/{TASK_ID_BY_NAME['Relatório final']}/status", {"status": "concluido"})),
            ("mudar status da tarefa pendente de aprovação para concluído",
             ("PUT", f"/tarefas/{TASK_ID_BY_NAME['Pendente de aprovação']}/status", {"status": "concluido"})),
            ("marcar tarefa revisão concluída como pendente",
             ("PUT", f"/tarefas/{TASK_ID_BY_NAME['Revisão concluída']}/status", {"status": "pendente"})),
            ("iniciar cronômetro da tarefa pausar deploy",
             ("PUT", f"/tarefas/{TASK_ID_BY_NAME['Pausar deploy']}/cronometro", {"acao": "iniciar"})),
            ("pausar cronômetro da tarefa iniciar migração",
             ("PUT", f"/tarefas/{TASK_ID_BY_NAME['Iniciar migração']}/cronometro", {"acao": "pausar"})),
        ):
            with self.subTest(phrase=phrase):
                self.api.calls.clear()
                payload, _status = self.send("token-user", phrase)
                self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation")
                self.assert_no_writes()
                payload, _status = self.send("token-user", "confirmar")
                self.assertTrue(payload["action_executed"], payload)
                self.assertEqual(self.api.writes(), [expected_write])


class ReadCommandsStillWorkTests(AssistantFlowTestCase):
    def test_reads_for_user_and_admin_only_issue_get(self):
        for token, utterance, key in (
            ("token-user", "minhas tarefas", "my_tasks"),
            ("token-user", "minhas equipes", "my_teams"),
            ("token-user", "meu perfil", "me"),
            ("token-user", "backlog", "backlog"),
            ("token-admin", "listar tarefas", "list_tasks"),
            ("token-admin", "listar equipes", "list_teams"),
        ):
            with self.subTest(token=token, utterance=utterance):
                payload, status = self.send(token, utterance, conversation_id=f"leitura-{key}")
                self.assertEqual(status, 200, payload)
                self.assertTrue(payload["ok"])
                self.assertTrue(payload["action_executed"])
                self.assertEqual(payload["command"]["key"], key)
        self.assert_no_writes()


if __name__ == "__main__":
    unittest.main()
