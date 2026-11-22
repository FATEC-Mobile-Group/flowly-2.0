"""Escrita so com instrucao direta e confirmacao explicita (digitada ou falada).

Camada 1: pergunta, negacao (inclusive "sem"), intencao futura e pedido de varias acoes nao preparam nem executam.
Camada 2: escrita direta e completa e preparada (so leituras), resumida com o alvo real e executada apenas com
"confirmar" numa mensagem posterior, uma unica vez, pela mesma pessoa, na mesma conversa e dentro do prazo.

A API do Flowly e simulada e a rede real e bloqueada: nenhum dado real e lido ou alterado.
"""

import json
import time
import unittest
from unittest.mock import patch

from test_command_safety import (
    BACKLOG_TASKS,
    CONVERSATION_ID,
    TASKS,
    TEAM_ID,
    USERS_BY_TOKEN,
    AssistantFlowTestCase,
    FakeRequest,
)
import function  # noqa: E402
from flowly_assistant.assistant_core.message_agent import MessageAgent, is_confirmation  # noqa: E402
from flowly_assistant.command_parser import CommandParser  # noqa: E402
from fake_conversations import (  # noqa: E402
    ConversationStateRepository,
    ScopedConversationState,
)

RELATORIO = TASKS[0]["_id"]
STATUS_PHRASE = "mudar status da tarefa relatório final para concluído"
STATUS_WRITE = ("PUT", f"/tarefas/{RELATORIO}/status", {"status": "concluido"})
TEAM_WRITE = ("POST", "/equipes", {"nome": "Marketing", "membros": []})

# Frases da auditoria de 2026-11-20 que persistiam sem confirmacao: (token, frase, motivo esperado).
NON_DIRECTIVE_CASES = (
    ("token-admin", "como criar equipe marketing", "pergunta"),
    ("token-admin", "como criar equipe", "pergunta"),
    ("token-admin", "como criar tarefa relatório semanal para equipe alfa", "pergunta"),
    ("token-admin", "Como criar uma equipe?", "pergunta"),
    ("token-admin", "o que acontece se eu criar equipe marketing", "pergunta"),
    ("token-admin", "é possível criar equipe marketing", "pergunta"),
    ("token-user", "como pegar a tarefa relatório final da equipe alfa", "pergunta"),
    ("token-user", "como mudar status da tarefa relatório final para concluído", "pergunta"),
    ("token-user", "como iniciar cronômetro da tarefa relatório final", "pergunta"),
    ("token-user", "como comentar na tarefa relatório final dizendo oi", "pergunta"),
    ("token-user", "como criar subtarefa revisar números na tarefa relatório final", "pergunta"),
    ("token-user", "posso mudar status da tarefa relatório final para concluído", "pergunta"),
    ("token-admin", "vou criar equipe marketing amanhã", "futuro"),
    ("token-admin", "vou criar uma equipe amanhã", "futuro"),
    ("token-user", "vou assumir a tarefa relatório final da equipe alfa amanhã", "futuro"),
    ("token-user", "vou marcar como concluído a tarefa relatório final amanhã", "futuro"),
    ("token-user", "vou pausar cronômetro da tarefa relatório final", "futuro"),
    ("token-user", "talvez iniciar cronômetro da tarefa relatório final", "futuro"),
    ("token-admin", "sem criar equipe marketing", "negacao"),
    ("token-admin", "sem criar equipe", "negacao"),
    ("token-user", "sem pegar a tarefa relatório final da equipe alfa", "negacao"),
    ("token-user", "sem mudar status da tarefa relatório final para concluído", "negacao"),
    ("token-user", "sem comentar na tarefa relatório final dizendo oi", "negacao"),
    ("token-admin", "listar ou criar equipe marketing", "conflito"),
    ("token-admin", "listar ou criar equipe", "conflito"),
    ("token-admin", "criar equipe marketing e listar equipes", "conflito"),
    ("token-user", "listar ou pegar a tarefa relatório final da equipe alfa", "conflito"),
    ("token-user", "mostrar minhas tarefas e mudar status da tarefa relatório final para concluído", "conflito"),
)

ACCEPTED_CONFIRMATIONS = ("confirmar", "Confirmar.", "confirmo", "sim, confirmar", "pode confirmar",
                          "confirmar por favor", "Ok, confirmo", "eu confirmo")
# Nada disto executa. Etapa 6B: negativa, cancelamento ou outro comando cancelam a pendente; resposta ambigua
# ("sim" sozinho, "ok", ruido, pergunta) nao executa e tambem nao cancela (a pendente continua aguardando).
CANCELLING_REPLIES = ("não confirmo", "confirmar não", "não", "cancelar", "listar equipes", "criar equipe vendas",
                      "confirmar criar equipe vendas")
AMBIGUOUS_REPLIES = ("sim", "Sim.", "ok", "pode", "isso", "claro", "beleza", "uhum", "talvez", "confirmar?",
                     "confirmar ou cancelar")
REJECTED_CONFIRMATIONS = CANCELLING_REPLIES + AMBIGUOUS_REPLIES


