"""Etapa 6A.2C2: confirmacoes de escrita compartilhadas (AssistantOperation na API do Flowly).

O MessageAgent cria a confirmacao pela API das operacoes (so params executaveis), mostra o resumo guardado la,
executa apenas o que veio do claim, com a MESMA Idempotency-Key em toda tentativa, e registra o desfecho sem
nunca afirmar sucesso incerto. Servidor das operacoes e API publica simulados; rede real bloqueada.

Numeracao (N) = item da lista de testes obrigatorios da etapa.
"""

import io
import json
import os
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from test_command_safety import (
    CONVERSATION_ID,
    TASKS,
    TEAM_ID,
    TEST_OPERATIONS_SECRET,
    USERS_BY_TOKEN,
    AssistantFlowTestCase,
    FakeRequest,
)
import function  # noqa: E402
from fake_operations import lost  # noqa: E402
from flowly_assistant.api_client import APIError  # noqa: E402
from flowly_assistant.assistant_core.message_agent import (  # noqa: E402
    COMPLETE_RESERVE_SEC,
    CONTEXT_UNAVAILABLE_REPLY,
    SHARED_UNAVAILABLE_REPLY,
    UNVERIFIED_CREATE_REPLY,
    WRITE_TIMEOUT_CAP_SEC,
    MessageAgent,
)
from flowly_assistant.commands import WRITES_DISABLED_REPLY, WRITES_ENABLED_ENV  # noqa: E402
from flowly_assistant.operations_client import params_fingerprint  # noqa: E402
from fake_conversations import (  # noqa: E402
    ConversationStateRepository,
    ScopedConversationState,
)

RELATORIO = TASKS[0]["_id"]
STATUS_PHRASE = "mudar status da tarefa relatório final para concluído"
STATUS_WRITE = ("PUT", f"/tarefas/{RELATORIO}/status", {"status": "concluido"})
LABEL_KEYS = ("_task_label", "_team_label", "_user_label")


class SharedConfirmationTestCase(AssistantFlowTestCase):
    def send_body(self, token, **body):
        body.setdefault("conversationId", CONVERSATION_ID)
        body.setdefault("channelId", "voice-assistant")
        raw, status, _headers = function.flowly_http(FakeRequest("/api/v1/messages", body, token))
        return json.loads(raw), status

    def op(self):
        self.assertTrue(self.ops.ops, "nenhuma operacao criada")
        return self.ops.ops[-1]

    def prepare_status(self):
        payload, status = self.send("token-user", STATUS_PHRASE)
        self.assertEqual((status, payload["conversation"]["status"]), (200, "awaiting_confirmation"), payload)
        return payload

    def write_raises(self, exc, times=1):
        """A escrita publica falha `times` vezes (a requisicao chegou a ser registrada pelo falso)."""
        state = {"left": times}

        def hook(_client, _method, _path, _kwargs):
            if state["left"] > 0:
                state["left"] -= 1
                raise exc
            return None

        self.api.on_write = hook

    def claims(self):
        return self.ops.calls.count("claim")


class CreationTests(SharedConfirmationTestCase):
    def test_01_creation_is_pending_on_the_api_for_this_owner_and_conversation(self):
        payload = self.prepare_status()
        op = self.op()
        self.assertEqual(op["status"], "pending")
        self.assertEqual((op["ownerId"], op["conversationId"]), (USERS_BY_TOKEN["token-user"]["_id"], CONVERSATION_ID))
        self.assertEqual(op["commandKey"], "update_status")
        self.assertEqual(op["params"], {"task_id": RELATORIO, "status": "concluido"})
        self.assertEqual(payload["conversation"]["operation_id"], op["operationId"])
        self.assertEqual(payload["conversation"]["expires_in"], self.ops.confirm_ttl)
        self.assertIsNone(ScopedConversationState(ConversationStateRepository(), op["ownerId"]).get(CONVERSATION_ID))
        self.assert_no_writes()

    def test_02_summary_is_shown_only_after_a_valid_creation(self):
        for exc in (APIError("HTTP 400", kind="http", status_code=400, code="invalid_params"),
                    APIError("nao configurado", kind="not_configured", code="assistant_operations_not_configured"),
                    APIError("HTTP 403", kind="http", status_code=403, code="forbidden")):
            with self.subTest(code=exc.code):
                self.ops.fail_before["create"] = exc
                payload, status = self.send("token-user", STATUS_PHRASE)
                self.assertGreaterEqual(status, 400, payload)
                self.assertNotIn("Confirme", payload["reply_text"])
                self.assertNotIn("Relatório final", payload["reply_text"])
                self.assertFalse(payload["action_executed"])
                self.assertEqual(self.ops.ops, [])
        # Criada: o texto mostrado e exatamente o resumo guardado na API.
        payload = self.prepare_status()
        self.assertIn(self.op()["summary"], payload["reply_text"])
        self.assert_no_writes()

    def test_03_labels_and_extra_client_keys_never_reach_the_operation(self):
        self.send_body("token-user", content=STATUS_PHRASE, params={
            "_task_label": "Tarefa inofensiva", "_team_label": "Outra", "_user_label": "X", "ownerId": "x",
            "status_extra": "y", "idempotencyKey": "chave-do-navegador"})
        op = self.op()
        self.assertEqual(set(op["params"]), {"task_id", "status"})
        for key in LABEL_KEYS:
            self.assertNotIn(key, op["params"])
        self.assertNotEqual(op["idempotencyKey"], "chave-do-navegador")
        self.assertEqual(op["ownerId"], USERS_BY_TOKEN["token-user"]["_id"])
        self.assertNotIn("Tarefa inofensiva", op["summary"])

    def test_04_ambiguous_or_invalid_dates_are_refused_before_creating(self):
        agent = MessageAgent(token="token-admin", body={})
        base = {"nome": "Relatório", "urgencia": "alta", "equipe": TEAM_ID}
        for value in ("05/12/2026", "2026-02-30", "2026-1-5", "amanhã", "2026-12-01T10:00:00Z", "12/05"):
            with self.subTest(value=value):
                params, problem = agent._executable_params("create_task", {**base, "dataEntrega": value})
                self.assertEqual(params, {})
                self.assertEqual(problem[0], "dataEntrega")
        params, problem = agent._executable_params("create_task", {**base, "dataEntrega": "2026-12-01"})
        self.assertIsNone(problem)
        self.assertEqual(params["dataEntrega"], "2026-12-01")
        # Pelo fluxo: data que o parser nao normaliza nao vira operacao nem escrita.
        payload, _status = self.send_body("token-admin", content="criar tarefa", params={
            "nome": "Relatório semanal", "dataEntrega": "2026-02-30", "urgencia": "alta", "equipe": TEAM_ID})
        self.assertFalse(payload["action_executed"])
        self.assertNotEqual(payload["conversation"]["status"], "awaiting_confirmation", payload)
        self.assertEqual(self.ops.ops, [])
        self.assert_no_writes()

    def test_05_texts_over_the_limits_are_refused_never_truncated(self):
        for phrase, limit in (("criar equipe " + "m" * 130, 120),
                              ("comentar na tarefa relatório final dizendo " + "a" * 2001, 2000)):
            with self.subTest(limit=limit):
                token = "token-admin"
                payload, _status = self.send(token, phrase)
                self.assertFalse(payload["action_executed"])
                self.assertIn(f"o limite é {limit}", payload["reply_text"])
                self.assertEqual(self.ops.ops, [])
                self.send(token, "cancelar")
        self.assert_no_writes()


