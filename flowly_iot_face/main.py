"""
Microserviço IoT de reconhecimento facial — Flowly 2.0
Expõe endpoints para extrair embeddings e comparar rostos via DeepFace.
"""

import base64
import binascii
import hmac
import logging
import os
import tempfile

import cv2
import numpy as np
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
allowed_origin = os.getenv("FACE_CORS_ORIGIN", "").strip()
if allowed_origin:
    CORS(app, origins=[origin.strip() for origin in allowed_origin.split(",") if origin.strip()])

MAX_IMAGE_BYTES = int(os.getenv("FACE_MAX_IMAGE_BYTES", str(10 * 1024 * 1024)))
app.config["MAX_CONTENT_LENGTH"] = int(
    os.getenv("FACE_MAX_REQUEST_BYTES", str(15 * 1024 * 1024))
)
SERVICE_SECRET = os.getenv("FACE_SERVICE_SECRET", "")

MODEL = os.getenv("FACE_MODEL", "VGG-Face")
DETECTOR = os.getenv("FACE_DETECTOR", "opencv")
DEFAULT_THRESHOLD = float(os.getenv("FACE_MATCH_THRESHOLD", "0.4"))
VERIFY_THRESHOLD = float(os.getenv("FACE_VERIFY_THRESHOLD", os.getenv("FACE_MATCH_THRESHOLD", "0.5")))

_FACE_CASCADE = None


def decode_image_to_path(image_base64: str) -> str:
    payload = image_base64
    if "," in payload:
        payload = payload.split(",", 1)[1]

    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("Imagem em base64 invalida") from exc

    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Imagem vazia ou acima do limite permitido")
    tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    tmp.write(raw)
    tmp.close()
    return tmp.name


def format_face_error(exc: Exception) -> str:
    message = str(exc).lower()

    if "face could not be detected" in message or "no face" in message:
        return (
            "Não foi possível identificar um rosto na foto. "
            "Posicione-se de frente à câmera, com boa iluminação, e tente novamente."
        )

    if "multiple faces" in message or "more than one face" in message:
        return (
            "Mais de um rosto foi detectado na imagem. "
            "Certifique-se de que apenas você apareça na foto."
        )

    if "could not be detected" in message:
        return (
            "Não foi possível identificar um rosto na foto. "
            "Capture outra imagem com o rosto bem visível e centralizado."
        )

    return (
        "Não foi possível processar a foto. "
        "Tire outra imagem com o rosto bem visível e tente novamente."
    )


def cosine_distance(source: np.ndarray, probe: np.ndarray) -> float:
    source = source.astype(np.float64)
    probe = probe.astype(np.float64)
    dot = float(np.dot(source, probe))
    norm = float(np.linalg.norm(source) * np.linalg.norm(probe))
    if norm == 0:
        return 1.0
    return 1.0 - (dot / norm)


def get_face_cascade():
    global _FACE_CASCADE
    if _FACE_CASCADE is None:
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        _FACE_CASCADE = cv2.CascadeClassifier(cascade_path)
    return _FACE_CASCADE


def has_detectable_face(image_path: str) -> bool:
    image = cv2.imread(image_path)
    if image is None:
        return False

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    faces = get_face_cascade().detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=4,
        minSize=(30, 30),
    )
    return len(faces) > 0


def warmup_model() -> None:
    try:
        from deepface import DeepFace

        logger.info("Pré-carregando modelo facial %s...", MODEL)
        DeepFace.build_model(MODEL)
        logger.info("Modelo facial pronto.")
    except Exception as exc:
        logger.warning("Não foi possível pré-carregar o modelo: %s", exc)


def extract_embedding(image_path: str) -> list[float]:
    if not has_detectable_face(image_path):
        raise ValueError("Face could not be detected")

    from deepface import DeepFace

    results = DeepFace.represent(
        img_path=image_path,
        model_name=MODEL,
        detector_backend=DETECTOR,
        enforce_detection=True,
    )
    if not results:
        raise ValueError("Nenhum rosto detectado na imagem.")
    if len(results) > 1:
        raise ValueError("Multiple faces detected")
    return results[0]["embedding"]


@app.before_request
def authenticate_internal_request():
    if request.path == "/health":
        return None

    if not SERVICE_SECRET:
        logger.error("FACE_SERVICE_SECRET nao configurado")
        return jsonify({"erro": "Servico facial indisponivel."}), 503

    supplied_secret = request.headers.get("X-Flowly-Service-Secret", "")
    if not hmac.compare_digest(supplied_secret, SERVICE_SECRET):
        return jsonify({"erro": "Nao autorizado."}), 401

    return None


@app.get("/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "service": "flowly_iot_face",
            "model": MODEL,
            "detector": DETECTOR,
            "threshold_default": DEFAULT_THRESHOLD,
            "verify_threshold": VERIFY_THRESHOLD,
        }
    )


@app.post("/embed")
def embed():
    data = request.get_json(silent=True) or {}
    image_base64 = data.get("image_base64")

    if not image_base64:
        return jsonify({"erro": "image_base64 é obrigatório."}), 400

    image_path = None
    try:
        image_path = decode_image_to_path(image_base64)
        embedding = extract_embedding(image_path)
        return jsonify(
            {
                "face_detected": True,
                "embedding": embedding,
                "model": MODEL,
            }
        )
    except Exception as exc:
        return jsonify({"face_detected": False, "erro": format_face_error(exc)}), 400
    finally:
        if image_path and os.path.exists(image_path):
            os.unlink(image_path)


def verify_against_references(references, image_base64, threshold):
    image_path = None
    try:
        image_path = decode_image_to_path(image_base64)
        probe_embedding = extract_embedding(image_path)
        probe = np.array(probe_embedding, dtype=np.float64)

        best_distance = 1.0
        for reference in references:
            ref = np.array(reference, dtype=np.float64)
            distance = cosine_distance(ref, probe)
            if distance < best_distance:
                best_distance = distance

        match = best_distance <= threshold

        return jsonify(
            {
                "match": bool(match),
                "distance": round(best_distance, 6),
                "threshold": threshold,
                "face_detected": True,
                "model": MODEL,
            }
        )
    except Exception as exc:
        return jsonify(
            {"match": False, "face_detected": False, "erro": format_face_error(exc)}
        ), 400
    finally:
        if image_path and os.path.exists(image_path):
            os.unlink(image_path)


@app.post("/verify")
def verify():
    data = request.get_json(silent=True) or {}
    reference = data.get("reference_embedding")
    image_base64 = data.get("image_base64")
    threshold = float(data.get("threshold", VERIFY_THRESHOLD))

    if reference is None or not image_base64:
        return jsonify(
            {"erro": "reference_embedding e image_base64 são obrigatórios."}
        ), 400

    return verify_against_references([reference], image_base64, threshold)


@app.post("/verify-multi")
def verify_multi():
    data = request.get_json(silent=True) or {}
    references = data.get("reference_embeddings")
    image_base64 = data.get("image_base64")
    threshold = float(data.get("threshold", VERIFY_THRESHOLD))

    if not isinstance(references, list) or len(references) == 0 or not image_base64:
        return jsonify(
            {"erro": "reference_embeddings e image_base64 são obrigatórios."}
        ), 400

    return verify_against_references(references, image_base64, threshold)


if __name__ == "__main__":
    warmup_model()
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5001"))
    app.run(host=host, port=port, debug=os.getenv("FLASK_DEBUG", "0") == "1")
