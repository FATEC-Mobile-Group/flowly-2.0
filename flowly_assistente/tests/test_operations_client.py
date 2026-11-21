"""Camada HTTP das confirmacoes compartilhadas (OperationsClient) e Idempotency-Key no FlowlyAPIClient.

HTTP simulado no nivel de requests.request (registra metodo, URL, cabecalhos, corpo, timeout e redirecionamento):
nenhuma conexao real, nenhum MongoDB, nenhum Cloud Run. O MessageAgent nao e usado aqui.
"""

import contextlib
import io
import os
import unittest
from unittest.mock import patch

import requests
from requests.structures import CaseInsensitiveDict

from flowly_assistant import api_client, operations_client
from flowly_assistant.api_client import APIError, FlowlyAPIClient
from flowly_assistant.operations_client import (
    OPERATIONS_SECRET_HEADER,
    OperationsClient,
)

BASE = "https://api.flowly.test/api"
SECRET = "Zx9_" + "k" * 40  # 44 caracteres (tamanho de 32 bytes em base64), so para teste
TOKEN = "jwt-do-usuario-de-teste"
CONV = "voice-aaaa-1732100000000"
OP_ID = "3f1c2b6e-8a4d-4c1b-9e2f-7a6b5c4d3e2f"
KEY = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a"
CLAIM_TOKEN = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"
TASK_ID = "c" * 24
INVALID_JSON = object()

PUBLIC_OP = {
    "operationId": OP_ID, "conversationId": CONV, "commandKey": "update_status", "summary": "mudar o status",
    "status": "pending", "attempts": 0, "expiresAt": "2026-11-21T12:02:00.000Z",
    "recoverUntil": "2026-11-21T12:12:00.000Z", "result": None,
    "createdAt": "2026-11-21T12:00:00.000Z", "updatedAt": "2026-11-21T12:00:00.000Z",
}
CLAIM = {**PUBLIC_OP, "status": "executing", "attempts": 1, "leaseUntil": "2026-11-21T12:03:00.000Z",
         "recovery": False, "params": {"task_id": TASK_ID, "status": "concluido"},
         "idempotencyKey": KEY, "claimToken": CLAIM_TOKEN}


class FakeResponse:
    def __init__(self, status_code, body=None, headers=None, text=""):
        self.status_code = status_code
        self._body = body
        self.headers = CaseInsensitiveDict({"content-type": "application/json", **(headers or {})})
        self.text = text

    def json(self):
        if self._body is INVALID_JSON:
            raise ValueError("corpo ilegivel")
        return self._body


class FakeHttp:
    """Substitui requests.request: registra cada chamada e devolve a resposta programada (ou levanta)."""

    def __init__(self):
        self.calls = []
        self.responses = []

    def push(self, *responses):
        self.responses.extend(responses)

    def __call__(self, method, url, headers=None, params=None, json=None, timeout=None, **kwargs):
        self.calls.append({"method": method, "url": url, "headers": dict(headers or {}), "params": params,
                           "json": json, "timeout": timeout, **kwargs})
        if not self.responses:
            raise AssertionError(f"chamada inesperada: {method} {url}")
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def env(**values):
    base = {"FLOWLY_API_BASE_URL": BASE, "ASSISTANT_OPERATIONS_SECRET": SECRET,
            "FLOWLY_ASSISTANT_WRITES_ENABLED": "true"}
    base.update(values)
    return patch.dict(os.environ, {k: v for k, v in base.items() if v is not None}, clear=False)


class BaseCase(unittest.TestCase):
    def setUp(self):
        self.http = FakeHttp()
        # Mesmo modulo requests nos dois clientes: um unico ponto de rede, sempre simulado.
        patcher = patch.object(requests, "request", self.http)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.assertIs(api_client.requests, requests)
        self.assertIs(operations_client.requests, requests)
        for name in ("ASSISTANT_OPERATIONS_SECRET", "FLOWLY_ASSISTANT_WRITES_ENABLED", "FLOWLY_API_URL"):
            os.environ.pop(name, None)  # cada teste define o proprio ambiente
        e = env()
        e.start()
        self.addCleanup(e.stop)

    def ops(self, token=TOKEN):
        return OperationsClient(token)