class ConfirmTests(SharedConfirmationTestCase):
    def test_06_explicit_confirmation_executes_once_with_the_claim_key(self):
        self.prepare_status()
        payload, status = self.send("token-user", "confirmar")
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["action_executed"], payload["reply_text"])
        self.assertEqual(self.api.writes(), [STATUS_WRITE])
        op = self.op()
        self.assertEqual(op["status"], "completed")
        self.assertEqual(op["result"]["httpStatus"], 200)
        self.assertEqual(self.api.keys, [op["idempotencyKey"]])

    def test_07_ambiguous_confirmation_cancels_without_claim(self):
        for phrase in ("sim", "confirmar?", "confirmar ou cancelar", "não confirmo", "ok"):
            with self.subTest(phrase=phrase):
                self.prepare_status()
                payload, _status = self.send("token-user", phrase)
                self.assertFalse(payload["action_executed"])
                self.assertEqual(self.op()["status"], "cancelled")
        self.assertEqual(self.claims(), 0)
        self.assert_no_writes()

    def test_08_two_instances_confirming_get_a_single_claim(self):
        self.prepare_status()
        seen = {}

        def concurrent_confirmation(_client, _method, _path, _kwargs):
            self.api.on_write = None
            seen["payload"], _ = self.send("token-user", "confirmar")  # outra instancia, durante a escrita
            return None

        self.api.on_write = concurrent_confirmation
        payload, _status = self.send("token-user", "confirmar")
        self.assertTrue(payload["action_executed"])
        self.assertFalse(seen["payload"]["action_executed"])
        self.assertIn("já está sendo executada", seen["payload"]["reply_text"])
        self.assertEqual(self.api.writes(), [STATUS_WRITE])
        self.assertEqual(self.op()["attempts"], 1)

    def test_09_execution_uses_only_the_claim_params(self):
        self.prepare_status()
        # Corpo do "confirmar", estado local adulterado e operationId do navegador nao mudam o que executa.
        store = ScopedConversationState(ConversationStateRepository(), USERS_BY_TOKEN["token-user"]["_id"])
        store.save(CONVERSATION_ID, {"mode": "write_confirmation", "command": "update_status",
                                     "conversation_id": CONVERSATION_ID, "expires_at": time.time() + 60,
                                     "owner_id": USERS_BY_TOKEN["token-user"]["_id"], "operation_id": "local",
                                     "params": {"task_id": TASKS[1]["_id"], "status": "pendente"}})
        payload, _status = self.send_body("token-user", content="confirmar", operationId=self.op()["operationId"],
                                          params={"task_id": TASKS[1]["_id"], "status": "pendente"},
                                          command="add_comment")
        self.assertTrue(payload["action_executed"], payload["reply_text"])
        self.assertEqual(self.api.writes(), [STATUS_WRITE])

    def test_09b_operation_id_from_the_browser_is_not_enough(self):
        self.prepare_status()
        payload, _status = self.send_body("token-user", content="confirmar", operationId="outra-operacao")
        self.assertFalse(payload["action_executed"])
        self.assertEqual(self.op()["status"], "cancelled")
        self.assertEqual(self.claims(), 0)
        self.assert_no_writes()


