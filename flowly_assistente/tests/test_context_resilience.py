"""Resiliencia do contexto de leitura (homologacao do PR #53): pergunta mal transcrita nao derruba a tarefa
escolhida, perguntas naturais sobre ela, continuacao de periodo (inclusive depois de lista vazia), leituras com
negacao, tarefa concluida que nao aparece como atrasada e /users/me uma vez por mensagem.

Tudo leitura: nenhuma escrita. API e contexto simulados (sem rede, banco ou dado real).
"""

import unittest
from datetime import date, datetime, timezone
from unittest.mock import patch

from test_read_responses import PROFILES, ReadResponseTestCase, make_task  # noqa: F401
from fake_conversations import ConversationStateRepository, ScopedConversationState

from flowly_assistant import task_queries
from flowly_assistant.command_parser import CommandParser

CONV = "voice-resiliencia"
INVALID_SELECTION = "Não identifiquei uma única tarefa"
CADASTRO = dict(make_task(1), descricao="Criar tela de cadastro", status="em_andamento", urgencia="alta",
                dataEntrega="2026-12-10T00:00:00.000Z")
RELATORIO = dict(make_task(2), descricao="Revisar relatório", status="pendente", urgencia="media",
                 dataEntrega="2026-12-12T00:00:00.000Z")


class ResilienceTestCase(ReadResponseTestCase):
    def setUp(self):
        super().setUp()
        clock = patch.object(task_queries, "_now", lambda: datetime(2026, 12, 5, 15, tzinfo=timezone.utc))
        clock.start()
        self.addCleanup(clock.stop)
        self.api.tasks = [dict(CADASTRO), dict(RELATORIO)]

    def say(self, content, token="token-user", conversation_id=CONV):
        payload, status = self.send(token, content, conversation_id)
        return payload, status

    def state(self, token="token-user", conversation_id=CONV):
        return ScopedConversationState(ConversationStateRepository(), PROFILES[token]["_id"]).get(conversation_id)

    def detail_calls(self):
        return [path for _m, path in self.api.calls if path.endswith("/detalhes")]

    def writes(self):
        return [(method, path) for method, path in self.api.calls if method != "GET"]

    def me_calls(self):
        return [path for _m, path in self.api.calls if path == "/users/me"]


class RealSequenceTests(ResilienceTestCase):
    def test_agencia_then_urgencia_then_status_keep_the_selected_task(self):
        payload, _ = self.say("Quais são minhas tarefas?")
        self.assertEqual(payload["command"]["key"], "my_tasks")
        payload, _ = self.say("Abra a primeira.")
        self.assertIn("Criar tela de cadastro", payload["reply_text"])
        payload, _ = self.say("Qual é o prazo dela?")
        self.assertIn("Tarefa Criar tela de cadastro: prazo 10/12/2026", payload["reply_text"])

        self.api.calls.clear()
        payload, status = self.say("Qual é a agência dela?")  # "urgência" mal transcrita
        self.assertEqual(status, 200, payload)
        self.assertNotIn(INVALID_SELECTION, payload["reply_text"])
        self.assertIn("Criar tela de cadastro", payload["reply_text"])
        self.assertIn("urgência", payload["reply_text"])
        self.assertFalse(payload["action_executed"])
        self.assertEqual((self.detail_calls(), self.writes()), ([], []))
        self.assertEqual(self.state()["selected_task_id"], CADASTRO["_id"])
        self.assertEqual(len(self.state()["tasks"]), 2)

        payload, _ = self.say("Qual é a urgência dela?")
        self.assertIn("Tarefa Criar tela de cadastro: urgência alta", payload["reply_text"])
        payload, _ = self.say("Qual é o status dela?")
        self.assertIn("Tarefa Criar tela de cadastro: status em andamento", payload["reply_text"])
        self.assertEqual(self.writes(), [])

    def test_unknown_question_without_a_suggestion_asks_which_information(self):
        self.say("minhas tarefas")
        self.say("abra a primeira")
        payload, _ = self.say("qual é a cor dela?")
        self.assertIn("Não entendi qual informação você quer sobre a tarefa Criar tela de cadastro", payload["reply_text"])
        self.assertIn("prazo", payload["reply_text"])
        self.assertEqual(self.state()["selected_task_id"], CADASTRO["_id"])

    def test_explicit_invalid_selection_still_drops_the_previous_task(self):
        self.say("minhas tarefas")
        self.say("abra a primeira")
        self.api.calls.clear()
        payload, _ = self.say("abra a tarefa 99")
        self.assertIn(INVALID_SELECTION, payload["reply_text"])
        self.assertNotIn("selected_task_id", self.state())
        self.assertEqual(self.detail_calls(), [])
        payload, _ = self.say("qual é o prazo dela?")  # sem tarefa escolhida: pergunta qual
        self.assertIn("De qual tarefa da lista?", payload["reply_text"])

    def test_unknown_question_with_assign_words_never_keeps_the_task_for_writing(self):
        self.say("minhas tarefas")
        self.say("abra a primeira")
        payload, _ = self.say("pegar a configurar alerta para mim")
        self.assertIn(INVALID_SELECTION, payload["reply_text"])
        self.assertNotIn("selected_task_id", self.state())
        self.assertEqual(self.writes(), [])