class CredentialTests(BaseCase):
    def test_01_02_secret_missing_or_short_fails_closed_without_network(self):
        for value in (None, "", "   ", "x" * 42):
            with self.subTest(secret=value), env(ASSISTANT_OPERATIONS_SECRET=value):
                if value is None:
                    os.environ.pop("ASSISTANT_OPERATIONS_SECRET", None)
                for call in (lambda: self.ops().create(conversation_id=CONV, command_key="update_status",
                                                       params={"task_id": TASK_ID, "status": "concluido"}, summary="s"),
                             lambda: self.ops().current(conversation_id=CONV),
                             lambda: self.ops().cancel(operation_id=OP_ID, conversation_id=CONV)):
                    with self.assertRaises(APIError) as ctx:
                        call()
                    self.assertEqual((ctx.exception.kind, ctx.exception.code),
                                     ("not_configured", "assistant_operations_not_configured"))
        self.assertEqual(self.http.calls, [])

    def test_03_06_headers_url_redirects_and_timeout(self):
        self.http.push(FakeResponse(200, {"ok": True, "operation": None}))
        self.assertIsNone(self.ops().current(conversation_id=CONV))
        [call] = self.http.calls
        self.assertEqual(call["method"], "GET")
        self.assertEqual(call["url"], f"{BASE}/assistant/operations/current")
        self.assertEqual(call["params"], {"conversationId": CONV})
        self.assertEqual(call["headers"]["Authorization"], f"Bearer {TOKEN}")
        self.assertEqual(call["headers"][OPERATIONS_SECRET_HEADER], SECRET)
        self.assertNotIn("Idempotency-Key", call["headers"])
        self.assertIs(call["allow_redirects"], False)
        self.assertLessEqual(call["timeout"], 30)

    def test_04_secret_never_sent_to_public_endpoints(self):
        self.http.push(FakeResponse(200, {"_id": "a" * 24, "tipo": "user"}), FakeResponse(201, {"_id": "e" * 24}),
                       FakeResponse(200, {"msg": "ok"}))
        client = FlowlyAPIClient(base_url=BASE, token=TOKEN)
        client.me()
        client.create_team("Marketing", idempotency_key=KEY)
        client.update_status(TASK_ID, "concluido")
        for call in self.http.calls:
            self.assertNotIn(OPERATIONS_SECRET_HEADER.lower(), {k.lower() for k in call["headers"]})
            self.assertNotIn(SECRET, repr(call))

    def test_05_missing_jwt_fails_before_network(self):
        for token in ("", None, "   "):
            with self.subTest(token=token):
                with self.assertRaises(APIError) as ctx:
                    OperationsClient(token).current(conversation_id=CONV)
                self.assertEqual(ctx.exception.code, "missing_token")
        self.assertEqual(self.http.calls, [])

    def test_28_no_arbitrary_destination(self):
        for url in ("http://api.flowly.test/api", "https://user:pass@api.flowly.test/api",
                    "https://api.flowly.test/api?x=1", "ftp://api.flowly.test/api", "https://api.flowly.test/api#f", "nada"):
            with self.subTest(url=url), env(FLOWLY_API_BASE_URL=url):
                with self.assertRaises(APIError) as ctx:
                    self.ops().current(conversation_id=CONV)
                self.assertEqual(ctx.exception.kind, "not_configured")
                self.assertNotIn("pass", str(ctx.exception))
        with env(FLOWLY_API_BASE_URL="http://localhost:5000/api"):  # http so na maquina local
            self.http.push(FakeResponse(200, {"ok": True, "operation": None}))
            self.ops().current(conversation_id=CONV)
            self.assertTrue(self.http.calls[-1]["url"].startswith("http://localhost:5000/api/assistant/operations/"))
        # Nenhum metodo aceita URL/caminho; identificadores que mudariam o caminho sao recusados antes da rede.
        calls = len(self.http.calls)
        for bad in ("../tarefas", "x/../../users", OP_ID + "/../x", OP_ID.upper(), "https://evil.test"):
            with self.subTest(operation_id=bad):
                with self.assertRaises(APIError) as ctx:
                    self.ops().result(operation_id=bad, conversation_id=CONV)
                self.assertEqual(ctx.exception.kind, "invalid_request")
        for conv in ("a?b=1", "../x", "", "x" * 121, {"$ne": None}):
            with self.subTest(conversation_id=conv):
                with self.assertRaises(APIError):
                    self.ops().current(conversation_id=conv)
        self.assertEqual(len(self.http.calls), calls)
        # O pedido do usuario nao escolhe destino: o construtor nao recebe URL.
        with self.assertRaises(TypeError):
            OperationsClient(TOKEN, base_url="https://evil.test")  # type: ignore[call-arg]


