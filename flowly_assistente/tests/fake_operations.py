"""Servidor falso das confirmacoes compartilhadas (/api/assistant/operations), em memoria. Nenhuma rede.

Imita o contrato da API (services/assistantOperationService.js + rotas): dono pelo JWT (token), conversa, estados,
prazo de confirmacao, claim atomico com lease e no maximo 3 claims, a MESMA idempotencyKey na recuperacao, e
recusas com status/code e a operacao publica. Substitui o OperationsClient dentro do MessageAgent.

Ganchos para os testes:
  fail_before[metodo] = excecao  -> a chamada falha antes de chegar ao servidor (nada muda);
  lose_response[metodo] = excecao -> o servidor aplica a mudanca e a resposta se perde (timeout/5xx);
  offset                          -> avanca o relogio do servidor (segundos).
"""

import os
import time
import uuid
from datetime import datetime, timezone

from flowly_assistant.api_client import APIError
from flowly_assistant.commands import WRITES_DISABLED_REPLY, assistant_writes_enabled
from flowly_assistant.operations_client import (
    MIN_SECRET_LENGTH,
    NOT_CONFIGURED_REPLY,
    OPERATIONS_SECRET_ENV,
    params_fingerprint,
)

ACTIVE = ("pending", "executing", "retry_pending")
TERMINAL_CODES = {"completed": "operation_completed", "failed": "operation_failed", "cancelled": "operation_cancelled",
                  "expired": "operation_expired", "unknown": "operation_unknown"}
PUBLIC = ("operationId", "conversationId", "commandKey", "summary", "status", "attempts", "expiresAt", "recoverUntil",
          "result", "createdAt", "updatedAt", "paramsFingerprint")


def lost(kind="timeout"):
    """Excecao igual a do OperationsClient quando a resposta se perde (o servidor pode ter aplicado)."""
    if kind == "http500":
        return APIError("HTTP 500 nas operações do assistente: internal_error", kind="http", status_code=500,
                        code="internal_error", may_have_executed=True)
    return APIError("Timeout ao chamar as operações do assistente.", kind=kind, may_have_executed=True)


