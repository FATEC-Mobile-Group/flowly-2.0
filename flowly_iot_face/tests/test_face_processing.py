"""Processamento facial: categoria e etapa de cada falha, status HTTP, logs seguros e autenticacao.

O DeepFace e sempre um modulo falso e nada e baixado. As imagens sao sinteticas (formas desenhadas
com OpenCV), nunca fotografias reais.
"""

import base64
import logging
import os
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import cv2
import numpy as np

os.environ.setdefault("FACE_SERVICE_SECRET", "segredo-de-teste")

import main  # noqa: E402

SECRET = "segredo-de-teste-processamento"
PHOTO_ERROR = "Não foi possível processar a foto. Tire outra imagem com o rosto bem visível e tente novamente."
NO_FACE = (
    "Não foi possível identificar um rosto na foto. "
    "Posicione-se de frente à câmera, com boa iluminação, e tente novamente."
)
MULTIPLE_FACES = "Mais de um rosto foi detectado na imagem. Certifique-se de que apenas você apareça na foto."
UNAVAILABLE = "Serviço facial indisponível no momento. Tente novamente em instantes."
INTERNAL = "Erro interno no serviço facial."
TECHNICAL_DETAIL = "detalhe-tecnico /root/.deepface/weights/vgg_face_weights.h5"

# Valores com casas decimais incomuns para detectar vazamento de embedding nos logs.
REFERENCE = [0.7311, -0.2417, 0.5523, 0.1189]
OTHER_FACE = [-0.6012, 0.4471, -0.3318, 0.2299]


def synthetic_jpeg() -> bytes:
    image = np.full((240, 320, 3), 200, dtype=np.uint8)
    cv2.rectangle(image, (40, 40), (280, 200), (90, 120, 160), -1)
    cv2.circle(image, (160, 120), 50, (30, 60, 90), -1)
    ok, encoded = cv2.imencode(".jpg", image)
    assert ok
    return encoded.tobytes()


JPEG = synthetic_jpeg()
RAW_BASE64 = base64.b64encode(JPEG).decode()
DATA_URL = "data:image/jpeg;base64," + RAW_BASE64


class FakeCascade:
    def __init__(self, faces=1, empty=False):
        self.faces = faces
        self._empty = empty

    def empty(self):
        return self._empty

    def detectMultiScale(self, *args, **kwargs):  # noqa: N802 - nome da API do OpenCV
        return [(10, 10, 60, 60)] * self.faces


class LogCapture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.lines = []

    def emit(self, record):
        self.lines.append(record.getMessage())


class FaceProcessingTestCase(unittest.TestCase):
    use_fake_cascade = True

    def setUp(self):
        self.deepface = MagicMock(name="DeepFace")
        self.deepface.represent.side_effect = self._represent
        self.probe = list(REFERENCE)
        self.received_images = []
        self.install_deepface(self._fake_module(self.deepface))

        patches = [patch.object(main, "SERVICE_SECRET", SECRET)]
        if self.use_fake_cascade:
            patches.append(patch.object(main, "get_face_cascade", return_value=FakeCascade()))
        for active in patches:
            active.start()
            self.addCleanup(active.stop)

        self.logs = LogCapture()
        main.logger.addHandler(self.logs)
        self.addCleanup(main.logger.removeHandler, self.logs)
        self.client = main.app.test_client()

    @staticmethod
    def _fake_module(deepface):
        module = types.ModuleType("deepface")
        module.DeepFace = deepface
        return module

    def install_deepface(self, module):
        active = patch.dict(sys.modules, {"deepface": module})
        active.start()
        self.addCleanup(active.stop)

    def _represent(self, img_path, **kwargs):
        with open(img_path, "rb") as handle:
            self.received_images.append(handle.read())
        return [{"embedding": self.probe, "face_confidence": 0.9}]

    def post(self, path, payload, secret=SECRET):
        headers = {} if secret is None else {"X-Flowly-Service-Secret": secret}
        return self.client.post(path, json=payload, headers=headers)

    def verify(self, image=DATA_URL, reference=None, threshold=0.5):
        reference = REFERENCE if reference is None else reference
        return self.post("/verify", {"reference_embedding": reference, "image_base64": image, "threshold": threshold})

    def assert_logged(self, category, stage):
        expected = [f"category={category}", f"stage={stage}"]
        matching = [line for line in self.logs.lines if all(item in line for item in expected)]
        self.assertTrue(matching, f"log sem {expected}: {self.logs.lines}")
        return matching[0]

    def assert_verify_failure(self, response, status, message, category, stage):
        self.assertEqual(response.status_code, status)
        self.assertEqual(response.get_json(), {"match": False, "face_detected": False, "erro": message})
        return self.assert_logged(category, stage)


