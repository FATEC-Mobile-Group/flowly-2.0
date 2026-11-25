"""Consultas de tarefas por periodo (hoje, amanha, atrasadas, semana, proxima semana, proximos dias, pendencias,
resumo): interpretacao de frases naturais, filtro por data, respostas so com dados reais e nenhuma escrita.

Datas controladas: "agora" e 2026-11-25 (quarta-feira) no fuso da aplicacao (America/Sao_Paulo); a semana
corrente vai de 23/11 (segunda) a 29/11 (domingo). A API do Flowly e simulada (sem rede, banco ou dado real).
"""

import os
import unittest
from datetime import date, datetime, timezone
from unittest.mock import patch

from test_read_responses import CONVERSATION_ID, ReadResponseTestCase  # noqa: F401 (base com API falsa)

from flowly_assistant import task_queries
from flowly_assistant.api_client import APIError, FlowlyAPIClient
from flowly_assistant.assistant_core import message_agent
from flowly_assistant.assistant_core.rest_assistant import RestAssistant
from flowly_assistant.command_parser import CommandParser, detect_task_period

TODAY = date(2026, 11, 25)
NOON_LOCAL = datetime(2026, 11, 25, 15, 0, tzinfo=timezone.utc)  # 12:00 em Brasilia


def task(index, descricao, due, status="pendente", urgencia="baixa"):
    item = {
        "_id": f"{0xf00 + index:024x}",
        "descricao": descricao,
        "status": status,
        "urgencia": urgencia,
        "equipe": {"_id": "c" * 24, "nome": "Equipe Alfa"},
        "user": {"_id": "b" * 24, "nome": "Caio Colaborador"},
    }
    if due is not None:
        item["dataEntrega"] = f"{due}T00:00:00.000Z"
    return item


def fixture_tasks():
    return [
        task(1, "Revisar relatório", "2026-11-25", urgencia="alta"),
        task(2, "Preparar apresentação", "2026-11-25", status="em_andamento", urgencia="media"),
        task(3, "Ata pronta", "2026-11-25", status="concluido", urgencia="alta"),
        task(4, "Planilha antiga", "2026-11-20", urgencia="media"),
        task(5, "Entrega já feita", "2026-11-19", status="concluido"),
        task(6, "Pendência de segunda", "2026-11-23"),
        task(7, "Relatório de sexta", "2026-11-27", urgencia="alta"),
        task(8, "Fechamento de domingo", "2026-11-29"),
        task(9, "Kickoff da próxima segunda", "2026-11-30"),
        task(10, "Projeto distante", "2026-12-20"),
        task(11, "Ideia sem prazo", None),
    ]