class FakeOperationsServer:
    def __init__(self, users_by_token):
        self.users_by_token = users_by_token
        self.ops = []
        self.calls = []
        self.offset = 0.0
        self.confirm_ttl, self.recovery, self.lease, self.max_claims = 120, 600, 180, 3
        self.fail_before = {}
        self.lose_response = {}

    # --- utilitarios ----------------------------------------------------------------------------------------
    def now(self):
        return time.time() + self.offset

    @staticmethod
    def iso(t):
        return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def public(self, op):
        view = {
            "operationId": op["operationId"], "conversationId": op["conversationId"], "commandKey": op["commandKey"],
            "summary": op["summary"], "status": op["status"], "attempts": op["attempts"],
            "expiresAt": self.iso(op["expiresAt"]), "recoverUntil": self.iso(op["recoverUntil"]),
            "result": dict(op["result"]) if op.get("result") else None,
            "createdAt": self.iso(op["createdAt"]), "updatedAt": self.iso(op["updatedAt"]),
            # Como a API: impressao digital dos params gravados, nunca os params (a equivalencia Node x Python e
            # conferida pelo vetor de referencia em test_shared_confirmations / assistantOperationService.test).
            "paramsFingerprint": params_fingerprint(op["commandKey"], op["params"]),
        }
        return view

    def refuse(self, status, code, op=None, retry_after=None):
        return APIError(f"HTTP {status} nas operações do assistente: {code}", kind="http", status_code=status, code=code,
                        retry_after=retry_after, operation=self.public(op) if op else None)

    def owner(self, token):
        user = self.users_by_token.get(token)
        if not user:
            raise APIError("HTTP 401 nas operações do assistente: erro", kind="http", status_code=401)
        return user["_id"]

    def active(self, owner, conv):
        return next((o for o in self.ops if o["ownerId"] == owner and o["conversationId"] == conv and o["status"] in ACTIVE), None)

    def find(self, owner, conv, op_id):
        return next((o for o in self.ops if o["ownerId"] == owner and o["conversationId"] == conv and o["operationId"] == op_id), None)

    def settle(self, owner, conv):
        t = self.now()
        for op in self.ops:
            if op["ownerId"] != owner or op["conversationId"] != conv:
                continue
            if op["status"] == "pending" and t >= op["expiresAt"]:
                op.update(status="expired", updatedAt=t)
            sem_lease = op["status"] == "retry_pending" or (op["status"] == "executing" and t >= op["leaseUntil"])
            if sem_lease and t >= op["recoverUntil"]:
                op.update(status="unknown", updatedAt=t, result={"code": "recovery_window_elapsed"})
            elif sem_lease and op["attempts"] >= self.max_claims:
                op.update(status="unknown", updatedAt=t, result={"code": "attempts_exhausted"})

    def dispatch(self, name, token, apply):
        self.calls.append(name)
        if len(str(os.getenv(OPERATIONS_SECRET_ENV) or "").strip()) < MIN_SECRET_LENGTH:
            raise APIError(NOT_CONFIGURED_REPLY, kind="not_configured", code="assistant_operations_not_configured")
        if name in self.fail_before:
            raise self.fail_before.pop(name)
        result = apply(self.owner(token))
        if name in self.lose_response:
            raise self.lose_response.pop(name)
        return result

    # --- contrato ---------------------------------------------------------------------------------------------
    def create(self, token, conv, command_key, params, summary):
        def apply(owner):
            self.settle(owner, conv)
            current = self.active(owner, conv)
            if current:
                raise self.refuse(409, "conversation_busy", current)
            t = self.now()
            op = {"operationId": str(uuid.uuid4()), "ownerId": owner, "conversationId": conv, "commandKey": command_key,
                  "params": dict(params), "summary": summary, "idempotencyKey": str(uuid.uuid4()), "status": "pending",
                  "attempts": 0, "claimToken": None, "leaseUntil": 0, "result": None, "createdAt": t, "updatedAt": t,
                  "expiresAt": t + self.confirm_ttl, "recoverUntil": t + self.confirm_ttl + self.recovery}
            self.ops.append(op)
            return self.public(op)
        return self.dispatch("create", token, apply)

    def current(self, token, conv):
        def apply(owner):
            self.settle(owner, conv)
            mine = [o for o in self.ops if o["ownerId"] == owner and o["conversationId"] == conv]
            return self.public(mine[-1]) if mine else None
        return self.dispatch("current", token, apply)

    def result(self, token, conv, op_id):
        def apply(owner):
            self.settle(owner, conv)
            op = self.find(owner, conv, op_id)
            if not op:
                raise self.refuse(404, "operation_not_found")
            if op["status"] in ACTIVE:
                raise self.refuse(409, "operation_not_terminal", op, 2)
            return self.public(op)
        return self.dispatch("result", token, apply)

    def claim(self, token, conv, op_id):
        def apply(owner):
            t = self.now()
            op = self.find(owner, conv, op_id)
            if not op:
                raise self.refuse(404, "operation_not_found")
            disponivel = op["attempts"] < self.max_claims and (
                (op["status"] == "pending" and t < op["expiresAt"])
                or (op["status"] == "executing" and t >= op["leaseUntil"] and t < op["recoverUntil"])
                or (op["status"] == "retry_pending" and t < op["recoverUntil"]))
            if disponivel:
                recovery = op["attempts"] > 0
                op.update(status="executing", claimToken=str(uuid.uuid4()), leaseUntil=t + self.lease,
                          attempts=op["attempts"] + 1, updatedAt=t)
                return {**self.public(op), "params": dict(op["params"]), "idempotencyKey": op["idempotencyKey"],
                        "claimToken": op["claimToken"], "leaseUntil": self.iso(op["leaseUntil"]), "recovery": recovery}
            self.settle(owner, conv)
            if op["status"] in TERMINAL_CODES:
                raise self.refuse(410 if op["status"] == "expired" else 409, TERMINAL_CODES[op["status"]], op)
            if op["status"] == "executing" and t < op["leaseUntil"]:
                raise self.refuse(409, "operation_in_progress", op, 5)
            raise self.refuse(409, "operation_state_changed", op, 1)
        return self.dispatch("claim", token, apply)

    def _holder(self, owner, conv, op_id, claim_token):
        op = self.find(owner, conv, op_id)
        if not op:
            raise self.refuse(404, "operation_not_found")
        if op["status"] != "executing" or op["claimToken"] != claim_token or self.now() >= op["leaseUntil"]:
            raise self.refuse(409, "claim_lost", op)
        return op

    def complete(self, token, conv, op_id, claim_token, outcome, result=None):
        def apply(owner):
            op = self._holder(owner, conv, op_id, claim_token)
            op.update(status=outcome, claimToken=None, leaseUntil=0, updatedAt=self.now(), result=result or op.get("result"))
            return self.public(op)
        return self.dispatch("complete", token, apply)

    def retry(self, token, conv, op_id, claim_token, result=None):
        def apply(owner):
            op = self._holder(owner, conv, op_id, claim_token)
            t = self.now()
            if op["attempts"] >= self.max_claims:
                op.update(status="unknown", result={**(result or {}), "code": "attempts_exhausted"})
            elif t >= op["recoverUntil"]:
                op.update(status="unknown", result={**(result or {}), "code": "recovery_window_elapsed"})
            else:
                op.update(status="retry_pending", result=result or op.get("result"))
            op.update(claimToken=None, leaseUntil=0, updatedAt=t)
            return self.public(op)
        return self.dispatch("retry", token, apply)

    def cancel(self, token, conv, op_id):
        def apply(owner):
            op = self.find(owner, conv, op_id)
            if not op:
                raise self.refuse(404, "operation_not_found")
            if op["status"] == "pending" and self.now() < op["expiresAt"]:
                op.update(status="cancelled", updatedAt=self.now())
                return self.public(op)
            self.settle(owner, conv)
            if op["status"] in ACTIVE:
                raise self.refuse(409, "operation_in_progress", op, 5)
            raise self.refuse(410 if op["status"] == "expired" else 409, TERMINAL_CODES[op["status"]], op)
        return self.dispatch("cancel", token, apply)


