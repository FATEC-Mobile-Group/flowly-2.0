"""Verificacao do build: VGG-Face e anti-spoofing (Fasnet) carregam da propria imagem, com a rede desligada.

Confere que os arquivos de pesos estao no caminho em que o DeepFace procura, com tamanho e SHA-256 fixados
em fetch_face_weights.py, e que os modelos montam, geram um embedding e uma analise de anti-spoofing valida
sem nenhuma tentativa de rede.
"""

import os
import socket
import sys
import time

_ORIGINAL_NETWORK = (socket.socket.connect, socket.create_connection, socket.getaddrinfo)


def block_network() -> list:
    """Toda tentativa de conexao ou de resolucao de nome falha e fica registrada."""
    attempts = []

    def refuse(*args, **kwargs):
        attempts.append("rede")
        raise OSError("rede desligada na verificacao do modelo")

    socket.socket.connect = refuse
    socket.create_connection = refuse
    socket.getaddrinfo = refuse
    return attempts


def restore_network() -> None:
    socket.socket.connect, socket.create_connection, socket.getaddrinfo = _ORIGINAL_NETWORK


def check_weights_file(path: str, sha256: str, size: int) -> list[str]:
    from fetch_face_weights import sha256_of

    if not os.path.isfile(path):
        return [f"pesos ausentes em {path}"]
    actual_size = os.path.getsize(path)
    if actual_size != size:
        return [f"tamanho {actual_size} diferente dos {size} bytes fixados"]
    if sha256_of(path) != sha256:
        return ["SHA-256 diferente do fixado"]
    return []


def run() -> int:
    import numpy as np

    import fetch_face_weights
    import main

    problems = []
    expected = main.model_weights_path()
    from deepface.commons import folder_utils

    used_by_deepface = os.path.join(folder_utils.get_deepface_home(), ".deepface", "weights", fetch_face_weights.WEIGHTS_FILE)
    if os.path.normpath(expected) != os.path.normpath(used_by_deepface):
        problems.append(f"main.py procura {expected}, mas o DeepFace procura {used_by_deepface}")
    weights_dir = os.path.dirname(expected)
    for name, sha256, size, _urls in fetch_face_weights.required_weights():
        problems += check_weights_file(os.path.join(weights_dir, name), sha256, size)

    dimensions = None
    liveness = None
    attempts = []
    load_ms = embed_ms = liveness_ms = 0.0
    if not problems:
        attempts = block_network()
        try:
            started = time.perf_counter()
            deepface = main.load_face_model()
            load_ms = (time.perf_counter() - started) * 1000
            image = np.random.default_rng(7).integers(0, 256, (224, 224, 3), dtype=np.uint8)
            started = time.perf_counter()
            result = deepface.represent(img_path=image, model_name=main.MODEL, detector_backend="skip", enforce_detection=False)
            embed_ms = (time.perf_counter() - started) * 1000
            dimensions = len(result[0]["embedding"])
            # O anti-spoofing precisa rodar e responder no formato que main.check_liveness exige.
            started = time.perf_counter()
            faces = deepface.extract_faces(img_path=image, detector_backend="skip", enforce_detection=False, anti_spoofing=True)
            liveness_ms = (time.perf_counter() - started) * 1000
            liveness = faces[0] if isinstance(faces, list) and faces else {}
        except Exception as exc:  # noqa: BLE001 - qualquer falha reprova o build
            problems.append(f"modelo nao carregou sem rede: {main.exception_name(exc)}")
        finally:
            restore_network()

    if attempts:
        problems.append(f"{len(attempts)} tentativa(s) de rede durante a carga do modelo")
    if dimensions is not None and dimensions != 4096:
        problems.append(f"embedding com {dimensions} dimensoes; o VGG-Face gera 4096")
    if liveness is not None and not (
        isinstance(liveness.get("is_real"), (bool, np.bool_)) and main._valid_liveness_score(liveness.get("antispoof_score"))
    ):
        problems.append("anti-spoofing nao devolveu is_real booleano e score entre 0 e 1")

    if problems:
        for problem in problems:
            print(f"ERRO: {problem}", file=sys.stderr)
        return 1

    print(
        f"{main.MODEL} e {main.ANTI_SPOOFING_MODEL} carregados de {weights_dir} sem rede: carga {load_ms:.0f} ms, "
        f"embedding de {dimensions} dimensoes em {embed_ms:.0f} ms, anti-spoofing em {liveness_ms:.0f} ms."
    )
    return 0


if __name__ == "__main__":
    sys.exit(run())