class ImageInputTests(FaceProcessingTestCase):
    def test_data_url_e_base64_puro_chegam_intactos_ao_modelo(self):
        for image in (DATA_URL, RAW_BASE64):
            with self.subTest(prefixo=image.startswith("data:")):
                response = self.verify(image=image)

                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.get_json()["match"])
                self.assertEqual(self.received_images[-1], JPEG)

    def test_base64_invalido_e_erro_de_entrada_sem_chamar_o_modelo(self):
        for image in ("data:image/jpeg;base64,@@@@", "isto nao e base64!", RAW_BASE64[:-3] + "*=="):
            with self.subTest(imagem=image[:30]):
                response = self.verify(image=image)

                self.assert_verify_failure(response, 400, PHOTO_ERROR, "invalid_input", "decode")
        self.deepface.build_model.assert_not_called()
        self.deepface.represent.assert_not_called()

    def test_imagem_vazia_ou_acima_do_limite_e_erro_de_entrada(self):
        response = self.verify(image="data:image/jpeg;base64,")
        self.assert_verify_failure(response, 400, PHOTO_ERROR, "invalid_input", "decode")

        with patch.object(main, "MAX_IMAGE_BYTES", 10):
            response = self.verify(image=DATA_URL)
        self.assert_verify_failure(response, 400, PHOTO_ERROR, "invalid_input", "decode")

    def test_image_base64_que_nao_e_texto_e_erro_de_entrada(self):
        for image in ({"conteudo": "x"}, 12345, ["a"]):
            with self.subTest(tipo=type(image).__name__):
                response = self.verify(image=image)

                self.assert_verify_failure(response, 400, PHOTO_ERROR, "invalid_input", "decode")

    def test_base64_valido_que_nao_e_imagem_e_erro_de_entrada(self):
        image = base64.b64encode(b"isto nao e uma imagem JPEG").decode()

        response = self.verify(image=image)

        self.assert_verify_failure(response, 400, PHOTO_ERROR, "invalid_input", "image_read")
        self.deepface.represent.assert_not_called()


class RealOpenCvTests(FaceProcessingTestCase):
    use_fake_cascade = False

    def test_imagem_sintetica_sem_rosto_e_recusada_pelo_haar_real(self):
        response = self.verify(image=DATA_URL)

        self.assert_verify_failure(response, 400, NO_FACE, "no_face", "face_detection")
        self.deepface.build_model.assert_not_called()
        self.deepface.represent.assert_not_called()