class WriteConfirmationTestCase(AssistantFlowTestCase):
    def send_body(self, token, **body):
        body.setdefault("conversationId", CONVERSATION_ID)
        body.setdefault("channelId", "voice-assistant")
        return self.frontend_send(token, body)

    def state(self, token, conversation_id=CONVERSATION_ID):
        return ScopedConversationState(ConversationStateRepository(), USERS_BY_TOKEN[token]["_id"]), conversation_id

    def assert_prepared(self, payload, status, token, command_key):
        """Preparado: resumo, nada escrito, operacao guardada para esta pessoa e esta conversa."""
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["ok"], payload)
        self.assertFalse(payload["action_executed"])
        self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation")
        self.assertEqual(payload["conversation"]["command"], command_key)
        self.assertIn("Nada foi alterado ainda", payload["reply_text"])
        self.assertIn('"confirmar"', payload["reply_text"])
        self.assert_no_writes()
        pending = self.pending(token)
        self.assertEqual(pending["mode"], "write_confirmation")
        self.assertEqual(pending["owner_id"], USERS_BY_TOKEN[token]["_id"])
        self.assertEqual(pending["operation_id"], payload["conversation"]["operation_id"])
        self.assertGreater(pending["expires_at"], time.time())
        return pending


class NonDirectiveWritesTests(WriteConfirmationTestCase):
    """Camada 1: descrever uma escrita nao e pedir a escrita."""

    def test_parser_selects_no_write_and_reports_the_reason(self):
        parser = CommandParser(threshold=78)
        for _token, phrase, reason in NON_DIRECTIVE_CASES:
            with self.subTest(phrase=phrase):
                self.assertIsNone(parser.match(phrase))
                self.assertEqual(parser.non_directive_reason(phrase), reason)

    def test_questions_negations_future_and_conflicts_never_prepare_or_write(self):
        for token, phrase, reason in NON_DIRECTIVE_CASES:
            with self.subTest(phrase=phrase):
                payload, status = self.send(token, phrase)
                self.assertEqual(status, 201, payload)
                self.assertFalse(payload["action_executed"])
                self.assertIsNone(payload["command"])
                self.assertIn("Nada foi alterado", payload["reply_text"])
                self.assertNotIn("Confirme", payload["reply_text"])  # pergunta nao vira pedido de confirmacao
                if reason == "pergunta":
                    self.assertIn("pergunta", payload["reply_text"])
                if reason == "conflito":
                    self.assertIn("uma ação por vez", payload["reply_text"])
                self.assertIsNone(self.pending(token))
        self.assert_no_writes()

    def test_typed_messages_get_the_same_protection(self):
        # O frontend manda channelId "voice-assistant" tambem para texto digitado; "web" tambem e protegido.
        for channel in ("web", "voice-assistant"):
            with self.subTest(channel=channel):
                payload, _status = self.send_body("token-admin", content="como criar equipe marketing", channelId=channel)
                self.assertFalse(payload["action_executed"])
                payload, status = self.send_body("token-admin", content="criar equipe marketing", channelId=channel)
                self.assert_prepared(payload, status, "token-admin", "create_team")
                self.send_body("token-admin", content="cancelar", channelId=channel)
        self.assert_no_writes()

    def test_reads_keep_working_even_as_questions(self):
        for token, phrase, key in (
            ("token-user", "meu perfil", "me"),
            ("token-user", "minhas tarefas", "my_tasks"),
            ("token-user", "quais são minhas tarefas", "my_tasks"),
            ("token-admin", "listar equipes", "list_teams"),
            ("token-admin", "minhas equipes", "my_teams"),
        ):
            with self.subTest(phrase=phrase):
                ScopedConversationState(ConversationStateRepository(), USERS_BY_TOKEN[token]["_id"]).clear(CONVERSATION_ID)
                payload, status = self.send(token, phrase)
                self.assertEqual(status, 200, payload)
                self.assertTrue(payload["action_executed"])
                self.assertEqual(payload["command"]["key"], key)
                self.assertNotEqual((payload.get("conversation") or {}).get("status"), "awaiting_confirmation")
        self.assert_no_writes()


