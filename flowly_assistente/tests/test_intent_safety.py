"""Intencao mal interpretada nunca vira escrita.

- S1: "para mim" sozinho nao e atribuicao; pedido de detalhes e consulta; detalhes + atribuir na mesma frase
  pergunta antes de escrever.
- S2: referencia a outra tarefa que nao pode ser resolvida (nome com erro, incompleto, fora das opcoes ou
  desconhecido) pede nova escolha e nunca reaproveita a tarefa escolhida antes; nome aproximado nao autoriza escrita.
- S3: um comando dito em resposta a uma pergunta pendente nao vira valor de campo; o assistente pergunta se e para
  continuar ou trocar de comando. Com o rotulo do campo ("nome Minhas Tarefas"), o valor e aceito.

A API do Flowly e simulada: nenhuma rede, banco ou dado real e usado.
"""

import unittest

from test_command_safety import (
    BACKLOG_TASKS,
    CONVERSATION_ID,
    TASKS,
    TEAM_ID,
    USERS_BY_TOKEN,
    AssistantFlowTestCase,
)
from fake_conversations import ConversationStateRepository, ScopedConversationState

TASK = {index: task["_id"] for index, task in enumerate(BACKLOG_TASKS, start=1)}
# Nomes com verbos de acao ("Pegar", "Abrir"): o nome citado nao pode decidir a acao.
ACTION_NAMED_TASKS = [
    {"_id": "f" * 22 + f"{index:02d}", "descricao": name, "status": "pendente", "equipe": {"_id": TEAM_ID, "nome": "Equipe Alfa"}}
    for index, name in enumerate(
        ("Pegar feedback dos clientes", "Abrir chamado no suporte", "Ajustar layout do painel", "Configurar alertas"),
        start=1,
    )
]


def assign_call(task_id):
    return ("PUT", f"/tarefas/{task_id}/atribuir-para-mim", None)


class TaskSelectionIntentTestCase(AssistantFlowTestCase):
    token = "token-user"

    def setUp(self):
        super().setUp()
        self.api.backlog = BACKLOG_TASKS

    def state(self):
        return ScopedConversationState(ConversationStateRepository(), USERS_BY_TOKEN[self.token]["_id"])

    def browse(self, select=None):
        # Cada caso comeca do zero: lista o backlog e, se pedido, escolhe uma tarefa.
        self.state().clear(CONVERSATION_ID)
        payload, _status = self.send(self.token, "backlog")
        self.assertEqual(payload["conversation"]["status"], "browsing_tasks")
        if select:
            payload, _status = self.send(self.token, select)
            self.assertEqual(payload["conversation"]["status"], "awaiting_task_action")
        self.api.calls.clear()

    def say(self, phrase):
        before = len(self.api.calls)
        payload, status = self.send(self.token, phrase)
        writes = [call for call in self.api.calls[before:] if call[0] != "GET"]
        reads = [call[1] for call in self.api.calls[before:] if call[0] == "GET" and call[1] != "/users/me"]
        return payload, status, writes, reads


