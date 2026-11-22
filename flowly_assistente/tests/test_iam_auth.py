"""Autenticacao IAM opcional (Cloud Run privado): X-Serverless-Authorization ao lado do JWT do usuario.

HTTP simulado no nivel de requests.request e google-auth simulado em sys.modules (nenhum metadata server, nenhuma
rede, nenhuma credencial real). Opt-in so com FLOWLY_API_IAM_ENABLED=true; desligado, nada muda.
"""

import base64
import contextlib
import io
import json
import os
import sys
import time
import types
import unittest
from unittest.mock import patch

from test_operations_client import CLAIM, CONV, KEY, OP_ID, PUBLIC_OP, SECRET, TASK_ID, FakeHttp, FakeResponse
from flowly_assistant import api_client, iam_auth, operations_client  # noqa: E402
from flowly_assistant.api_client import APIError, FlowlyAPIClient  # noqa: E402
from flowly_assistant.conversation_client import ConversationStateClient  # noqa: E402
from flowly_assistant.iam_auth import IAM_HEADER  # noqa: E402
from flowly_assistant.operations_client import OPERATIONS_SECRET_HEADER, OperationsClient  # noqa: E402

AUDIENCE = "https://flowly-api-homolog-646126851973.southamerica-east1.run.app"
API_BASE = f"{AUDIENCE}/api"
USER_JWT = "jwt-do-usuario-de-teste"
CREDENTIAL_DETAIL = "detalhe-sigiloso-da-credencial"


def make_id_token(exp_offset=3600, marker="a"):
    """ID token de teste (formato JWT; a assinatura nao e conferida aqui, so o exp para o cache)."""
    encode = lambda data: base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")  # noqa: E731
    return f"{encode({'alg': 'RS256'})}.{encode({'aud': AUDIENCE, 'exp': int(time.time() + exp_offset)})}.sig-{marker}"


class FakeGoogleAuth:
    """google.auth.transport.requests.Request + google.oauth2.id_token.fetch_id_token simulados."""

    def __init__(self, tokens=None, error=None):
        self.tokens = list(tokens or [make_id_token()])
        self.error = error
        self.audiences = []

    def fetch_id_token(self, request, audience):
        self.audiences.append(audience)
        if self.error:
            raise self.error
        return self.tokens.pop(0) if len(self.tokens) > 1 else self.tokens[0]

    def modules(self):
        google, auth, transport = (types.ModuleType(n) for n in ("google", "google.auth", "google.auth.transport"))
        treq, oauth2, idt = (types.ModuleType(n) for n in ("google.auth.transport.requests", "google.oauth2",
                                                           "google.oauth2.id_token"))
        treq.Request = type("Request", (), {})
        idt.fetch_id_token = self.fetch_id_token
        google.auth, google.oauth2 = auth, oauth2
        auth.transport, transport.requests, oauth2.id_token = transport, treq, idt
        return {"google": google, "google.auth": auth, "google.auth.transport": transport,
                "google.auth.transport.requests": treq, "google.oauth2": oauth2, "google.oauth2.id_token": idt}