class PrepareAndConfirmTests(WriteConfirmationTestCase):
    """Camada 2: preparar sem alterar, resumir o alvo real e executar uma vez com confirmacao explicita."""

    def test_each_complete_write_is_prepared_with_a_summary_of_the_real_target(self):
        for token, phrase, key, summary, expected_write in (
            ("token-admin", "criar equipe marketing", "create_team", 'criar a equipe "Marketing"', TEAM_WRITE),
            ("token-user", "atribuir para mim a tarefa relatório final da equipe alfa", "assign_to_me",
             'atribuir a tarefa "Relatório final (equipe Equipe Alfa)" para você',
             ("PUT", f"/tarefas/{RELATORIO}/atribuir-para-mim", None)),
            ("token-user", STATUS_PHRASE, "update_status",
             'mudar o status da tarefa "Relatório final (equipe Equipe Alfa)" para concluida', STATUS_WRITE),
            ("token-user", "iniciar cronômetro da tarefa relatório final", "timer",
             'iniciar o cronômetro da tarefa "Relatório final', ("PUT", f"/tarefas/{RELATORIO}/cronometro", {"acao": "iniciar"})),
            ("token-user", "comentar na tarefa relatório final dizendo revisar amanhã", "add_comment",
             'comentar na tarefa "Relatório final (equipe Equipe Alfa)": "revisar amanhã"',
             ("POST", f"/tarefas/{RELATORIO}/comentarios", {"texto": "revisar amanhã"})),
        ):
            with self.subTest(phrase=phrase):
                self.api.calls.clear()
                payload, status = self.send(token, phrase)
                self.assert_prepared(payload, status, token, key)
                self.assertIn(summary, payload["reply_text"])
                self.assertNotIn(RELATORIO, payload["reply_text"])  # o resumo nao mostra IDs
                payload, status = self.send(token, "confirmar")
                self.assertEqual(status, 200, payload)
                self.assertTrue(payload["action_executed"], payload["reply_text"])
                self.assertEqual(payload["conversation"]["status"], "completed")
                self.assertIn("Operação concluída", payload["reply_text"])
                self.assertEqual(self.api.writes(), [expected_write])
                self.assertIsNone(self.pending(token))

    def test_accepted_confirmation_phrases_execute_exactly_once(self):
        for phrase in ACCEPTED_CONFIRMATIONS:
            with self.subTest(phrase=phrase):
                self.api.calls.clear()
                self.send("token-user", STATUS_PHRASE)
                self.assert_no_writes()
                payload, _status = self.send("token-user", phrase)
                self.assertTrue(payload["action_executed"], payload["reply_text"])
                self.assertEqual(self.api.writes(), [STATUS_WRITE])
                # Repetir a confirmacao (eco da voz, clique duplo) nao executa de novo.
                payload, _status = self.send("token-user", phrase)
                self.assertFalse(payload["action_executed"])
                self.assertIn("Não há nenhuma operação aguardando confirmação", payload["reply_text"])
                self.assertEqual(self.api.writes(), [STATUS_WRITE])

    def test_negatives_and_other_commands_cancel_without_writing(self):
        for phrase in CANCELLING_REPLIES:
            with self.subTest(phrase=phrase):
                self.send("token-admin", "criar equipe marketing")
                payload, status = self.send("token-admin", phrase)
                self.assertEqual(status, 200, payload)
                self.assertFalse(payload["action_executed"])
                self.assertEqual(payload["conversation"]["status"], "cancelled")
                self.assertIn("Nada foi alterado", payload["reply_text"])
                self.assertIsNone(self.pending("token-admin"))
                # Depois do cancelamento, um "confirmar" atrasado nao encontra nada para executar.
                payload, _status = self.send("token-admin", "confirmar")
                self.assertFalse(payload["action_executed"])
        self.assert_no_writes()

    def test_ambiguous_replies_never_execute_and_keep_the_confirmation_waiting(self):
        self.send("token-admin", "criar equipe marketing")
        operation_id = self.pending("token-admin")["operation_id"]
        for phrase in AMBIGUOUS_REPLIES:
            with self.subTest(phrase=phrase):
                payload, status = self.send("token-admin", phrase)
                self.assertEqual(status, 200, payload)
                self.assertFalse(payload["action_executed"])
                self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation")
                self.assertEqual(payload["conversation"]["operation_id"], operation_id)  # a tela mantem o resumo
                self.assertIn("Nada foi alterado", payload["reply_text"])
                self.assertEqual(self.pending("token-admin")["operation_id"], operation_id)
        self.assertEqual(self.ops.calls.count("claim"), 0)
        self.assert_no_writes()
        payload, _status = self.send("token-admin", "cancelar")  # so o cancelamento explicito encerra
        self.assertEqual(payload["conversation"]["status"], "cancelled")
        self.assert_no_writes()

    def test_confirmation_word_detection(self):
        for phrase in ACCEPTED_CONFIRMATIONS:
            self.assertTrue(is_confirmation(phrase), phrase)
        for phrase in REJECTED_CONFIRMATIONS + ("", "   ", "sim sim", "pode ser"):
            self.assertFalse(is_confirmation(phrase), phrase)

    def test_cancel_prevents_persistence(self):
        for phrase in ("cancelar", "não", "não, deixa pra lá", "esquece"):
            with self.subTest(phrase=phrase):
                self.send("token-user", STATUS_PHRASE)
                payload, _status = self.send("token-user", phrase)
                self.assertEqual(payload["conversation"]["status"], "cancelled")
                self.assertIn("cancelei", payload["reply_text"])
                self.send("token-user", "confirmar")
        self.assert_no_writes()

    def test_expired_confirmation_never_executes(self):
        self.send("token-user", STATUS_PHRASE)
        self.ops.offset = self.ops.confirm_ttl + 1  # o prazo agora e o da operacao compartilhada (API)
        payload, _status = self.send("token-user", "confirmar")
        self.assertEqual(payload["conversation"]["status"], "expired")
        self.assertIn("expirou", payload["reply_text"])
        self.assertIsNone(self.pending("token-user"))
        self.assert_no_writes()

    def test_confirmation_deadline_comes_from_the_operations_api(self):
        # O prazo e definido pela API das operacoes; a variavel local antiga nao o estende.
        self.ops.confirm_ttl = 5
        with patch.dict("os.environ", {"FLOWLY_WRITE_CONFIRMATION_TTL_SEC": "999"}):
            payload, _status = self.send("token-user", STATUS_PHRASE)
        self.assertEqual(payload["conversation"]["expires_in"], 5)
        self.assertLessEqual(self.pending("token-user")["expires_at"], time.time() + 5)
        self.send("token-user", "cancelar")

    def test_confirmation_for_another_operation_neither_executes_nor_cancels(self):
        payload, _status = self.send("token-user", STATUS_PHRASE)
        old_operation = payload["conversation"]["operation_id"]
        self.send("token-user", "cancelar")
        self.send("token-user", STATUS_PHRASE)
        current = self.pending("token-user")["operation_id"]
        payload, status = self.send_body("token-user", content="confirmar", operationId=old_operation)
        self.assertEqual((status, payload["error"]), (409, "confirmation_mismatch"))
        self.assertIn("não corresponde", payload["reply_text"])
        # A pendente legitima nao e cancelada e e reapresentada para a tela.
        self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation")
        self.assertEqual(payload["conversation"]["operation_id"], current)
        self.assertEqual(self.pending("token-user")["operation_id"], current)
        self.assert_no_writes()
        # Com o operationId certo, a confirmacao vale.
        payload, _status = self.send_body(
            "token-user", content="confirmar", operationId=payload["conversation"]["operation_id"])
        self.assertTrue(payload["action_executed"], payload["reply_text"])
        self.assertEqual(self.api.writes(), [STATUS_WRITE])

    def test_stale_read_of_an_already_confirmed_operation_does_not_execute_twice(self):
        # Duas confirmacoes simultaneas (duas instancias): a segunda leu a operacao pendente antes de a primeira
        # executa-la; o claim atomico da API recusa a segunda.
        self.send("token-user", STATUS_PHRASE)
        store, conversation = self.state("token-user")
        stale = self.ops.current("token-user", conversation)
        self.assertEqual(stale["status"], "pending")
        self.send("token-user", "confirmar")
        self.assertEqual(self.api.writes(), [STATUS_WRITE])
        agent = MessageAgent(token="token-user", body={"conversationId": conversation, "content": "confirmar"})
        agent.user_id = USERS_BY_TOKEN["token-user"]["_id"]
        agent.conversations = store
        payload, _status = agent._confirm_shared(
            operation=stale, conversation_id=conversation, event_id="e", moderation_score=0.0, queue_result={},
        )
        self.assertFalse(payload["action_executed"])
        self.assertIn("já foi confirmada", payload["reply_text"])
        self.assertEqual(self.api.writes(), [STATUS_WRITE])

    def test_client_cannot_choose_the_summary_labels(self):
        payload, _status = self.send_body("token-user", content=STATUS_PHRASE,
                                          params={"_task_label": "Tarefa inofensiva", "_team_label": "Outra"})
        self.assertNotIn("Tarefa inofensiva", payload["reply_text"])
        self.assertIn('"Relatório final', payload["reply_text"])
        self.send("token-user", "cancelar")
        self.assert_no_writes()

    def test_target_given_as_id_by_the_client_is_named_in_the_summary(self):
        payload, _status = self.send_body("token-user", content="mudar status para concluído",
                                          params={"task_id": RELATORIO})
        self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation", payload["reply_text"])
        self.assertIn('"Relatório final"', payload["reply_text"])
        self.send("token-user", "confirmar")
        self.assertEqual(self.api.writes(), [STATUS_WRITE])


