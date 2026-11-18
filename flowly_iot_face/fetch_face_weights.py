"""Baixa os pesos do VGG-Face e do anti-spoofing (Fasnet) no build da imagem e os grava onde o DeepFace procura.

As origens sao as listas de URLs do DeepFace instalado (release oficial v1.0 no GitHub e espelho oficial no
Hugging Face). Cada arquivo so entra na imagem se tamanho e SHA-256 baterem com os valores fixados.
Em execucao nada e baixado: main.py recusa carregar os modelos sem os arquivos (FACE_REQUIRE_LOCAL_WEIGHTS=1).
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

# Anti-spoofing (Fasnet, backend tensorflow do DeepFace 0.0.105): arquivo, SHA-256, tamanho e atributo de URLs.
# SHA-256 publicado pela release v1.0 no GitHub (digest do asset) e pelo Hugging Face (oid do LFS): as duas conferem.
FASNET_WEIGHTS = (
    ("2.7_80x80_MiniFASNetV2.h5", "da0de51d44dc3d9af808c6c2f6fe97dd174774fa66881c9fd291bde1a1174e04", 2234368, "FIRST_WEIGHTS_URL"),
    ("4_0_0_80x80_MiniFASNetV1SE.h5", "d2f4280c30d88dbd02d0d6691dcfbdd389316de398f94bb6cba30144e23889b0", 2288392, "SECOND_WEIGHTS_URL"),
)

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


def installed_fasnet_urls(attribute: str) -> list:
    from deepface import DeepFace  # noqa: F401

    try:
        from deepface.models.spoofing.tf import FasNet as module
    except ModuleNotFoundError as exc:
        raise WeightsError("o DeepFace instalado nao tem o Fasnet para tensorflow (requer 0.0.105)") from exc
    urls = getattr(module, attribute)
    return [urls] if isinstance(urls, str) else list(urls)


def required_weights() -> list:
    """(arquivo, SHA-256, tamanho, funcao que devolve as origens) de tudo o que a imagem precisa."""
    weights = [(WEIGHTS_FILE, PINNED_SHA256, PINNED_SIZE, installed_weight_urls)]
    for name, sha256, size, attribute in FASNET_WEIGHTS:
        weights.append((name, sha256, size, lambda attribute=attribute: installed_fasnet_urls(attribute)))
    return weights


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


def fetch_weights(
    urls, target_dir: str, sha256: str = PINNED_SHA256, size: int = PINNED_SIZE, file_name: str = WEIGHTS_FILE
) -> str:
    """Grava target_dir/file_name somente leitura. Arquivo ja valido nao e baixado de novo."""
    target = os.path.join(target_dir, file_name)
    if file_matches(target, sha256, size):
        return target

    os.makedirs(target_dir, exist_ok=True)
    failures = []
    for url in urls:
        handle, partial = tempfile.mkstemp(prefix=f".{file_name}-", suffix=".part", dir=target_dir)
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
    target_dir = deepface_weights_dir()
    try:
        for name, sha256, size, urls in required_weights():
            path = fetch_weights(urls(), target_dir, sha256, size, name)
            print(f"{name} conferido em {path} ({size} bytes, SHA-256 {sha256}).")
    except WeightsError as exc:
        print(f"ERRO: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