class ModelFailureTests(FaceProcessingTestCase):
    def test_falha_ao_importar_o_deepface_e_indisponibilidade(self):
        broken = types.ModuleType("deepface")

        def missing_dependency(name):
            raise ModuleNotFoundError("No module named 'pandas'", name="pandas")

        broken.__getattr__ = missing_dependency
        self.install_deepface(broken)

        response = self.verify()

        line = self.assert_verify_failure(response, 503, UNAVAILABLE, "model_unavailable", "model_import")
        self.assertIn("error=ModuleNotFoundError", line)
        self.assertIn("module=pandas", line)

    def test_falha_ao_carregar_os_pesos_e_indisponibilidade(self):
        self.deepface.build_model.side_effect = ValueError(TECHNICAL_DETAIL)

        response = self.verify()

        line = self.assert_verify_failure(response, 503, UNAVAILABLE, "model_unavailable", "model_load")
        self.assertIn("error=ValueError", line)
        self.deepface.represent.assert_not_called()

    def test_classificador_haar_sem_arquivo_e_indisponibilidade(self):
        with patch.object(main, "get_face_cascade", return_value=FakeCascade(empty=True)):
            response = self.verify()

        self.assert_verify_failure(response, 503, UNAVAILABLE, "model_unavailable", "face_detection")

    def test_erro_inesperado_ao_gerar_o_embedding_e_erro_interno(self):
        self.deepface.represent.side_effect = RuntimeError(TECHNICAL_DETAIL)

        response = self.verify()

        line = self.assert_verify_failure(response, 500, INTERNAL, "internal_error", "embedding")
        self.assertIn("error=RuntimeError", line)

    def test_falha_de_download_registra_tipo_qualificado_da_causa(self):
        class ConnectionError(OSError):  # noqa: A001 - imita requests.exceptions.ConnectionError
            pass

        def build_model(_name):
            try:
                raise ConnectionError(TECHNICAL_DETAIL)
            except ConnectionError as err:
                raise ValueError(TECHNICAL_DETAIL) from err

        self.deepface.build_model.side_effect = build_model

        response = self.verify()

        line = self.assert_verify_failure(response, 503, UNAVAILABLE, "model_unavailable", "model_load")
        self.assertIn("error=ValueError", line)
        self.assertIn("cause=test_face_processing.", line)
        self.assertIn("ConnectionError", line)
        self.assertNotIn(TECHNICAL_DETAIL, line)

    def test_deepface_sem_rosto_continua_erro_de_foto(self):
        class FaceNotDetected(ValueError):
            pass

        self.deepface.represent.side_effect = FaceNotDetected(
            "Face could not be detected in numpy array.Please confirm that the picture is a face photo."
        )

        response = self.verify()

        self.assert_verify_failure(response, 400, NO_FACE, "no_face", "embedding")

    def test_deepface_sem_resultado_e_rosto_nao_detectado(self):
        self.deepface.represent.side_effect = None
        self.deepface.represent.return_value = []

        response = self.verify()

        self.assert_verify_failure(response, 400, NO_FACE, "no_face", "embedding")

    def test_varios_rostos_continua_erro_de_foto(self):
        self.deepface.represent.side_effect = None
        self.deepface.represent.return_value = [{"embedding": REFERENCE}, {"embedding": OTHER_FACE}]

        response = self.verify()

        self.assert_verify_failure(response, 400, MULTIPLE_FACES, "multiple_faces", "embedding")

    def test_embed_usa_as_mesmas_categorias(self):
        self.deepface.build_model.side_effect = ValueError(TECHNICAL_DETAIL)

        response = self.post("/embed", {"image_base64": DATA_URL})

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json(), {"face_detected": False, "erro": UNAVAILABLE})
        self.assert_logged("model_unavailable", "model_load")

    def test_versoes_das_dependencias_registradas_uma_vez_por_processo(self):
        with patch.object(main, "_RUNTIME_LOGGED", False):
            self.verify()
            self.verify()

        runtime = [line for line in self.logs.lines if line.startswith("face_runtime")]
        self.assertEqual(len(runtime), 1, self.logs.lines)
        for package in ("deepface=", "tensorflow=", "tf-keras=", "numpy=", "opencv-python-headless="):
            self.assertIn(package, runtime[0])

    def test_warmup_registra_a_falha_sem_derrubar_o_processo(self):
        self.deepface.build_model.side_effect = ValueError(TECHNICAL_DETAIL)

        main.warmup_model()

        line = self.assert_logged("model_unavailable", "model_load")
        self.assertIn("path=-", line)
        self.assertNotIn(TECHNICAL_DETAIL, "\n".join(self.logs.lines))

    def test_modelo_carregado_antes_de_gerar_o_embedding(self):
        response = self.verify()

        self.assertEqual(response.status_code, 200)
        self.deepface.build_model.assert_called_with(main.MODEL)
        self.deepface.represent.assert_called_once()


class ReferenceTests(FaceProcessingTestCase):
    def test_referencia_invalida_e_erro_interno_sem_rodar_o_modelo(self):
        invalid = {
            "lista vazia": [],
            "texto": "0.1,0.2",
            "objeto": {"0": 0.1},
            "valores nao numericos": ["a", "b"],
            "lista aninhada": [[0.1, 0.2], [0.3, 0.4]],
            "valor nao finito": [0.1, float("nan"), 0.3, 0.4],
        }
        for label, reference in invalid.items():
            with self.subTest(referencia=label):
                response = self.verify(reference=reference)

                self.assert_verify_failure(response, 500, INTERNAL, "invalid_reference", "reference")
        self.deepface.represent.assert_not_called()

    def test_dimensao_diferente_da_sonda_e_erro_interno_e_nunca_reconhece(self):
        response = self.verify(reference=REFERENCE[:3])

        line = self.assert_verify_failure(response, 500, INTERNAL, "invalid_reference", "compare")
        self.assertIn("reference_dim=3", line)
        self.assertIn("probe_dim=4", line)

    def test_verify_multi_com_uma_referencia_invalida_falha_inteira(self):
        for references in ([REFERENCE, REFERENCE[:3]], [REFERENCE, "invalida"], [REFERENCE, []]):
            with self.subTest(referencias=str(references)[:40]):
                response = self.post(
                    "/verify-multi", {"reference_embeddings": references, "image_base64": DATA_URL}
                )

                self.assertEqual(response.status_code, 500)
                self.assertFalse(response.get_json()["match"])
                self.assert_logged("invalid_reference", "reference" if len(references[1]) != 3 else "compare")