class AssignNeedsExplicitIntentTests(TaskSelectionIntentTestCase):
    """S1: "para mim" sozinho nao atribui; detalhes sao consulta; leitura + escrita na mesma frase pergunta."""

    NOT_ASSIGN = (
        "mostra os detalhes para mim",
        "mostra a 3 para mim",
        "lê a terceira para mim",
        "a 3 para mim",
        "quero ver essa para mim",
        "detalhes da 3 para mim",
        "mostrar os detalhes e atribuir para mim",
        "abrir a 3 e atribuir para mim",
    )

    def test_phrases_without_explicit_assign_intent_never_write(self):
        for phrase in self.NOT_ASSIGN:
            for selected_before in (None, "7"):
                with self.subTest(phrase=phrase, selected_before=selected_before):
                    self.browse(select=selected_before)
                    payload, status, writes, _reads = self.say(phrase)
                    self.assertEqual(status, 200, payload)
                    self.assertEqual(writes, [], payload["reply_text"])
                    self.assertNotEqual((payload.get("command") or {}).get("key"), "assign_to_me")

    def test_details_request_with_para_mim_reads_the_selected_task(self):
        self.browse(select="7")
        payload, _status, writes, reads = self.say("mostra os detalhes para mim")
        self.assertEqual(writes, [])
        self.assertEqual(reads, [f"/tarefas/{TASK[7]}/detalhes"])
        self.assertEqual(payload["command"]["key"], "task_details")
        self.assertIn("Preparar demonstração", payload["reply_text"])

        self.browse()
        payload, _status, writes, reads = self.say("detalhes da 3 para mim")
        self.assertEqual(writes, [])
        self.assertEqual(reads, [f"/tarefas/{TASK[3]}/detalhes"])

    def test_position_with_para_mim_only_selects_and_asks(self):
        for phrase in ("mostra a 3 para mim", "lê a terceira para mim", "a 3 para mim"):
            with self.subTest(phrase=phrase):
                self.browse(select="7")
                payload, _status, writes, reads = self.say(phrase)
                self.assertEqual((writes, reads), ([], []))
                self.assertEqual(payload["conversation"]["status"], "awaiting_task_action")
                self.assertIn("Selecionei Corrigir filtro de busca", payload["reply_text"])
                self.assertEqual(self.state().get(CONVERSATION_ID)["selected_task_id"], TASK[3])

    def test_details_and_assign_in_the_same_phrase_asks_without_writing(self):
        for phrase, selected_before, expected_task in (
            ("mostrar os detalhes e atribuir para mim", "7", 7),
            ("abrir a 3 e atribuir para mim", None, 3),
            ("abrir a 3 e atribuir para mim", "7", 3),
            ("atribuir para mim e mostrar os detalhes", "7", 7),
        ):
            with self.subTest(phrase=phrase, selected_before=selected_before):
                self.browse(select=selected_before)
                payload, _status, writes, reads = self.say(phrase)
                self.assertEqual((writes, reads), ([], []))
                self.assertEqual(payload["conversation"]["status"], "awaiting_task_action")
                self.assertIn("detalhes ou atribuir", payload["reply_text"])
                self.assertFalse(payload["action_executed"])
                self.assertEqual(self.state().get(CONVERSATION_ID)["selected_task_id"], TASK[expected_task])

    def test_explicit_assign_still_works(self):
        for steps, expected in (
            (("7", "atribuir para mim"), 7),
            (("7", "atribuir essa para mim"), 7),
            (("7", "pode atribuir ela pra mim por favor"), 7),
            (("7", "assumir essa tarefa"), 7),
            (("7", "pegar essa tarefa para mim"), 7),
            (("7", "detalhes", "atribuir para mim"), 7),
            # Tarefa citada agora por numero ou nome: resumo com o nome e confirmacao explicita antes do PUT.
            (("atribuir a 3 para mim", "confirmar"), 3),
            (("7", "atribuir a 3 para mim", "confirmar"), 3),
            (("pegar a 2 para mim", "confirmar"), 2),
            (("atribuir configurar alertas para mim", "confirmar"), 8),
            (("7", "atribuir configurar alertas para mim", "confirmar"), 8),
        ):
            with self.subTest(steps=steps):
                self.browse()
                for step in steps:
                    payload, _status, writes, _reads = self.say(step)
                self.assertEqual(writes, [assign_call(TASK[expected])], payload["reply_text"])
                self.assertEqual(payload["conversation"]["status"], "completed")
                self.assertIsNone(self.state().get(CONVERSATION_ID))

    def test_action_words_inside_a_task_name_do_not_decide_the_action(self):
        self.api.backlog = ACTION_NAMED_TASKS
        pegar, abrir = ACTION_NAMED_TASKS[0]["_id"], ACTION_NAMED_TASKS[1]["_id"]
        for phrase, selected_before in (
            ("detalhes da pegar feedback dos clientes", None),
            ("detalhes da pegar feedback dos clientes", "3"),
        ):
            with self.subTest(phrase=phrase, selected_before=selected_before):
                self.browse(select=selected_before)
                payload, _status, writes, reads = self.say(phrase)
                self.assertEqual(writes, [])
                self.assertEqual(reads, [f"/tarefas/{pegar}/detalhes"])
        for phrase, task_id in (
            ("atribuir pegar feedback dos clientes para mim", pegar),
            ("atribuir abrir chamado no suporte para mim", abrir),
        ):
            with self.subTest(phrase=phrase):
                self.browse(select="3")
                payload, _status, writes, _reads = self.say(phrase)
                self.assertEqual((writes, payload["conversation"]["status"]), ([], "awaiting_confirmation"))
                task_name = next(t["descricao"] for t in ACTION_NAMED_TASKS if t["_id"] == task_id)
                self.assertIn(f'"{task_name}', payload["reply_text"])
                _payload, _status, writes, _reads = self.say("confirmar")
                self.assertEqual(writes, [assign_call(task_id)])


