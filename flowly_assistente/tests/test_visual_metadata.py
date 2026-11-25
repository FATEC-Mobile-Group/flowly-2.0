"""Metadados opcionais para a interface (cartoes) e concordancia do texto falado.

Contrato aditivo: `query` (listagens de selecao, mesmo formato das consultas por periodo) e `task` (detalhes). O
reply_text continua igual para clientes antigos; a numeracao dos cartoes e a mesma da lista guardada.
"""

import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from test_read_responses import PROFILES, ReadResponseTestCase, make_task  # noqa: F401
from fake_conversations import ConversationStateRepository, ScopedConversationState

from flowly_assistant import task_queries
from flowly_assistant.assistant_core.rest_assistant import tts_payload
from flowly_assistant.task_queries import feminine_number

CONV = "voice-visual"
ITEM_KEYS = {"id", "titulo", "status", "dataEntrega", "urgencia", "equipe", "responsavel"}
TASK_KEYS = {"id", "titulo", "status", "dataEntrega", "urgencia", "equipe", "responsavel", "descricao", "today",
             "atribuidaAoUsuario"}


class SpokenAgreementTests(unittest.TestCase):
    def test_feminine_numbers(self):
        cases = {1: "uma", 2: "duas", 3: "3", 10: "10", 12: "12", 21: "vinte e uma", 22: "vinte e duas", 32: "trinta e duas"}
        for number, expected in cases.items():
            with self.subTest(number=number):
                self.assertEqual(feminine_number(number), expected)

    def test_tts_payload_never_rewrites_text_by_itself(self):
        # Resumo de confirmacao com numero dentro de dado da pessoa: falado como veio.
        summary = 'criar a tarefa "Revisar 2 tarefas" na Equipe 2'
        self.assertEqual(tts_payload(summary)["text"], summary)


class VisualMetadataTests(ReadResponseTestCase):
    def setUp(self):
        super().setUp()
        clock = patch.object(task_queries, "_now", lambda: datetime(2026, 12, 5, 15, tzinfo=timezone.utc))
        clock.start()
        self.addCleanup(clock.stop)

    def say(self, content, token="token-user"):
        payload, _status = self.send(token, content, CONV)
        return payload

    def stored_ids(self, token="token-user"):
        state = ScopedConversationState(ConversationStateRepository(), PROFILES[token]["_id"]).get(CONV)
        return [task["_id"] for task in state["tasks"]]

    def test_listing_metadata_has_the_same_numbered_list_and_the_full_total(self):
        payload = self.say("minhas tarefas")  # 12 tarefas, 10 guardadas para selecao
        query = payload["query"]
        self.assertEqual((query["type"], query["total"], len(query["tasks"])), ("my_tasks", 12, 10))
        self.assertEqual([item["id"] for item in query["tasks"]], self.stored_ids())
        self.assertEqual(set(query["tasks"][0]), ITEM_KEYS)
        self.assertEqual(query["tasks"][0]["responsavel"], "Caio Colaborador")
        self.assertTrue(payload["reply_text"].startswith("Encontrei 12 tarefas."))  # texto antigo preservado

    def test_backlog_and_admin_listing_types(self):
        self.assertEqual(self.say("backlog")["query"]["type"], "backlog")
        self.assertEqual(self.say("listar tarefas", token="token-admin")["query"]["type"], "list_tasks")

    def test_empty_listing_has_no_metadata(self):
        self.api.tasks = []
        self.assertNotIn("query", self.say("minhas tarefas"))

    def test_most_urgent_metadata_follows_the_new_numbering(self):
        self.api.tasks = [dict(make_task(1), urgencia="baixa"), dict(make_task(2), urgencia="alta"),
                          dict(make_task(3), urgencia="alta", status="concluido")]
        self.say("minhas tarefas")
        payload = self.say("quais são as mais urgentes?")
        self.assertEqual(payload["query"]["type"], "urgent")
        self.assertEqual([item["id"] for item in payload["query"]["tasks"]], self.stored_ids())
        self.assertNotIn(make_task(3)["_id"], self.stored_ids())  # concluida nao entra nas mais urgentes

    def test_details_metadata_is_a_safe_projection(self):
        self.api.tasks = [dict(make_task(1), status="concluido", dataEntrega="2026-06-25T00:00:00.000Z")]
        self.say("minhas tarefas")
        payload = self.say("detalhes da primeira")
        task = payload["task"]
        self.assertEqual(set(task), TASK_KEYS)
        self.assertEqual((task["id"], task["status"], task["dataEntrega"]), (make_task(1)["_id"], "concluido", "2026-06-25"))
        self.assertEqual((task["equipe"], task["responsavel"], task["descricao"]), ("Equipe 01", "Caio Colaborador",
                                                                                  "Detalhe fictício 1"))
        self.assertNotIn("Comentário sigiloso", str(task))
        self.assertNotIn("https://", str(task))  # nada de URL assinada de anexo
        # Pergunta curta continua so texto.
        payload = self.say("qual é o prazo dela?")
        self.assertNotIn("task", payload)
        self.assertNotIn("query", payload)

    def test_spoken_listing_uses_agreement_and_the_screen_keeps_numerals(self):
        self.api.tasks = [make_task(1), make_task(2)]
        payload = self.say("minhas tarefas")
        self.assertTrue(payload["reply_text"].startswith("Encontrei 2 tarefas."))
        self.assertTrue(payload["tts"]["text"].startswith("Encontrei duas tarefas."))


