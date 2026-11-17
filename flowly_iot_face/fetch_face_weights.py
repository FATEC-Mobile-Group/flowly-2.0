"""Baixa os pesos do VGG-Face durante o build da imagem e os grava onde o DeepFace procura.

As origens sao as da lista WEIGHTS_URL do DeepFace instalado (release oficial v1.0 no GitHub e espelho
oficial no Hugging Face). O arquivo so entra na imagem se tamanho e SHA-256 baterem com os valores fixados.
Em execucao nada e baixado: main.py recusa carregar o modelo sem o arquivo (FACE_REQUIRE_LOCAL_WEIGHTS=1).
"""

import hashlib
import os
import sys
import tempfile
import urllib.request

WEIGHTS_FILE = "vgg_face_weights.h5"
# SHA-256 publicado pelo Hugging Face para serengil/deepface/vgg_face_weights.h5 (oid do LFS), identico ao de
# uma copia baixada pelo proprio DeepFace da release v1.0 (github.com/serengil/deepface_models) em 06/06/2026.
# A release do GitHub nao publica digest para este asset.
PINNED_SHA256 = "759266b9614d0fd5d65b97bf716818b746cc77ab5944c7bffc937c6ba9455d8c"
PINNED_SIZE = 580085408

CHUNK_BYTES = 8 * 1024 * 1024
TIMEOUT_SECONDS = 60


class WeightsError(RuntimeError):
    pass


def deepface_weights_dir() -> str:
    # Mesma regra de deepface.commons.folder_utils.get_deepface_home().
    home = str(os.getenv("DEEPFACE_HOME", default=os.path.expanduser("~")))
    return os.path.join(home, ".deepface", "weights")


def urls_from(module) -> list:
    urls = module.WEIGHTS_URL
    return [urls] if isinstance(urls, str) else list(urls)


def installed_weight_urls() -> list:
    # Inicializa o pacote antes: importar o modulo do modelo direto cai num import circular em algumas versoes.
    from deepface import DeepFace  # noqa: F401

    try:
        from deepface.models.facial_recognition.tf import VGGFace as module  # DeepFace 0.0.105+
    except ModuleNotFoundError:
        from deepface.models.facial_recognition import VGGFace as module  # versoes anteriores
    return urls_from(module)


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_matches(path: str, sha256: str, size: int) -> bool:
    return os.path.isfile(path) and os.path.getsize(path) == size and sha256_of(path) == sha256


def _download(url: str, destination: str, size: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    with urllib.request.urlopen(url, timeout=TIMEOUT_SECONDS) as response, open(destination, "wb") as output:
        for chunk in iter(lambda: response.read(CHUNK_BYTES), b""):
            total += len(chunk)
            if total > size:
                raise WeightsError(f"maior que os {size} bytes esperados")
            digest.update(chunk)
            output.write(chunk)
    return digest.hexdigest(), total


def _remove(path: str) -> None:
    if os.path.exists(path):
        os.chmod(path, 0o644)
        os.remove(path)


def fetch_weights(urls, target_dir: str, sha256: str = PINNED_SHA256, size: int = PINNED_SIZE) -> str:
    """Grava target_dir/vgg_face_weights.h5 somente leitura. Arquivo ja valido nao e baixado de novo."""
    target = os.path.join(target_dir, WEIGHTS_FILE)
    if file_matches(target, sha256, size):
        return target

    os.makedirs(target_dir, exist_ok=True)
    failures = []
    for url in urls:
        handle, partial = tempfile.mkstemp(prefix=".vgg-face-", suffix=".part", dir=target_dir)
        os.close(handle)
        try:
            got_sha256, got_size = _download(url, partial, size)
            if got_size != size:
                raise WeightsError(f"tamanho {got_size} diferente dos {size} bytes esperados")
            if got_sha256 != sha256:
                raise WeightsError("SHA-256 diferente do fixado")
            _remove(target)
            os.replace(partial, target)
            os.chmod(target, 0o444)
            return target
        except Exception as exc:  # noqa: BLE001 - tenta a proxima origem e relata todas no fim
            failures.append(f"{url}: {exc}")
        finally:
            _remove(partial)

    raise WeightsError("nenhuma origem entregou os pesos esperados: " + " | ".join(failures))


def main() -> int:
    try:
        path = fetch_weights(installed_weight_urls(), deepface_weights_dir())
    except WeightsError as exc:
        print(f"ERRO: {exc}", file=sys.stderr)
        return 1
    print(f"{WEIGHTS_FILE} conferido em {path} ({PINNED_SIZE} bytes, SHA-256 {PINNED_SHA256}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
