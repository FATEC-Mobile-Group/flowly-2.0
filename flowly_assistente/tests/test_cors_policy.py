"""Politica de CORS do servico HTTP do assistente (function.flowly_http).

FLOWLY_CORS_ORIGIN aceita uma ou mais origens explicitas separadas por virgula; a resposta devolve so a origem da
requisicao, comparada por inteiro. CORS nao autentica: as rotas continuam exigindo JWT ou segredo interno.
Sem rede: so rotas que respondem antes de qualquer chamada a API.
"""

import json
import os
import sys
import types
import unittest
from unittest.mock import patch

for _modulo, _substituto in (
    ("dotenv", types.SimpleNamespace(load_dotenv=lambda *args, **kwargs: None)),
    (
        "requests",
        types.SimpleNamespace(Timeout=TimeoutError, RequestException=RuntimeError, request=lambda *args, **kwargs: None),
    ),
):
    if _modulo not in sys.modules:
        try:
            __import__(_modulo)
        except ModuleNotFoundError:
            sys.modules[_modulo] = _substituto

import function  # noqa: E402

PROD = "https://flowly-producao.example"
PREVIEW = "https://flowly-producao-54.preview.example"
BOTH = f"{PROD},{PREVIEW}"


class FakeRequest:
    def __init__(self, method="GET", path="/health", origin=None, headers=None, body=None):
        self.method = method
        self.path = path
        self.headers = dict(headers or {})
        if origin is not None:
            self.headers["Origin"] = origin
        self._body = body or {}

    def get_json(self, silent=True):
        return self._body


def call(cors, **kwargs):
    with patch.dict(os.environ, {"FLOWLY_CORS_ORIGIN": cors}, clear=False):
        body, status, headers = function.flowly_http(FakeRequest(**kwargs))
    return (json.loads(body) if body else None), status, headers


class AllowedOriginsParsingTests(unittest.TestCase):
    def test_list_trims_spaces_and_drops_empty_wildcard_and_null_entries(self):
        self.assertEqual(function.allowed_cors_origins(f" {PROD} , ,{PREVIEW}/ ,*, null,{PROD}"), (PROD, PREVIEW))
        self.assertEqual(function.allowed_cors_origins(""), ())
        self.assertEqual(function.allowed_cors_origins(" , "), ())
        self.assertEqual(function.allowed_cors_origins("*"), ())


