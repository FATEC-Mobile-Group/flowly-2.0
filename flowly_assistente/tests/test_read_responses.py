"""Respostas das consultas do assistente: tela completa, fala resumida, sem dados sensiveis.

- reply_text (tela) traz o conteudo detalhado; tts.text (fala) resume;
- perfil sem IDs, foto (URL assinada) ou campos de biometria; listas sem e-mail de terceiros;
- tarefas: as opcoes mostradas sao exatamente as guardadas para selecao (no maximo 10);
- permissoes, selecao e contrato da resposta continuam iguais; nenhuma consulta escreve.

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
from flowly_assistant.storage.conversation_state import (  # noqa: E402
    ConversationStateRepository,
    ScopedConversationState,
)

CONVERSATION_ID = "voice-consultas-1767225600000"
SIGNED_URL = "https://storage.example.test/foto.png?X-Goog-Signature=ficticia"
PROFILES = {
    "token-admin": {
        "_id": "a" * 24, "nome": "Ana Admin", "email": "ana@example.test", "tipo": "admin",
        "fotoPerfil": SIGNED_URL, "faceEnrollmentOffered": True, "faceEnrollmentSkipped": False,
    },
    "token-user": {
        "_id": "b" * 24, "nome": "Caio Colaborador", "email": "caio@example.test", "tipo": "user",
        "fotoPerfil": SIGNED_URL, "faceEnrollmentOffered": False, "faceEnrollmentSkipped": True,
    },
}
ADMIN_ONLY_PATHS = {"/users", "/users/search", "/equipes", "/tarefas"}


def make_person(index):
    return {"_id": f"{0xd00 + index:024x}", "nome": f"Pessoa {index:02d}", "email": f"pessoa{index}@example.test",
            "fotoPerfil": SIGNED_URL, "tipo": "user"}


def make_team(index):
    return {"_id": f"{0xc00 + index:024x}", "nome": f"Equipe {index:02d}",
            "membros": [make_person(1), make_person(2)], "createdBy": "a" * 24}


def make_task(index):
    return {
        "_id": f"{0xe00 + index:024x}", "descricao": f"Atividade {index:02d}", "detalhes": f"Detalhe fictício {index}",
        "status": "pendente", "urgencia": "alta", "dataEntrega": "2026-12-01T00:00:00.000Z",
        "equipe": {"_id": make_team(1)["_id"], "nome": "Equipe 01"},
        "user": {"_id": "b" * 24, "nome": "Caio Colaborador"}, "anexos": [{"url": SIGNED_URL}],
    }


def make_message(index):
    return {"texto": f"Conteúdo sigiloso fictício {index}", "user": {"nome": f"Pessoa {index % 3 + 1:02d}", "fotoPerfil": SIGNED_URL},
            "createdAt": f"2026-11-{index:02d}T12:00:00.000Z"}


class FakeRequest:
    def __init__(self, path, body, token):
        self.method = "POST"
        self.path = path
        self._body = body
        self.headers = {"Authorization": f"Bearer {token}"}

    def get_json(self, silent=True):
        return self._body


class FakeFlowlyAPI:
    """Substitui FlowlyAPIClient.request: dados configuraveis e as mesmas restricoes de admin da API."""

    def __init__(self):
        self.calls = []
        self.profiles = {token: dict(profile) for token, profile in PROFILES.items()}
        self.teams = [make_team(index) for index in range(1, 15)]
        self.tasks = [make_task(index) for index in range(1, 13)]
        self.members = [make_person(index) for index in range(1, 5)]
        self.users = [make_person(index) for index in range(1, 11)]
        self.messages = [make_message(index) for index in range(1, 31)]

    def writes(self):
        return [call for call in self.calls if call[0] != "GET"]

    def __call__(self, client, method, path, **kwargs):
        method = method.upper()
        self.calls.append((method, path))
        if method != "GET":
            return {"ok": True}
        if client.token not in self.profiles:
            raise APIError("HTTP 401 em GET /users/me: Token inválido")
        if path == "/users/me":
            return self.profiles[client.token]
        if path in ADMIN_ONLY_PATHS and self.profiles[client.token].get("tipo") != "admin":
            raise APIError(f"HTTP 403 em GET {path}: Acesso negado")
        if path in ("/equipes", "/equipes/minhas"):
            return self.teams
        if path.endswith("/membros"):
            return self.members
        if path.endswith("/messages"):
            return self.messages
        if path in ("/tarefas", "/tarefas/minhas", "/tarefas/backlog"):
            return self.tasks
        if path.endswith("/detalhes"):
            task = next(task for task in self.tasks if task["_id"] == path.split("/")[2])
            return {
                "tarefa": task,
                "comentarios": [{"texto": "Comentário sigiloso fictício", "user": {"nome": "Pessoa 01"}}],
                "logs": [{"descricao": "Registro interno fictício", "user": {"nome": "Pessoa 02"}}],
            }
        if path == "/users":
            return self.users
        if path == "/users/search":
            return self.users[:2]
        raise AssertionError(f"Chamada inesperada à API: {method} {path}")


class ReadResponseTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        env = patch.dict(
            os.environ,
            {
                "FLOWLY_CONVERSATION_STORE": os.path.join(tmp.name, "state.json"),
                "FLOWLY_API_BASE_URL": "https://api.flowly.test/api",
                # Padroes de producao, independentes de um .env local.
                "FLOWLY_TTS_ENABLED": "true",
                "FLOWLY_LANGUAGE": "pt-BR",
            },
        )
        env.start()
        self.addCleanup(env.stop)

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
        # Formatadores puros (sem rede nem estado), para objetos incompletos.
        self.agent = message_agent.MessageAgent.__new__(message_agent.MessageAgent)

    def send(self, token, content, conversation_id=CONVERSATION_ID, **body):
        body = {"conversationId": conversation_id, "content": content, "channelId": "voice-assistant", **body}
        raw, status, _headers = function.flowly_http(FakeRequest("/api/v1/messages", body, token))
        return json.loads(raw), status

    def read(self, token, content, conversation_id=CONVERSATION_ID):
        payload, status = self.send(token, content, conversation_id)
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["ok"], payload)
        return payload, payload["reply_text"], payload["tts"]["text"]

    def pending(self, token, conversation_id=CONVERSATION_ID):
        user_id = PROFILES[token]["_id"]
        return ScopedConversationState(ConversationStateRepository(), user_id).get(conversation_id)

    def assert_no_sensitive_data(self, *texts):
        for text in texts:
            self.assertNotIn("example.test", text.replace("ana@example.test", "").replace("caio@example.test", ""))
            for forbidden in ("X-Goog", "http", "face", "biometr", "a" * 24, "b" * 24, "sigiloso", "interno"):
                self.assertNotIn(forbidden, text)

    def tearDown(self):
        self.assertEqual(self.api.writes(), [], f"consulta escreveu: {self.api.writes()}")


class ProfileReplyTests(ReadResponseTestCase):
    def test_profile_shows_name_type_and_email_and_speaks_only_name_and_type(self):
        for token, nome, tipo, email in (
            ("token-admin", "Ana Admin", "conta de administrador", "ana@example.test"),
            ("token-user", "Caio Colaborador", "conta de colaborador", "caio@example.test"),
        ):
            with self.subTest(token=token):
                payload, display, spoken = self.read(token, "meu perfil", conversation_id=f"perfil-{token}")
                self.assertEqual(display, f"Seu perfil: {nome}, {tipo}, e-mail {email}.")
                self.assertEqual(spoken, f"Seu perfil: {nome}, {tipo}.")
                self.assertNotIn(email, spoken)
                self.assert_no_sensitive_data(display, spoken)
                # Contrato preservado: result continua sendo o objeto da API.
                self.assertEqual(payload["result"]["email"], email)
                self.assertEqual(payload["command"]["key"], "me")

    def test_incomplete_or_unexpected_profiles(self):
        self.assertEqual(self.agent._profile_reply({"nome": "Só Nome"}), ("Seu perfil: Só Nome.", "Seu perfil: Só Nome."))
        self.assertEqual(
            self.agent._profile_reply({"email": "x@example.test", "tipo": "outro"}),
            ("Seu perfil: e-mail x@example.test.", "Seu perfil está na tela."),
        )
        empty = "Seu perfil não tem nome, tipo de conta ou e-mail para mostrar."
        self.assertEqual(self.agent._profile_reply({"_id": "a" * 24, "fotoPerfil": SIGNED_URL}), (empty, empty))
        unreadable = "Não consegui ler os dados do seu perfil."
        self.assertEqual(self.agent._profile_reply("<html>erro</html>"), (unreadable, unreadable))
        # Pela API: tipo desconhecido nao vira rotulo nem quebra a permissao de "any".
        self.api.profiles["token-user"]["tipo"] = "desconhecido"
        _payload, display, _spoken = self.read("token-user", "meu perfil")
        self.assertEqual(display, "Seu perfil: Caio Colaborador, e-mail caio@example.test.")


class TeamListReplyTests(ReadResponseTestCase):
    def test_fourteen_teams_all_on_screen_and_eight_spoken(self):
        for token, utterance in (("token-admin", "listar equipes"), ("token-user", "minhas equipes")):
            with self.subTest(token=token, utterance=utterance):
                payload, display, spoken = self.read(token, utterance, conversation_id=f"equipes-{token}")
                names = [f"Equipe {index:02d}" for index in range(1, 15)]
                self.assertEqual(display, f"Você participa de 14 equipes: {', '.join(names)}.")
                self.assertEqual(
                    spoken,
                    f"Você participa de 14 equipes: {', '.join(names[:8])} e mais 6. A lista completa está na tela.",
                )
                self.assertNotEqual(display, spoken)
                # Membros, e-mails e fotos das equipes nao entram no texto.
                self.assertNotIn("Pessoa", display + spoken)
                self.assert_no_sensitive_data(display, spoken)
                self.assertEqual(len(payload["result"]), 14)

    def test_empty_small_unnamed_and_unexpected_team_lists(self):
        reply = self.agent._teams_reply
        empty = "Não encontrei equipes vinculadas a você."
        self.assertEqual(reply([]), (empty, empty))
        self.assertEqual(reply([{"nome": "Alfa"}, {"nome": "Beta"}]), ("Você participa de 2 equipes: Alfa, Beta.",) * 2)
        self.assertEqual(reply([{"nome": "Alfa"}]), ("Você participa de 1 equipe: Alfa.",) * 2)
        self.assertEqual(reply([{"_id": "x"}, {"nome": " "}]), ("Você participa de 2 equipes.",) * 2)
        self.assertEqual(reply([{"nome": "Alfa"}, {"_id": "x"}])[0], "Você participa de 2 equipes: Alfa e mais 1 sem nome.")
        # Resultado fora do formato esperado conta como lista vazia.
        self.api.teams = "<html>erro</html>"
        _payload, display, spoken = self.read("token-user", "minhas equipes")
        self.assertEqual((display, spoken), (empty, empty))


class TaskListReplyTests(ReadResponseTestCase):
    def test_lists_with_0_1_5_10_and_more_than_10_tasks(self):
        follow_up = "Você pode pedir detalhes, atribuir uma tarefa para você ou cancelar."
        for count in (0, 1, 5, 10, 12):
            with self.subTest(count=count):
                conversation = f"tarefas-{count}"
                self.api.tasks = [make_task(index) for index in range(1, count + 1)]
                payload, display, spoken = self.read("token-user", "minhas tarefas", conversation_id=conversation)
                state = self.pending("token-user", conversation)
                if count == 0:
                    self.assertEqual((display, spoken), ("Não encontrei tarefas para listar.",) * 2)
                    self.assertIsNone(state)
                    self.assertNotIn("conversation", payload)
                    continue

                options = min(count, 10)
                header = f"Encontrei {count} tarefa{'s' if count != 1 else ''}."
                self.assertTrue(display.startswith(f"{header} Opções para seleção: 1. Atividade 01, status pendente"))
                self.assertTrue(spoken.startswith(f"{header} 1. Atividade 01, status pendente, equipe Equipe 01."))
                self.assertTrue(display.endswith(follow_up) and spoken.endswith(follow_up))
                # Tela: as mesmas opcoes guardadas no estado, numeradas, com resumo; nada alem delas como opcao.
                self.assertEqual([task["_id"] for task in state["tasks"]], [make_task(i)["_id"] for i in range(1, options + 1)])
                for index in range(1, options + 1):
                    self.assertIn(f"{index}. Atividade {index:02d}, status pendente, urgência alta, equipe Equipe 01, "
                                  "entrega 01/12/2026", display)
                for index in range(options + 1, count + 1):
                    self.assertNotIn(f"Atividade {index:02d}", display + spoken)
                self.assertEqual("Mais 2 tarefas ficam fora desta seleção" in display, count == 12)
                # Fala: no maximo cinco, sem urgencia/entrega, e avisa das outras opcoes na tela.
                for index in range(1, min(count, 5) + 1):
                    self.assertIn(f"{index}. Atividade {index:02d}", spoken)
                for index in range(6, count + 1):
                    self.assertNotIn(f"Atividade {index:02d}", spoken)
                self.assertNotIn("entrega", spoken)
                extra = options - 5
                if extra > 0:
                    self.assertIn(f"Há mais {extra} opções na tela.", spoken)
                else:
                    self.assertNotIn("Há mais", spoken)
                self.assert_no_sensitive_data(display, spoken)
                self.assertEqual(payload["conversation"]["status"], "browsing_tasks")

    def test_backlog_and_admin_list_use_the_same_format(self):
        for token, utterance in (("token-user", "backlog"), ("token-admin", "listar tarefas")):
            with self.subTest(utterance=utterance):
                _payload, display, spoken = self.read(token, utterance, conversation_id=f"lista-{utterance}")
                self.assertIn("Encontrei 12 tarefas. Opções para seleção: 1. Atividade 01", display)
                self.assertIn("10. Atividade 10", display)
                self.assertIn("Há mais 5 opções na tela.", spoken)

    def test_selection_after_the_list_still_works(self):
        self.read("token-user", "minhas tarefas")
        payload, display, _spoken = self.read("token-user", "7")
        self.assertEqual(payload["conversation"]["status"], "awaiting_task_action")
        self.assertIn("Atividade 07", display)
        payload, display, spoken = self.read("token-user", "detalhes")
        self.assertEqual(self.api.calls[-1], ("GET", f"/tarefas/{make_task(7)['_id']}/detalhes"))
        self.assertIn("detalhes: Detalhe fictício 7", display)
        self.assertNotIn("Detalhe fictício", spoken)
        # No fluxo de selecao, o convite para continuar aparece na tela e na fala.
        self.assertTrue(display.endswith("Voce pode pedir outra tarefa, atribuir para voce ou cancelar."))
        self.assertTrue(spoken.endswith("Voce pode pedir outra tarefa, atribuir para voce ou cancelar."))
        # Opcao fora das 10 guardadas continua pedindo nova escolha (PR #20).
        payload, display, _spoken = self.read("token-user", "11")
        self.assertEqual(payload["conversation"]["status"], "awaiting_task_selection")
        self.assertIn("10. Atividade 10", display)


class TaskDetailsReplyTests(ReadResponseTestCase):
    def test_direct_details_show_everything_on_screen_and_speak_without_the_details_text(self):
        payload, display, spoken = self.read("token-user", "detalhes da tarefa atividade 03")
        self.assertEqual(payload["command"]["key"], "task_details")
        expected = "Tarefa Atividade 03. status pendente. equipe Equipe 01. responsavel Caio Colaborador"
        self.assertEqual(display, f"{expected}. detalhes: Detalhe fictício 3.")
        self.assertEqual(spoken, f"{expected}.")
        # Sem comentarios, logs, anexos (URL assinada) ou convite de selecao (nao ha lista ativa).
        self.assert_no_sensitive_data(display, spoken)
        self.assertNotIn("atribuir", display)
        self.assertIsNone(self.pending("token-user"))

    def test_incomplete_or_unexpected_details(self):
        reply = self.agent._task_details_reply
        unreadable = "Não consegui ler os detalhes dessa tarefa."
        self.assertEqual(reply(None, follow_up=False), (unreadable, unreadable))
        self.assertEqual(reply({"tarefa": "texto"}, follow_up=True), (unreadable, unreadable))
        minimal = ("Tarefa sem descricao. status pendente. sem responsavel.",) * 2
        self.assertEqual(reply({"tarefa": {}}, follow_up=False), minimal)
        long_details = "x" * 500
        display, spoken = reply({"tarefa": {"descricao": "Longa", "detalhes": long_details}}, follow_up=False)
        self.assertIn("x" * 180, display)
        self.assertNotIn("x" * 181, display)
        self.assertNotIn("x", spoken.replace("sem descricao", ""))


class PeopleAndMessagesReplyTests(ReadResponseTestCase):
    def test_team_members_show_count_and_names_without_emails(self):
        _payload, display, spoken = self.read("token-admin", "membros da equipe equipe 03")
        self.assertEqual(display, "A equipe Equipe 03 tem 4 membros: Pessoa 01, Pessoa 02, Pessoa 03, Pessoa 04.")
        self.assertEqual(spoken, display)
        self.api.members = [make_person(index) for index in range(1, 11)]
        _payload, display, spoken = self.read("token-admin", "membros da equipe equipe 03", conversation_id="membros-10")
        self.assertIn("Pessoa 10.", display)
        self.assertTrue(spoken.endswith("Pessoa 08 e mais 2. A lista completa está na tela."))
        self.assert_no_sensitive_data(display, spoken)

    def test_users_and_search_show_count_and_names_without_emails(self):
        _payload, display, spoken = self.read("token-admin", "listar usuarios")
        self.assertEqual(display, "Encontrei 10 usuários: " + ", ".join(f"Pessoa {i:02d}" for i in range(1, 11)) + ".")
        self.assertEqual(
            spoken,
            "Encontrei 10 usuários: " + ", ".join(f"Pessoa {i:02d}" for i in range(1, 9))
            + " e mais 2. A lista completa está na tela.",
        )
        _payload, display, spoken = self.read("token-admin", "buscar usuario pessoa", conversation_id="busca")
        self.assertEqual((display, spoken), ("Encontrei 2 usuários: Pessoa 01, Pessoa 02.",) * 2)
        self.assert_no_sensitive_data(display, spoken)

    def test_team_messages_show_count_and_latest_author_without_content(self):
        _payload, display, spoken = self.read("token-admin", "mensagens da equipe equipe 03")
        self.assertEqual(display, "O chat da equipe Equipe 03 tem 30 mensagens. A mais recente é de Pessoa 01.")
        self.assertEqual(spoken, display)
        self.assert_no_sensitive_data(display, spoken)
        # Fora de ordem, a data decide; sem autor, so a quantidade.
        reply = self.agent._messages_reply
        out_of_order = [make_message(20), make_message(25), make_message(3)]
        self.assertEqual(reply(out_of_order, "Alfa")[0], "O chat da equipe Alfa tem 3 mensagens. A mais recente é de Pessoa 02.")
        self.assertEqual(reply([{"texto": "oi"}], ""), ("O chat da equipe tem 1 mensagem.",) * 2)

    def test_empty_people_and_message_lists(self):
        self.assertEqual(self.agent._members_reply([], "Alfa"), ("A equipe Alfa não tem membros para mostrar.",) * 2)
        self.assertEqual(self.agent._users_reply([]), ("Não encontrei usuários.",) * 2)
        self.assertEqual(self.agent._messages_reply([], "Alfa"), ("O chat da equipe Alfa não tem mensagens.",) * 2)
        self.assertEqual(self.agent._users_reply([{"email": "z@example.test"}]), ("Encontrei 1 usuário.",) * 2)


class ReadContractAndPermissionTests(ReadResponseTestCase):
    def test_permissions_are_unchanged(self):
        for token, utterance in (
            ("token-user", "listar usuarios"),  # recusado pela API (somente admin)
            ("token-user", "buscar usuario pessoa"),
            ("token-user", "listar equipes"),  # recusado pelo assistente (comando de admin)
            ("token-user", "listar tarefas"),
            ("token-admin", "minhas tarefas"),  # comando de colaborador
        ):
            with self.subTest(token=token, utterance=utterance):
                payload, status = self.send(token, utterance, conversation_id=f"permissao-{utterance}")
                self.assertFalse(payload["ok"])
                self.assertIn(status, (400, 403))
                self.assertFalse(payload["action_executed"])
                self.assertNotIn("Pessoa", payload["reply_text"])
                self.assertNotIn("Equipe 01", payload["reply_text"])

    def test_contract_fields_are_kept_and_reads_never_write(self):
        reads = (
            ("token-admin", "meu perfil"), ("token-user", "meu perfil"), ("token-admin", "listar equipes"),
            ("token-user", "minhas equipes"), ("token-user", "minhas tarefas"), ("token-user", "backlog"),
            ("token-admin", "listar tarefas"), ("token-user", "detalhes da tarefa atividade 02"),
            ("token-admin", "membros da equipe equipe 02"), ("token-admin", "mensagens da equipe equipe 02"),
            ("token-admin", "listar usuarios"), ("token-admin", "buscar usuario pessoa"),
        )
        for token, utterance in reads:
            with self.subTest(token=token, utterance=utterance):
                payload, display, spoken = self.read(token, utterance, conversation_id=f"contrato-{utterance}")
                for field in ("ok", "reply_text", "tts", "result", "action_executed", "command"):
                    self.assertIn(field, payload)
                self.assertTrue(payload["action_executed"])
                self.assertEqual(set(payload["tts"]), {"enabled", "language", "text"})
                self.assertTrue(payload["tts"]["enabled"])
                self.assertEqual(payload["tts"]["language"], "pt-BR")
                self.assertTrue(display and spoken)
        self.assertEqual(self.api.writes(), [])

    def test_tts_settings_from_the_request_are_respected(self):
        payload, _status = self.send("token-admin", "listar equipes", tts_enabled="false", language="pt-PT")
        self.assertFalse(payload["tts"]["enabled"])
        self.assertEqual(payload["tts"]["language"], "pt-PT")
        self.assertIn("e mais 6", payload["tts"]["text"])


if __name__ == "__main__":
    unittest.main()