class ContractTests(BaseCase):
    def test_07_create(self):
        self.http.push(FakeResponse(201, {"ok": True, "operation": PUBLIC_OP}))
        operation = self.ops().create(conversation_id=CONV, command_key="update_status",
                                      params={"task_id": TASK_ID, "status": "concluido"}, summary="mudar o status")
        self.assertEqual(operation, PUBLIC_OP)
        [call] = self.http.calls
        self.assertEqual((call["method"], call["url"]), ("POST", f"{BASE}/assistant/operations"))
        self.assertEqual(call["json"], {"conversationId": CONV, "commandKey": "update_status",
                                        "params": {"task_id": TASK_ID, "status": "concluido"}, "summary": "mudar o status"})

    def test_07b_create_validates_locally(self):
        for kwargs in ({"command_key": "delete_task"}, {"params": {"task_id": 1}}, {"params": []}, {"summary": "  "}):
            args = {"conversation_id": CONV, "command_key": "update_status",
                    "params": {"task_id": TASK_ID, "status": "concluido"}, "summary": "s", **kwargs}
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(APIError) as ctx:
                    self.ops().create(**args)
                self.assertEqual(ctx.exception.kind, "invalid_request")
        self.assertEqual(self.http.calls, [])

    def test_08_current_and_result(self):
        terminal = {**PUBLIC_OP, "status": "completed", "result": {"httpStatus": 200}}
        self.http.push(FakeResponse(200, {"ok": True, "operation": PUBLIC_OP}),
                       FakeResponse(200, {"ok": True, "operation": terminal}),
                       FakeResponse(409, {"ok": False, "code": "operation_not_terminal", "operation": PUBLIC_OP}, {"Retry-After": "2"}))
        self.assertEqual(self.ops().current(conversation_id=CONV), PUBLIC_OP)
        self.assertEqual(self.ops().result(operation_id=OP_ID, conversation_id=CONV), terminal)
        with self.assertRaises(APIError) as ctx:
            self.ops().result(operation_id=OP_ID, conversation_id=CONV)
        self.assertEqual((ctx.exception.status_code, ctx.exception.code, ctx.exception.retry_after), (409, "operation_not_terminal", 2))
        self.assertEqual(self.http.calls[1]["url"], f"{BASE}/assistant/operations/{OP_ID}/result")
        self.assertEqual(self.http.calls[1]["params"], {"conversationId": CONV})

    def test_09_claim_returns_private_view(self):
        self.http.push(FakeResponse(200, {"ok": True, "claim": CLAIM}))
        claim = self.ops().claim(operation_id=OP_ID, conversation_id=CONV)
        self.assertEqual((claim["idempotencyKey"], claim["claimToken"], claim["params"]), (KEY, CLAIM_TOKEN, CLAIM["params"]))
        self.assertEqual(self.http.calls[0]["url"], f"{BASE}/assistant/operations/{OP_ID}/claim")
        self.assertEqual(self.http.calls[0]["json"], {"conversationId": CONV})

    def test_10_claim_in_progress(self):
        executing = {**PUBLIC_OP, "status": "executing", "attempts": 1}
        self.http.push(FakeResponse(409, {"ok": False, "code": "operation_in_progress", "operation": executing}, {"Retry-After": "5"}))
        with self.assertRaises(APIError) as ctx:
            self.ops().claim(operation_id=OP_ID, conversation_id=CONV)
        error = ctx.exception
        self.assertEqual((error.category, error.retry_after, error.operation), ("in_progress", 5, executing))
        self.assertFalse(error.may_have_executed)

    def test_11_complete(self):
        done = {**PUBLIC_OP, "status": "completed", "result": {"httpStatus": 200, "replayed": True}}
        self.http.push(FakeResponse(200, {"ok": True, "operation": done}))
        result = self.ops().complete(operation_id=OP_ID, conversation_id=CONV, claim_token=CLAIM_TOKEN,
                                     outcome="completed", result={"httpStatus": 200, "replayed": True})
        self.assertEqual(result, done)
        self.assertEqual(self.http.calls[0]["json"], {"conversationId": CONV, "claimToken": CLAIM_TOKEN,
                                                      "outcome": "completed", "result": {"httpStatus": 200, "replayed": True}})
        for bad in ({"outcome": "retry"}, {"claim_token": "x"}, {"result": "texto"}):
            args = {"operation_id": OP_ID, "conversation_id": CONV, "claim_token": CLAIM_TOKEN, "outcome": "completed", **bad}
            with self.subTest(bad=bad), self.assertRaises(APIError):
                self.ops().complete(**args)
        self.assertEqual(len(self.http.calls), 1)

    def test_12_cancel(self):
        cancelled = {**PUBLIC_OP, "status": "cancelled"}
        self.http.push(FakeResponse(200, {"ok": True, "operation": cancelled}),
                       FakeResponse(409, {"ok": False, "code": "operation_in_progress", "operation": PUBLIC_OP}, {"Retry-After": "5"}))
        self.assertEqual(self.ops().cancel(operation_id=OP_ID, conversation_id=CONV), cancelled)
        with self.assertRaises(APIError) as ctx:
            self.ops().cancel(operation_id=OP_ID, conversation_id=CONV)
        self.assertEqual(ctx.exception.category, "in_progress")
        self.assertEqual(self.http.calls[0]["url"], f"{BASE}/assistant/operations/{OP_ID}/cancel")

    def test_13_retry_keeps_same_operation(self):
        pending = {**PUBLIC_OP, "status": "retry_pending", "attempts": 1, "result": {"code": "network_error"}}
        self.http.push(FakeResponse(200, {"ok": True, "operation": pending}))
        self.assertEqual(self.ops().retry(operation_id=OP_ID, conversation_id=CONV, claim_token=CLAIM_TOKEN,
                                          result={"code": "network_error"}), pending)
        [call] = self.http.calls
        self.assertEqual(call["url"], f"{BASE}/assistant/operations/{OP_ID}/retry")
        self.assertEqual(call["json"], {"conversationId": CONV, "claimToken": CLAIM_TOKEN, "result": {"code": "network_error"}})

    def test_14_unknown_is_never_success(self):
        unknown = {**PUBLIC_OP, "status": "unknown", "result": {"code": "attempts_exhausted"}}
        self.http.push(FakeResponse(409, {"ok": False, "code": "operation_unknown", "operation": unknown}))
        with self.assertRaises(APIError) as ctx:
            self.ops().claim(operation_id=OP_ID, conversation_id=CONV)
        self.assertEqual((ctx.exception.category, ctx.exception.operation["status"]), ("outcome_unknown", "unknown"))
        # Na escrita publica, o nucleo de idempotencia tambem pode responder 409 de resultado desconhecido.
        self.http.push(FakeResponse(409, {"erro": "Não foi possível confirmar se o status foi atualizado.", "code": "idempotency_outcome_unknown"}))
        with self.assertRaises(APIError) as ctx:
            FlowlyAPIClient(base_url=BASE, token=TOKEN).update_status(TASK_ID, "concluido", idempotency_key=KEY)
        self.assertEqual(ctx.exception.category, "outcome_unknown")

    def test_15_expired(self):
        self.http.push(FakeResponse(410, {"ok": False, "code": "operation_expired", "operation": {**PUBLIC_OP, "status": "expired"}}))
        with self.assertRaises(APIError) as ctx:
            self.ops().claim(operation_id=OP_ID, conversation_id=CONV)
        self.assertEqual((ctx.exception.status_code, ctx.exception.category), (410, "expired"))

    def test_invalid_success_body_is_not_success(self):
        for response in (FakeResponse(200, {"ok": False}), FakeResponse(200, {"ok": True}), FakeResponse(200, INVALID_JSON),
                         FakeResponse(200, ["lista"])):
            self.http.push(response)
            with self.subTest(body=response._body), self.assertRaises(APIError) as ctx:
                self.ops().claim(operation_id=OP_ID, conversation_id=CONV)
            self.assertEqual(ctx.exception.kind, "invalid_response")
            self.assertTrue(ctx.exception.may_have_executed)  # o claim pode ter entrado

    def test_redirect_is_not_followed(self):
        self.http.push(FakeResponse(307, None, {"Location": "https://evil.test/steal"}))
        with self.assertRaises(APIError) as ctx:
            self.ops().cancel(operation_id=OP_ID, conversation_id=CONV)
        self.assertEqual(ctx.exception.kind, "redirect")
        self.assertEqual(len(self.http.calls), 1)


