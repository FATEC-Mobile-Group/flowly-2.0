"""
Microserviço IoT de reconhecimento facial — Flowly 2.0
Expõe endpoints para extrair embeddings e comparar rostos via DeepFace.
"""

import base64
import binascii
import hmac
import importlib.metadata
import logging
import os
import platform
import tempfile
import time
import traceback
from contextlib import contextmanager

import cv2
import numpy as np
from dotenv import load_dotenv
from flask import Flask, g, has_request_context, jsonify, request
from flask_cors import CORS

# Base da medicao de inicializacao: o import deste modulo pelo worker do gunicorn.
_PROCESS_STARTED = time.perf_counter()

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
_RUNTIME_LOGGED = False
_MODEL_READY = False
# Arquivo que o DeepFace (backend tensorflow) procura para cada modelo. Na imagem ele vem de fetch_face_weights.py.
MODEL_WEIGHT_FILES = {"VGG-Face": "vgg_face_weights.h5"}
RUNTIME_PACKAGES = (
    "deepface",
    "tensorflow",
    "tf-keras",
    "keras",
    "numpy",
    "opencv-python",
    "opencv-python-headless",
)

# Categoria -> (HTTP, mensagem ao cliente). A mensagem nunca vem da excecao.
# 4xx: problema da foto, que o usuario resolve tirando outra. 5xx: falha do servico, que outra foto nao resolve.
FAILURES = {
    "invalid_input": (
        400,
        "Não foi possível processar a foto. Tire outra imagem com o rosto bem visível e tente novamente.",
    ),
    "no_face": (
        400,
        "Não foi possível identificar um rosto na foto. "
        "Posicione-se de frente à câmera, com boa iluminação, e tente novamente.",
    ),
    "multiple_faces": (
        400,
        "Mais de um rosto foi detectado na imagem. Certifique-se de que apenas você apareça na foto.",
    ),
    "model_unavailable": (503, "Serviço facial indisponível no momento. Tente novamente em instantes."),
    "invalid_reference": (500, "Erro interno no serviço facial."),
    "internal_error": (500, "Erro interno no serviço facial."),
}


class FaceProcessingError(ValueError):
    """Falha com categoria e etapa conhecidas. O log recebe as duas; o cliente, so a mensagem da categoria."""

    def __init__(self, category: str, stage: str, message: str = "", **log_fields):
        super().__init__(message or category)
        self.category = category
        self.stage = stage
        self.log_fields = log_fields


def classify_failure(exc: Exception) -> tuple[str, str]:
    if isinstance(exc, FaceProcessingError):
        return exc.category, exc.stage
    return "internal_error", "unexpected"


def format_face_error(exc: Exception) -> str:
    return FAILURES[classify_failure(exc)[0]][1]


def exception_name(exc: BaseException) -> str:
    kind = type(exc)
    return kind.__qualname__ if kind.__module__ == "builtins" else f"{kind.__module__}.{kind.__qualname__}"


def log_face_failure(exc: Exception, category: str, stage: str, status: int) -> None:
    """Categoria, etapa, tipo e local da excecao. Nunca a mensagem: ela pode repetir dados da requisicao."""
    fields = [
        f"path={request.path if has_request_context() else '-'}",
        f"category={category}",
        f"stage={stage}",
        f"status={status}",
    ]
    root = exc.__cause__ if isinstance(exc, FaceProcessingError) else exc
    if root is not None:
        fields.append(f"error={exception_name(root)}")
        if isinstance(root, ImportError) and root.name:
            fields.append(f"module={root.name}")
        cause = root.__cause__ or root.__context__
        if cause is not None:
            fields.append(f"cause={exception_name(cause)}")
        frames = traceback.extract_tb(root.__traceback__)
        if frames:
            fields.append(f"at={os.path.basename(frames[-1].filename)}:{frames[-1].lineno}")
    if isinstance(exc, FaceProcessingError):
        fields.extend(f"{key}={value}" for key, value in exc.log_fields.items())
    logger.log(logging.ERROR if status >= 500 else logging.WARNING, "face_failure %s", " ".join(fields))