class CancelAndExpiryTests(SharedConfirmationTestCase):
    def test_11_cancel_pending(self):
        self.prepare_status()
        payload, _status = self.send("token-user", "cancelar")
        self.assertEqual(payload["conversation"]["status"], "cancelled")
        self.assertIn("Nada foi alterado", payload["reply_text"])
        self.assertEqual(self.op()["status"], "cancelled")
        self.send("token-user", "confirmar")
        self.assertEqual(self.claims(), 0)
        self.assert_no_writes()

    def test_11b_cancel_without_api_answer_is_not_reported_as_done(self):
        self.prepare_status()
        self.ops.fail_before["cancel"] = lost("network")
        payload, _status = self.send("token-user", "cancelar")
        self.assertNotIn("cancelei", payload["reply_text"].lower())
        self.assertIn("Não consegui confirmar o cancelamento", payload["reply_text"])
        self.assert_no_writes()

    def test_12_cancel_after_claim_is_refused_and_not_claimed_as_success(self):
        self.prepare_status()
        self.ops.claim("token-user", CONVERSATION_ID, self.op()["operationId"])  # outra instancia executando
        payload, _status = self.send("token-user", "cancelar")
        self.assertIn("Não é possível cancelar", payload["reply_text"])
        self.assertEqual(self.op()["status"], "executing")
        self.assert_no_writes()

    def test_13_expiry_before_confirmation(self):
        self.prepare_status()
        self.ops.offset = self.ops.confirm_ttl + 1
        payload, _status = self.send("token-user", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assertEqual(payload["conversation"]["status"], "expired")
        self.assertEqual(self.op()["status"], "expired")
        self.assertEqual(self.claims(), 0)
        self.assert_no_writes()


class LostResponseTests(SharedConfirmationTestCase):
    def test_14_15_lost_create_response_reuses_the_matching_pending_operation(self):
        self.ops.lose_response["create"] = lost()
        payload, status = self.send("token-user", STATUS_PHRASE)
        self.assertEqual((status, payload["conversation"]["status"]), (200, "awaiting_confirmation"), payload)
        self.assertEqual(len(self.ops.ops), 1)  # nao criou outra
        self.assertEqual(payload["conversation"]["operation_id"], self.op()["operationId"])
        self.assertEqual(self.ops.calls.count("create"), 1)
        self.send("token-user", "confirmar")
        self.assertEqual(self.api.writes(), [STATUS_WRITE])

    def test_14b_lost_create_without_current_is_unverified_and_never_replaced(self):
        self.ops.lose_response["create"] = lost()
        original_current = self.ops.current

        def current_down_after_create(token, conv):
            if "create" in self.ops.calls:
                self.ops.calls.append("current")
                raise lost("network")
            return original_current(token, conv)

        with patch.object(self.ops, "current", current_down_after_create):
            payload, status = self.send("token-user", STATUS_PHRASE)
        self.assertEqual((status, payload["reply_text"]), (503, UNVERIFIED_CREATE_REPLY))
        self.assertNotIn("Confirme", payload["reply_text"])
        payload, status = self.send("token-user", "cancelar")  # a pendente desconhecida e cancelada pelo current
        self.assertEqual(self.op()["status"], "cancelled")
        self.assertEqual(len(self.ops.ops), 1)
        self.assert_no_writes()

    def test_16_current_finding_a_different_operation_is_not_reused(self):
        original = self.ops.create

        def created_then_replaced(token, conv, command_key, params, summary):
            original(token, conv, command_key, params, summary)
            self.ops.ops[-1]["status"] = "cancelled"  # outra instancia cancelou e criou outra
            original(token, conv, "create_team", {"nome": "vendas"}, 'criar a equipe "Vendas"')
            raise lost()

        with patch.object(self.ops, "create", created_then_replaced):
            payload, status = self.send("token-user", STATUS_PHRASE)
        # Conflito explicito: nao reutiliza, nao cria outra, nao cancela e nao convida a confirmar a divergente.
        self.assertEqual((status, payload["error"], payload["conversation"]["status"]),
                         (409, "confirmation_mismatch", "conflict"), payload)
        self.assertIn("já existe outra confirmação pendente", payload["reply_text"])
        self.assertNotIn("Confirme a operação", payload["reply_text"])
        self.assertNotIn("Vendas", payload["reply_text"])
        self.assertEqual(self.op()["commandKey"], "create_team")
        self.assertEqual(self.op()["status"], "pending")  # intacta
        self.assertEqual(len(self.ops.ops), 2)  # as duas da simulacao; nenhuma terceira
        self.assertEqual((self.ops.calls.count("cancel"), self.claims()), (0, 0))
        self.assert_no_writes()

    def test_17_lost_claim_response_sends_nothing_and_recovers_after_the_lease(self):
        self.prepare_status()
        self.ops.lose_response["claim"] = lost()
        payload, _status = self.send("token-user", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assertIn("Nenhuma alteração foi enviada", payload["reply_text"])
        self.assert_no_writes()
        payload, _status = self.send("token-user", "confirmar")  # lease ainda valido
        self.assertIn("já está sendo executada", payload["reply_text"])
        self.assert_no_writes()
        self.ops.offset = self.ops.lease + 1
        payload, _status = self.send("token-user", "confirmar")
        self.assertTrue(payload["action_executed"], payload["reply_text"])
        self.assertEqual(self.api.writes(), [STATUS_WRITE])
        self.assertEqual(self.api.keys, [self.op()["idempotencyKey"]])

    def test_18_10_21_timeout_during_the_write_recovers_with_the_same_key(self):
        self.prepare_status()
        self.write_raises(APIError("Timeout", kind="timeout", may_have_executed=True))
        payload, _status = self.send("token-user", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assertIn("pode ter sido aplicada", payload["reply_text"])
        self.assertEqual(self.op()["status"], "retry_pending")
        payload, _status = self.send("token-user", "confirmar")
        self.assertTrue(payload["action_executed"], payload["reply_text"])
        key = self.op()["idempotencyKey"]
        self.assertEqual(self.api.keys, [key, key])  # (10) mesma chave em toda tentativa
        self.assertEqual(len(self.ops.ops), 1)  # (21) recuperacao sem nova operacao
        self.assertEqual(self.op()["status"], "completed")

    def test_19_server_errors_after_possible_execution_are_uncertain(self):
        for status_code in (500, 503):
            with self.subTest(status=status_code):
                self.prepare_status()
                self.write_raises(APIError(f"HTTP {status_code}", kind="http", status_code=status_code,
                                           may_have_executed=True))
                payload, _status = self.send("token-user", "confirmar")
                self.assertFalse(payload["action_executed"])
                self.assertEqual(payload["error"], "outcome_uncertain")
                self.assertEqual(self.op()["status"], "retry_pending")
                self.send("token-user", "confirmar")  # recuperacao conclui
                self.assertEqual(self.op()["status"], "completed")

    def test_20_lost_complete_response_does_not_execute_again(self):
        self.prepare_status()
        self.ops.lose_response["complete"] = lost()
        payload, _status = self.send("token-user", "confirmar")
        self.assertTrue(payload["action_executed"], payload["reply_text"])
        self.assertEqual(self.op()["status"], "completed")
        payload, _status = self.send("token-user", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assertEqual(self.api.writes(), [STATUS_WRITE])

    def test_20b_complete_failure_without_registration_recovers_with_the_same_key(self):
        self.prepare_status()
        self.ops.fail_before["complete"] = lost("network")
        payload, _status = self.send("token-user", "confirmar")
        self.assertTrue(payload["action_executed"])  # a API publica confirmou a escrita
        self.assertEqual(self.op()["status"], "executing")
        self.ops.offset = self.ops.lease + 1
        self.send("token-user", "confirmar")
        key = self.op()["idempotencyKey"]
        self.assertEqual(self.api.keys, [key, key])  # a API publica devolve o replay; nada duplica
        self.assertEqual(self.op()["status"], "completed")


class TerminalOutcomeTests(SharedConfirmationTestCase):
    def test_22_unknown_outcome_is_never_executed_again(self):
        self.prepare_status()
        self.write_raises(APIError("HTTP 409", kind="http", status_code=409, code="idempotency_outcome_unknown"))
        payload, _status = self.send("token-user", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assertEqual(payload["conversation"]["status"], "unknown")
        self.assertEqual(self.op()["status"], "unknown")
        payload, _status = self.send("token-user", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assertIn("não vou repetir", payload["reply_text"])
        self.assertEqual(len(self.api.writes()), 1)

    def test_22b_attempts_exhausted_become_unknown(self):
        self.prepare_status()
        self.write_raises(APIError("Timeout", kind="timeout", may_have_executed=True), times=5)
        for _ in range(5):
            self.send("token-user", "confirmar")
        self.assertEqual(self.op()["status"], "unknown")
        self.assertEqual(len(self.api.writes()), self.ops.max_claims)

    def test_23_completed_is_never_executed_again(self):
        self.prepare_status()
        self.send("token-user", "confirmar")
        for phrase in ("confirmar", "confirmo", "pode confirmar"):
            payload, _status = self.send("token-user", phrase)
            self.assertFalse(payload["action_executed"])
            self.assertIn("Nada foi executado de novo", payload["reply_text"])
        self.assertEqual(self.api.writes(), [STATUS_WRITE])

    def test_23b_replayed_result_is_kept(self):
        from flowly_assistant.api_client import APIResponse

        self.prepare_status()

        def replay(client, _method, _path, _kwargs):
            client.last_response = APIResponse(200, {"ok": True}, replayed=True)
            return {"ok": True}

        self.api.on_write = replay
        payload, _status = self.send("token-user", "confirmar")
        self.assertTrue(payload["action_executed"])
        self.assertTrue(payload["replayed"])
        self.assertTrue(self.op()["result"]["replayed"])

    def test_24_old_claim_has_no_authority_to_complete(self):
        self.prepare_status()
        holder = {}

        def lease_lost_mid_write(_client, _method, _path, _kwargs):
            self.api.on_write = None
            self.ops.offset = self.ops.lease + 1
            holder["claim"] = self.ops.claim("token-user", CONVERSATION_ID, self.op()["operationId"])
            return None

        self.api.on_write = lease_lost_mid_write
        self.send("token-user", "confirmar")
        op = self.op()
        self.assertEqual(op["status"], "executing")  # o claim antigo nao concluiu
        self.assertEqual(op["claimToken"], holder["claim"]["claimToken"])
        self.assertEqual(op["attempts"], 2)

    def test_25_permission_denied_by_the_public_api_fails_definitively(self):
        self.prepare_status()
        self.write_raises(APIError("Sem permissão para alterar essa tarefa.", kind="http", status_code=403))
        payload, _status = self.send("token-user", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assertEqual(payload["conversation"]["status"], "failed")
        self.assertEqual(self.op()["status"], "failed")
        self.send("token-user", "confirmar")
        self.assertEqual(len(self.api.writes()), 1)

    def test_26_role_change_or_revoked_session_executes_nothing(self):
        self.send("token-admin", "criar equipe marketing")
        demoted = {**USERS_BY_TOKEN, "token-admin": {**USERS_BY_TOKEN["token-admin"], "tipo": "user"}}
        with patch.dict(USERS_BY_TOKEN, demoted):
            payload, status = self.send("token-admin", "confirmar")
        self.assertEqual((status, payload["error"]), (403, "forbidden"))
        self.assertEqual(self.op()["status"], "cancelled")
        self.assertEqual(self.claims(), 0)
        # Sessao revogada: a autenticacao recusa antes de qualquer operacao.
        self.send("token-admin", "criar equipe marketing")
        revoked = dict(USERS_BY_TOKEN)
        revoked.pop("token-admin")
        with patch.dict(USERS_BY_TOKEN, revoked, clear=True):
            payload, status = self.send("token-admin", "confirmar")
        self.assertEqual(status, 401, payload)
        self.assertEqual(self.claims(), 0)
        self.assertEqual(self.op()["status"], "pending")
        self.assert_no_writes()


class FailClosedTests(SharedConfirmationTestCase):
    def test_27_flag_off_no_new_confirmation_no_claim_and_pending_is_discarded(self):
        self.prepare_status()
        os.environ.pop(WRITES_ENABLED_ENV, None)
        payload, status = self.send("token-user", "confirmar")
        self.assertEqual((status, payload["reply_text"]), (403, WRITES_DISABLED_REPLY))
        self.assertEqual(self.op()["status"], "cancelled")
        payload, status = self.send("token-user", STATUS_PHRASE)
        self.assertEqual(status, 403, payload)
        self.assertEqual(len(self.ops.ops), 1)
        payload, status = self.send("token-user", "minhas tarefas")
        self.assertTrue(payload["action_executed"])
        os.environ[WRITES_ENABLED_ENV] = "true"
        self.send("token-user", "confirmar")  # religada: a pendente antiga nao volta
        self.assertEqual((self.claims(), self.ops.calls.count("create")), (0, 1))
        self.assert_no_writes()

    def test_28_missing_internal_secret_blocks_writes_without_fallback(self):
        with patch.dict(os.environ, {"ASSISTANT_OPERATIONS_SECRET": ""}):
            # O mesmo segredo protege o contexto da conversa: ele e o primeiro a faltar (nada local no lugar).
            payload, status = self.send("token-user", STATUS_PHRASE)
            self.assertEqual((status, payload["reply_text"]), (503, CONTEXT_UNAVAILABLE_REPLY))
            self.assertFalse(payload["action_executed"])
            payload, _status = self.send("token-user", "confirmar")
            self.assertFalse(payload["action_executed"])
            payload, _status = self.send("token-user", "minhas tarefas")
            self.assertTrue(payload["action_executed"])
        self.assertNotEqual((self.pending("token-user") or {}).get("mode"), "write_confirmation")  # sem fallback local
        self.assertEqual(self.ops.ops, [])
        self.assert_no_writes()

    def test_29_old_local_confirmation_state_never_executes(self):
        store = ScopedConversationState(ConversationStateRepository(), USERS_BY_TOKEN["token-user"]["_id"])
        store.save(CONVERSATION_ID, {
            "mode": "write_confirmation", "command": "update_status", "conversation_id": CONVERSATION_ID,
            "params": {"task_id": RELATORIO, "status": "concluido"}, "owner_id": USERS_BY_TOKEN["token-user"]["_id"],
            "operation_id": "local", "expires_at": time.time() + 60})
        payload, _status = self.send("token-user", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assertEqual(payload["conversation"]["status"], "cancelled")
        self.assertIsNone(store.get(CONVERSATION_ID))
        self.assertEqual(self.claims(), 0)
        self.assert_no_writes()

    def test_30_no_private_data_in_logs_or_browser_response(self):
        claim_tokens = []
        original = self.ops.claim

        def spy_claim(*args):
            claim = original(*args)
            claim_tokens.append(claim["claimToken"])
            return claim

        output = io.StringIO()
        with patch.object(self.ops, "claim", spy_claim), redirect_stdout(output):
            first = self.prepare_status()
            self.write_raises(APIError("Timeout", kind="timeout", may_have_executed=True))
            second, _ = self.send("token-user", "confirmar")
            third, _ = self.send("token-user", "confirmar")
        secrets = [self.op()["idempotencyKey"], TEST_OPERATIONS_SECRET, "token-user", *claim_tokens]
        for payload in (first, second, third):
            text = json.dumps(payload, ensure_ascii=False)
            for secret in secrets:
                self.assertNotIn(secret, text)
        for secret in secrets:
            self.assertNotIn(secret, output.getvalue())

    def test_31_write_timeout_is_bounded_by_the_lease_not_by_the_browser(self):
        self.prepare_status()
        self.send_body("token-user", content="confirmar", timeout_sec=600)
        self.assertEqual(self.api.timeouts, [WRITE_TIMEOUT_CAP_SEC])
        # Lease curto: o timeout encolhe para caber antes do fim do lease, com reserva para registrar o desfecho.
        self.ops.lease = 60
        self.prepare_status()
        self.send_body("token-user", content="confirmar", timeout_sec=600)
        self.assertLessEqual(self.api.timeouts[-1], 60 - COMPLETE_RESERVE_SEC)
        # Sem folga: nada e enviado e a operacao fica para recuperacao.
        self.ops.lease = COMPLETE_RESERVE_SEC + 2
        self.prepare_status()
        writes_before = len(self.api.writes())
        payload, status = self.send("token-user", "confirmar")
        self.assertEqual(status, 503, payload)
        self.assertIn("Nada foi enviado", payload["reply_text"])
        self.assertEqual(len(self.api.writes()), writes_before)
        self.assertEqual(self.op()["status"], "retry_pending")

    def test_32_read_commands_are_unchanged_and_never_touch_claims(self):
        for token, phrase, key in (("token-user", "meu perfil", "me"), ("token-user", "minhas tarefas", "my_tasks"),
                                   ("token-admin", "listar equipes", "list_teams")):
            with self.subTest(phrase=phrase):
                payload, status = self.send(token, phrase)
                self.assertEqual(status, 200, payload)
                self.assertEqual(payload["command"]["key"], key)
                self.assertTrue(payload["action_executed"])
        self.assertEqual(set(self.ops.calls), {"current"})
        self.assert_no_writes()

    def test_delete_stays_blocked_with_shared_confirmations(self):
        payload, _status = self.send("token-admin", "excluir tarefa relatório final")
        self.assertEqual(payload["error"], "command_disabled")
        self.assertEqual(self.ops.ops, [])
        self.assertNotIn("DELETE", [call[0] for call in self.api.calls])


class ParamsFingerprintTests(SharedConfirmationTestCase):
    """Ajuste 1: resposta perdida no create so reutiliza a operacao com exatamente os mesmos params."""

    # Vetor de referencia, o mesmo de assistantOperationService.test.js (pontos de codigo, sem escapes no fonte):
    # aspas, acentos, quebra de linha, barra invertida, controles, DEL, U+2028, simbolo e emoji.
    VECTOR_CODES = (82, 101, 118, 34, 110, 250, 109, 34, 10, 224, 109, 227, 32, 92, 32, 111, 107, 1, 31, 127, 32,
                    0x2028, 32, 0x2713, 32, 0x1F600)
    VECTOR_HASH = "67e7a379e9a71251cc564c4cee1cb4686c202ac63a4ae98cdbfa44aed47e5e13"

    def lose_create_storing(self, **changes):
        """O create e aplicado, mas a operacao gravada difere (params/prazo) e a resposta se perde."""
        original = self.ops.create

        def create(token, conv, command_key, params, summary):
            original(token, conv, command_key, params, summary)
            op = self.ops.ops[-1]
            for name, value in changes.items():
                op[name] = value(op) if callable(value) else value
            raise lost()

        return patch.object(self.ops, "create", create)

    def test_fingerprint_matches_the_node_reference_vector(self):
        from flowly_assistant.operations_client import params_fingerprint

        texto = "".join(chr(code) for code in self.VECTOR_CODES)
        params = {"texto": texto, "task_id": "1" * 24}
        self.assertEqual(params_fingerprint("add_comment", params), self.VECTOR_HASH)
        self.assertEqual(params_fingerprint("add_comment", dict(reversed(list(params.items())))), self.VECTOR_HASH)
        self.assertNotEqual(params_fingerprint("add_subtask", params), self.VECTOR_HASH)
        self.assertNotEqual(params_fingerprint("add_comment", {**params, "texto": texto + " "}), self.VECTOR_HASH)
        self.assertEqual(params_fingerprint("add_comment", {**params, "user": None}), self.VECTOR_HASH)
        for bad in ({"texto": 1}, {"texto": "ok " + chr(0xD83D)}, ["texto"], None):
            with self.subTest(bad=bad):
                self.assertIsNone(params_fingerprint("add_comment", bad))

    def test_same_command_and_summary_with_different_params_is_not_reused(self):
        # Mesmo comando e mesmo resumo (o resumo cita o nome, nao o ID): so a impressao digital diferencia.
        with self.lose_create_storing(params=lambda op: {**op["params"], "task_id": TASKS[1]["_id"]}):
            payload, status = self.send("token-user", STATUS_PHRASE)
        op = self.op()
        self.assertEqual(op["commandKey"], "update_status")
        self.assertEqual((status, payload["error"]), (409, "confirmation_mismatch"), payload)
        self.assertNotIn("Confirme a operação", payload["reply_text"])
        self.assertNotEqual(payload["conversation"].get("operation_id"), op["operationId"])
        self.assertEqual(op["status"], "pending")  # nao cancelada automaticamente
        self.assertEqual((len(self.ops.ops), self.ops.calls.count("create")), (1, 1))  # nao criou outra
        self.assertEqual((self.ops.calls.count("cancel"), self.claims()), (0, 0))
        self.send("token-user", "cancelar")  # so o cancelamento explicito a encerra
        self.assertEqual(op["status"], "cancelled")
        self.assert_no_writes()

    def test_two_operations_same_command_and_summary_have_different_fingerprints(self):
        self.prepare_status()
        first = self.ops.current("token-user", CONVERSATION_ID)
        self.send("token-user", "cancelar")
        self.ops.create("token-user", CONVERSATION_ID, "update_status",
                        {"task_id": TASKS[1]["_id"], "status": "concluido"}, first["summary"])
        second = self.ops.current("token-user", CONVERSATION_ID)
        self.assertEqual((first["commandKey"], first["summary"]), (second["commandKey"], second["summary"]))
        self.assertNotEqual(first["paramsFingerprint"], second["paramsFingerprint"])

    def test_missing_malformed_fingerprint_or_incompatible_deadline_is_not_reused(self):
        cases = {
            "sem impressao": {"params": lambda op: {**op["params"], "status": 7}},  # o falso nao calcula -> None
            "prazo longo demais": {"expiresAt": lambda op: op["createdAt"] + 601},
            "prazo invertido": {"expiresAt": lambda op: op["createdAt"] - 1, "recoverUntil": lambda op: op["createdAt"] + 999},
        }
        for name, changes in cases.items():
            with self.subTest(case=name):
                cancels = self.ops.calls.count("cancel")
                with self.lose_create_storing(**changes):
                    payload, status = self.send("token-user", STATUS_PHRASE)
                self.assertFalse(payload["action_executed"])
                self.assertNotEqual(payload["conversation"]["status"], "awaiting_confirmation", payload)
                self.assertGreaterEqual(status, 400)
                self.assertEqual(self.ops.calls.count("cancel"), cancels)  # a recusa nao mexe no estado
                self.send("token-user", "cancelar")
        self.assertEqual(self.claims(), 0)
        self.assert_no_writes()

    def test_lost_create_finding_another_pending_operation_keeps_it_intact(self):
        # A: pendente, com parametros proprios, criada por outra instancia entre o inicio desta mensagem e o
        # create de B. A API recusa B (conversa ocupada) e essa resposta se perde; o current encontra A.
        original = self.ops.create
        a_params = {"task_id": TASKS[1]["_id"], "status": "concluido"}
        summary = self.agent_summary()

        def other_instance_then_lost(token, conv, command_key, params, b_summary):
            self.assertEqual(b_summary, summary)  # mesmo comando e mesmo resumo de A
            original(token, conv, "update_status", a_params, summary)  # A
            try:
                original(token, conv, command_key, params, b_summary)  # B: 409 conversation_busy
            except APIError as exc:
                self.assertEqual(exc.code, "conversation_busy")
            raise lost()

        with patch.object(self.ops, "create", other_instance_then_lost):
            payload, status = self.send("token-user", STATUS_PHRASE)
        a = self.op()
        snapshot = dict(a)
        self.assertEqual(len(self.ops.ops), 1)  # B nao foi criada
        b_fingerprint = params_fingerprint("update_status", {"task_id": RELATORIO, "status": "concluido"})
        self.assertNotEqual(self.ops.public(a)["paramsFingerprint"], b_fingerprint)
        self.assertEqual((status, payload["error"], payload["conversation"]["status"]),
                         (409, "confirmation_mismatch", "conflict"), payload)
        self.assertIn("já existe outra confirmação pendente", payload["reply_text"])
        self.assertIn('"cancelar"', payload["reply_text"])
        self.assertNotIn(summary, payload["reply_text"])  # nao reapresenta A como se fosse B
        self.assertNotEqual(payload["conversation"].get("operation_id"), a["operationId"])
        # A intacta: mesmo status, params, chave, prazo; nenhuma transicao, claim ou escrita.
        self.assertEqual(a, snapshot)
        self.assertEqual((a["status"], a["params"], a["attempts"]), ("pending", a_params, 0))
        self.assertEqual((self.ops.calls.count("cancel"), self.claims()), (0, 0))
        self.assert_no_writes()
        # So o cancelamento explicito da pessoa encerra A (fluxo de cancelamento de sempre).
        payload, _status = self.send("token-user", "cancelar")
        self.assertEqual(payload["conversation"]["status"], "cancelled")
        self.assertEqual(a["status"], "cancelled")
        self.assertEqual(a["expiresAt"], snapshot["expiresAt"])
        self.assert_no_writes()

    def agent_summary(self):
        """Resumo que o assistente monta para STATUS_PHRASE (o mesmo para A e B)."""
        self.prepare_status()
        summary = self.op()["summary"]
        self.send("token-user", "cancelar")
        self.ops.ops.clear()
        self.ops.calls.clear()
        return summary

    def test_fingerprint_never_reaches_the_browser(self):
        payload = self.prepare_status()
        fingerprint = self.ops.current("token-user", CONVERSATION_ID)["paramsFingerprint"]
        confirmed, _status = self.send("token-user", "confirmar")
        for response in (payload, confirmed):
            text = json.dumps(response, ensure_ascii=False)
            self.assertNotIn(fingerprint, text)
            self.assertNotIn("paramsFingerprint", text)


class ProfileCancelTests(SharedConfirmationTestCase):
    """Ajuste 2: perfil desconhecido ou sem permissao so e "cancelado" quando a API confirma."""

    def no_profile(self):
        from flowly_assistant.assistant_core.rest_assistant import RestAssistant

        return patch.object(RestAssistant, "_detect_user_type", return_value=None)

    def test_unknown_profile_with_confirmed_cancel(self):
        self.prepare_status()
        with self.no_profile():
            payload, status = self.send("token-user", "confirmar")
        self.assertEqual((status, payload["error"], payload["conversation"]["status"]),
                         (403, "user_type_unknown", "cancelled"))
        self.assertEqual(payload["cancellation"], "confirmed")
        self.assertEqual(self.op()["status"], "cancelled")
        self.send("token-user", "confirmar")  # perfil de volta: a operacao consumida nao executa
        self.assertEqual(self.claims(), 0)
        self.assert_no_writes()

    def test_unknown_profile_with_lost_cancel_response_is_unverified(self):
        for hook in ("lose_response", "fail_before"):
            with self.subTest(hook=hook):
                self.prepare_status()
                getattr(self.ops, hook)["cancel"] = lost()
                with self.no_profile():
                    payload, status = self.send("token-user", "confirmar")
                self.assertEqual((status, payload["error"]), (403, "user_type_unknown"))
                self.assertEqual(payload["conversation"]["status"], "cancel_unverified")
                self.assertEqual(payload["cancellation"], "unverified")
                self.assertNotIn("cancelei", payload["reply_text"].lower())
                self.assertIn("Não consegui confirmar o cancelamento", payload["reply_text"])
                self.assertFalse(payload["action_executed"])
                self.assertNotEqual((self.pending("token-user") or {}).get("mode"), "task_selection")
                self.send("token-user", "cancelar")
        self.assertEqual(self.claims(), 0)
        self.assert_no_writes()

    def test_permission_denied_with_failed_cancel_is_unverified_and_never_executes(self):
        self.send("token-admin", "criar equipe marketing")
        self.ops.fail_before["cancel"] = APIError("HTTP 503", kind="http", status_code=503, code="unavailable",
                                                  may_have_executed=True)
        demoted = {**USERS_BY_TOKEN, "token-admin": {**USERS_BY_TOKEN["token-admin"], "tipo": "user"}}
        with patch.dict(USERS_BY_TOKEN, demoted):
            payload, status = self.send("token-admin", "confirmar")
        self.assertEqual((status, payload["error"], payload["conversation"]["status"]),
                         (403, "forbidden", "cancel_unverified"))
        self.assertEqual(self.op()["status"], "pending")  # o cancelamento nao entrou; nada foi afirmado
        store = ScopedConversationState(ConversationStateRepository(), USERS_BY_TOKEN["token-admin"]["_id"])
        self.assertIsNone(store.get(CONVERSATION_ID))  # nenhum estado local que permita executar depois
        self.assertEqual(self.claims(), 0)
        self.assert_no_writes()

    def test_already_cancelled_counts_as_confirmed(self):
        self.prepare_status()
        self.ops.fail_before["cancel"] = APIError("HTTP 409", kind="http", status_code=409, code="operation_cancelled",
                                                  operation={"status": "cancelled"})
        with self.no_profile():
            payload, _status = self.send("token-user", "confirmar")
        self.assertEqual(payload["cancellation"], "confirmed")
        self.assert_no_writes()


class ClaimMetadataTests(SharedConfirmationTestCase):
    """Ajuste 3: claim incompleto, malformado ou incoerente nao executa nem presume lease."""

    def tamper_claim(self, change):
        original = self.ops.claim

        def claim(token, conv, op_id):
            data = original(token, conv, op_id)
            change(data)
            return data

        return patch.object(self.ops, "claim", claim)

    def assert_nothing_sent(self, payload, status):
        self.assertEqual((status, payload["error"]), (503, "claim_invalid"), payload)
        self.assertFalse(payload["action_executed"])
        self.assertIn("Nada foi enviado", payload["reply_text"])
        self.assert_no_writes()
        self.assertEqual(self.api.keys, [])

    def test_invalid_lease_is_never_assumed(self):
        cases = {
            "sem leaseUntil": lambda c: c.pop("leaseUntil"),
            "sem updatedAt": lambda c: c.pop("updatedAt"),
            "leaseUntil malformado": lambda c: c.update(leaseUntil="amanha"),
            "leaseUntil sem fuso": lambda c: c.update(leaseUntil=c["leaseUntil"].replace("Z", "")),
            "leaseUntil numerico": lambda c: c.update(leaseUntil=1767225600),
            "lease nulo": lambda c: c.update(leaseUntil=c["updatedAt"]),
            "lease negativo": lambda c: c.update(leaseUntil="2000-01-01T00:00:00.000Z"),
        }
        for name, change in cases.items():
            with self.subTest(case=name):
                self.prepare_status()
                with self.tamper_claim(change):
                    payload, status = self.send("token-user", "confirmar")
                self.assert_nothing_sent(payload, status)
                self.assertEqual(self.op()["status"], "retry_pending")  # token valido: registra recuperavel
                self.ops.ops[-1]["status"] = "cancelled"  # libera a conversa para o proximo caso

    def test_incomplete_or_inconsistent_claim_is_not_executed(self):
        cases = {
            "sem params": lambda c: c.pop("params"),
            "params com campo a mais": lambda c: c["params"].update(extra="x"),
            "params sem obrigatorio": lambda c: c["params"].pop("status"),
            "params ajustados": lambda c: c["params"].update(status=" concluido"),
            "params nao dict": lambda c: c.update(params=[["status", "concluido"]]),
            "sem idempotencyKey": lambda c: c.pop("idempotencyKey"),
            "idempotencyKey malformada": lambda c: c.update(idempotencyKey="chave"),
            "outro comando": lambda c: c.update(commandKey="add_comment"),
            "outra operacao": lambda c: c.update(operationId="0" * 8 + "-0000-4000-8000-" + "0" * 12),
            "outra conversa": lambda c: c.update(conversationId="outra"),
            "status errado": lambda c: c.update(status="pending"),
        }
        for name, change in cases.items():
            with self.subTest(case=name):
                self.prepare_status()
                with self.tamper_claim(change):
                    payload, status = self.send("token-user", "confirmar")
                self.assert_nothing_sent(payload, status)
                self.assertEqual(self.op()["status"], "retry_pending")
                self.ops.ops[-1]["status"] = "cancelled"

    def test_without_a_valid_claim_token_nothing_is_recorded(self):
        for name, change in {"sem claimToken": lambda c: c.pop("claimToken"),
                             "claimToken malformado": lambda c: c.update(claimToken="x")}.items():
            with self.subTest(case=name):
                self.prepare_status()
                retries = self.ops.calls.count("retry") + self.ops.calls.count("complete")
                with self.tamper_claim(change):
                    payload, status = self.send("token-user", "confirmar")
                self.assert_nothing_sent(payload, status)
                self.assertEqual(self.ops.calls.count("retry") + self.ops.calls.count("complete"), retries)
                self.assertEqual(self.op()["status"], "executing")  # o lease vence e a recuperacao segue possivel
                self.ops.ops[-1]["status"] = "cancelled"

    def test_lease_longer_than_the_default_is_capped(self):
        self.ops.lease = 600
        self.prepare_status()
        self.send("token-user", "confirmar")
        self.assertEqual(self.api.timeouts, [WRITE_TIMEOUT_CAP_SEC])
        self.assertEqual(self.api.writes(), [STATUS_WRITE])


if __name__ == "__main__":
    unittest.main()