class ErrorTests(BaseCase):
    def test_16_17_timeout_and_network_never_mean_nothing_changed(self):
        cases = ((requests.Timeout("lento"), "timeout"), (requests.ConnectionError("recusada https://api.flowly.test"), "network"))
        for exc, kind in cases:
            with self.subTest(kind=kind):
                self.http.push(exc)
                with self.assertRaises(APIError) as ctx:
                    self.ops().claim(operation_id=OP_ID, conversation_id=CONV)
                self.assertEqual((ctx.exception.kind, ctx.exception.may_have_executed, ctx.exception.category),
                                 (kind, True, "outcome_uncertain"))
                self.assertNotIn("nada foi alterado", str(ctx.exception).lower())
                self.http.push(exc)
                with self.assertRaises(APIError) as ctx:
                    self.ops().current(conversation_id=CONV)
                self.assertFalse(ctx.exception.may_have_executed)  # leitura
                # Escrita publica: mesma regra e a mensagem de sempre.
                self.http.push(exc)
                with self.assertRaises(APIError) as ctx:
                    FlowlyAPIClient(base_url=BASE, token=TOKEN).timer(TASK_ID, "pausar", idempotency_key=KEY)
                self.assertTrue(ctx.exception.may_have_executed)
                expected = "Timeout ao chamar PUT" if kind == "timeout" else "Erro de rede ao chamar PUT"
                self.assertTrue(str(ctx.exception).startswith(expected))

    def test_18_status_categories(self):
        cases = [
            (400, {"ok": False, "code": "params_invalid"}, "invalid_input"),
            (401, {"ok": False, "code": "assistant_secret_invalid"}, "unauthenticated"),
            (403, {"erro": "Você não pode editar essa tarefa"}, "forbidden"),
            (404, {"ok": False, "code": "operation_not_found"}, "not_found"),
            (409, {"ok": False, "code": "conversation_busy", "operation": PUBLIC_OP}, "conflict"),
            (409, {"ok": False, "code": "claim_lost", "operation": PUBLIC_OP}, "claim_lost"),
            (409, {"ok": False, "code": "operation_in_progress"}, "in_progress"),
            (409, {"erro": "em andamento", "code": "idempotency_in_progress"}, "in_progress"),
            (409, {"ok": False, "code": "operation_unknown"}, "outcome_unknown"),
            (409, {"ok": False, "code": "operation_completed"}, "conflict"),
            (410, {"ok": False, "code": "operation_expired"}, "expired"),
            (422, {"erro": "chave usada", "code": "idempotency_key_reused"}, "key_reused"),
            (500, {"ok": False, "code": "internal_error"}, "server_error"),
            (503, {"ok": False, "code": "operation_indexes_missing"}, "unavailable"),
            (503, {"ok": False, "code": "assistant_operations_not_configured"}, "unavailable"),
        ]
        for status, body, category in cases:
            with self.subTest(status=status, code=body.get("code")):
                self.http.push(FakeResponse(status, body))
                with self.assertRaises(APIError) as ctx:
                    self.ops().cancel(operation_id=OP_ID, conversation_id=CONV)
                self.assertEqual((ctx.exception.status_code, ctx.exception.category), (status, category))
                # Recusa 4xx: nada aconteceu. 5xx numa transicao: incerto (pode ter gravado antes de falhar).
                self.assertEqual(ctx.exception.may_have_executed, status >= 500)
                if body.get("operation"):
                    self.assertEqual(ctx.exception.operation, body["operation"])

    def test_5xx_on_writes_keeps_uncertainty_for_recovery(self):
        client = FlowlyAPIClient(base_url=BASE, token=TOKEN)
        for status, body in ((500, {"erro": "Erro ao atualizar status"}), (502, INVALID_JSON), (503, {"erro": "indisponivel", "code": "transactions_unavailable"}),
                             (504, INVALID_JSON)):
            with self.subTest(status=status):
                self.http.push(FakeResponse(status, body, text="gateway"))
                with self.assertRaises(APIError) as ctx:
                    client.update_status(TASK_ID, "concluido", idempotency_key=KEY)
                # Pode ter sido confirmada antes da falha (ou por tras do gateway): nunca "nada mudou".
                self.assertTrue(ctx.exception.may_have_executed)
                self.assertNotIn("nada foi alterado", str(ctx.exception).lower())
        # Leitura com 5xx nao executa nada.
        self.http.push(FakeResponse(500, {"erro": "falhou"}))
        with self.assertRaises(APIError) as ctx:
            client.my_tasks()
        self.assertFalse(ctx.exception.may_have_executed)

    def test_public_write_200_with_invalid_body_or_redirect_keeps_uncertainty(self):
        client = FlowlyAPIClient(base_url=BASE, token=TOKEN)
        self.http.push(FakeResponse(200, INVALID_JSON), FakeResponse(308, None, {"Location": "https://evil.test/x"}))
        with self.assertRaises(APIError) as ctx:
            client.add_comment(TASK_ID, "oi", idempotency_key=KEY)
        self.assertEqual((ctx.exception.kind, ctx.exception.may_have_executed), ("invalid_response", True))
        with self.assertRaises(APIError) as ctx:
            client.add_comment(TASK_ID, "oi", idempotency_key=KEY)
        self.assertEqual((ctx.exception.kind, ctx.exception.may_have_executed), ("redirect", True))
        self.assertEqual(len(self.http.calls), 2)  # o redirecionamento nao foi seguido
        self.assertTrue(all(c["allow_redirects"] is False for c in self.http.calls))

    def test_19_20_retry_after_and_replayed_are_preserved(self):
        self.http.push(FakeResponse(503, {"erro": "Serviço temporariamente indisponível.", "code": "transactions_unavailable"}, {"Retry-After": "2"}))
        client = FlowlyAPIClient(base_url=BASE, token=TOKEN)
        with self.assertRaises(APIError) as ctx:
            client.update_status(TASK_ID, "concluido", idempotency_key=KEY)
        self.assertEqual((ctx.exception.retry_after, ctx.exception.code, ctx.exception.category), (2, "transactions_unavailable", "unavailable"))
        self.http.push(FakeResponse(200, {"msg": "Status atualizado com sucesso"}, {"Idempotency-Replayed": "true"}))
        data = client.update_status(TASK_ID, "concluido", idempotency_key=KEY)
        self.assertEqual(data, {"msg": "Status atualizado com sucesso"})  # retorno de sempre
        self.assertTrue(client.last_response.replayed)
        self.assertEqual(client.last_response.status_code, 200)
        self.http.push(FakeResponse(403, {"erro": "Sem acesso"}, {"Idempotency-Replayed": "true"}))
        with self.assertRaises(APIError) as ctx:
            client.update_status(TASK_ID, "concluido", idempotency_key=KEY)
        self.assertTrue(ctx.exception.replayed)
        self.http.push(FakeResponse(200, {"msg": "ok"}))
        client.update_status(TASK_ID, "concluido", idempotency_key=KEY)
        self.assertFalse(client.last_response.replayed)