class NaturalFollowUpTests(ResilienceTestCase):
    def test_natural_questions_about_the_selected_task(self):
        self.say("minhas tarefas")
        self.say("abra a primeira")
        for phrase, expected in (
            ("Qual o prazo?", "prazo 10/12/2026"), ("Quando ela vence?", "prazo 10/12/2026"),
            ("Quando tenho que entregar?", "prazo 10/12/2026"), ("Qual é a urgência dela?", "urgência alta"),
            ("Qual é a prioridade?", "urgência alta"), ("Ela é urgente?", "urgência alta"),
            ("Qual é o status?", "status em andamento"), ("Ela já foi concluída?", "status em andamento"),
            ("Quem é o responsável?", "responsável Caio"), ("Quem está cuidando dela?", "responsável Caio"),
            ("De qual equipe ela é?", "equipe Equipe 01"), ("Em que equipe ela está?", "equipe Equipe 01"),
            ("Qual é a descrição?", "descrição: Detalhe fictício 1"),
            ("E o prazo?", "prazo 10/12/2026"), ("E a urgência?", "urgência alta"), ("E o status?", "status em andamento"),
        ):
            with self.subTest(phrase=phrase):
                payload, status = self.say(phrase)
                self.assertEqual(status, 200, payload)
                self.assertIn(f"Tarefa Criar tela de cadastro: {expected}", payload["reply_text"])
                self.assertEqual(self.state()["selected_task_id"], CADASTRO["_id"])
        payload, _ = self.say("Me fale mais sobre ela.")
        self.assertEqual(payload["command"]["key"], "task_details")
        self.assertIn("Criar tela de cadastro", payload["reply_text"])
        self.assertEqual(self.writes(), [])

    def test_follow_up_answers_are_direct_without_the_long_instructions(self):
        self.say("minhas tarefas")
        self.say("abra a primeira")
        payload, _ = self.say("qual é o prazo dela?")
        self.assertNotIn("Você pode pedir", payload["reply_text"])
        self.assertLess(len(payload["reply_text"]), 80)

    def test_individual_urgency_versus_general_listing(self):
        self.say("minhas tarefas")
        self.say("abra a primeira")
        payload, _ = self.say("qual é a urgência dela?")
        self.assertIn("Tarefa Criar tela de cadastro: urgência alta", payload["reply_text"])
        payload, _ = self.say("quais são as tarefas mais urgentes?")
        self.assertNotIn("Tarefa Criar tela de cadastro:", payload["reply_text"])
        self.assertIn("urgência alta", payload["reply_text"])

    def test_urgency_of_her_without_a_selected_task_asks_which_task(self):
        self.say("minhas tarefas")
        payload, _ = self.say("qual é a urgência dela?")
        self.assertIn("De qual tarefa da lista?", payload["reply_text"])
        self.assertEqual(self.detail_calls(), [])

    def test_positions_from_pr_53_still_work(self):
        self.say("minhas tarefas")
        payload, _ = self.say("detalhes da segunda")
        self.assertIn("Revisar relatório", payload["reply_text"])
        payload, _ = self.say("qual é o prazo da primeira?")
        self.assertIn("Tarefa Criar tela de cadastro: prazo 10/12/2026", payload["reply_text"])

    def test_selection_is_not_shared_between_users_or_conversations(self):
        self.say("minhas tarefas")
        self.say("abra a primeira")
        payload, _ = self.say("qual é o prazo dela?", token="token-admin")
        self.assertNotIn("Criar tela de cadastro", payload["reply_text"])
        payload, _ = self.say("qual é o prazo dela?", conversation_id="outra-conversa")
        self.assertNotIn("Criar tela de cadastro", payload["reply_text"])


