"""Anti-spoofing (Fasnet do DeepFace): foto ou tela e recusada antes de gerar qualquer embedding.

DeepFace falso e imagens sinteticas: aqui se testa a decisao do servico sobre a resposta do Fasnet.
O modelo real e validado a parte (check_face_model.py e o teste no conteiner).
"""

import os
import shutil
import tempfile
from pathlib import Path
from unittest.mock import ANY, patch

import numpy as np

os.environ.setdefault("FACE_SERVICE_SECRET", "segredo-de-teste")

import main  # noqa: E402
from test_face_processing import (  # noqa: E402
    DATA_URL,
    MULTIPLE_FACES,
    NO_FACE,
    OTHER_FACE,
    RAW_BASE64,
    REFERENCE,
    UNAVAILABLE,
    FaceProcessingTestCase,
)

SPOOF = (
    "Não foi possível confirmar que a captura é de um rosto ao vivo. "
    "Olhe diretamente para a câmera, sem fotos ou telas, com boa iluminação, e tente novamente."
)


def face(is_real=True, score=0.97, **extra):
    analysis = {
        "face": np.zeros((4, 4, 3)),
        "facial_area": {"x": 10, "y": 10, "w": 60, "h": 60},
        "confidence": 0.9,
        "is_real": is_real,
        "antispoof_score": score,
    }
    analysis.update(extra)
    return analysis


class AntiSpoofingTestCase(FaceProcessingTestCase):
    def liveness(self, result=None, error=None):
        self.deepface.extract_faces.return_value = result
        self.deepface.extract_faces.side_effect = error

    def assert_rejected_without_embedding(self, response, status, message, category):
        line = self.assert_verify_failure(response, status, message, category, "liveness")
        self.deepface.represent.assert_not_called()
        return line


class LegitimateFaceTests(AntiSpoofingTestCase):
    def test_rosto_real_aprovado_segue_para_o_embedding_e_autentica(self):
        response = self.verify()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["match"])
        self.deepface.extract_faces.assert_called_once_with(
            img_path=ANY, detector_backend=main.DETECTOR, enforce_detection=True, align=True, anti_spoofing=True
        )

    def test_anti_spoofing_roda_antes_do_embedding(self):
        self.verify()

        calls = [call[0] for call in self.deepface.mock_calls]
        self.assertLess(calls.index("extract_faces"), calls.index("represent"))

    def test_tipos_numpy_do_modelo_real_sao_aceitos(self):
        self.liveness([face(is_real=np.bool_(True), score=np.float32(0.88))])

        self.assertEqual(self.verify().status_code, 200)

    def test_rosto_real_de_outra_pessoa_continua_recusado(self):
        self.probe = list(OTHER_FACE)

        response = self.verify()

        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.get_json()["match"])

    def test_tempo_da_checagem_aparece_na_requisicao(self):
        with patch.object(main, "_MODEL_READY", True):
            self.verify()

        timing = [line for line in self.logs.lines if line.startswith("face_timing ")][0]
        self.assertIn("liveness_ms=", timing)


class SpoofRejectionTests(AntiSpoofingTestCase):
    def test_foto_detectada_como_falsa_e_recusada_sem_embedding(self):
        self.liveness([face(is_real=False, score=0.91)])

        line = self.assert_rejected_without_embedding(self.verify(), 400, SPOOF, "spoof_detected")
        self.assertNotIn("0.91", "\n".join(self.logs.lines))
        self.assertNotIn(RAW_BASE64[:40], line)

    def test_foto_falsa_tambem_e_recusada_no_verify_multi_e_no_cadastro(self):
        self.liveness([face(is_real=False)])

        multi = self.post("/verify-multi", {"reference_embeddings": [OTHER_FACE, REFERENCE], "image_base64": DATA_URL})
        embed = self.post("/embed", {"image_base64": DATA_URL})

        self.assertEqual(multi.status_code, 400)
        self.assertEqual(multi.get_json(), {"match": False, "face_detected": False, "erro": SPOOF})
        self.assertEqual(embed.status_code, 400)
        self.assertEqual(embed.get_json(), {"face_detected": False, "erro": SPOOF})
        self.deepface.represent.assert_not_called()

    def test_rosto_nao_detectado_na_checagem(self):
        self.liveness(error=ValueError("Face could not be detected in numpy array.Please confirm that the picture is a face photo"))

        self.assert_rejected_without_embedding(self.verify(), 400, NO_FACE, "no_face")

    def test_mais_de_um_rosto_na_checagem(self):
        self.liveness([face(), face()])

        self.assert_rejected_without_embedding(self.verify(), 400, MULTIPLE_FACES, "multiple_faces")

    def test_sem_rosto_no_haar_nem_chega_ao_anti_spoofing(self):
        with patch.object(main, "has_detectable_face", return_value=False):
            response = self.verify()

        self.assertEqual(response.status_code, 400)
        self.deepface.extract_faces.assert_not_called()