if __name__ == "__main__":
    unittest.main()

class SpokenCountsOnlyTests(ReadResponseTestCase):
    """So as contagens geradas pelo assistente mudam na fala; titulos, equipes, posicoes e datas ficam como vieram."""

    def setUp(self):
        super().setUp()
        clock = patch.object(task_queries, "_now", lambda: datetime(2026, 12, 5, 15, tzinfo=timezone.utc))
        clock.start()
        self.addCleanup(clock.stop)

    def say(self, content):
        payload, _status = self.send("token-user", content, CONV)
        return payload

    def test_titles_and_team_names_with_numbers_are_spoken_as_they_are(self):
        team = {"_id": "c" * 24, "nome": "Equipe 2"}
        self.api.tasks = [dict(make_task(1), descricao="Revisar 2 tarefas", equipe=team),
                          dict(make_task(2), descricao="Organizar 1 entrega", equipe=team)]
        payload = self.say("minhas tarefas")
        spoken = payload["tts"]["text"]
        self.assertTrue(spoken.startswith("Encontrei duas tarefas. 1. Revisar 2 tarefas"), spoken)
        self.assertIn("Organizar 1 entrega", spoken)
        self.assertIn("equipe Equipe 2", spoken)
        self.assertTrue(payload["reply_text"].startswith("Encontrei 2 tarefas."))

    def test_period_counts_are_spoken_with_agreement_and_masculine_words_stay(self):
        self.api.tasks = [dict(make_task(1), descricao="Revisar 2 tarefas", dataEntrega="2026-12-03T00:00:00.000Z"),
                          dict(make_task(2), dataEntrega="2026-12-01T00:00:00.000Z")]
        payload = self.say("o que está atrasado?")
        spoken, display = payload["tts"]["text"], payload["reply_text"]
        self.assertIn("Você tem duas tarefas atrasadas.", spoken)
        self.assertIn("Você tem 2 tarefas atrasadas.", display)
        self.assertIn("Revisar 2 tarefas", spoken)
        self.assertIn("venceu há 2 dias", spoken)  # "dias" e masculino: numeral mantido
        self.assertNotIn(task_queries.COUNT_MARK, spoken + display)

    def test_twenty_two_tasks(self):
        self.api.tasks = [make_task(i) for i in range(1, 23)]
        self.assertTrue(self.say("minhas tarefas")["tts"]["text"].startswith("Encontrei vinte e duas tarefas."))

    def test_details_tell_whether_the_task_belongs_to_the_user(self):
        own_id = PROFILES["token-user"]["_id"]
        self.api.tasks = [dict(make_task(1), user={"_id": own_id, "nome": "Eu"}),
                          dict(make_task(2), user={"_id": "d" * 24, "nome": "Outra pessoa"})]
        self.say("minhas tarefas")
        self.assertTrue(self.say("detalhes da primeira")["task"]["atribuidaAoUsuario"])
        self.assertFalse(self.say("detalhes da segunda")["task"]["atribuidaAoUsuario"])