class UnknownReferenceNeverReusesSelectionTests(TaskSelectionIntentTestCase):
    """S2: referencia nao resolvida pede nova escolha e descarta a tarefa escolhida antes."""

    UNKNOWN = (
        "atribuir configurar alerta para mim",  # erro de transcricao: a lista tem "Configurar alertas" (8)
        "atribuir corrigir filtro para mim",  # nome incompleto da 3
        "atribuir traduzir mensagens para mim",  # 11: existe, mas fica fora das 10 opcoes
        "atribuir relatorio trimestral para mim",  # tarefa desconhecida
        "pegar a tarefa de deploy",
        "assumir configurar alerta",
        "detalhes de configurar alerta",
        "mostrar minhas equipes",
    )

    def test_unresolved_reference_asks_again_with_the_options(self):
        for phrase in self.UNKNOWN:
            for selected_before in (None, "7"):
                with self.subTest(phrase=phrase, selected_before=selected_before):
                    self.browse(select=selected_before)
                    payload, status, writes, reads = self.say(phrase)
                    self.assertEqual(status, 200, payload)
                    self.assertEqual((writes, reads), ([], []), payload["reply_text"])
                    self.assertEqual(payload["conversation"]["status"], "awaiting_task_selection")
                    self.assertFalse(payload["action_executed"])
                    self.assertIn("1. Ajustar layout do painel", payload["reply_text"])
                    self.assertIn("10. Melhorar acessibilidade", payload["reply_text"])
                    state = self.state().get(CONVERSATION_ID)
                    self.assertNotIn("selected_task_id", state)
                    self.assertEqual(len(state["tasks"]), 10)

    def test_after_asking_again_a_valid_choice_and_cancel_still_work(self):
        self.browse(select="7")
        self.say("atribuir configurar alerta para mim")
        _payload, _status, writes, _reads = self.say("atribuir para mim")
        self.assertEqual(writes, [])  # a 7 foi descartada: sem nova escolha nao ha alvo
        payload, _status, writes, _reads = self.say("atribuir a 8 para mim")
        self.assertEqual(writes, [])
        payload, _status, writes, _reads = self.say("confirmar")
        self.assertEqual(writes, [assign_call(TASK[8])], payload["reply_text"])

        self.browse(select="7")
        self.say("atribuir relatorio trimestral para mim")
        payload, _status, writes, _reads = self.say("cancelar")
        self.assertEqual((payload["conversation"]["status"], writes), ("cancelled", []))
        self.assertIsNone(self.state().get(CONVERSATION_ID))

    def test_approximate_name_selects_but_never_writes(self):
        self.api.backlog = ACTION_NAMED_TASKS
        pegar = ACTION_NAMED_TASKS[0]["_id"]
        for selected_before in (None, "3"):
            with self.subTest(selected_before=selected_before):
                self.browse(select=selected_before)
                # "pegar feedback" e parte do nome: so seleciona e pergunta.
                payload, _status, writes, reads = self.say("pegar feedback")
                self.assertEqual((writes, reads), ([], []))
                self.assertEqual(payload["conversation"]["status"], "awaiting_task_action")
                self.assertIn("Selecionei Pegar feedback dos clientes", payload["reply_text"])
                _payload, _status, writes, _reads = self.say("atribuir para mim")
                self.assertEqual(writes, [assign_call(pegar)])

    def test_negation_still_cancels(self):
        for phrase in ("não atribuir configurar alerta para mim", "não, mostra os detalhes para mim"):
            with self.subTest(phrase=phrase):
                self.browse(select="7")
                payload, _status, writes, _reads = self.say(phrase)
                self.assertEqual((payload["conversation"]["status"], writes), ("cancelled", []))