def titles(tasks):
    return [t["descricao"] for t in tasks]


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.parser = CommandParser()

    def key(self, text):
        match = self.parser.match(text)
        return match.command.key if match else None

    def test_natural_phrases_choose_the_period(self):
        cases = {
            "tasks_today": [
                "O que tenho para fazer hoje?", "Quais são minhas tarefas de hoje?", "O que preciso entregar hoje?",
                "Mostre minhas atividades para hoje.", "O que tenho para hoje?", "tarefa de hoje", "TAREFAS DE HOJE",
                "o que preciso concluir hoje?", "quais as tarefas do dia",
            ],
            "tasks_overdue": [
                "Tenho alguma tarefa atrasada?", "Quais atividades estão vencidas?",
                "O que está pendente e passou do prazo?", "Mostre minhas tarefas atrasadas.", "Tenho algo vencido?",
                "minhas tarefas em atraso", "tarefa atrasada",
            ],
            "tasks_week": [
                "O que tenho para esta semana?", "Mostre as tarefas da semana.", "Quais entregas tenho nesta semana?",
                "minhas tarefas dessa semana",
            ],
            "tasks_next_week": ["tarefas da semana que vem", "O que tenho para a próxima semana?"],
            "tasks_upcoming": [
                "Quais tarefas vencem nos próximos dias?", "Quais são minhas próximas entregas?",
                "o que vai vencer em breve?",
            ],
            "tasks_tomorrow": ["O que tenho para amanhã?", "minhas tarefas de amanha"],
            "tasks_pending": ["Me fala minhas pendências.", "quais tarefas estão em aberto?"],
            "tasks_summary": [
                "Como está meu dia?", "Faça um resumo das minhas tarefas.",
                "O que é mais importante para eu fazer hoje?", "o que está atrasado ou vence hoje?",
            ],
        }
        for expected, phrases in cases.items():
            for phrase in phrases:
                with self.subTest(phrase=phrase):
                    self.assertEqual(self.key(phrase), expected)

    def test_unrelated_or_write_phrases_are_not_queries(self):
        for phrase in (
            "Como está o tempo hoje?", "resumo da reunião", "tarefas da semana passada",
            "concluir as tarefas de hoje", "iniciar a tarefa de hoje", "não quero ver as tarefas de hoje",
        ):
            with self.subTest(phrase=phrase):
                self.assertNotIn(self.key(phrase), set(task_queries.TASK_QUERY_KEYS))

    def test_existing_commands_keep_their_meaning(self):
        self.assertEqual(self.key("minhas tarefas"), "my_tasks")
        self.assertEqual(self.key("quais tarefas tenho?"), "my_tasks")
        self.assertEqual(self.key("listar backlog"), "backlog")
        self.assertEqual(self.key("minhas equipes"), "my_teams")
        self.assertEqual(self.key("listar tarefas"), "list_tasks")
        # Escrita explicita continua escrita (com confirmacao/chave): uma data na frase nao vira consulta.
        self.assertEqual(self.key("criar tarefa para hoje"), "create_task")
        self.assertEqual(self.key("marcar como concluída a tarefa atrasada"), "update_status")
        self.assertEqual(self.key("excluir tarefa"), "delete_task")

    def test_new_commands_are_read_only_and_have_no_fuzzy_phrases(self):
        commands = {c.key: c for c in self.parser.commands}
        for key in task_queries.TASK_QUERY_KEYS:
            with self.subTest(key=key):
                self.assertEqual(commands[key].method, "GET")
                self.assertEqual(commands[key].route, "GET /api/tarefas/minhas")
                self.assertEqual(commands[key].phrases, [])
        self.assertIsNone(detect_task_period("bom dia"))


