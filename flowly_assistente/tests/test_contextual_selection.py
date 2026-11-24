"""Selecao contextual de tarefas: posicoes (ordinais, numeros por extenso, "7ª", ultima/penultima), verbos de
leitura, perguntas sobre um dado da tarefa escolhida e troca de periodo com a lista aberta.

Tudo e leitura: nenhuma chamada de escrita, confirmacoes e permissoes como antes. API e contexto simulados.
"""

import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from test_read_responses import PROFILES, ReadResponseTestCase, make_task  # noqa: F401
from fake_conversations import ConversationStateRepository, ScopedConversationState

from flowly_assistant import task_queries
from flowly_assistant.api_client import APIError, FlowlyAPIClient
from flowly_assistant.assistant_core.message_agent import (
    WEEKDAY_UNSUPPORTED_REPLY,
    requested_quantity,
    task_position_index,
    weekday_reference,
)
from flowly_assistant.command_parser import (
    PERIOD_COMMAND_KEYS,
    PERIOD_FOLLOW_UP_UTTERANCES,
    CommandParser,
    period_follow_up_utterance,
)

CONV = "voice-selecao-contextual"
INVALID_SELECTION = "Não identifiquei uma única tarefa"


class PositionIndexTests(unittest.TestCase):
    def test_positions(self):
        for ref, count, expected in (
            ("primeira", 10, 0), ("segundo", 10, 1), ("terceira", 10, 2), ("sexta", 10, 5), ("setima", 10, 6),
            ("nona", 10, 8), ("decima", 10, 9), ("dois", 10, 1), ("duas", 10, 1), ("tres", 10, 2), ("dez", 10, 9),
            ("7", 10, 6), ("7a", 10, 6), ("7o", 10, 6), ("ultima", 10, 9), ("penultima", 10, 8), ("ultimo", 1, 0),
        ):
            with self.subTest(ref=ref, count=count):
                self.assertEqual(task_position_index(ref, count), expected)

    def test_positions_that_do_not_exist(self):
        for ref, count in (
            ("onze", 10), ("vigesima", 10), ("11", 10), ("0", 10), ("117", 10), ("penultima", 1), ("ultima", 0),
            ("terceira", 2), ("3a", 2), ("um", 10), ("uma", 10), ("dezembro", 10), ("7x", 10),
        ):
            with self.subTest(ref=ref, count=count):
                self.assertIsNone(task_position_index(ref, count))


class QuantityAndWeekdayTests(unittest.TestCase):
    def test_quantity_is_a_number_right_after_a_plural_article(self):
        for phrase, expected in (
            ("quais são as três mais urgentes?", 3), ("mostre as duas mais urgentes", 2), ("as 4 mais urgentes", 4),
            ("mostre a terceira", None), ("detalhes da 3", None), ("qual é a urgência da terceira?", None),
            ("a tarefa dois", None), ("e as dos próximos 7 dias", None), ("as 0", None),
        ):
            with self.subTest(phrase=phrase):
                self.assertEqual(requested_quantity(phrase), expected)

    def test_weekday_versus_position(self):
        for phrase in ("tarefas de sexta-feira", "tarefas de segunda", "e as de quarta?", "o que tenho na quinta?",
                       "e as de sábado?", "até terça", "na sexta"):
            with self.subTest(phrase=phrase):
                self.assertTrue(weekday_reference(phrase))
        for phrase in ("abra a sexta tarefa", "detalhes da sexta", "mostre a quarta", "a segunda", "a quinta",
                       "detalhes da segunda tarefa", "minhas tarefas desta semana"):
            with self.subTest(phrase=phrase):
                self.assertFalse(weekday_reference(phrase))