def failure_response(exc: Exception, body: dict):
    category, stage = classify_failure(exc)
    status, message = FAILURES[category]
    log_face_failure(exc, category, stage, status)
    return jsonify({**body, "face_detected": False, "erro": message}), status


def log_runtime_versions() -> None:
    """Uma vez por processo: versoes instaladas, para achar incompatibilidade de dependencias pelo log."""
    global _RUNTIME_LOGGED
    if _RUNTIME_LOGGED:
        return
    _RUNTIME_LOGGED = True

    versions = []
    for package in RUNTIME_PACKAGES:
        try:
            versions.append(f"{package}={importlib.metadata.version(package)}")
        except importlib.metadata.PackageNotFoundError:
            versions.append(f"{package}=ausente")
    logger.info(
        "face_runtime python=%s model=%s detector=%s %s",
        platform.python_version(),
        MODEL,
        DETECTOR,
        " ".join(versions),
    )


def decode_image_to_path(image_base64) -> str:
    if not isinstance(image_base64, str):
        raise FaceProcessingError("invalid_input", "decode", "Imagem em base64 invalida")

    payload = image_base64
    if "," in payload:
        payload = payload.split(",", 1)[1]

    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise FaceProcessingError("invalid_input", "decode", "Imagem em base64 invalida") from exc

    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise FaceProcessingError("invalid_input", "decode", "Imagem vazia ou acima do limite permitido")
    tmp = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    tmp.write(raw)
    tmp.close()
    return tmp.name


def cosine_distance(source: np.ndarray, probe: np.ndarray) -> float:
    source = source.astype(np.float64)
    probe = probe.astype(np.float64)
    dot = float(np.dot(source, probe))
    norm = float(np.linalg.norm(source) * np.linalg.norm(probe))
    if norm == 0:
        return 1.0
    return 1.0 - (dot / norm)


HAAR_FACE_FILE = "haarcascade_frontalface_default.xml"
# O detector "opencv" do DeepFace le este arquivo da mesma pasta para alinhar o rosto pelos olhos.
HAAR_EYE_FILE = "haarcascade_eye.xml"


def haar_cascade_path(file_name: str) -> str:
    data_dir = getattr(getattr(cv2, "data", None), "haarcascades", None) or ""
    return os.path.join(data_dir, file_name)


def load_haar_cascade(file_name: str):
    """Classificador Haar do OpenCV instalado. Ausente ou invalido: detector indisponivel, nunca 'sem rosto'."""
    path = haar_cascade_path(file_name)
    if not os.path.isfile(path):
        raise FaceProcessingError(
            "model_unavailable", "face_detection", "Classificador facial ausente",
            haar_file=file_name, haar_status="missing",
        )
    cascade = cv2.CascadeClassifier(path)
    if cascade.empty():
        raise FaceProcessingError(
            "model_unavailable", "face_detection", "Classificador facial invalido",
            haar_file=file_name, haar_status="invalid",
        )
    return cascade


def get_face_cascade():
    """So um classificador carregado entra no cache: se o arquivo faltar, o proximo pedido tenta de novo."""
    global _FACE_CASCADE
    if _FACE_CASCADE is None:
        cascade = load_haar_cascade(HAAR_FACE_FILE)
        load_haar_cascade(HAAR_EYE_FILE)
        _FACE_CASCADE = cascade
    return _FACE_CASCADE


def has_detectable_face(image_path: str) -> bool:
    image = cv2.imread(image_path)
    if image is None:
        raise FaceProcessingError("invalid_input", "image_read", "Imagem ilegivel")

    cascade = get_face_cascade()
    if cascade.empty():
        raise FaceProcessingError("model_unavailable", "face_detection", "Classificador facial indisponivel")

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=4,
        minSize=(30, 30),
    )
    return len(faces) > 0


def record_timing(stage: str, started: float) -> float:
    """Soma o tempo da etapa na requisicao atual (log face_timing). Fora de requisicao, so devolve o valor."""
    elapsed_ms = (time.perf_counter() - started) * 1000
    timings = getattr(g, "face_timings", None) if has_request_context() else None
    if timings is not None:
        timings[stage] = timings.get(stage, 0.0) + elapsed_ms
    return elapsed_ms