class QueryTests(unittest.TestCase):
    def run_query(self, period, tasks=None):
        return task_queries.run_query(period, fixture_tasks() if tasks is None else tasks, TODAY)

    def test_today_open_tasks_sorted_by_urgency_and_done_counted_apart(self):
        query = self.run_query("today")
        self.assertEqual(titles(query["tasks"]), ["Revisar relatório", "Preparar apresentação"])
        self.assertEqual(query["doneInRange"], 1)
        self.assertEqual(query["range"], {"from": "2026-11-25", "to": "2026-11-25"})

    def test_overdue_excludes_done_and_tasks_without_due_date(self):
        query = self.run_query("overdue")
        self.assertEqual(titles(query["tasks"]), ["Planilha antiga", "Pendência de segunda"])
        self.assertNotIn("Entrega já feita", titles(query["tasks"]))
        self.assertNotIn("Ideia sem prazo", titles(query["tasks"]))

    def test_week_is_monday_to_sunday_and_differs_from_next_seven_days(self):
        week = self.run_query("week")
        self.assertEqual(week["range"], {"from": "2026-11-23", "to": "2026-11-29"})
        self.assertEqual(
            titles(week["tasks"]),
            ["Pendência de segunda", "Revisar relatório", "Preparar apresentação", "Relatório de sexta", "Fechamento de domingo"],
        )
        self.assertEqual(week["overdueCount"], 1)
        upcoming = self.run_query("upcoming")
        self.assertEqual(upcoming["range"], {"from": "2026-11-25", "to": "2026-12-02"})
        self.assertIn("Kickoff da próxima segunda", titles(upcoming["tasks"]))
        self.assertNotIn("Pendência de segunda", titles(upcoming["tasks"]))
        self.assertEqual(titles(self.run_query("next_week")["tasks"]), ["Kickoff da próxima segunda"])
        self.assertEqual(titles(self.run_query("tomorrow")["tasks"]), [])

    def test_upcoming_without_items_points_to_the_next_real_delivery(self):
        query = task_queries.run_query("upcoming", [task(1, "Longe", "2027-01-10")], TODAY)
        self.assertEqual(query["tasks"], [])
        text, _spoken = task_queries.build_reply(query)
        self.assertEqual(text, "Você não tem entregas nos próximos 7 dias. A próxima entrega é Longe, em 10/01.")

    def test_pending_lists_all_open_tasks_with_undated_last(self):
        query = self.run_query("pending")
        self.assertEqual(len(query["tasks"]), 9)  # 11 da API menos 2 concluidas
        self.assertEqual(query["tasks"][-1]["descricao"], "Ideia sem prazo")
        self.assertEqual(query["withoutDueDate"], 1)
        self.assertEqual(query["overdueCount"], 2)

    def test_summary_is_deterministic(self):
        query = self.run_query("summary")
        self.assertEqual(titles(query["dueToday"]), ["Revisar relatório", "Preparar apresentação"])
        self.assertEqual(len(query["overdue"]), 2)
        self.assertEqual(
            titles(query["upcoming"]),
            ["Relatório de sexta", "Fechamento de domingo", "Kickoff da próxima segunda"],
        )
        # Maior urgencia entre atrasadas e de hoje; empate de urgencia, a entrega mais antiga.
        self.assertEqual(query["mostImportant"]["descricao"], "Revisar relatório")
        text, spoken = task_queries.build_reply(query)
        # Tela com numerais; fala igual, so com a concordancia das contagens geradas ("duas tarefas").
        self.assertEqual(spoken, text.replace("2 tarefas", "duas tarefas").replace("1 tarefa de hoje", "uma tarefa de hoje"))
        self.assertIn("Hoje você tem duas tarefas: Revisar relatório, Preparar apresentação.", spoken)
        self.assertIn("Hoje você tem 2 tarefas: Revisar relatório, Preparar apresentação.", text)
        self.assertIn("1 tarefa de hoje já foi concluída.", text)
        self.assertIn("2 tarefas atrasadas.", text)
        self.assertIn("a próxima é Relatório de sexta, em 27/11.", text)
        self.assertIn("Prioridade sugerida: Revisar relatório (urgência alta, vence hoje).", text)

    def test_today_reply_uses_only_real_data(self):
        text, spoken = task_queries.build_reply(self.run_query("today"))
        self.assertTrue(text.startswith("Você tem 2 tarefas para hoje. 1 está em andamento e 1 ainda não foi iniciada."))
        self.assertIn("A mais urgente é Revisar relatório (vence hoje).", text)
        self.assertIn("1 tarefa desse período já foi concluída.", text)
        self.assertIn("1. Revisar relatório, não iniciada, vence hoje, urgência alta, equipe Equipe Alfa", text)
        self.assertNotIn("Planilha antiga", text)
        self.assertNotIn("urgência", spoken)  # a fala e mais curta

    def test_empty_results(self):
        for period, expected in (
            ("today", "Você não tem tarefas previstas para hoje."),
            ("overdue", "Você não tem tarefas atrasadas."),
            ("week", "Você não tem tarefas abertas com entrega nesta semana."),
            ("pending", "Você não tem tarefas pendentes."),
        ):
            with self.subTest(period=period):
                text, spoken = task_queries.build_reply(task_queries.run_query(period, [], TODAY))
                self.assertEqual(text, expected)
                self.assertEqual(spoken, expected)
        summary, _ = task_queries.build_reply(task_queries.run_query("summary", [], TODAY))
        self.assertEqual(
            summary,
            "Você não tem tarefas previstas para hoje. Nenhuma tarefa atrasada. Nenhuma entrega nos próximos 7 dias.",
        )

    def test_today_follows_app_timezone_and_due_date_is_a_civil_day(self):
        # 23:30 do dia 25 em Brasilia (02:30 UTC do dia 26): ainda e dia 25; a entrega de hoje nao esta atrasada.
        late = datetime(2026, 11, 26, 2, 30, tzinfo=timezone.utc)
        with patch.object(task_queries, "_now", lambda: late), patch.dict(os.environ, {"FLOWLY_TIMEZONE": ""}):
            self.assertEqual(task_queries.today_local(), TODAY)
            query = task_queries.run_query("overdue", fixture_tasks())
        self.assertNotIn("Revisar relatório", titles(query["tasks"]))
        # 00:30 do dia 25 em Brasilia (03:30 UTC): ja e dia 25.
        early = datetime(2026, 11, 25, 3, 30, tzinfo=timezone.utc)
        with patch.object(task_queries, "_now", lambda: early):
            self.assertEqual(task_queries.today_local(), TODAY)
        self.assertEqual(task_queries.due_day({"dataEntrega": "2026-11-25T00:00:00.000Z"}), TODAY)
        self.assertIsNone(task_queries.due_day({"dataEntrega": "data inválida"}))
        self.assertIsNone(task_queries.due_day({}))

    def test_metadata_is_a_safe_projection(self):
        meta = task_queries.metadata(self.run_query("today"))
        self.assertEqual(meta["type"], "today")
        self.assertEqual(meta["total"], 2)
        self.assertEqual(
            meta["tasks"][0],
            {"id": f"{0xf01:024x}", "titulo": "Revisar relatório", "status": "pendente",
             "dataEntrega": "2026-11-25", "urgencia": "alta", "equipe": "Equipe Alfa"},
        )