class PeriodFollowUpParserTests(unittest.TestCase):
    def test_follow_ups_become_the_equivalent_full_query(self):
        for phrase, period in (
            ("E as de amanhã?", "tomorrow"), ("Mostre as de hoje.", "today"), ("E as atrasadas?", "overdue"),
            ("E as da próxima semana?", "next_week"), ("Mostre as próximas.", "upcoming"),
            ("Agora as desta semana.", "week"), ("e as pendentes", "pending"), ("e as que vencem amanhã?", "tomorrow"),
        ):
            with self.subTest(phrase=phrase):
                self.assertEqual(period_follow_up_utterance(phrase), PERIOD_FOLLOW_UP_UTTERANCES[period])

    def test_each_equivalent_query_is_recognized_by_the_normal_parser(self):
        parser = CommandParser()
        for period, utterance in PERIOD_FOLLOW_UP_UTTERANCES.items():
            with self.subTest(period=period):
                self.assertEqual(parser.match(utterance).command.key, PERIOD_COMMAND_KEYS[period])

    def test_refuses_without_article_with_other_words_or_without_period(self):
        for phrase in (
            "amanhã", "amanhã?", "e o prazo?", "excluir as de amanhã", "concluir as de hoje", "e as da sprint 15", "e as da 2",
            "e o resumo?", "e as de segunda?", "mostre as de amanhã da equipe alfa", "e as outras", "",
        ):
            with self.subTest(phrase=phrase):
                self.assertIsNone(period_follow_up_utterance(phrase))