class PeriodContinuationTests(ResilienceTestCase):
    def test_short_period_continuations_after_a_listing(self):
        for phrase, key in (("E amanhã?", "tasks_tomorrow"), ("E para amanhã?", "tasks_tomorrow"),
                            ("E hoje?", "tasks_today"), ("E as atrasadas?", "tasks_overdue"),
                            ("E as da próxima semana?", "tasks_next_week"), ("Mostre as de hoje.", "tasks_today"),
                            ("E se amanhã?", "tasks_tomorrow")):
            with self.subTest(phrase=phrase):
                self.say("minhas tarefas")
                payload, status = self.say(phrase)
                self.assertEqual((status, (payload.get("command") or {}).get("key")), (200, key), payload)

    def test_e_se_amanha_with_a_selected_task_asks_instead_of_listing(self):
        self.say("minhas tarefas")
        self.say("abra a primeira")
        self.api.calls.clear()
        payload, _ = self.say("E se amanhã?")
        self.assertIn("Criar tela de cadastro", payload["reply_text"])
        self.assertIn("amanhã", payload["reply_text"])
        self.assertNotIn("/tarefas/minhas", [p for _m, p in self.api.calls])
        self.assertEqual(self.state()["selected_task_id"], CADASTRO["_id"])

    def test_continuation_after_an_empty_list(self):
        payload, _ = self.say("Quais são minhas tarefas de amanhã?")
        self.assertEqual(payload["reply_text"], "Você não tem tarefas previstas para amanhã.")
        payload, status = self.say("E as de hoje?")
        self.assertEqual((status, payload["command"]["key"]), (200, "tasks_today"), payload)
        self.say("Quais são minhas tarefas de amanhã?")
        payload, _ = self.say("e hoje?")
        self.assertEqual(payload["command"]["key"], "tasks_today")

    def test_empty_list_has_no_positions_and_never_reuses_an_old_list(self):
        self.say("minhas tarefas")
        self.say("abra a primeira")
        self.say("quais são minhas tarefas de amanhã?")  # vazia: substitui a lista anterior
        self.api.calls.clear()
        payload, _ = self.say("abra a primeira")
        self.assertNotIn("Criar tela de cadastro", payload["reply_text"])
        payload, _ = self.say("atribuir a primeira para mim")
        self.assertEqual((self.detail_calls(), self.writes()), ([], []))

    def test_empty_context_does_not_widen_unrelated_phrases(self):
        self.say("quais são minhas tarefas de amanhã?")
        payload, _ = self.say("meu perfil")
        self.assertEqual(payload["command"]["key"], "me")
        payload, _ = self.say("e amanhã?")  # o contexto vazio ja foi substituido pelo perfil
        self.assertIsNone(payload.get("command"))

    def test_admin_continuation_keeps_the_profile_restrictions(self):
        payload, status = self.say("quais são minhas tarefas de amanhã?", token="token-admin")
        self.assertEqual(status, 403)
        payload, status = self.say("e as de hoje?", token="token-admin")
        self.assertNotEqual(status, 200)