class AgentTaskQueryTests(ReadResponseTestCase):
    def setUp(self):
        super().setUp()
        self.api.tasks = fixture_tasks()
        clock = patch.object(task_queries, "_now", lambda: NOON_LOCAL)
        clock.start()
        self.addCleanup(clock.stop)

    def task_calls(self):
        return [path for method, path in self.api.calls if path != "/users/me"]

    def test_today_end_to_end_reads_only_my_tasks(self):
        payload, text, spoken = self.read("token-user", "O que tenho para fazer hoje?")
        self.assertEqual(payload["command"]["key"], "tasks_today")
        self.assertTrue(text.startswith("Você tem 2 tarefas para hoje."))
        self.assertIn("Revisar relatório", spoken)
        self.assertEqual(payload["query"]["type"], "today")
        self.assertEqual([t["titulo"] for t in payload["query"]["tasks"]], ["Revisar relatório", "Preparar apresentação"])
        # So a rota das tarefas do proprio usuario: nada de /tarefas (admin) nem backlog.
        self.assertEqual(set(self.task_calls()), {"/tarefas/minhas"})
        self.assertEqual(payload["conversation"]["status"], "browsing_tasks")
        self.assertEqual([t["descricao"] for t in self.pending("token-user")["tasks"]], ["Revisar relatório", "Preparar apresentação"])

    def test_only_tasks_returned_by_the_api_appear(self):
        # A API so devolve o que o usuario pode ver; a resposta nao acrescenta nada.
        self.api.tasks = [task(1, "Única autorizada", "2026-11-25")]
        payload, text, _spoken = self.read("token-user", "minhas tarefas de hoje")
        self.assertIn("Única autorizada", text)
        self.assertNotIn("Revisar relatório", text)
        self.assertEqual(payload["query"]["total"], 1)

    def test_summary_and_week_end_to_end(self):
        payload, text, _ = self.read("token-user", "Como está meu dia?")
        self.assertEqual(payload["command"]["key"], "tasks_summary")
        self.assertIn("Prioridade sugerida: Revisar relatório", text)
        self.assertEqual(self.pending("token-user"), {"mode": "task_selection", "tasks": []})  # sem lista nem tarefa escolhida  # resumo nao deixa lista numerada
        payload, text, _ = self.read("token-user", "Quais entregas tenho nesta semana?")
        self.assertEqual(payload["query"]["range"], {"from": "2026-11-23", "to": "2026-11-29"})
        self.assertIn("1 delas já venceu.", text)

    def test_no_tasks_today(self):
        self.api.tasks = [task(1, "Outro dia", "2026-11-28")]
        _payload, text, spoken = self.read("token-user", "Quais são minhas tarefas de hoje?")
        self.assertEqual(text, "Você não tem tarefas previstas para hoje.")
        self.assertEqual(spoken, text)

    def test_api_unavailable_is_not_reported_as_no_tasks(self):
        original = FlowlyAPIClient.request

        def failing(client, method, path, **kwargs):
            if path == "/tarefas/minhas":
                raise APIError("Falha de conexão com https://api.flowly.test/api/tarefas/minhas: timeout")
            return original(client, method, path, **kwargs)

        with patch.object(FlowlyAPIClient, "request", failing):
            payload, _status = self.send("token-user", "Tenho alguma tarefa atrasada?")
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["reply_text"], message_agent.TASK_QUERY_UNAVAILABLE_REPLY)
        self.assertNotIn("api.flowly.test", str(payload))
        self.assertNotIn("Você não tem", payload["reply_text"])

    def test_admin_gets_the_same_permission_rule_as_my_tasks(self):
        payload, status = self.send("token-admin", "O que tenho para hoje?")
        self.assertFalse(payload["ok"])
        self.assertEqual(status, 403)
        self.assertNotIn("/tarefas/minhas", self.task_calls())

    def test_follow_up_most_urgent_uses_the_list_just_shown(self):
        self.read("token-user", "Quais minhas tarefas atrasadas?")
        calls_before = len(self.task_calls())
        payload, text, _ = self.read("token-user", "E quais são as mais urgentes?")
        self.assertEqual(text.split(" 1.")[0], "Nenhuma tem urgência alta. 1 tarefa tem urgência média.")
        self.assertIn("Planilha antiga", text)
        self.assertNotIn("Pendência de segunda", text)
        self.assertEqual(len(self.task_calls()), calls_before)  # sem nova consulta
        self.assertEqual([t["descricao"] for t in self.pending("token-user")["tasks"]], ["Planilha antiga"])
        self.assertFalse(payload["action_executed"])

    def test_new_period_query_replaces_an_open_selection(self):
        self.read("token-user", "minhas tarefas")
        payload, text, _ = self.read("token-user", "e as atrasadas?")
        self.assertEqual(payload["command"]["key"], "tasks_overdue")
        self.assertTrue(text.startswith("Você tem 2 tarefas atrasadas."))
        # Sem tarefas no novo periodo: a selecao antiga nao continua valendo.
        self.read("token-user", "o que tenho para amanhã?")
        self.assertEqual(self.pending("token-user"), {"mode": "task_selection", "tasks": []})  # sem lista nem tarefa escolhida

    def test_legacy_assist_path_returns_the_filtered_result(self):
        assistant = RestAssistant(api_base_url="https://api.flowly.test/api", token="token-user")
        payload, status = assistant.handle("tarefas atrasadas")
        self.assertEqual(status, 200)
        self.assertEqual(payload["result"]["type"], "overdue")
        self.assertEqual(titles(payload["result"]["tasks"]), ["Planilha antiga", "Pendência de segunda"])
        self.assertTrue(payload["reply_text"].startswith("Você tem 2 tarefas atrasadas."))


if __name__ == "__main__":
    unittest.main()
