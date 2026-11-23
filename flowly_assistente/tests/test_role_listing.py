"""Listagem de tarefas conforme o perfil autenticado (tipo lido da API em /users/me).

- colaborador: "listar tarefas" e equivalentes consultam so as proprias tarefas (GET /tarefas/minhas);
- admin: "listar tarefas" continua sendo a lista geral (GET /tarefas); "minhas tarefas" continua recusado;
- sem autenticacao, nada roda; nenhuma consulta escreve; o tipo enviado pelo cliente e ignorado.

A API do Flowly e simulada (FakeFlowlyAPI de test_read_responses): /tarefas devolve 403 para quem nao e admin.
"""

import unittest

from test_read_responses import ReadResponseTestCase  # noqa: F401 (base com API falsa e checagem de escrita)

from flowly_assistant.command_parser import CommandParser, Match, resolve_for_role

USER_LISTING_PHRASES = (
    "listar tarefas", "listar as tarefas", "mostrar tarefas", "mostre minhas tarefas", "quais tarefas tenho?",
    "ver minhas atividades", "listar minhas tarefas", "minhas atividades",
)


class ResolveForRoleTests(unittest.TestCase):
    def setUp(self):
        self.parser = CommandParser()

    def key(self, text, user_type):
        match = resolve_for_role(self.parser.match(text), user_type, self.parser.commands)
        return match.command.key if match else None

    def test_only_the_explicit_equivalence_applies(self):
        self.assertEqual(self.key("listar tarefas", "user"), "my_tasks")
        self.assertEqual(self.key("listar tarefas", "admin"), "list_tasks")
        # Perfil desconhecido (falha ao ler /users/me): nada muda; a API continua decidindo.
        self.assertEqual(self.key("listar tarefas", None), "list_tasks")
        self.assertEqual(self.key("listar tarefas", "superadmin"), "list_tasks")
        # Outros comandos de admin nao viram nada para o colaborador.
        self.assertEqual(self.key("listar equipes", "user"), "list_teams")
        self.assertEqual(self.key("listar usuarios", "user"), "list_users")
        self.assertIsNone(resolve_for_role(None, "user", self.parser.commands))

    def test_write_commands_are_never_resolved(self):
        commands = {c.key: c for c in self.parser.commands}
        write = Match(command=commands["delete_task"], score=100, params={"task_id": "x"})
        self.assertIs(resolve_for_role(write, "user", self.parser.commands), write)
        self.assertEqual(self.key("excluir tarefa", "user"), "delete_task")
        self.assertEqual(self.key("criar tarefa", "user"), "create_task")


class RoleListingAgentTests(ReadResponseTestCase):
    def task_paths(self):
        return [path for _method, path in self.api.calls if path.startswith("/tarefas")]

    def test_collaborator_listing_phrases_read_only_their_tasks(self):
        for index, phrase in enumerate(USER_LISTING_PHRASES):
            with self.subTest(phrase=phrase):
                self.api.calls.clear()
                payload, status = self.send("token-user", phrase, conversation_id=f"lista-{index}")
                self.assertEqual(status, 200, payload)
                self.assertTrue(payload["ok"], payload)
                self.assertEqual(payload["command"]["key"], "my_tasks")
                self.assertEqual(self.task_paths(), ["/tarefas/minhas"])
                self.assertTrue(payload["reply_text"].startswith("Encontrei 12 tarefas."))

    def test_client_cannot_claim_admin_role(self):
        payload, _status = self.send("token-user", "listar tarefas", userType="admin", role="admin", tipo="admin")
        self.assertEqual(payload["command"]["key"], "my_tasks")
        self.assertNotIn("/tarefas", self.task_paths())

    def test_admin_keeps_the_general_listing_and_collaborator_command_stays_refused(self):
        payload, status = self.send("token-admin", "listar tarefas", conversation_id="admin-lista")
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["command"]["key"], "list_tasks")
        self.assertIn("/tarefas", self.task_paths())
        payload, status = self.send("token-admin", "minhas tarefas", conversation_id="admin-minhas")
        self.assertFalse(payload["ok"])
        self.assertEqual(status, 403)

    def test_unauthenticated_request_is_refused(self):
        payload, status = self.send("token-invalido", "listar tarefas", conversation_id="sem-login")
        self.assertEqual(status, 401)
        self.assertFalse(payload["ok"])
        self.assertEqual(self.task_paths(), [])


if __name__ == "__main__":
    unittest.main()