class NegatedReadTests(ResilienceTestCase):
    def test_safe_reads_with_negation(self):
        payload, _ = self.say("Quais tarefas eu não concluí?")
        self.assertEqual(payload["command"]["key"], "tasks_pending")
        payload, _ = self.say("o que eu ainda não terminei?")
        self.assertEqual(payload["command"]["key"], "tasks_pending")
        payload, _ = self.say("Deixa eu ver minhas tarefas.")
        self.assertEqual(payload["command"]["key"], "my_tasks")
        self.assertEqual(self.writes(), [])

    def test_negated_or_ambiguous_writes_stay_blocked(self):
        parser = CommandParser()
        for phrase in ("Não altere essa tarefa.", "Não conclua a primeira.", "Não atribua isso para mim.",
                       "Não confirme a operação.", "deixa eu concluir a tarefa", "deixa eu atribuir a primeira",
                       "quais tarefas eu não concluí? conclua todas", "não quero ver minhas tarefas"):
            with self.subTest(phrase=phrase):
                match = parser.match(phrase)
                self.assertTrue(match is None or match.command.key in {"tasks_pending", "my_tasks"} and "conclua" not in phrase,
                                match and match.command.key)
        for phrase in ("Não conclua a primeira.", "Não atribua isso para mim.", "Não confirme a operação."):
            with self.subTest(fluxo=phrase):
                self.say("minhas tarefas")
                self.say(phrase)
                self.assertEqual(self.writes(), [])


class CompletedTaskDeadlineTests(ResilienceTestCase):
    def setUp(self):
        super().setUp()
        self.api.tasks = [
            dict(make_task(1), descricao="Tarefa concluída antiga", status="concluido", urgencia="alta",
                 dataEntrega="2026-06-25T00:00:00.000Z"),
            dict(make_task(2), descricao="Tarefa pendente vencida", status="pendente", urgencia="alta",
                 dataEntrega="2026-12-01T00:00:00.000Z"),
            dict(make_task(3), descricao="Tarefa sem prazo", status="pendente", urgencia="media", dataEntrega=None),
        ]

    def test_completed_task_is_not_overdue_in_the_urgency_listing(self):
        self.say("minhas tarefas")
        payload, _ = self.say("quais são as mais urgentes?")
        self.assertNotIn("Tarefa concluída antiga", payload["reply_text"])
        self.assertNotIn("163 dias", payload["reply_text"])
        self.assertIn("Tarefa pendente vencida", payload["reply_text"])
        self.assertIn("venceu há 4 dias", payload["reply_text"])

    def test_deadline_text_of_completed_open_and_undated_tasks(self):
        today = date(2026, 12, 5)
        done, late, undated = self.api.tasks
        self.assertEqual(task_queries._deadline(done, today), "prazo era 25/06")
        self.assertEqual(task_queries._deadline(late, today), "venceu há 4 dias (01/12)")
        self.assertEqual(task_queries._deadline(undated, today), "sem prazo")

    def test_overdue_query_and_counts_exclude_completed_tasks(self):
        payload, _ = self.say("o que está atrasado?")
        self.assertIn("Você tem 1 tarefa atrasada.", payload["reply_text"])
        self.assertNotIn("Tarefa concluída antiga", payload["reply_text"])
        self.assertEqual([t["titulo"] for t in payload["query"]["tasks"]], ["Tarefa pendente vencida"])

    def test_all_completed_list_has_no_urgent_tasks(self):
        self.api.tasks = [self.api.tasks[0]]
        self.say("minhas tarefas")
        payload, _ = self.say("quais são as mais urgentes?")
        self.assertIn("concluídas", payload["reply_text"])
        self.assertNotIn("venceu", payload["reply_text"])


