"""Etapa 6B: a confirmacao vale so para a operacao que a pessoa viu (operationId reenviado pela tela).

operationId ausente, malformado ou de outra operacao nunca produz claim nem escrita e nunca cancela a operacao
legitima: a operacao atual e reapresentada (resumo guardado na API + operation_id). O operationId nao substitui
autenticacao, intencao explicita, dono, conversa, prazo ou claim. Servidores simulados; rede real bloqueada.
"""

import unittest

from test_command_safety import CONVERSATION_ID, TASKS, AssistantFlowTestCase

RELATORIO = TASKS[0]["_id"]
STATUS_PHRASE = "mudar status da tarefa relatório final para concluído"
STATUS_WRITE = ("PUT", f"/tarefas/{RELATORIO}/status", {"status": "concluido"})
OTHER_UUID = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"


class ConfirmationBindingTests(AssistantFlowTestCase):
    def prepare(self):
        payload, status = self.send("token-user", STATUS_PHRASE)
        self.assertEqual((status, payload["conversation"]["status"]), (200, "awaiting_confirmation"), payload)
        return payload["conversation"]

    def op(self):
        return self.ops.ops[-1]

    def assert_represented(self, payload, status, error):
        self.assertEqual((status, payload["error"]), (409, error), payload)
        self.assertFalse(payload["action_executed"])
        conversation = payload["conversation"]
        self.assertEqual(conversation["status"], "awaiting_confirmation")
        self.assertEqual(conversation["operation_id"], self.op()["operationId"])
        self.assertEqual(conversation["summary"], self.op()["summary"])  # o resumo real, guardado na API
        self.assertGreater(conversation["expires_in"], 0)
        self.assertIn("Nada foi alterado", payload["reply_text"])

    def test_creation_returns_the_binding_the_screen_needs(self):
        conversation = self.prepare()
        self.assertEqual(conversation["operation_id"], self.op()["operationId"])
        self.assertEqual(conversation["summary"], self.op()["summary"])
        self.assertNotIn("idempotencyKey", str(conversation))
        self.assertNotIn(self.op()["idempotencyKey"], str(conversation))

    def test_confirmation_without_operation_id_neither_claims_nor_cancels(self):
        self.prepare()
        payload, status = self.send_raw("token-user", "confirmar")
        self.assert_represented(payload, status, "operation_id_required")
        self.assertEqual((self.op()["status"], self.ops.calls.count("claim")), ("pending", 0))
        self.assert_no_writes()

    def test_malformed_or_other_operation_id_neither_claims_nor_cancels(self):
        self.prepare()
        for bad in (OTHER_UUID, "nao-e-uuid", " ", self.op()["operationId"].upper()):
            with self.subTest(operation_id=bad):
                payload, status = self.send_raw("token-user", "confirmar", operationId=bad)
                if bad.strip():
                    self.assert_represented(payload, status, "confirmation_mismatch")
                else:
                    self.assert_represented(payload, status, "operation_id_required")
                self.assertEqual(self.op()["status"], "pending")
        self.assertEqual(self.ops.calls.count("claim"), 0)
        self.assert_no_writes()

    def test_cancel_referencing_another_operation_does_not_cancel_the_legitimate_one(self):
        self.prepare()
        payload, status = self.send_raw("token-user", "cancelar", operationId=OTHER_UUID)
        self.assert_represented(payload, status, "confirmation_mismatch")
        self.assertEqual(self.op()["status"], "pending")
        payload, _status = self.send_raw("token-user", "cancelar", operationId=self.op()["operationId"])
        self.assertEqual(payload["conversation"]["status"], "cancelled")
        self.assertEqual(self.op()["status"], "cancelled")
        self.assert_no_writes()

    def test_bound_confirmation_by_voice_or_text_executes_once(self):
        conversation = self.prepare()
        for phrase in ("confirmar", "Confirmar."):  # a voz transcrita chega como o mesmo texto
            payload, _status = self.send_raw("token-user", phrase, operationId=conversation["operation_id"])
        self.assertEqual(self.api.writes(), [STATUS_WRITE])
        self.assertEqual(self.ops.calls.count("claim"), 1)
        self.assertFalse(payload["action_executed"])  # a segunda so diz que ja foi concluida

    def test_operation_id_of_another_person_or_conversation_is_useless(self):
        conversation = self.prepare()
        payload, _status = self.send_raw("token-admin", "confirmar", operationId=conversation["operation_id"])
        self.assertFalse(payload["action_executed"])
        payload, _status = self.send_raw("token-user", "confirmar", conversation_id="outra-conversa",
                                         operationId=conversation["operation_id"])
        self.assertFalse(payload["action_executed"])
        self.assertEqual((self.op()["status"], self.ops.calls.count("claim")), ("pending", 0))
        self.assert_no_writes()

    def test_busy_conversation_shows_the_pending_operation_with_its_binding(self):
        # Outra instancia criou uma pendente entre o inicio desta mensagem e o create desta: 409 conversation_busy.
        from unittest.mock import patch

        original = self.ops.create
        other_summary = 'mudar o status da tarefa "Outra" para concluída'

        def other_instance_first(token, conv, command_key, params, summary):
            original(token, conv, "update_status", {"task_id": TASKS[1]["_id"], "status": "concluido"}, other_summary)
            return original(token, conv, command_key, params, summary)

        with patch.object(self.ops, "create", other_instance_first):
            payload, status = self.send_raw("token-user", STATUS_PHRASE)
        self.assertEqual((status, payload["error"]), (409, "conversation_busy"))
        self.assertEqual(payload["conversation"]["operation_id"], self.op()["operationId"])
        self.assertEqual(payload["conversation"]["summary"], other_summary)  # a que esta valendo, nao a pedida
        self.assertEqual(len(self.ops.ops), 1)
        self.assert_no_writes()

    def test_retry_pending_recovery_requires_the_binding(self):
        conversation = self.prepare()
        from fake_operations import lost

        state = {"left": 1}

        def timeout_once(_client, _method, _path, _kwargs):
            if state["left"]:
                state["left"] -= 1
                raise lost()
            return None

        self.api.on_write = timeout_once
        self.send_raw("token-user", "confirmar", operationId=conversation["operation_id"])
        self.assertEqual(self.op()["status"], "retry_pending")
        payload, status = self.send_raw("token-user", "confirmar")  # sem vinculo: so reapresenta
        self.assertEqual((status, payload["error"], payload["conversation"]["status"]),
                         (409, "operation_id_required", "retry_pending"))
        self.assertEqual(payload["conversation"]["operation_id"], self.op()["operationId"])
        self.assertEqual(self.ops.calls.count("claim"), 1)
        self.send_raw("token-user", "confirmar", operationId=conversation["operation_id"])  # recupera
        key = self.op()["idempotencyKey"]
        self.assertEqual(self.api.keys, [key, key])
        self.assertEqual(self.op()["status"], "completed")

    def test_selected_task_assignment_still_needs_its_explicit_flow(self):
        # Atribuicao pedida depois de selecionar e mostrar a tarefa: cria e executa na MESMA mensagem (sem
        # operationId do navegador), mas so a partir da tarefa mostrada; um numero dito agora pede confirmacao.
        self.api.backlog = []
        self.send("token-user", "minhas tarefas")
        payload, _status = self.send("token-user", "1")
        self.assertEqual(payload["conversation"]["status"], "awaiting_task_action", payload)
        payload, _status = self.send("token-user", "atribuir para mim")
        self.assertTrue(payload["action_executed"], payload)
        self.assertEqual(self.ops.calls.count("claim"), 1)
        self.assertEqual(self.op()["status"], "completed")
        # Numero + atribuir na mesma frase: nada executa sem o resumo e a confirmacao ligada a ele.
        self.send("token-user", "minhas tarefas")
        payload, _status = self.send_raw("token-user", "atribuir para mim a 2")
        self.assertFalse(payload["action_executed"])
        payload, status = self.send_raw("token-user", "confirmar")
        self.assertFalse(payload["action_executed"])
        self.assertEqual(self.ops.calls.count("claim"), 1)


if __name__ == "__main__":
    unittest.main()