class LivenessUnavailableTests(AntiSpoofingTestCase):
    def test_modelo_anti_spoofing_que_nao_carrega_e_indisponibilidade(self):
        def build_model(model_name, task="facial_recognition"):
            if task == "spoofing":
                raise ValueError("pesos do Fasnet corrompidos /opt/deepface")

        self.deepface.build_model.side_effect = build_model
        with patch.object(main, "_MODEL_READY", False):
            response = self.verify()

        self.assert_verify_failure(response, 503, UNAVAILABLE, "model_unavailable", "liveness_load")
        self.deepface.represent.assert_not_called()
        self.assertNotIn("/opt/deepface", "\n".join(self.logs.lines))

    def test_excecao_na_analise_e_indisponibilidade_e_nao_desliga_a_protecao(self):
        self.liveness(error=RuntimeError("falha interna do Fasnet"))

        self.assert_rejected_without_embedding(self.verify(), 503, UNAVAILABLE, "model_unavailable")

    def test_resposta_incompleta_ou_inesperada_e_indisponibilidade(self):
        cases = {
            "lista vazia": [],
            "nao e lista": "texto",
            "item nao e dicionario": ["rosto"],
            "sem is_real": [{key: value for key, value in face().items() if key != "is_real"}],
            "is_real texto": [face(is_real="true")],
            "is_real numero": [face(is_real=1)],
            "is_real nulo": [face(is_real=None)],
            "sem score": [{key: value for key, value in face().items() if key != "antispoof_score"}],
            "score nulo": [face(score=None)],
            "score nao finito": [face(score=float("nan"))],
            "score acima de 1": [face(score=1.5)],
            "score negativo": [face(score=-0.1)],
            "score booleano": [face(score=True)],
        }
        for label, result in cases.items():
            with self.subTest(resposta=label):
                self.deepface.represent.reset_mock()
                self.liveness(result)

                line = self.assert_rejected_without_embedding(self.verify(), 503, UNAVAILABLE, "model_unavailable")
                self.assertIn("liveness=invalid_response", line)

    def test_producao_sem_os_pesos_do_anti_spoofing_nao_carrega(self):
        home = tempfile.mkdtemp(prefix="deepface-home-")
        self.addCleanup(shutil.rmtree, home, True)
        weights = Path(home, ".deepface", "weights")
        weights.mkdir(parents=True)
        Path(weights, "vgg_face_weights.h5").write_bytes(b"vgg")
        with patch.object(main, "_MODEL_READY", False), patch.dict(
            os.environ, {"DEEPFACE_HOME": home, "FACE_REQUIRE_LOCAL_WEIGHTS": "1"}
        ):
            response = self.verify()

        line = self.assert_verify_failure(response, 503, UNAVAILABLE, "model_unavailable", "model_load")
        self.assertIn("weights=missing", line)
        self.deepface.build_model.assert_not_called()


class NoAuthenticationAfterFailureTests(AntiSpoofingTestCase):
    FAILURES = {
        "foto falsa": ([face(is_real=False)], None),
        "sem confirmacao": ([face(is_real=None)], None),
        "excecao": (None, RuntimeError("falha")),
    }

    def test_nenhuma_falha_de_seguranca_termina_em_match(self):
        for label, (result, error) in self.FAILURES.items():
            for path, payload in (
                ("/verify", {"reference_embedding": REFERENCE, "image_base64": DATA_URL}),
                ("/verify-multi", {"reference_embeddings": [REFERENCE], "image_base64": DATA_URL}),
            ):
                with self.subTest(falha=label, rota=path):
                    self.liveness(result, error)

                    response = self.post(path, payload)

                    self.assertNotEqual(response.status_code, 200)
                    body = response.get_json()
                    self.assertFalse(body["match"])
                    self.assertNotIn("distance", body)
        self.deepface.represent.assert_not_called()


class ReadinessTests(AntiSpoofingTestCase):
    def test_pre_carregamento_carrega_o_anti_spoofing_junto(self):
        with patch.object(main, "_MODEL_READY", False), patch.dict(os.environ, {"FACE_PRELOAD_MODEL": "1"}):
            main.preload_model_if_enabled()
            self.assertTrue(main._MODEL_READY)

        self.deepface.build_model.assert_any_call(main.MODEL)
        self.deepface.build_model.assert_any_call(model_name=main.ANTI_SPOOFING_MODEL, task="spoofing")

    def test_producao_sem_anti_spoofing_nao_sobe_e_health_nao_fica_pronto(self):
        def build_model(model_name, task="facial_recognition"):
            if task == "spoofing":
                raise ValueError("Fasnet indisponivel")

        self.deepface.build_model.side_effect = build_model
        with patch.object(main, "_MODEL_READY", False), patch.dict(
            os.environ, {"FACE_PRELOAD_MODEL": "1", "FACE_REQUIRE_LOCAL_WEIGHTS": "0"}
        ):
            main.preload_model_if_enabled()
            self.assertFalse(main._MODEL_READY)
            health = self.client.get("/health")

        self.assertEqual(health.status_code, 503)
        with patch.object(main, "_MODEL_READY", False), patch.dict(
            os.environ, {"FACE_PRELOAD_MODEL": "1", "FACE_REQUIRE_LOCAL_WEIGHTS": "1"}
        ), patch.object(main, "assert_local_weights"):
            with self.assertRaises(main.ModelPreloadError):
                main.preload_model_if_enabled()


if __name__ == "__main__":
    import unittest

    unittest.main()