class ProfileLookupTests(ResilienceTestCase):
    def test_users_me_is_read_once_per_message_and_again_on_the_next_message(self):
        self.api.calls.clear()
        self.say("minhas tarefas")
        self.assertEqual(len(self.me_calls()), 1)
        self.api.calls.clear()
        self.say("abra a primeira")
        self.assertEqual(len(self.me_calls()), 1)  # nova mensagem: perfil lido de novo (sem cache entre pedidos)

    def test_profile_failure_still_fails_closed(self):
        original = self.api.profiles["token-user"]
        self.api.profiles["token-user"] = None
        try:
            payload, status = self.say("minhas tarefas")
        finally:
            self.api.profiles["token-user"] = original
        self.assertEqual(status, 401)
        self.assertFalse(payload["ok"])


if __name__ == "__main__":
    unittest.main()


class ContinuationScopeTests(ResilienceTestCase):
    """A troca de periodo consulta so GET /tarefas/minhas (as proprias tarefas, escopo aplicado pela API)."""

    def task_paths(self):
        return [path for _m, path in self.api.calls if path.startswith("/tarefas")]

    def test_own_list_continuation_stays_on_the_own_tasks(self):
        self.say("minhas tarefas")
        self.api.calls.clear()
        payload, _ = self.say("e amanhã?")
        self.assertEqual(payload["command"]["key"], "tasks_tomorrow")
        self.assertEqual(self.task_paths(), ["/tarefas/minhas"])

    def test_backlog_list_is_not_silently_switched_to_another_scope(self):
        self.api.tasks = [dict(CADASTRO, user=None), dict(RELATORIO, user=None)]  # backlog: tarefas sem responsavel
        self.say("backlog")
        self.api.calls.clear()
        for phrase in ("e amanhã?", "e as de hoje?", "e se amanhã?"):
            with self.subTest(phrase=phrase):
                payload, status = self.say(phrase)
                self.assertEqual(status, 200, payload)
                self.assertIn("backlog", payload["reply_text"])
                self.assertEqual(self.task_paths(), [])
                self.assertEqual(len(self.state()["tasks"]), 2)  # a lista do backlog continua aberta
        payload, _ = self.say("minhas tarefas de amanhã")  # pedido explicito: consulta as proprias tarefas
        self.assertEqual(payload["command"]["key"], "tasks_tomorrow")

    def test_empty_backlog_and_empty_admin_list_keep_no_continuation_context(self):
        self.api.tasks = []
        self.say("backlog")
        self.assertIsNone(self.state())
        payload, _ = self.say("e amanhã?")
        self.assertIsNone(payload.get("command"))
        self.say("listar tarefas", token="token-admin")
        self.assertIsNone(self.state("token-admin"))

    def test_admin_general_listing_continuation_is_still_refused(self):
        self.say("listar tarefas", token="token-admin")
        self.api.calls.clear()
        payload, status = self.say("e amanhã?", token="token-admin")
        self.assertEqual(status, 403)
        self.assertEqual(self.task_paths(), [])


class ReadClarificationIsNotConsentTests(ResilienceTestCase):
    def test_sim_after_the_urgency_suggestion_never_writes(self):
        self.say("minhas tarefas")
        self.say("abra a primeira")
        payload, _ = self.say("Qual é a agência dela?")
        self.assertIn("Você quis dizer a urgência?", payload["reply_text"])
        self.api.calls.clear()
        payload, status = self.say("Sim")
        self.assertEqual(status, 200, payload)
        self.assertEqual(self.writes(), [])
        self.assertNotEqual((payload.get("command") or {}).get("key"), "assign_to_me")
        self.assertEqual(self.state()["selected_task_id"], CADASTRO["_id"])
        payload, _ = self.say("qual é a urgência dela?")  # reformulada: responde sobre a mesma tarefa
        self.assertIn("Tarefa Criar tela de cadastro: urgência alta", payload["reply_text"])