class IdempotencyKeyTests(BaseCase):
    def seven(self, client, key):
        return [
            ("POST", "/equipes", lambda: client.create_team("Marketing", idempotency_key=key)),
            ("POST", "/tarefas", lambda: client.create_task(descricao="R", equipe="e" * 24, dataEntrega="2026-12-01", urgencia="alta", idempotency_key=key)),
            ("POST", f"/tarefas/{TASK_ID}/comentarios", lambda: client.add_comment(TASK_ID, "oi", idempotency_key=key)),
            ("POST", f"/tarefas/{TASK_ID}/subtarefas", lambda: client.add_subtask(TASK_ID, "x", idempotency_key=key)),
            ("PUT", f"/tarefas/{TASK_ID}/atribuir-para-mim", lambda: client.assign_to_me(TASK_ID, idempotency_key=key)),
            ("PUT", f"/tarefas/{TASK_ID}/status", lambda: client.update_status(TASK_ID, "concluido", idempotency_key=key)),
            ("PUT", f"/tarefas/{TASK_ID}/cronometro", lambda: client.timer(TASK_ID, "iniciar", idempotency_key=key)),
        ]

    def test_21_key_sent_on_the_seven_protected_writes(self):
        client = FlowlyAPIClient(base_url=BASE, token=TOKEN)
        for method, path, call in self.seven(client, KEY):
            with self.subTest(path=path):
                self.http.push(FakeResponse(200, {"ok": True}))
                call()
                sent = self.http.calls[-1]
                self.assertEqual((sent["method"], sent["url"]), (method, f"{BASE}{path}"))
                self.assertEqual(sent["headers"]["Idempotency-Key"], KEY)
                self.assertIs(sent["allow_redirects"], False)
                self.assertNotIn(OPERATIONS_SECRET_HEADER, sent["headers"])

    def test_22_same_key_after_a_failure_and_never_generated_by_the_client(self):
        client = FlowlyAPIClient(base_url=BASE, token=TOKEN)
        self.http.push(requests.Timeout("lento"), FakeResponse(200, {"msg": "ok"}, {"Idempotency-Replayed": "true"}))
        with self.assertRaises(APIError) as ctx:
            client.update_status(TASK_ID, "concluido", idempotency_key=KEY)
        self.assertTrue(ctx.exception.may_have_executed)
        client.update_status(TASK_ID, "concluido", idempotency_key=KEY)  # quem repete passa a MESMA chave
        self.assertEqual([c["headers"]["Idempotency-Key"] for c in self.http.calls], [KEY, KEY])
        self.assertTrue(client.last_response.replayed)
        # Sem chave informada, o cliente nao inventa uma.
        self.http.push(FakeResponse(200, {"msg": "ok"}))
        client.update_status(TASK_ID, "concluido")
        self.assertNotIn("Idempotency-Key", self.http.calls[-1]["headers"])

    def test_23_never_on_get_and_invalid_keys_refused(self):
        client = FlowlyAPIClient(base_url=BASE, token=TOKEN)
        with self.assertRaises(APIError) as ctx:
            client.request("GET", "/tarefas/minhas", idempotency_key=KEY)
        self.assertEqual(ctx.exception.kind, "invalid_request")
        for bad in ("nao-e-uuid", KEY.upper(), KEY + " ", 123):
            with self.subTest(key=bad), self.assertRaises(APIError) as ctx:
                client.update_status(TASK_ID, "concluido", idempotency_key=bad)
            self.assertNotIn(str(bad), str(ctx.exception))
        self.assertEqual(self.http.calls, [])
        self.http.push(FakeResponse(200, []), FakeResponse(200, {"_id": "a" * 24}))
        client.my_tasks()
        client.me()
        for call in self.http.calls:
            self.assertNotIn("Idempotency-Key", call["headers"])

    def test_24_delete_still_blocked(self):
        client = FlowlyAPIClient(base_url=BASE, token=TOKEN)
        for call in (lambda: client.delete_task(TASK_ID), lambda: client.request("DELETE", f"/tarefas/{TASK_ID}", idempotency_key=KEY)):
            with self.assertRaises(APIError) as ctx:
                call()
            self.assertEqual(ctx.exception.kind, "blocked")
        self.assertEqual(self.http.calls, [])

    def test_25b_flag_turned_off_between_two_calls_blocks_the_next_write(self):
        client = FlowlyAPIClient(base_url=BASE, token=TOKEN)
        ops = self.ops()
        self.http.push(FakeResponse(200, {"msg": "ok"}), FakeResponse(200, {"ok": True, "claim": CLAIM}))
        client.update_status(TASK_ID, "concluido", idempotency_key=KEY)
        ops.claim(operation_id=OP_ID, conversation_id=CONV)
        calls = len(self.http.calls)
        with env(FLOWLY_ASSISTANT_WRITES_ENABLED="false"):  # desligada depois, sem recriar os clientes
            for call in (lambda: client.update_status(TASK_ID, "concluido", idempotency_key=KEY),
                         lambda: ops.claim(operation_id=OP_ID, conversation_id=CONV)):
                with self.assertRaises(APIError) as ctx:
                    call()
                self.assertEqual(ctx.exception.kind, "writes_disabled")
        self.assertEqual(len(self.http.calls), calls)

    def test_25_writes_flag_off_blocks_public_writes_and_new_confirmations(self):
        with env(FLOWLY_ASSISTANT_WRITES_ENABLED="false"):
            client = FlowlyAPIClient(base_url=BASE, token=TOKEN)
            for _method, path, call in self.seven(client, KEY):
                with self.subTest(path=path), self.assertRaises(APIError) as ctx:
                    call()
                self.assertEqual(ctx.exception.kind, "writes_disabled")
            for call in (lambda: self.ops().create(conversation_id=CONV, command_key="timer",
                                                   params={"task_id": TASK_ID, "acao": "iniciar"}, summary="s"),
                         lambda: self.ops().claim(operation_id=OP_ID, conversation_id=CONV)):
                with self.assertRaises(APIError) as ctx:
                    call()
                self.assertEqual(ctx.exception.kind, "writes_disabled")
            self.assertEqual(self.http.calls, [])
            # Encerrar/consultar continua possivel (nao altera tarefas): cancelar uma confirmacao antiga.
            self.http.push(FakeResponse(200, {"ok": True, "operation": {**PUBLIC_OP, "status": "cancelled"}}))
            self.ops().cancel(operation_id=OP_ID, conversation_id=CONV)
            self.assertTrue(self.http.calls[-1]["url"].endswith(f"/assistant/operations/{OP_ID}/cancel"))