class ComparisonTests(FaceProcessingTestCase):
    def test_rosto_reconhecido(self):
        response = self.verify()

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertTrue(body["match"])
        self.assertTrue(body["face_detected"])
        self.assertEqual(body["distance"], 0.0)
        self.assertEqual(body["threshold"], 0.5)
        self.assertEqual([line for line in self.logs.lines if "face_failure" in line], [])

    def test_rosto_nao_reconhecido(self):
        self.probe = list(OTHER_FACE)

        response = self.verify()

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertFalse(body["match"])
        self.assertTrue(body["face_detected"])
        self.assertGreater(body["distance"], 0.5)

    def test_verify_multi_usa_a_referencia_mais_proxima(self):
        response = self.post(
            "/verify-multi", {"reference_embeddings": [OTHER_FACE, REFERENCE], "image_base64": DATA_URL}
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["match"])

    def test_regra_de_comparacao_inalterada_no_limite(self):
        self.probe = [0.70, -0.20, 0.50, 0.15]
        distance = main.cosine_distance(np.array(REFERENCE), np.array(self.probe))

        self.assertTrue(self.verify(threshold=distance).get_json()["match"])
        self.assertFalse(self.verify(threshold=distance - 1e-9).get_json()["match"])


class AuthenticationTests(FaceProcessingTestCase):
    ROUTES = {
        "/embed": {"image_base64": DATA_URL},
        "/verify": {"reference_embedding": REFERENCE, "image_base64": DATA_URL},
        "/verify-multi": {"reference_embeddings": [REFERENCE], "image_base64": DATA_URL},
    }

    def test_sem_segredo_configurado_responde_503_sem_processar(self):
        with patch.object(main, "SERVICE_SECRET", ""), patch.object(main, "decode_image_to_path") as decode:
            for path, payload in self.ROUTES.items():
                with self.subTest(rota=path):
                    response = self.post(path, payload)

                    self.assertEqual(response.status_code, 503)
                    self.assertEqual(response.get_json(), {"erro": "Servico facial indisponivel."})
        decode.assert_not_called()
        self.deepface.build_model.assert_not_called()

    def test_segredo_errado_ou_ausente_responde_401_sem_processar(self):
        self.deepface.build_model.side_effect = ValueError(TECHNICAL_DETAIL)
        with patch.object(main, "decode_image_to_path") as decode:
            for path, payload in self.ROUTES.items():
                for secret in ("segredo-errado", None):
                    with self.subTest(rota=path, segredo=secret):
                        response = self.post(path, payload, secret=secret)

                        self.assertEqual(response.status_code, 401)
                        self.assertEqual(response.get_json(), {"erro": "Nao autorizado."})
        decode.assert_not_called()

    def test_health_continua_publico(self):
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["status"], "ok")


class SafeLoggingTests(FaceProcessingTestCase):
    FORBIDDEN = [RAW_BASE64[:40], RAW_BASE64[-40:], SECRET, TECHNICAL_DETAIL, "Traceback", "0.7311", "0.2417", "0.6012"]

    def run_failures(self):
        responses = [self.verify(image="data:image/jpeg;base64,@@@@")]
        self.deepface.build_model.side_effect = ValueError(TECHNICAL_DETAIL)
        responses.append(self.verify())
        self.deepface.build_model.side_effect = None
        self.deepface.represent.side_effect = RuntimeError(TECHNICAL_DETAIL)
        responses.append(self.verify())
        self.deepface.represent.side_effect = self._represent
        responses.append(self.verify(reference=REFERENCE[:3]))
        responses.append(self.verify(reference=["0.7311", "texto"]))
        responses.append(self.post("/verify-multi", {"reference_embeddings": [OTHER_FACE, [1]], "image_base64": DATA_URL}))
        return responses

    def test_logs_identificam_a_falha_sem_dados_sensiveis(self):
        self.run_failures()

        failures = [line for line in self.logs.lines if "face_failure" in line]
        self.assertEqual(len(failures), 6, self.logs.lines)
        joined = "\n".join(self.logs.lines)
        for forbidden in self.FORBIDDEN:
            self.assertNotIn(forbidden, joined)

    def test_respostas_de_falha_nao_expoem_detalhe_tecnico(self):
        for response in self.run_failures():
            text = response.get_data(as_text=True)
            for forbidden in [*self.FORBIDDEN, "ValueError", "RuntimeError", "deepface", "invalid_reference", "stage"]:
                self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