@contextmanager
def timed(stage: str):
    started = time.perf_counter()
    try:
        yield
    finally:
        record_timing(stage, started)


def model_weights_path() -> str:
    """Onde o DeepFace procura os pesos (mesma regra de deepface.commons.folder_utils.get_deepface_home)."""
    home = str(os.getenv("DEEPFACE_HOME", default=os.path.expanduser("~")))
    return os.path.join(home, ".deepface", "weights", MODEL_WEIGHT_FILES.get(MODEL, ""))


def assert_local_weights() -> None:
    """Na imagem (FACE_REQUIRE_LOCAL_WEIGHTS=1), sem os pesos o modelo nao carrega: nada de baixar no login."""
    if os.getenv("FACE_REQUIRE_LOCAL_WEIGHTS") != "1" or MODEL not in MODEL_WEIGHT_FILES:
        return
    if not os.path.isfile(model_weights_path()):
        raise FaceProcessingError("model_unavailable", "model_load", "Pesos do modelo ausentes", weights="missing")


def load_face_model():
    """Importa o DeepFace e garante o modelo carregado (o DeepFace guarda em cache depois da 1a vez)."""
    global _MODEL_READY
    log_runtime_versions()
    first_load = not _MODEL_READY
    if first_load:
        assert_local_weights()

    started = time.perf_counter()
    try:
        from deepface import DeepFace
    except Exception as exc:
        raise FaceProcessingError("model_unavailable", "model_import") from exc
    import_ms = (time.perf_counter() - started) * 1000

    started = time.perf_counter()
    try:
        DeepFace.build_model(MODEL)
    except Exception as exc:
        raise FaceProcessingError("model_unavailable", "model_load") from exc
    build_ms = (time.perf_counter() - started) * 1000

    if first_load:
        _MODEL_READY = True
        logger.info("face_model_load model=%s import_ms=%.0f build_ms=%.0f", MODEL, import_ms, build_ms)
        if has_request_context() and getattr(g, "face_timings", None) is not None:
            g.face_timings["model"] = import_ms + build_ms
    return DeepFace


class ModelPreloadError(RuntimeError):
    """Inicializacao de producao sem o modelo obrigatorio: o worker nao sobe e o gunicorn encerra."""


def warmup_model() -> bool:
    logger.info("Pré-carregando modelo facial %s...", MODEL)
    try:
        # O classificador Haar tambem fica pronto: a primeira requisicao nao paga a leitura dos XML.
        get_face_cascade()
        load_face_model()
    except FaceProcessingError as exc:
        log_face_failure(exc, exc.category, exc.stage, FAILURES[exc.category][0])
        return False
    logger.info("Modelo facial pronto.")
    return True


def recognition_ready() -> bool:
    """Modelo carregado e classificador Haar disponivel."""
    if not _MODEL_READY:
        return False
    try:
        get_face_cascade()
    except FaceProcessingError:
        return False
    return True


def is_no_face_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return type(exc).__name__ == "FaceNotDetected" or "could not be detected" in message or "no face" in message


def extract_embedding(image_path: str) -> list[float]:
    with timed("detect"):
        try:
            face_found = has_detectable_face(image_path)
        except FaceProcessingError:
            raise
        except Exception as exc:
            raise FaceProcessingError("internal_error", "face_detection") from exc
    if not face_found:
        raise FaceProcessingError("no_face", "face_detection", "Face could not be detected")

    DeepFace = load_face_model()

    with timed("embed"):
        try:
            results = DeepFace.represent(
                img_path=image_path,
                model_name=MODEL,
                detector_backend=DETECTOR,
                enforce_detection=True,
            )
        except Exception as exc:
            if is_no_face_error(exc):
                raise FaceProcessingError("no_face", "embedding", "Face could not be detected") from exc
            raise FaceProcessingError("internal_error", "embedding") from exc
    if not results:
        raise FaceProcessingError("no_face", "embedding", "Nenhum rosto detectado na imagem.")
    if len(results) > 1:
        raise FaceProcessingError("multiple_faces", "embedding", "Multiple faces detected")
    return results[0]["embedding"]