class IAMTestCase(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "FLOWLY_API_BASE_URL": API_BASE, "ASSISTANT_OPERATIONS_SECRET": SECRET,
            "FLOWLY_ASSISTANT_WRITES_ENABLED": "true",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        for name in ("FLOWLY_API_IAM_ENABLED", "FLOWLY_API_IAM_AUDIENCE"):
            os.environ.pop(name, None)
        iam_auth.clear_cache()
        self.addCleanup(iam_auth.clear_cache)
        self.http = FakeHttp()
        for module in (api_client, operations_client):
            target = patch.object(module.requests, "request", self.http)
            target.start()
            self.addCleanup(target.stop)
        self.google = FakeGoogleAuth()
        target = patch.dict(sys.modules, self.google.modules())
        target.start()
        self.addCleanup(target.stop)

    def enable(self, audience=AUDIENCE):
        os.environ["FLOWLY_API_IAM_ENABLED"] = "true"
        os.environ["FLOWLY_API_IAM_AUDIENCE"] = audience

    def api(self, **kwargs):
        return FlowlyAPIClient(base_url=API_BASE, token=USER_JWT, **kwargs)

    def assert_refused_before_network(self, call):
        with self.assertRaises(APIError) as caught:
            call()
        self.assertEqual((caught.exception.kind, caught.exception.code), ("not_configured", "api_iam_unavailable"))
        self.assertFalse(caught.exception.may_have_executed)  # nada saiu: nao ha duvida sobre a escrita
        self.assertEqual(self.http.calls, [])
        return caught.exception


class OptInTests(IAMTestCase):
    def test_disabled_by_default_and_for_any_value_other_than_true(self):
        for value in (None, "", "false", "0", "1", "yes", "on", "verdadeiro"):
            with self.subTest(value=value):
                if value is None:
                    os.environ.pop("FLOWLY_API_IAM_ENABLED", None)
                else:
                    os.environ["FLOWLY_API_IAM_ENABLED"] = value
                os.environ["FLOWLY_API_IAM_AUDIENCE"] = AUDIENCE
                self.http.push(FakeResponse(200, {"_id": "a" * 24}))
                self.api().me()
                call = self.http.calls[-1]
                self.assertNotIn(IAM_HEADER, call["headers"])
                self.assertEqual(call["headers"]["Authorization"], f"Bearer {USER_JWT}")
                self.assertNotIn("allow_redirects", call)  # leitura sem chave: comportamento de antes
        self.assertEqual(self.google.audiences, [])  # google-auth nem e chamado

    def test_disabled_ignores_a_missing_or_invalid_audience(self):
        os.environ["FLOWLY_API_IAM_AUDIENCE"] = "http://invalido/api"
        self.http.push(FakeResponse(200, {"ok": True, "operation": None}))
        self.assertIsNone(OperationsClient(USER_JWT).current(conversation_id=CONV))
        self.assertNotIn(IAM_HEADER, self.http.calls[0]["headers"])

    def test_true_is_case_insensitive_and_trimmed(self):
        self.enable()
        os.environ["FLOWLY_API_IAM_ENABLED"] = " TRUE "
        self.http.push(FakeResponse(200, {"_id": "a" * 24}))
        self.api().me()
        self.assertIn(IAM_HEADER, self.http.calls[0]["headers"])


class BothHeadersTests(IAMTestCase):
    def test_public_api_read_and_keyed_write_carry_both_headers(self):
        self.enable()
        token = self.google.tokens[0]
        self.http.push(FakeResponse(200, {"_id": "a" * 24}), FakeResponse(200, {"ok": True}))
        client = self.api()
        client.me()
        client.update_status(TASK_ID, "concluido", idempotency_key=KEY)
        for call in self.http.calls:
            self.assertEqual(call["headers"]["Authorization"], f"Bearer {USER_JWT}")  # usuario continua no JWT
            self.assertEqual(call["headers"][IAM_HEADER], f"Bearer {token}")
            self.assertIs(call["allow_redirects"], False)
        self.assertEqual(self.http.calls[1]["headers"]["Idempotency-Key"], KEY)
        self.assertEqual(self.http.calls[0]["url"], f"{API_BASE}/users/me")
        self.assertEqual(self.google.audiences, [AUDIENCE])  # audience sem /api

    def test_internal_routes_keep_the_secret_and_add_the_id_token(self):
        self.enable()
        token = self.google.tokens[0]
        self.http.push(FakeResponse(200, {"ok": True, "operation": PUBLIC_OP}),
                       FakeResponse(200, {"ok": True, "claim": CLAIM}),
                       FakeResponse(200, {"ok": True, "context": {"conversationId": CONV, "version": 1}}))
        ops = OperationsClient(USER_JWT)
        ops.current(conversation_id=CONV)
        ops.claim(operation_id=OP_ID, conversation_id=CONV)
        ConversationStateClient(USER_JWT).save(conversation_id=CONV, expected_version=0,
                                               state={"command_key": "create_team", "params": {}, "missing": ["nome"]})
        for call in self.http.calls:
            self.assertEqual(call["headers"]["Authorization"], f"Bearer {USER_JWT}")
            self.assertEqual(call["headers"][OPERATIONS_SECRET_HEADER], SECRET)
            self.assertEqual(call["headers"][IAM_HEADER], f"Bearer {token}")
            self.assertIs(call["allow_redirects"], False)
            self.assertTrue(call["url"].startswith(f"{API_BASE}/assistant/"))

    def test_token_is_cached_and_renewed_before_it_expires(self):
        self.enable()
        self.google.tokens = [make_id_token(3600, "primeiro"), make_id_token(3600, "segundo")]
        for _ in range(3):
            self.http.push(FakeResponse(200, {"_id": "a" * 24}))
            self.api().me()
        self.assertEqual(len(self.google.audiences), 1)
        with patch.object(iam_auth.time, "time", return_value=time.time() + 3600 - iam_auth.REFRESH_MARGIN_SEC + 1):
            self.http.push(FakeResponse(200, {"_id": "a" * 24}))
            self.api().me()
        self.assertEqual(len(self.google.audiences), 2)
        self.assertTrue(self.http.calls[-1]["headers"][IAM_HEADER].endswith("sig-segundo"))

    def test_token_without_a_readable_expiry_is_not_reused(self):
        self.enable()
        self.google.tokens = ["aaa.bbb.ccc"]
        for _ in range(2):
            self.http.push(FakeResponse(200, {"_id": "a" * 24}))
            self.api().me()
        self.assertEqual(len(self.google.audiences), 2)


class FailClosedTests(IAMTestCase):
    def test_missing_or_invalid_audience_sends_nothing(self):
        for audience in ("", "http://flowly-api-homolog.run.app", f"{AUDIENCE}/api", f"{AUDIENCE}?x=1",
                         "https://usuario:senha@flowly-api-homolog.run.app", "nao-e-url"):
            with self.subTest(audience=audience):
                self.enable(audience)
                self.assert_refused_before_network(lambda: self.api().me())
                self.assert_refused_before_network(lambda: OperationsClient(USER_JWT).current(conversation_id=CONV))

    def test_destination_other_than_the_audience_is_refused(self):
        self.enable("https://outro-servico-646126851973.southamerica-east1.run.app")
        self.assert_refused_before_network(lambda: self.api().me())
        self.assert_refused_before_network(lambda: ConversationStateClient(USER_JWT).current(conversation_id=CONV))
        self.assertEqual(self.google.audiences, [])  # nem pede token para um destino errado

    def test_token_failure_sends_nothing_and_hides_the_detail(self):
        self.enable()
        self.google.error = RuntimeError(f"falha de metadata {CREDENTIAL_DETAIL}")
        error = self.assert_refused_before_network(
            lambda: self.api().update_status(TASK_ID, "concluido", idempotency_key=KEY))
        self.assertNotIn(CREDENTIAL_DETAIL, str(error))
        self.assertIsNone(error.__cause__)
        self.assert_refused_before_network(lambda: OperationsClient(USER_JWT).claim(operation_id=OP_ID, conversation_id=CONV))

    def test_missing_library_or_malformed_token_sends_nothing(self):
        self.enable()
        with patch.dict(sys.modules, {name: None for name in self.google.modules()}):
            self.assert_refused_before_network(lambda: self.api().me())
        iam_auth.clear_cache()
        self.google.tokens = ["sem-formato-de-jwt"]
        self.assert_refused_before_network(lambda: self.api().me())

    def test_redirect_is_never_followed_with_the_id_token(self):
        self.enable()
        self.http.push(FakeResponse(302, None, headers={"Location": "https://outro.example/captura"}))
        with self.assertRaises(APIError) as caught:
            self.api().me()
        self.assertEqual(caught.exception.kind, "redirect")
        self.assertFalse(caught.exception.may_have_executed)  # leitura
        self.assertEqual(len(self.http.calls), 1)
        self.assertIs(self.http.calls[0]["allow_redirects"], False)

    def test_tokens_never_appear_in_debug_output_or_errors(self):
        self.enable()
        token = self.google.tokens[0]
        output = io.StringIO()
        self.http.push(FakeResponse(200, {"_id": "a" * 24}), FakeResponse(500, {"erro": "falhou"}))
        with contextlib.redirect_stdout(output):
            client = self.api(debug=True)
            client.me()
            with self.assertRaises(APIError) as caught:
                client.update_status(TASK_ID, "concluido", idempotency_key=KEY)
        for secret in (token, USER_JWT, SECRET, KEY):
            self.assertNotIn(secret, output.getvalue())
            self.assertNotIn(secret, str(caught.exception))
        self.assertNotIn(token, repr(client))


if __name__ == "__main__":
    unittest.main()