class CorsPolicyTests(unittest.TestCase):
    def assert_allowed(self, headers, origin):
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        self.assertEqual(headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS")
        self.assertEqual(headers["Access-Control-Allow-Headers"], "Content-Type, Authorization")
        self.assertEqual(headers["Access-Control-Max-Age"], "3600")
        self.assertIn("Origin", headers["Vary"])

    def assert_no_cors(self, headers):
        for name in ("Access-Control-Allow-Origin", "Access-Control-Allow-Methods", "Access-Control-Allow-Headers"):
            self.assertNotIn(name, headers)

    def test_single_origin_configuration_keeps_working(self):
        _body, status, headers = call(PROD, origin=PROD)
        self.assertEqual(status, 200)
        self.assert_allowed(headers, PROD)

    def test_two_origins_return_exactly_the_request_origin_never_a_list(self):
        for origin in (PROD, PREVIEW):
            with self.subTest(origin=origin):
                _body, _status, headers = call(BOTH, origin=origin)
                self.assert_allowed(headers, origin)
                self.assertNotIn(",", headers["Access-Control-Allow-Origin"])

    def test_spaces_and_empty_entries_in_the_configuration(self):
        _body, _status, headers = call(f"  {PROD} ,, {PREVIEW}  ,", origin=PREVIEW)
        self.assert_allowed(headers, PREVIEW)

    def test_unknown_similar_or_malicious_origins_are_not_allowed(self):
        for origin in (
            "https://outro-site.example",
            "https://flowly-producao.example.evil.example",
            "https://evil-flowly-producao.example",
            "http://flowly-producao.example",  # outro esquema
            "https://flowly-producao.example:8443",  # outra porta
            "https://FLOWLY-PRODUCAO.example",
            "https://flowly-producao-99.preview.example",  # outro preview
            f"{PROD}/",
            f"{PROD},{PREVIEW}",
            " ",
            "null",
            "*",
        ):
            with self.subTest(origin=origin):
                _body, status, headers = call(BOTH, origin=origin)
                self.assertEqual(status, 200)  # a rota responde; o navegador e que bloqueia sem o cabecalho
                self.assert_no_cors(headers)
                self.assertIn("Origin", headers["Vary"])

    def test_wildcard_configuration_never_allows_any_origin(self):
        _body, _status, headers = call("*", origin="https://qualquer.example")
        self.assert_no_cors(headers)

    def test_request_without_origin_is_served_without_cors_headers(self):
        body, status, headers = call(BOTH)
        self.assertEqual((status, body["ok"]), (200, True))
        self.assert_no_cors(headers)

    def test_empty_configuration_sends_no_cors_headers(self):
        _body, _status, headers = call("", origin=PROD)
        self.assert_no_cors(headers)
        self.assertNotIn("Vary", headers)

    def test_preflight_options(self):
        _body, status, headers = call(BOTH, method="OPTIONS", path="/api/v1/messages", origin=PREVIEW)
        self.assertEqual(status, 204)
        self.assert_allowed(headers, PREVIEW)
        _body, status, headers = call(BOTH, method="OPTIONS", path="/api/v1/messages", origin="https://evil.example")
        self.assertEqual(status, 204)
        self.assert_no_cors(headers)

    def test_vary_origin_is_added_once_and_keeps_existing_values(self):
        headers = {"Vary": "Accept-Encoding"}
        function._with_vary_origin(headers)
        function._with_vary_origin(headers)
        self.assertEqual(headers["Vary"], "Accept-Encoding, Origin")
        headers = {"Vary": "origin"}
        function._with_vary_origin(headers)
        self.assertEqual(headers["Vary"], "origin")

    def test_cors_on_error_responses_and_authentication_unchanged(self):
        # Sem token: continua 401, agora com o CORS da origem autorizada (o navegador consegue ler o erro).
        for method, path in (("POST", "/api/v1/messages"), ("POST", "/standby"), ("GET", "/api/v1/admin/insights"),
                             ("POST", "/assist")):
            with self.subTest(path=path):
                body, status, headers = call(BOTH, method=method, path=path, origin=PREVIEW)
                self.assertEqual((status, body["error"]), (401, "missing_token"))
                self.assert_allowed(headers, PREVIEW)
        body, status, headers = call(BOTH, method="GET", path="/inexistente", origin=PROD)
        self.assertEqual((status, body["error"]), (404, "route_not_found"))
        self.assert_allowed(headers, PROD)
        # Origem autorizada nao substitui autenticacao.
        body, status, _headers = call(BOTH, method="POST", path="/api/v1/messages", origin=PROD,
                                      body={"content": "minhas tarefas"})
        self.assertEqual(status, 401)

    def test_internal_server_to_server_call_without_origin_is_unchanged(self):
        with patch.dict(os.environ, {"UPLOAD_MODERATION_SECRET": "segredo-correto"}, clear=False):
            body, status, headers = call(BOTH, method="POST", path="/api/v1/uploads/moderate",
                                         headers={"Authorization": "Bearer segredo-correto"}, body={})
            self.assertEqual(status, 200)
            self.assertIn("allowed", body)
            self.assert_no_cors(headers)
            body, status, _headers = call(BOTH, method="POST", path="/api/v1/uploads/moderate",
                                          headers={"Authorization": "Bearer errado"}, body={})
            self.assertEqual(status, 401)
            # Origem autorizada tambem nao dispensa o segredo interno.
            body, status, _headers = call(BOTH, method="POST", path="/api/v1/uploads/moderate", origin=PROD, body={})
            self.assertEqual(status, 401)


if __name__ == "__main__":
    unittest.main()
