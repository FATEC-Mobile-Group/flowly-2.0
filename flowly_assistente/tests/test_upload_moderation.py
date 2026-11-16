import base64
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

# function.py importa python-dotenv e requests, que o CI nao instala neste job. Os testes nao
# fazem chamadas de rede: um substituto minimo so entra quando o pacote real nao existe.
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
from flowly_assistant.nlp.upload_moderation import (  # noqa: E402
    FILENAME_TERMS,
    PORN_COMPOUND_PREFIXES,
    PORN_COMPOUND_ROOTS,
    PORN_COMPOUND_SUFFIXES,
    TEXT_TERMS,
    moderate_upload_payload,
)

# Mesmos casos usados pela API (flowly_api/__tests__/uploadModeration.falsePositives.test.js).
CASOS = json.loads(
    (Path(__file__).resolve().parents[2] / "flowly_api" / "__tests__" / "fixtures" / "upload-moderation-cases.json").read_text(
        encoding="utf-8"
    )
)
CONTRATO = {"allowed", "categories", "reason", "provider"}


def _pdf(texto: str = "ata") -> str:
    conteudo = f"%PDF-1.4\n1 0 obj << /Length 44 >> stream\nBT ({texto}) Tj ET\nendstream endobj\n%%EOF"
    return base64.b64encode(conteudo.encode("latin1")).decode("ascii")


def _png() -> str:
    return base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x01" * 32).decode("ascii")


class FakeRequest:
    def __init__(self, body, headers=None, method="POST", path="/api/v1/uploads/moderate"):
        self.method = method
        self.path = path
        self.headers = headers or {}
        self._body = body

    def get_json(self, silent=True):
        return self._body


class UploadModerationFalsePositiveTests(unittest.TestCase):
    def test_listas_iguais_as_da_api(self):
        self.assertEqual(sorted(FILENAME_TERMS), sorted(CASOS["terms"]["filename"]))
        self.assertEqual(sorted(TEXT_TERMS), sorted(CASOS["terms"]["text"]))

    def test_compostos_iguais_aos_da_api(self):
        compostos = CASOS["terms"]["pornCompounds"]
        self.assertEqual(PORN_COMPOUND_ROOTS, compostos["roots"])
        self.assertEqual(PORN_COMPOUND_PREFIXES, compostos["prefixes"])
        self.assertEqual(PORN_COMPOUND_SUFFIXES, compostos["suffixes"])

    def test_cada_composto_bloqueia_e_vizinhos_legitimos_passam(self):
        compostos = CASOS["terms"]["pornCompounds"]
        for raiz in compostos["roots"]:
            gerados = [p + raiz for p in compostos["prefixes"]] + [raiz + s for s in compostos["suffixes"]]
            gerados += [p + raiz + s for p in compostos["prefixes"] for s in compostos["suffixes"]]
            for composto in gerados:
                with self.subTest(composto=composto):
                    self.assertFalse(moderate_upload_payload({"filename": composto + ".pdf"})["allowed"])
        for palavra in ["foodporn", "cityporn", "earthporn", "pornic", "pornichet", "pornox", "xporn", "pornvideox", "myporn"]:
            with self.subTest(legitimo=palavra):
                self.assertTrue(moderate_upload_payload({"filename": palavra + ".pdf"})["allowed"])

    def test_cada_termo_bloqueia_nome_e_texto(self):
        for termo in CASOS["terms"]["filename"]:
            with self.subTest(nome=termo):
                nome = termo.replace(" ", "-") + ".pdf"
                self.assertFalse(moderate_upload_payload({"filename": nome, "mimetype": "application/pdf"})["allowed"])
        for termo in CASOS["terms"]["text"]:
            with self.subTest(texto=termo):
                resultado = moderate_upload_payload(
                    {"filename": "doc.pdf", "mimetype": "application/pdf", "contentBase64": _pdf(f"trecho {termo} final")}
                )
                self.assertFalse(resultado["allowed"])

    def test_nomes_compartilhados_com_a_api(self):
        for caso in CASOS["filenames"]:
            with self.subTest(nome=caso["name"]):
                resultado = moderate_upload_payload(
                    {"filename": caso["name"], "mimetype": "application/pdf", "contentBase64": _pdf()}
                )
                self.assertEqual(resultado["allowed"], not caso["blocked"])
                self.assertEqual(set(resultado), CONTRATO)

    def test_textos_de_pdf_compartilhados_com_a_api(self):
        for caso in CASOS["pdfTexts"]:
            with self.subTest(texto=caso["text"]):
                resultado = moderate_upload_payload(
                    {"filename": "documento.pdf", "mimetype": "application/pdf", "contentBase64": _pdf(caso["text"])}
                )
                self.assertEqual(resultado["allowed"], not caso["blocked"])

    def test_bloqueio_mantem_o_contrato_e_a_categoria(self):
        resultado = moderate_upload_payload({"filename": "video-porno.pdf", "mimetype": "application/pdf"})

        self.assertEqual(
            resultado,
            {
                "allowed": False,
                "categories": ["offensive_content"],
                "reason": "Arquivo bloqueado pela moderacao de upload.",
                "provider": "flowly_assistant_upload_moderation",
            },
        )

    def test_imagem_legitima_e_aceita(self):
        resultado = moderate_upload_payload(
            {"filename": "Relatório Sexta-Feira.png", "mimetype": "image/png", "contentBase64": _png()}
        )

        self.assertEqual(
            resultado,
            {"allowed": True, "categories": [], "reason": "", "provider": "flowly_assistant_upload_moderation"},
        )

    def test_base64_invalido_nao_derruba(self):
        resultado = moderate_upload_payload(
            {"filename": "ata.pdf", "mimetype": "application/pdf", "contentBase64": "@@@ nao e base64 @@@"}
        )

        self.assertTrue(resultado["allowed"])

    def test_corpo_vazio_e_aceito_sem_erro(self):
        self.assertEqual(set(moderate_upload_payload({})), CONTRATO)