class ContextualSelectionTests(ReadResponseTestCase):
    def setUp(self):
        super().setUp()
        clock = patch.object(task_queries, "_now", lambda: datetime(2026, 12, 5, 15, tzinfo=timezone.utc))
        clock.start()
        self.addCleanup(clock.stop)

    def say(self, content, token="token-user", conversation_id=CONV):
        return self.send(token, content, conversation_id)

    def state(self, token="token-user", conversation_id=CONV):
        return ScopedConversationState(ConversationStateRepository(), PROFILES[token]["_id"]).get(conversation_id)

    def selection(self, token="token-user"):
        state = self.state(token)
        return [t["descricao"] for t in (state or {}).get("tasks", [])] if state else None

    def detail_calls(self):
        return [path for _m, path in self.api.calls if path.endswith("/detalhes")]

    def writes(self):
        return [(method, path) for method, path in self.api.calls if method != "GET"]

    def details_of(self, *indexes):
        return [f"/tarefas/{make_task(index)['_id']}/detalhes" for index in indexes]

    def fresh_list(self, tasks=None):
        if tasks is not None:
            self.api.tasks = tasks
        ScopedConversationState(ConversationStateRepository(), PROFILES["token-user"]["_id"]).clear(CONV)
        self.api.calls.clear()
        payload, _ = self.say("minhas tarefas")
        self.assertEqual(payload["conversation"]["status"], "browsing_tasks", payload)
        self.api.calls.clear()

    # 1. Posicoes

    def test_ordinals_spelled_numbers_numeric_ordinals_and_from_the_end(self):
        for phrase, index in (
            ("detalhes da primeira", 1), ("detalhes da segunda", 2), ("detalhes da tarefa dois", 2),
            ("detalhes da três", 3), ("mostre a sexta", 6), ("abra a nona", 9), ("detalhes da décima", 10),
            ("detalhes da última", 10), ("detalhes da penúltima", 9), ("detalhes da 7ª", 7), ("detalhes da 7º", 7),
        ):
            with self.subTest(phrase=phrase):
                self.fresh_list()  # 12 tarefas, 10 guardadas: "a última" e a 10ª mostrada
                payload, status = self.say(phrase)
                self.assertEqual(status, 200, payload)
                self.assertEqual(self.detail_calls(), self.details_of(index))
                self.assertIn(f"Atividade {index:02d}", payload["reply_text"])
                self.assertEqual(self.writes(), [])

    def test_position_that_does_not_exist_never_picks_another_task(self):
        for phrase in ("detalhes da terceira", "detalhes da 3ª", "mostre a sexta", "detalhes da décima"):
            with self.subTest(phrase=phrase):
                self.fresh_list([make_task(1), make_task(2)])
                self.say("detalhes da 1")  # tarefa escolhida antes
                self.api.calls.clear()
                payload, status = self.say(phrase)
                self.assertEqual(status, 200, payload)
                self.assertIn(INVALID_SELECTION, payload["reply_text"])
                self.assertEqual(self.detail_calls(), [])
                self.assertNotIn("selected_task_id", self.state())

    def test_list_with_a_single_task(self):
        for phrase, ok in (("detalhes da última", True), ("detalhes da primeira", True),
                           ("detalhes da penúltima", False), ("detalhes da segunda", False)):
            with self.subTest(phrase=phrase):
                self.fresh_list([make_task(5)])
                payload, _ = self.say(phrase)
                self.assertEqual(self.detail_calls(), self.details_of(5) if ok else [])
                if not ok:
                    self.assertIn(INVALID_SELECTION, payload["reply_text"])

    def test_number_inside_a_task_name_is_not_a_position(self):
        sprint = dict(make_task(1), descricao="Sprint 15")
        self.fresh_list([sprint, make_task(2)])
        payload, _ = self.say("detalhes da sprint 15")
        self.assertEqual(self.detail_calls(), self.details_of(1))
        self.api.calls.clear()
        payload, _ = self.say("qual é o prazo da sprint 15?")
        self.assertEqual(self.detail_calls(), self.details_of(1))
        self.assertIn("Sprint 15: prazo 01/12/2026", payload["reply_text"])

    def test_conflicting_references_ask_again_without_reading(self):
        for phrase in ("detalhes da segunda e da terceira", "qual é o prazo da 2 e da 3?",
                       "qual é o prazo da segunda, quer dizer da quarta?"):
            with self.subTest(phrase=phrase):
                self.fresh_list()
                payload, _ = self.say(phrase)
                self.assertIn(INVALID_SELECTION, payload["reply_text"])
                self.assertEqual((self.detail_calls(), self.writes()), ([], []))

    # 2. Verbos de leitura

    def test_reading_verbs_return_the_details_directly(self):
        for phrase in ("Abra a segunda.", "Abre a segunda.", "Mostre a segunda.", "Mostra a segunda.", "Veja a segunda.",
                       "Quero ver a segunda.", "Me fale sobre a segunda.", "Detalhes da segunda.", "Conte sobre a segunda."):
            with self.subTest(phrase=phrase):
                self.fresh_list()
                payload, status = self.say(phrase)
                self.assertEqual(status, 200, payload)
                self.assertEqual(payload["command"]["key"], "task_details")
                self.assertEqual(self.detail_calls(), self.details_of(2))
                self.assertEqual(self.writes(), [])

    def test_verbs_are_whole_words_not_parts_of_other_words(self):
        # "reabrir" contem "abrir": antes virava detalhes; agora so seleciona e pergunta (e nunca escreve).
        self.fresh_list()
        payload, _ = self.say("reabrir a segunda")
        self.assertEqual(payload["conversation"]["status"], "awaiting_task_action")
        self.assertEqual((self.detail_calls(), self.writes()), ([], []))

    # 3. Perguntas sobre a tarefa escolhida

    def test_questions_about_the_selected_task_use_current_data(self):
        self.fresh_list()
        self.say("detalhes da segunda")
        for phrase, expected in (
            ("Qual é o prazo dela?", "prazo 01/12/2026"), ("Quando ela vence?", "prazo 01/12/2026"),
            ("Qual é a prioridade?", "urgência alta"), ("Qual é a urgência dela?", "urgência alta"),
            ("Qual é o status?", "status pendente"), ("Em que equipe ela está?", "equipe Equipe 01"),
            ("Qual é a descrição?", "descrição: Detalhe fictício 2"), ("Quem é o responsável?", "responsável Caio"),
            ("qual é o prazo e o status dela?", "prazo 01/12/2026; status pendente"),
        ):
            with self.subTest(phrase=phrase):
                self.api.calls.clear()
                payload, status = self.say(phrase)
                self.assertEqual(status, 200, payload)
                self.assertIn(f"Tarefa Atividade 02: {expected}", payload["reply_text"])
                self.assertEqual(self.detail_calls(), self.details_of(2))  # dado atual, da rota de detalhes
                self.assertEqual(self.writes(), [])
                self.assertEqual(self.state()["selected_task_id"], make_task(2)["_id"])  # selecao mantida

        payload, _ = self.say("Me mostre os detalhes dela.")
        self.assertEqual(payload["command"]["key"], "task_details")
        self.assertIn("Atividade 02", payload["reply_text"])

    def test_changed_status_and_deadline_come_from_the_api_not_from_the_saved_list(self):
        self.fresh_list()
        self.say("detalhes da segunda")
        self.api.tasks[1] = dict(self.api.tasks[1], status="concluido", dataEntrega="2026-12-20T00:00:00.000Z")
        payload, _ = self.say("qual é o status dela?")
        self.assertIn("status concluida", payload["reply_text"])
        payload, _ = self.say("qual é o prazo dela?")
        self.assertIn("prazo 20/12/2026", payload["reply_text"])

    def test_missing_information_is_said_as_missing(self):
        vazia = {"_id": f"{0xf01:024x}", "descricao": "Sem dados", "status": ""}
        self.fresh_list([vazia])
        self.say("detalhes da primeira")
        for phrase, expected in (
            ("qual é o prazo dela?", "sem prazo definido"), ("qual é a urgência dela?", "sem urgência definida"),
            ("em que equipe ela está?", "sem equipe informada"), ("qual é a descrição?", "sem descrição cadastrada"),
            ("qual é o status?", "status não informado"), ("quem é o responsável?", "sem responsável"),
        ):
            with self.subTest(phrase=phrase):
                payload, _ = self.say(phrase)
                self.assertIn(f"Tarefa Sem dados: {expected}", payload["reply_text"])

    def test_question_without_a_selected_task_asks_which_one_and_keeps_the_list(self):
        self.fresh_list()
        payload, status = self.say("qual é o prazo dela?")
        self.assertEqual(status, 200, payload)
        self.assertIn("De qual tarefa da lista?", payload["reply_text"])
        self.assertEqual(payload["conversation"]["status"], "awaiting_task_selection")
        self.assertEqual(self.detail_calls(), [])
        self.assertEqual(len(self.selection()), 10)
        # "qual é a prioridade?" sem tarefa escolhida continua mostrando as mais urgentes da lista, sem consultar.
        payload, _ = self.say("qual é a prioridade?")
        self.assertNotIn("De qual tarefa", payload["reply_text"])
        self.assertEqual(self.detail_calls(), [])

    def test_question_with_an_unknown_task_never_uses_the_previous_selection(self):
        self.fresh_list()
        self.say("detalhes da segunda")
        self.api.calls.clear()
        payload, _ = self.say("qual é o prazo da tarefa configurar alerta?")
        self.assertIn(INVALID_SELECTION, payload["reply_text"])
        self.assertEqual(self.detail_calls(), [])
        self.assertNotIn("selected_task_id", self.state())

    def test_question_about_another_listed_task_answers_for_that_task(self):
        self.fresh_list()
        self.say("detalhes da segunda")
        self.api.calls.clear()
        payload, _ = self.say("qual é o prazo da terceira?")
        self.assertIn("Tarefa Atividade 03: prazo", payload["reply_text"])
        self.assertEqual(self.detail_calls(), self.details_of(3))
        self.assertEqual(self.state()["selected_task_id"], make_task(3)["_id"])

    def test_personal_questions_are_not_task_questions(self):
        self.fresh_list()
        self.say("detalhes da segunda")
        self.api.calls.clear()
        payload, _ = self.say("qual é minha prioridade?")
        self.assertNotIn("Tarefa Atividade 02:", payload["reply_text"])
        self.assertEqual(self.detail_calls(), [])

    def test_failed_reading_is_not_answered_with_old_data(self):
        self.fresh_list()
        self.say("detalhes da segunda")
        original = FlowlyAPIClient.request

        def failing(client, method, path, **kwargs):
            if path.endswith("/detalhes"):
                raise APIError("HTTP 503 em GET detalhes", kind="http", status_code=503)
            return original(client, method, path, **kwargs)

        with patch.object(FlowlyAPIClient, "request", failing):
            payload, _ = self.say("qual é o prazo dela?")
        self.assertFalse(payload["ok"])
        self.assertIn("Não consegui consultar essa tarefa agora", payload["reply_text"])
        self.assertNotIn("01/12/2026", payload["reply_text"])
        self.assertEqual(self.state()["selected_task_id"], make_task(2)["_id"])

    # 4. Troca de periodo com a lista aberta

    def test_period_changes_after_a_listing(self):
        for phrase, key in (
            ("E as de amanhã?", "tasks_tomorrow"), ("Mostre as de hoje.", "tasks_today"),
            ("E as atrasadas?", "tasks_overdue"), ("E as da próxima semana?", "tasks_next_week"),
            ("Mostre as próximas.", "tasks_upcoming"), ("Agora as desta semana.", "tasks_week"),
        ):
            with self.subTest(phrase=phrase):
                self.fresh_list()
                payload, status = self.say(phrase)
                self.assertEqual((status, payload["command"]["key"]), (200, key), payload)
                self.assertNotIn(INVALID_SELECTION, payload["reply_text"])
                self.assertEqual(self.writes(), [])

    def test_new_list_replaces_the_old_one_and_empty_list_invalidates_the_selection(self):
        self.fresh_list()
        self.say("detalhes da segunda")
        payload, _ = self.say("e as atrasadas?")  # todas venceram em 01/12: nova lista, sem tarefa escolhida
        self.assertEqual(payload["command"]["key"], "tasks_overdue")
        self.assertNotIn("selected_task_id", self.state())
        payload, _ = self.say("e as de amanhã?")  # nenhuma: a lista anterior deixa de valer
        self.assertEqual(payload["command"]["key"], "tasks_tomorrow")
        self.assertEqual(self.state(), {"mode": "task_selection", "tasks": []})  # sem lista nem tarefa escolhida

    def test_follow_up_without_an_open_list_is_not_widened(self):
        payload, _ = self.say("e as de amanhã?")
        self.assertIsNone(payload.get("command"))
        self.assertEqual(self.writes(), [])

    def test_deadline_of_the_selected_task_is_not_a_new_listing(self):
        for phrase in ("ela vence amanhã?", "essa tarefa vence hoje?"):
            with self.subTest(phrase=phrase):
                self.fresh_list()
                self.say("detalhes da segunda")
                self.api.calls.clear()
                payload, _ = self.say(phrase)
                self.assertIn("Tarefa Atividade 02: prazo 01/12/2026", payload["reply_text"])
                self.assertNotIn("/tarefas/minhas", [path for _m, path in self.api.calls])
                self.assertEqual(len(self.selection()), 10)

    # 5. Protecoes preservadas

    def test_assign_requests_keep_the_existing_protections(self):
        # Chave de escrita desligada nesta suite: nada e executado.
        for phrase in ("atribuir a segunda para mim", "abra a segunda e atribuir para mim"):
            with self.subTest(phrase=phrase):
                self.fresh_list()
                payload, _ = self.say(phrase)
                self.assertFalse(payload["action_executed"])
                self.assertEqual(self.writes(), [])
        # "para mim" com verbo novo: so seleciona e pergunta (pode ser um pedido de atribuicao mal dito).
        self.fresh_list()
        payload, _ = self.say("mostra a 3 para mim")
        self.assertEqual(payload["conversation"]["status"], "awaiting_task_action")
        self.assertEqual((self.detail_calls(), self.writes()), ([], []))
        # Pergunta junto de um pedido de escrita nao vira resposta de leitura.
        self.fresh_list()
        self.say("detalhes da segunda")
        payload, _ = self.say("qual é o prazo dela e pegar para mim")
        self.assertNotIn("Tarefa Atividade 02: prazo", payload["reply_text"])
        self.assertEqual(self.writes(), [])

    def test_cancel_and_permissions_are_unchanged(self):
        self.fresh_list()
        self.say("detalhes da segunda")
        payload, _ = self.say("cancelar")
        self.assertEqual(payload["conversation"]["status"], "cancelled")
        self.assertIsNone(self.state())
        # Admin com lista aberta: consulta por periodo continua exclusiva do colaborador (403) e a lista fica.
        self.say("listar tarefas", token="token-admin")
        payload, status = self.say("e as de amanhã?", token="token-admin")
        self.assertEqual((payload["ok"], status), (False, 403))
        self.assertEqual(len(self.selection("token-admin")), 10)


    # 6. Quantidade versus posicao

    def test_quantity_of_most_urgent_tasks_is_not_a_position(self):
        tasks = [dict(make_task(i), urgencia=u) for i, u in enumerate(("baixa", "alta", "media", "alta", "baixa"), 1)]
        for phrase, count in (("Quais são as três mais urgentes?", 3), ("Mostre as duas mais urgentes", 2)):
            with self.subTest(phrase=phrase):
                self.fresh_list(tasks)
                payload, status = self.say(phrase)
                self.assertEqual(status, 200, payload)
                self.assertTrue(payload["reply_text"].startswith(f"As {count} tarefas mais urgentes da lista:"),
                                payload["reply_text"])
                self.assertNotIn("Selecionei", payload["reply_text"])
                self.assertEqual((self.detail_calls(), self.writes()), ([], []))
                # Alta antes de media; a nova numeracao e a da lista mostrada.
                self.assertEqual(self.selection()[:2], ["Atividade 02", "Atividade 04"])
                self.assertEqual(len(self.selection()), count)

    def test_fewer_tasks_with_urgency_than_requested(self):
        tasks = [dict(make_task(1), urgencia="alta"), dict(make_task(2), urgencia=None), dict(make_task(3), urgencia="baixa")]
        self.fresh_list(tasks)
        payload, _ = self.say("quais são as três mais urgentes?")
        self.assertTrue(payload["reply_text"].startswith("Só 2 tarefas da lista têm urgência informada:"),
                        payload["reply_text"])
        self.assertEqual(self.selection(), ["Atividade 01", "Atividade 03"])

    def test_position_and_task_question_still_work_next_to_quantities(self):
        self.fresh_list()
        payload, _ = self.say("Mostre a terceira")
        self.assertEqual(self.detail_calls(), self.details_of(3))
        self.api.calls.clear()
        payload, _ = self.say("Qual é a urgência da terceira?")
        self.assertIn("Tarefa Atividade 03: urgência alta", payload["reply_text"])

    def test_unclear_quantity_asks_instead_of_selecting(self):
        for phrase in ("mostre as duas", "atribuir as duas para mim", "detalhes das 3"):
            with self.subTest(phrase=phrase):
                self.fresh_list()
                self.say("detalhes da primeira")
                self.api.calls.clear()
                payload, status = self.say(phrase)
                self.assertEqual(status, 200, payload)
                self.assertIn("Você quer uma tarefa da lista ou as", payload["reply_text"])
                self.assertFalse(payload["action_executed"])
                self.assertEqual((self.detail_calls(), self.writes()), ([], []))
                self.assertEqual(len(self.selection()), 10)
                self.assertEqual(self.state()["selected_task_id"], make_task(1)["_id"])

    # 7. Dia da semana versus posicao

    def test_weekday_with_an_open_list_never_selects_a_task(self):
        for phrase in ("tarefas de sexta-feira", "tarefas de segunda", "e as de quarta?", "o que tenho na quinta?",
                       "e as de sábado?", "atribuir a tarefa de sexta para mim"):
            with self.subTest(phrase=phrase):
                self.fresh_list()
                self.say("detalhes da primeira")
                self.api.calls.clear()
                payload, status = self.say(phrase)
                self.assertEqual(status, 200, payload)
                self.assertEqual(payload["reply_text"], WEEKDAY_UNSUPPORTED_REPLY)
                self.assertFalse(payload["action_executed"])
                self.assertEqual((self.detail_calls(), self.writes()), ([], []))
                self.assertEqual(len(self.selection()), 10)
                self.assertEqual(self.state()["selected_task_id"], make_task(1)["_id"])

    def test_ordinal_positions_that_are_also_weekday_names_still_select(self):
        for phrase, index in (("abra a sexta tarefa", 6), ("detalhes da sexta", 6), ("mostre a quarta", 4),
                              ("detalhes da segunda tarefa", 2)):
            with self.subTest(phrase=phrase):
                self.fresh_list()
                self.say(phrase)
                self.assertEqual(self.detail_calls(), self.details_of(index))

    def test_weekday_without_a_list_gets_a_clear_answer(self):
        for phrase in ("minhas tarefas de sexta-feira", "o que tenho na segunda?", "tarefas de sábado"):
            with self.subTest(phrase=phrase):
                payload, status = self.say(phrase)
                self.assertEqual(status, 201, payload)
                self.assertEqual(payload["reply_text"], WEEKDAY_UNSUPPORTED_REPLY)
                self.assertEqual(self.writes(), [])
                self.assertNotIn("/tarefas/minhas", [path for _m, path in self.api.calls])
        payload, _ = self.say("minhas tarefas desta semana")  # periodo suportado continua igual
        self.assertEqual(payload["command"]["key"], "tasks_week")

if __name__ == "__main__":
    unittest.main()
