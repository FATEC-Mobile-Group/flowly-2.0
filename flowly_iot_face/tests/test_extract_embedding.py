"""PR-04 — a imagem deve conter exatamente um rosto.

O DeepFace é substituído por um mock para não carregar o modelo real.
"""

import base64
import os
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

os.environ.setdefault("FACE_SERVICE_SECRET", "segredo-de-teste")

_fake_deepface = types.ModuleType("deepface")
_fake_deepface.DeepFace = MagicMock()
sys.modules["deepface"] = _fake_deepface

import main  # noqa: E402

EMBEDDING_A = [0.1, 0.2, 0.3]
EMBEDDING_B = [0.9, 0.8, 0.7]
IMAGE_BASE64 = "data:image/jpeg;base64," + base64.b64encode(b"fake-jpeg").decode()
MULTIPLE_FACES_MESSAGE = (
    "Mais de um rosto foi detectado na imagem. "
    "Certifique-se de que apenas você apareça na foto."
)


class FaceTestCase(unittest.TestCase):
    def setUp(self):
        self.represent = _fake_deepface.DeepFace.represent
        self.represent.reset_mock(return_value=True, side_effect=True)
        haar = patch.object(main, "has_detectable_face", return_value=True)
        self.has_detectable_face = haar.start()
        self.addCleanup(haar.stop)

    def faces(self, *embeddings):
        self.represent.return_value = [
            {"embedding": embedding, "face_confidence": 0.9} for embedding in embeddings
        ]


class ExtractEmbeddingTests(FaceTestCase):
    def test_exactly_one_face_returns_embedding(self):
        self.faces(EMBEDDING_A)

        self.assertEqual(main.extract_embedding("foto.jpg"), EMBEDDING_A)
        self.represent.assert_called_once_with(
            img_path="foto.jpg",
            model_name=main.MODEL,
            detector_backend=main.DETECTOR,
            enforce_detection=True,
        )

    def test_two_faces_are_rejected(self):
        self.faces(EMBEDDING_A, EMBEDDING_B)

        with self.assertRaises(ValueError) as ctx:
            main.extract_embedding("foto.jpg")
        self.assertEqual(main.format_face_error(ctx.exception), MULTIPLE_FACES_MESSAGE)

    def test_three_faces_are_rejected(self):
        self.faces(EMBEDDING_A, EMBEDDING_B, EMBEDDING_A)

        with self.assertRaises(ValueError):
            main.extract_embedding("foto.jpg")

    def test_no_face_from_deepface_is_rejected(self):
        self.faces()

        with self.assertRaises(ValueError):
            main.extract_embedding("foto.jpg")

    def test_no_face_from_haar_is_rejected_before_deepface(self):
        self.has_detectable_face.return_value = False

        with self.assertRaises(ValueError) as ctx:
            main.extract_embedding("foto.jpg")
        self.assertIn("rosto", main.format_face_error(ctx.exception))
        self.represent.assert_not_called()


class EndpointTests(FaceTestCase):
    def setUp(self):
        super().setUp()
        self.client = main.app.test_client()
        self.headers = {"X-Flowly-Service-Secret": os.environ["FACE_SERVICE_SECRET"]}

    def post(self, path, payload):
        return self.client.post(path, json=payload, headers=self.headers)

    def test_embed_one_face_keeps_response_contract(self):
        self.faces(EMBEDDING_A)

        response = self.post("/embed", {"image_base64": IMAGE_BASE64})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.get_json(),
            {"face_detected": True, "embedding": EMBEDDING_A, "model": main.MODEL},
        )

    def test_embed_multiple_faces_returns_400(self):
        self.faces(EMBEDDING_A, EMBEDDING_B)

        response = self.post("/embed", {"image_base64": IMAGE_BASE64})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.get_json(),
            {"face_detected": False, "erro": MULTIPLE_FACES_MESSAGE},
        )

    def test_verify_one_face_keeps_response_contract(self):
        self.faces(EMBEDDING_A)

        response = self.post(
            "/verify",
            {"reference_embedding": EMBEDDING_A, "image_base64": IMAGE_BASE64, "threshold": 0.5},
        )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertTrue(body["match"])
        self.assertTrue(body["face_detected"])
        self.assertEqual(body["threshold"], 0.5)
        self.assertEqual(body["distance"], 0.0)

    def test_verify_multiple_faces_returns_400_without_match(self):
        self.faces(EMBEDDING_B, EMBEDDING_A)

        response = self.post(
            "/verify",
            {"reference_embedding": EMBEDDING_A, "image_base64": IMAGE_BASE64, "threshold": 0.5},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.get_json(),
            {"match": False, "face_detected": False, "erro": MULTIPLE_FACES_MESSAGE},
        )

    def test_verify_multi_one_face_keeps_response_contract(self):
        self.faces(EMBEDDING_A)

        response = self.post(
            "/verify-multi",
            {"reference_embeddings": [EMBEDDING_B, EMBEDDING_A], "image_base64": IMAGE_BASE64},
        )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertTrue(body["match"])
        self.assertEqual(body["threshold"], main.VERIFY_THRESHOLD)

    def test_verify_multi_multiple_faces_returns_400(self):
        self.faces(EMBEDDING_A, EMBEDDING_B)

        response = self.post(
            "/verify-multi",
            {"reference_embeddings": [EMBEDDING_A], "image_base64": IMAGE_BASE64},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["erro"], MULTIPLE_FACES_MESSAGE)
        self.assertFalse(response.get_json()["match"])


if __name__ == "__main__":
    unittest.main()