class UploadModerationRouteTests(unittest.TestCase):
    def _chamar(self, body, headers=None):
        texto, status, _cabecalhos = function.flowly_http(FakeRequest(body, headers))
        return json.loads(texto), status

    @patch.dict(os.environ, {"UPLOAD_MODERATION_SECRET": ""}, clear=False)
    def test_sem_segredo_configurado_falha_fechado(self):
        corpo, status = self._chamar({"filename": "ata.pdf"}, {"Authorization": "Bearer qualquer"})

        self.assertEqual(status, 503)
        self.assertFalse(corpo["allowed"])

    @patch.dict(os.environ, {"UPLOAD_MODERATION_SECRET": "segredo-correto"}, clear=False)
    def test_segredo_errado_e_recusado(self):
        corpo, status = self._chamar({"filename": "ata.pdf"}, {"Authorization": "Bearer errado"})

        self.assertEqual(status, 401)
        self.assertFalse(corpo["allowed"])

    @patch.dict(os.environ, {"UPLOAD_MODERATION_SECRET": "segredo-correto"}, clear=False)
    def test_nome_legitimo_passa_pela_rota(self):
        corpo, status = self._chamar(
            {"filename": "relatorio-sexta.pdf", "mimetype": "application/pdf", "contentBase64": _pdf("ata de sexta")},
            {"Authorization": "Bearer segredo-correto"},
        )

        self.assertEqual(status, 200)
        self.assertEqual(set(corpo), CONTRATO)
        self.assertTrue(corpo["allowed"])

    @patch.dict(os.environ, {"UPLOAD_MODERATION_SECRET": "segredo-correto"}, clear=False)
    def test_texto_proibido_continua_bloqueado_pela_rota(self):
        corpo, status = self._chamar(
            {"filename": "ata.pdf", "mimetype": "application/pdf", "contentBase64": _pdf("conteudo sexual explicito")},
            {"Authorization": "Bearer segredo-correto"},
        )

        self.assertEqual(status, 200)
        self.assertFalse(corpo["allowed"])
        self.assertEqual(corpo["categories"], ["offensive_content"])


if __name__ == "__main__":
    unittest.main()