class CommandIsNotAParamValueTests(AssistantFlowTestCase):
    """S3: um comando dito como resposta a uma pergunta pendente nao vira valor e nao escreve."""

    COMMAND_ANSWERS = (
        "minhas tarefas",
        "Minhas tarefas.",
        "quais são minhas tarefas",
        "listar equipes",
        "meu perfil",
        "backlog",
        "criar tarefa",
        "parar assistente",
    )

    def ask_team_name(self, token="token-admin"):
        payload, _status = self.send(token, "criar equipe")
        self.assertEqual(payload["conversation"]["next_param"], "nome")

    def assert_asks_to_continue_or_switch(self, token, answer, command_key, param):
        before = dict(self.pending(token))
        payload, status = self.send(token, answer)
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["conversation"]["status"], "awaiting_params")
        self.assertEqual(payload["conversation"]["next_param"], param)
        self.assertFalse(payload["action_executed"])
        self.assertIn("também é um comando", payload["reply_text"])
        self.assertIn("cancelar", payload["reply_text"])
        self.assert_no_writes()
        after = self.pending(token)
        self.assertEqual(
            {k: after[k] for k in ("command_key", "params", "missing")},
            {k: before[k] for k in ("command_key", "params", "missing")},
        )
        self.assertEqual(after["command_key"], command_key)

    def test_team_name_that_is_a_command_asks_instead_of_creating(self):
        for answer in self.COMMAND_ANSWERS:
            with self.subTest(answer=answer):
                self.ask_team_name()
                self.assert_asks_to_continue_or_switch("token-admin", answer, "create_team", "nome")
                self.send("token-admin", "cancelar")
        self.assert_no_writes()

    def test_explicit_label_or_a_regular_name_creates_the_team(self):
        for answers, name in (
            (("nome Minhas Tarefas",), "Minhas Tarefas"),
            (("minhas tarefas", "nome minhas tarefas"), "Minhas Tarefas"),
            (("backlog", "nome Backlog"), "Backlog"),
            (("Marketing",), "Marketing"),
            (("Equipe Backlog",), "Equipe Backlog"),
            (("meu perfil", "Equipe Alfa Dois"), "Equipe Alfa Dois"),
        ):
            with self.subTest(answers=answers):
                self.api.calls.clear()
                self.ask_team_name()
                for answer in answers:
                    payload, _status = self.send("token-admin", answer)
                self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation")
                self.assertIn(f'"{name}"', payload["reply_text"])
                self.assertEqual(self.api.writes(), [])
                payload, _status = self.send("token-admin", "confirmar")
                self.assertTrue(payload["action_executed"], payload["reply_text"])
                self.assertEqual(self.api.writes(), [("POST", "/equipes", {"nome": name, "membros": []})])
                self.assertIsNone(self.pending("token-admin"))

    def test_cancel_or_negation_after_the_question_ends_without_writing(self):
        for answer in ("cancelar", "não", "deixa pra lá"):
            with self.subTest(answer=answer):
                self.ask_team_name()
                self.send("token-admin", "minhas tarefas")
                payload, _status = self.send("token-admin", answer)
                self.assertEqual(payload["conversation"]["status"], "cancelled")
                self.assertIsNone(self.pending("token-admin"))
        self.assert_no_writes()

    def test_other_free_text_and_reference_fields(self):
        # Criar tarefa: nome e descricao.
        self.send("token-admin", "criar tarefa")
        self.assert_asks_to_continue_or_switch("token-admin", "meu perfil", "create_task", "nome")
        self.send("token-admin", "Relatório de vendas")
        self.assert_asks_to_continue_or_switch("token-admin", "backlog", "create_task", "descricao")
        self.send("token-admin", "cancelar")
        # Comentario: tarefa (referencia por nome) e texto.
        self.send("token-user", "adicionar comentário")
        self.assert_asks_to_continue_or_switch("token-user", "minhas tarefas", "add_comment", "task_id")
        self.send("token-user", "Relatório final")
        self.assert_asks_to_continue_or_switch("token-user", "listar equipes", "add_comment", "texto")
        self.send("token-user", "cancelar")
        self.assert_no_writes()

    def test_valid_create_task_and_comment_flows_still_complete(self):
        # Texto que so contem um comando no meio ("o backlog") continua sendo valor.
        for step in ("criar tarefa", "Relatório de vendas", "Consolidar o backlog do mês", "amanhã", "alta",
                     "Equipe Alfa"):
            payload, _status = self.send("token-admin", step)
            self.assertNotIn("também é um comando", payload["reply_text"])
        self.assertEqual(payload["conversation"]["next_param"], "user")
        params = self.pending("token-admin")["params"]
        self.assertEqual((params["nome"], params["descricao"]), ("Relatório de vendas", "Consolidar o backlog do mês"))
        # A etapa final (resolucao da equipe, resumo e confirmacao) e coberta em test_write_confirmation.
        self.send("token-admin", "cancelar")
        self.assert_no_writes()

        self.api.calls.clear()
        for step in ("adicionar comentário", "Relatório final", "revisar o relatório amanhã", "confirmar"):
            payload, _status = self.send("token-user", step)
        self.assertTrue(payload["action_executed"], payload["reply_text"])
        self.assertEqual(
            self.api.writes(),
            [("POST", f"/tarefas/{TASKS[0]['_id']}/comentarios", {"texto": "revisar o relatório amanhã"})],
        )
        # Comentario que cita um comando no meio da frase nao e barrado pela nova pergunta.
        self.send("token-user", "adicionar comentário")
        self.send("token-user", "Relatório final")
        payload, _status = self.send("token-user", "lembrar de olhar minhas tarefas")
        self.assertNotIn("também é um comando", payload["reply_text"])

    def test_permission_is_still_checked_after_the_question(self):
        self.ask_team_name(token="token-user")
        self.assert_asks_to_continue_or_switch("token-user", "minhas tarefas", "create_team", "nome")
        payload, status = self.send("token-user", "nome Minhas Tarefas")
        self.assertEqual((status, payload["error"]), (403, "forbidden"))
        self.assert_no_writes()

    def test_read_command_questions_are_unchanged(self):
        # Fora das escritas nada muda: a resposta segue como valor da consulta.
        self.send("token-admin", "membros da equipe")
        payload, _status = self.send("token-admin", "Equipe Alfa")
        self.assertEqual(payload["command"]["key"], "team_members")
        self.assert_no_writes()

    def test_users_keep_separate_conversations(self):
        # Mesmo conversationId: a pergunta pendente do admin nao afeta a selecao da pessoa usuaria.
        self.api.backlog = BACKLOG_TASKS
        self.ask_team_name()
        self.send("token-user", "backlog")
        self.send("token-user", "7")
        self.assert_asks_to_continue_or_switch("token-admin", "minhas tarefas", "create_team", "nome")
        self.assertEqual(self.pending("token-user")["selected_task_id"], TASK[7])
        payload, _status = self.send("token-user", "atribuir para mim")
        self.assertEqual(self.api.writes(), [assign_call(TASK[7])], payload["reply_text"])
        self.assertEqual(self.pending("token-admin")["command_key"], "create_team")


if __name__ == "__main__":
    unittest.main()