class FakeOperationsClient:
    """Mesma interface publica do OperationsClient, falando com FakeOperationsClient.server."""

    server = None

    def __init__(self, token, *, timeout_sec=10.0):
        self.token = token
        self.timeout_sec = timeout_sec

    def create(self, *, conversation_id, command_key, params, summary):
        if not assistant_writes_enabled():
            raise APIError(WRITES_DISABLED_REPLY, kind="writes_disabled")
        return self.server.create(self.token, conversation_id, command_key, params, summary)

    def current(self, *, conversation_id):
        return self.server.current(self.token, conversation_id)

    def result(self, *, operation_id, conversation_id):
        return self.server.result(self.token, conversation_id, operation_id)

    def claim(self, *, operation_id, conversation_id):
        if not assistant_writes_enabled():
            raise APIError(WRITES_DISABLED_REPLY, kind="writes_disabled")
        return self.server.claim(self.token, conversation_id, operation_id)

    def complete(self, *, operation_id, conversation_id, claim_token, outcome, result=None):
        return self.server.complete(self.token, conversation_id, operation_id, claim_token, outcome, result)

    def retry(self, *, operation_id, conversation_id, claim_token, result=None):
        return self.server.retry(self.token, conversation_id, operation_id, claim_token, result)

    def cancel(self, *, operation_id, conversation_id):
        return self.server.cancel(self.token, conversation_id, operation_id)