def parse_references(references) -> list[np.ndarray]:
    """Vetores 1-D, nao vazios e finitos. Uma referencia invalida derruba o pedido: nunca compara so com as validas."""
    vectors = []
    for reference in references:
        try:
            vector = np.asarray(reference, dtype=np.float64)
        except (TypeError, ValueError) as exc:
            raise FaceProcessingError("invalid_reference", "reference") from exc
        if vector.ndim != 1 or vector.size == 0 or not np.all(np.isfinite(vector)):
            raise FaceProcessingError("invalid_reference", "reference")
        vectors.append(vector)
    return vectors


@app.before_request
def start_request_timer():
    g.face_started = time.perf_counter()
    g.face_timings = {}


# Uma linha por requisicao: so caminho, status e milissegundos por etapa. Nada de imagem, embedding ou segredo.
@app.after_request
def log_request_timing(response):
    started = getattr(g, "face_started", None)
    if request.path != "/health" and started is not None:
        fields = [f"path={request.path}", f"status={response.status_code}", f"total_ms={(time.perf_counter() - started) * 1000:.0f}"]
        fields += [f"{stage}_ms={value:.0f}" for stage, value in getattr(g, "face_timings", {}).items()]
        logger.info("face_timing %s", " ".join(fields))
    return response


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
    # Com pre-carregamento (imagem Docker), "ok" so quando o reconhecimento consegue de fato rodar.
    if os.getenv("FACE_PRELOAD_MODEL") == "1" and not recognition_ready():
        return jsonify({"status": "unavailable", "service": "flowly_iot_face"}), 503
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
        with timed("decode"):
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
        return failure_response(exc, {})
    finally:
        if image_path and os.path.exists(image_path):
            os.unlink(image_path)


def verify_against_references(references, image_base64, threshold):
    image_path = None
    try:
        reference_vectors = parse_references(references)
        with timed("decode"):
            image_path = decode_image_to_path(image_base64)
        probe_embedding = extract_embedding(image_path)
        probe = np.array(probe_embedding, dtype=np.float64)

        best_distance = 1.0
        with timed("compare"):
            for ref in reference_vectors:
                if ref.shape != probe.shape:
                    raise FaceProcessingError(
                        "invalid_reference", "compare", reference_dim=ref.size, probe_dim=probe.size
                    )
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
        return failure_response(exc, {"match": False})
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


def preload_model_if_enabled() -> None:
    """Com FACE_PRELOAD_MODEL=1 (imagem Docker), o worker carrega o modelo antes de atender.

    Em producao (tambem FACE_REQUIRE_LOCAL_WEIGHTS=1), falhar ao carregar o VGG-Face ou o Haar encerra a
    inicializacao: o import lanca, o worker do gunicorn nao sobe e o processo termina, em vez de uma
    instancia que parece saudavel mas nao reconhece rostos. Em desenvolvimento, so registra e segue.
    """
    if os.getenv("FACE_PRELOAD_MODEL") != "1":
        return
    started = time.perf_counter()
    ready = warmup_model()
    logger.info(
        "face_startup preload=1 model_ready=%s model_ms=%.0f total_ms=%.0f",
        "true" if ready else "false",
        (time.perf_counter() - started) * 1000,
        (time.perf_counter() - _PROCESS_STARTED) * 1000,
    )
    if not ready and os.getenv("FACE_REQUIRE_LOCAL_WEIGHTS") == "1":
        # Mensagem fixa: a causa (categoria e etapa) ja esta na linha face_failure, sem caminhos nem segredos.
        raise ModelPreloadError("Modelo facial obrigatorio indisponivel na inicializacao.")


preload_model_if_enabled()


if __name__ == "__main__":
    warmup_model()
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5001"))
    app.run(host=host, port=port, debug=os.getenv("FLASK_DEBUG", "0") == "1")