class ConfirmationBindingTests(WriteConfirmationTestCase):
    """A confirmacao vale so para quem preparou, na conversa em que preparou."""

    def test_another_person_cannot_confirm_in_the_same_conversation(self):
        self.send("token-admin", "criar equipe marketing")
        for token in ("token-admin-2", "token-user"):
            with self.subTest(token=token):
                payload, _status = self.send(token, "confirmar")
                self.assertFalse(payload["action_executed"])
                self.assertIn("Não há nenhuma operação aguardando confirmação", payload["reply_text"])
        self.assert_no_writes()
        self.assertEqual(self.pending("token-admin")["mode"], "write_confirmation")
        payload, _status = self.send("token-admin", "confirmar")
        self.assertEqual(self.api.writes(), [TEAM_WRITE])

    def test_confirmation_in_another_conversation_does_nothing(self):
        self.send("token-admin", "criar equipe marketing")
        payload, _status = self.send("token-admin", "confirmar", conversation_id="outra-conversa")
        self.assertFalse(payload["action_executed"])
        self.assert_no_writes()
        self.assertEqual(self.pending("token-admin")["mode"], "write_confirmation")

    def test_state_bound_to_another_owner_is_refused(self):
        # (a) Estado local antigo de confirmacao (de antes da mudanca, copia, migracao ou adulteracao), preparado
        # para outra pessoa: e descartado e nunca executa.
        store, conversation = self.state("token-admin")
        store.save(conversation, {
            "mode": "write_confirmation", "command": "create_team", "params": {"nome": "marketing"},
            "owner_id": USERS_BY_TOKEN["token-admin-2"]["_id"], "conversation_id": conversation,
            "operation_id": "operacao-local-antiga", "expires_at": time.time() + 60,
        })
        payload, _status = self.send("token-admin", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assertEqual(payload["conversation"]["status"], "cancelled")
        self.assertIsNone(self.pending("token-admin"))
        self.assert_no_writes()
        # (b) Operacao compartilhada cujo dono (no servidor) e outra pessoa: esta pessoa nao a ve nem a confirma.
        self.send("token-admin", "criar equipe marketing")
        self.ops.ops[-1]["ownerId"] = USERS_BY_TOKEN["token-admin-2"]["_id"]
        payload, _status = self.send("token-admin", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assertIsNone(self.pending("token-admin"))
        self.assertEqual((self.ops.ops[-1]["status"], self.ops.ops[-1]["attempts"]), ("pending", 0))
        self.assert_no_writes()


class PermissionTests(WriteConfirmationTestCase):
    def test_without_permission_nothing_is_prepared(self):
        payload, status = self.send("token-user", "criar equipe marketing")
        self.assertEqual((status, payload["error"]), (403, "forbidden"))
        self.assertIsNone(self.pending("token-user"))
        payload, _status = self.send("token-user", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assert_no_writes()

    def test_permission_is_checked_again_when_confirming(self):
        self.send("token-admin", "criar equipe marketing")
        with patch.dict(USERS_BY_TOKEN["token-admin"], {"tipo": "user"}):
            payload, status = self.send("token-admin", "confirmar")
        self.assertEqual((status, payload["error"]), (403, "forbidden"))
        self.assertFalse(payload["action_executed"])
        self.assertIsNone(self.pending("token-admin"))
        self.assert_no_writes()

    def test_admin_cannot_prepare_assignment_from_a_task_list(self):
        self.send("token-admin", "listar tarefas")
        payload, status = self.send("token-admin", "atribuir a 1 para mim")
        self.assertEqual((status, payload["error"]), (403, "forbidden"))
        self.assertIsNone(self.pending("token-admin"))
        self.assert_no_writes()


class MultiTurnFlowTests(WriteConfirmationTestCase):
    """Fluxos com perguntas: o ultimo valor leva ao resumo; a confirmacao nao se confunde com um campo."""

    def test_last_answer_prepares_and_only_confirmar_writes(self):
        self.send("token-admin", "criar equipe")
        payload, status = self.send("token-admin", "Marketing")
        self.assert_prepared(payload, status, "token-admin", "create_team")
        self.assertIn('criar a equipe "Marketing"', payload["reply_text"])
        self.send("token-admin", "confirmar")
        self.assertEqual(self.api.writes(), [TEAM_WRITE])

    def test_confirmar_while_a_field_is_pending_is_not_a_value(self):
        self.send("token-admin", "criar equipe")
        for answer in ("confirmar", "sim, confirmo"):
            with self.subTest(answer=answer):
                payload, _status = self.send("token-admin", answer)
                self.assertEqual(payload["conversation"]["status"], "awaiting_params")
                self.assertEqual(payload["conversation"]["next_param"], "nome")
                self.assertIn("Ainda não há nada para confirmar", payload["reply_text"])
                self.assertNotIn("nome", self.pending("token-admin")["params"])
        self.assert_no_writes()

    def test_create_task_by_voice_resolves_the_team_and_the_assignee_before_confirming(self):
        for step in ("criar tarefa", "Relatório semanal", "Resumo das entregas", "25/12/2026", "alta", "Equipe Alfa"):
            self.send("token-admin", step)
        payload, status = self.send("token-admin", "Pessoa Ficticia")
        self.assert_prepared(payload, status, "token-admin", "create_task")
        for part in ('criar a tarefa "Relatório semanal"', 'na equipe "Equipe Alfa"', "entrega em 25/12/2026",
                     "urgência alta", "responsável: Pessoa Ficticia"):
            self.assertIn(part, payload["reply_text"])
        self.send("token-admin", "confirmar")
        self.assertEqual(self.api.writes(), [("POST", "/tarefas", {
            "descricao": "Relatório semanal", "equipe": TEAM_ID, "dataEntrega": "2026-12-25", "urgencia": "alta",
            "detalhes": "Resumo das entregas", "user": "f" * 24,
        })])

    def test_new_command_while_confirmation_is_pending_cancels_it(self):
        self.send("token-admin", "criar equipe marketing")
        payload, _status = self.send("token-admin", "criar equipe vendas")
        self.assertEqual(payload["conversation"]["status"], "cancelled")
        payload, _status = self.send("token-admin", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assert_no_writes()


class LegacyAssistRouteTests(WriteConfirmationTestCase):
    """POST /assist e POST /: sem estado nem confirmacao, so leituras; escrita nunca chega a API."""

    # (token, frase, params completos com IDs ja resolvidos) para cada comando de escrita.
    WRITES = {
        "create_team": ("token-admin", "criar equipe marketing", {"nome": "Marketing"}),
        "create_task": ("token-admin", "criar tarefa relatório", {
            "nome": "Relatório", "descricao": "Resumo", "dataEntrega": "2026-12-01", "urgencia": "alta",
            "equipe": TEAM_ID, "user": "__none__"}),
        "assign_to_me": ("token-user", "atribuir tarefa para mim", {"team_id": TEAM_ID, "task_id": RELATORIO}),
        "update_status": ("token-user", STATUS_PHRASE, {"task_id": RELATORIO, "status": "concluido"}),
        "timer": ("token-user", "iniciar cronômetro da tarefa relatório final", {"task_id": RELATORIO, "acao": "iniciar"}),
        "add_comment": ("token-user", "adicionar comentário", {"task_id": RELATORIO, "texto": "revisar"}),
        "add_subtask": ("token-user", "adicionar subtarefa", {"task_id": RELATORIO, "descricao": "revisar números"}),
        "delete_task": ("token-admin", "excluir tarefa", {"task_id": RELATORIO}),
    }

    def post(self, path, token, **body):
        raw, status, _headers = function.flowly_http(FakeRequest(path, body, token))
        return json.loads(raw), status

    def test_every_write_command_is_covered(self):
        from flowly_assistant.command_parser import is_write_command
        from flowly_assistant.commands import get_commands

        self.assertEqual(set(self.WRITES), {c.key for c in get_commands() if is_write_command(c)})

    def test_no_write_reaches_the_api_even_with_a_valid_phrase_and_all_params(self):
        for path in ("/assist", "/"):
            for key, (token, utterance, params) in self.WRITES.items():
                for owner in (token, "token-admin", "token-user"):  # com ou sem permissao: bloqueado igual
                    for field in ("utterance", "text"):
                        with self.subTest(path=path, key=key, token=owner, field=field):
                            payload, status = self.post(path, owner, **{field: utterance, "params": params})
                            self.assertEqual(status, 403, payload)
                            self.assertFalse(payload["ok"])
                            expected = "command_disabled" if key == "delete_task" else "write_requires_confirmation"
                            self.assertEqual(payload["error"], expected)
                            self.assertEqual(payload["command"]["key"], key)
                            self.assertIn("Nada foi", payload["reply_text"])
        self.assertEqual([c for c in self.api.calls if c[0] in ("POST", "PUT", "PATCH", "DELETE")], [])
        self.assertEqual({c[1] for c in self.api.calls}, {"/users/me"})  # nem a busca de alvos acontece

    def test_confirmation_words_or_forged_state_fields_do_not_write(self):
        for body in (
            {"utterance": "confirmar"},
            {"utterance": "confirmar", "operationId": "qualquer"},
            {"utterance": STATUS_PHRASE, "params": {"task_id": RELATORIO, "status": "concluido"}, "confirm": True,
             "confirmed": True, "mode": "write_confirmation"},
        ):
            with self.subTest(body=body):
                payload, _status = self.post("/assist", "token-user", **body)
                self.assertFalse(payload["ok"])
        self.assert_no_writes()

    def test_reads_and_authentication_are_preserved(self):
        for token, utterance, key in (
            ("token-user", "meu perfil", "me"),
            ("token-user", "minhas tarefas", "my_tasks"),
            ("token-admin", "listar equipes", "list_teams"),
            ("token-admin", "detalhes da tarefa", "task_details"),
        ):
            with self.subTest(utterance=utterance):
                params = {"task_id": RELATORIO} if key == "task_details" else {}
                payload, status = self.post("/assist", token, utterance=utterance, params=params)
                self.assertEqual(status, 200, payload)
                self.assertEqual(payload["command"]["key"], key)
        payload, status = self.post("/assist", None, utterance="meu perfil")
        self.assertEqual((status, payload["error"]), (401, "missing_token"))
        payload, status = self.post("/assist", "token-invalido", utterance="meu perfil")
        self.assertFalse(payload["ok"])
        self.assert_no_writes()

    def test_rest_assistant_handle_never_writes_for_any_caller(self):
        # handle() tambem atende o ultimo passo das consultas com perguntas, que remonta a frase: mesmo que ela
        # forme uma escrita, nada executa por ali (so prepare_write + execute_prepared escrevem).
        from flowly_assistant.assistant_core.rest_assistant import RestAssistant

        assistant = RestAssistant(api_base_url="https://api.flowly.test/api", token="token-admin")
        for utterance, params in (("criar equipe marketing", {"nome": "Marketing"}),
                                  ("criar equipe nome Marketing", {})):
            with self.subTest(utterance=utterance):
                payload, status = assistant.handle(utterance, params)
                self.assertEqual((status, payload["error"]), (403, "write_requires_confirmation"))
        self.assert_no_writes()


class TaskSelectionConfirmationTests(WriteConfirmationTestCase):
    def setUp(self):
        super().setUp()
        self.api.backlog = BACKLOG_TASKS

    def test_assignment_by_number_shows_the_task_name_and_waits_for_confirmar(self):
        self.send("token-user", "backlog")
        payload, status = self.send("token-user", "atribuir a 3 para mim")
        self.assert_prepared(payload, status, "token-user", "assign_to_me")
        self.assertIn('"Corrigir filtro de busca (equipe Equipe Alfa)"', payload["reply_text"])
        self.send("token-user", "confirmar")
        self.assertEqual(self.api.writes(), [("PUT", f"/tarefas/{BACKLOG_TASKS[2]['_id']}/atribuir-para-mim", None)])

    def test_task_already_selected_and_shown_is_assigned_on_the_explicit_answer(self):
        self.send("token-user", "backlog")
        payload, _status = self.send("token-user", "3")
        self.assertIn("Selecionei Corrigir filtro de busca", payload["reply_text"])
        payload, _status = self.send("token-user", "atribuir para mim")
        self.assertTrue(payload["action_executed"], payload["reply_text"])
        self.assertEqual(self.api.writes(), [("PUT", f"/tarefas/{BACKLOG_TASKS[2]['_id']}/atribuir-para-mim", None)])

    def test_questions_future_and_sem_during_selection_never_assign(self):
        for select in (None, "3"):
            for phrase in ("como pegar a 3?", "vou pegar a 3 amanhã", "sem pegar a 3", "posso atribuir essa para mim",
                           "como atribuir para mim"):
                with self.subTest(select=select, phrase=phrase):
                    ScopedConversationState(ConversationStateRepository(), USERS_BY_TOKEN["token-user"]["_id"]).clear(
                        CONVERSATION_ID)
                    self.send("token-user", "backlog")
                    if select:
                        self.send("token-user", select)
                    payload, _status = self.send("token-user", phrase)
                    self.assertFalse(payload["action_executed"])
                    self.assertIn("Não identifiquei um pedido direto", payload["reply_text"])
                    self.assertEqual(self.pending("token-user")["mode"], "task_selection")  # a lista continua valendo
        self.assert_no_writes()


class UnexpectedErrorsTests(WriteConfirmationTestCase):
    """M1: "eu" como equipe e erros inesperados no preparo/execucao viram JSON seguro, sem detalhe interno."""

    CREATE_TASK_UNTIL_TEAM = ("criar tarefa", "Relatório", "Resumo", "amanhã", "alta")

    def test_team_reference_eu_in_task_creation_returns_json_and_writes_nothing(self):
        for team_answer in ("eu", "mim", "para mim", "eu mesma"):
            with self.subTest(team_answer=team_answer):
                ScopedConversationState(ConversationStateRepository(), USERS_BY_TOKEN["token-admin"]["_id"]).clear(
                    CONVERSATION_ID)
                for step in self.CREATE_TASK_UNTIL_TEAM + (team_answer,):
                    self.send("token-admin", step)
                payload, status = self.send("token-admin", "não")  # responsavel: ultimo passo -> preparo
                self.assertEqual(status, 400, payload)
                self.assertEqual(payload["error"], "api_error")
                self.assertFalse(payload["action_executed"])
                self.assertIn("Diga o nome da equipe", payload["reply_text"])
                self.assertNotIn("team_id", json.dumps(payload))
        self.assert_no_writes()

    def test_team_resolver_never_returns_a_person_as_team(self):
        from flowly_assistant.api_client import APIError
        from flowly_assistant.assistant_core.rest_assistant import RestAssistant

        assistant = RestAssistant(api_base_url="https://api.flowly.test/api", token="token-admin")
        for ref in ("eu", "mim", "pra mim", "eu mesmo"):
            with self.subTest(ref=ref), self.assertRaises(APIError):
                assistant._resolve_team_ref(ref)
        self.assertEqual(assistant._resolve_team_ref("equipe alfa"), (TEAM_ID, "Equipe Alfa"))

    def test_unexpected_error_while_preparing_is_safe_json(self):
        from flowly_assistant.assistant_core.rest_assistant import INTERNAL_ERROR_REPLY, RestAssistant

        with patch.object(RestAssistant, "_resolve_refs", side_effect=RuntimeError("detalhe interno /tmp/segredo")):
            payload, status = self.send("token-user", STATUS_PHRASE)
        self.assertEqual((status, payload["error"], payload["reply_text"]), (500, "internal_error", INTERNAL_ERROR_REPLY))
        self.assertNotIn("detalhe interno", json.dumps(payload, ensure_ascii=False))
        self.assertIsNone(self.pending("token-user"))
        self.assert_no_writes()

    def test_unexpected_error_while_executing_is_safe_json(self):
        from flowly_assistant.assistant_core.rest_assistant import RestAssistant

        self.send("token-user", STATUS_PHRASE)
        # A confirmacao compartilhada executa por execute_with_key (chave do claim).
        with patch.object(RestAssistant, "execute_with_key", side_effect=RuntimeError("detalhe interno /tmp/segredo")):
            payload, status = self.send("token-user", "confirmar")
        self.assertEqual((status, payload["error"]), (500, "internal_error"))
        self.assertFalse(payload["action_executed"])
        self.assertNotIn("detalhe interno", json.dumps(payload, ensure_ascii=False))
        # Resultado incerto: a operacao fica para recuperacao com a mesma chave, nunca como concluida.
        self.assertEqual(self.ops.ops[-1]["status"], "retry_pending")
        # O proprio metodo tambem nao devolve o detalhe (outro chamador poderia repassar o payload inteiro).
        from flowly_assistant.commands import get_commands

        assistant = RestAssistant(api_base_url="https://api.flowly.test/api", token="token-user")
        update_status = next(c for c in get_commands() if c.key == "update_status")
        for method, target in (("_execute", assistant.execute_prepared), ("_resolve_refs", assistant.prepare_write)):
            with self.subTest(method=method), \
                    patch.object(RestAssistant, method, side_effect=RuntimeError("detalhe interno /tmp/segredo")):
                payload, status = target(update_status, {"task_id": "relatório final", "status": "concluido"})
                self.assertEqual((status, payload["error"]), (500, "internal_error"))
                self.assertNotIn("detalhe interno", json.dumps(payload, ensure_ascii=False))
        self.assert_no_writes()


class UnknownProfileFailsClosedTests(WriteConfirmationTestCase):
    """B1: sem perfil identificado (falha no /users/me ou tipo ausente), nada e preparado nem executado."""

    def profile_lookup_fails_after_login(self):
        """O /users/me da autenticacao responde; os seguintes (deteccao do perfil) falham nesta requisicao."""
        from flowly_assistant.api_client import APIError, FlowlyAPIClient

        api, calls = self.api, {"me": 0}

        def request(client, method, path, **kwargs):
            if path == "/users/me":
                calls["me"] += 1
                if calls["me"] > 1:
                    raise APIError("HTTP 503 em GET /users/me")
            return api(client, method, path, **kwargs)

        return patch.object(FlowlyAPIClient, "request", request)

    def assert_unknown_profile(self, payload, status):
        from flowly_assistant.assistant_core.rest_assistant import PROFILE_UNKNOWN_REPLY

        self.assertEqual((status, payload["error"]), (403, "user_type_unknown"), payload)
        self.assertEqual(payload["reply_text"], PROFILE_UNKNOWN_REPLY)
        self.assertFalse(payload["action_executed"])

    def test_profile_without_type_prepares_nothing(self):
        for token, phrase in (("token-admin", "criar equipe marketing"), ("token-user", STATUS_PHRASE)):
            with self.subTest(phrase=phrase), patch.dict(USERS_BY_TOKEN[token]):
                del USERS_BY_TOKEN[token]["tipo"]
                payload, status = self.send(token, phrase)
                self.assert_unknown_profile(payload, status)
                self.assertIsNone(self.pending(token))
        self.assert_no_writes()

    def test_profile_lookup_failure_while_preparing_prepares_nothing(self):
        with self.profile_lookup_fails_after_login():
            payload, status = self.send("token-admin", "criar equipe marketing")
        self.assert_unknown_profile(payload, status)
        self.assertIsNone(self.pending("token-admin"))
        self.assert_no_writes()

    def test_profile_lookup_failure_at_confirmation_executes_nothing(self):
        payload, _status = self.send("token-admin", "criar equipe marketing")
        self.assertEqual(payload["conversation"]["status"], "awaiting_confirmation")
        with self.profile_lookup_fails_after_login():
            payload, status = self.send("token-admin", "confirmar")
        self.assertEqual(status, 403, payload)
        self.assertEqual(payload["error"], "user_type_unknown")
        self.assertFalse(payload["action_executed"])
        self.assertIsNone(self.pending("token-admin"))  # operacao consumida: nao pode ser repetida
        self.send("token-admin", "confirmar")
        self.assert_no_writes()

    def test_profile_without_type_cannot_prepare_assignment_from_the_task_list(self):
        self.api.backlog = BACKLOG_TASKS
        self.send("token-user", "backlog")
        with patch.dict(USERS_BY_TOKEN["token-user"]):
            del USERS_BY_TOKEN["token-user"]["tipo"]
            payload, status = self.send("token-user", "atribuir a 3 para mim")
        self.assert_unknown_profile(payload, status)
        self.assertIsNone(self.pending("token-user"))
        self.assert_no_writes()

    def test_rest_assistant_methods_refuse_without_profile(self):
        from flowly_assistant.assistant_core.rest_assistant import RestAssistant
        from flowly_assistant.commands import get_commands

        assistant = RestAssistant(api_base_url="https://api.flowly.test/api", token="token-admin")
        create_team = next(c for c in get_commands() if c.key == "create_team")
        with patch.object(RestAssistant, "_detect_user_type", return_value=None):
            for call in (assistant.prepare_write, assistant.execute_prepared):
                with self.subTest(call=call.__name__):
                    payload, status = call(create_team, {"nome": "Marketing"})
                    self.assertEqual((status, payload["error"]), (403, "user_type_unknown"))
        self.assert_no_writes()


class StatusReadQuestionTests(WriteConfirmationTestCase):
    """M2: perguntar ou pedir para ver o status nao vira escrita e recebe a sugestao do comando de leitura."""

    PHRASES = ("Qual o status da tarefa Relatório final?", "Ver status da tarefa Relatório final")

    def test_status_read_questions_suggest_task_details_in_both_modes(self):
        for enabled in ("true", None):
            for phrase in self.PHRASES:
                with self.subTest(enabled=enabled, phrase=phrase), patch.dict("os.environ"):
                    if enabled is None:
                        import os

                        os.environ.pop("FLOWLY_ASSISTANT_WRITES_ENABLED", None)
                    self.assertIsNone(CommandParser(threshold=78).match(phrase))  # parser inalterado: nao e ordem
                    payload, status = self.send("token-user", phrase)
                    self.assertEqual(status, 201, payload)
                    self.assertIsNone(payload["command"])
                    self.assertFalse(payload["action_executed"])
                    self.assertIn("Nada foi alterado", payload["reply_text"])
                    self.assertIn('"detalhes da tarefa Relatório final"', payload["reply_text"])
                    self.assertIsNone(self.pending("token-user"))
        self.assert_no_writes()

    def test_the_suggested_command_shows_the_status(self):
        self.send("token-user", self.PHRASES[0])
        payload, status = self.send("token-user", "detalhes da tarefa Relatório final")
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["command"]["key"], "task_details")
        self.assertIn("status pendente", payload["reply_text"])
        self.assert_no_writes()

    def test_questions_about_changing_status_keep_the_question_reply(self):
        payload, _status = self.send("token-user", "como mudar status da tarefa relatório final para concluído")
        self.assertIn("parece uma pergunta", payload["reply_text"])
        self.assertNotIn("detalhes da tarefa", payload["reply_text"])
        self.assert_no_writes()


if __name__ == "__main__":
    unittest.main()