class LoggingAndCompatibilityTests(BaseCase):
    def test_26_no_secret_or_private_identifier_in_logs_or_messages(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            client = FlowlyAPIClient(base_url=BASE, token=TOKEN, debug=True)
            self.http.push(FakeResponse(200, {"msg": "ok"}), requests.Timeout("lento"))
            client.update_status(TASK_ID, "concluido", idempotency_key=KEY)
            messages = []
            with self.assertRaises(APIError) as ctx:
                client.update_status(TASK_ID, "concluido", idempotency_key=KEY)
            messages.append(str(ctx.exception))
            ops = self.ops()
            self.http.push(FakeResponse(200, {"ok": True, "claim": CLAIM}),
                           FakeResponse(409, {"ok": False, "code": "claim_lost", "operation": PUBLIC_OP}),
                           requests.ConnectionError(f"falha com {SECRET} e {TOKEN}"))
            ops.claim(operation_id=OP_ID, conversation_id=CONV)
            for call in (lambda: ops.complete(operation_id=OP_ID, conversation_id=CONV, claim_token=CLAIM_TOKEN, outcome="completed"),
                         lambda: ops.retry(operation_id=OP_ID, conversation_id=CONV, claim_token=CLAIM_TOKEN)):
                with self.assertRaises(APIError) as ctx:
                    call()
                messages.append(str(ctx.exception))
                messages.append(repr(ctx.exception.__dict__))
            messages.append(repr(ops))
        texto = out.getvalue() + "\n".join(messages)
        for sensitive in (SECRET, TOKEN, KEY, CLAIM_TOKEN):
            self.assertNotIn(sensitive, texto)

    def test_27_legacy_methods_keep_their_contracts(self):
        client = FlowlyAPIClient(base_url=BASE, token=TOKEN)
        self.http.push(FakeResponse(200, {"_id": "a" * 24, "tipo": "user"}), FakeResponse(201, {"_id": "e" * 24}))
        self.assertEqual(client.me(), {"_id": "a" * 24, "tipo": "user"})
        self.assertEqual(client.create_team("Marketing"), {"_id": "e" * 24})
        # Sem chave: chamada identica a de antes (sem Idempotency-Key, sem allow_redirects).
        for call in self.http.calls:
            self.assertEqual(set(call), {"method", "url", "headers", "params", "json", "timeout"})
            self.assertEqual(call["headers"], {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
        # Mensagens de sempre (consumidores usam str(exc)).
        self.http.push(FakeResponse(404, {"erro": "Tarefa não encontrada"}), FakeResponse(500, INVALID_JSON, text="falhou"),
                       FakeResponse(400, ["lista"]))
        for expected in ("HTTP 404 em GET /tarefas/x/detalhes: Tarefa não encontrada", "HTTP 500 em GET /tarefas/x/detalhes: falhou",
                         "HTTP 400 em GET /tarefas/x/detalhes: ['lista']"):
            with self.assertRaises(APIError) as ctx:
                client.task_details("x")
            self.assertEqual(str(ctx.exception), expected)
            self.assertIsInstance(ctx.exception, RuntimeError)
        self.http.push(FakeResponse(204, None))
        self.assertIsNone(client.request("PUT", "/tarefas/x/status", json={}))
        self.http.push(FakeResponse(200, None, {"content-type": "text/plain"}, text="texto"))
        self.assertEqual(client.request("GET", "/health"), "texto")
        # APIError antigo (so mensagem) continua valido.
        legado = APIError("mensagem")
        self.assertEqual((str(legado), legado.kind, legado.status_code, legado.category), ("mensagem", None, None, "error"))


if __name__ == "__main__":
    unittest.main()
