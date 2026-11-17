"""Verificacao do build Docker: barra a imagem se a deteccao facial nao puder funcionar nela.

Confere que ha uma unica distribuicao OpenCV (a headless), que os classificadores Haar usados pelo
servico e pelo DeepFace existem e carregam, e que o DeepFace importa e monta o detector "opencv".
Nao baixa pesos de modelo.
"""

import importlib.metadata
import sys

import cv2

import main

EXPECTED_OPENCV = "opencv-python-headless"


def installed_opencv_distributions() -> list[str]:
    names = set()
    for dist in importlib.metadata.distributions():
        name = (dist.metadata["Name"] or "").lower()
        if name.startswith("opencv"):
            names.add(name)
    return sorted(names)


def check_installation() -> list[str]:
    problems = []

    opencv = installed_opencv_distributions()
    if opencv != [EXPECTED_OPENCV]:
        problems.append(f"distribuicoes OpenCV instaladas: {opencv or 'nenhuma'}; esperado somente {EXPECTED_OPENCV}")

    for file_name in (main.HAAR_FACE_FILE, main.HAAR_EYE_FILE):
        try:
            main.load_haar_cascade(file_name)
        except main.FaceProcessingError as exc:
            problems.append(f"{file_name}: {exc.log_fields['haar_status']} em {main.haar_cascade_path(file_name)}")

    if not problems:
        try:
            from deepface import DeepFace

            DeepFace.build_model(model_name=main.DETECTOR, task="face_detector")
        except Exception as exc:
            problems.append(f"DeepFace nao montou o detector {main.DETECTOR}: {main.exception_name(exc)}: {exc}")

    return problems


def run() -> int:
    problems = check_installation()
    if problems:
        for problem in problems:
            print(f"ERRO: {problem}", file=sys.stderr)
        return 1

    print(
        f"OpenCV {cv2.__version__} ({EXPECTED_OPENCV}): {main.HAAR_FACE_FILE} e {main.HAAR_EYE_FILE} carregados; "
        f"detector {main.DETECTOR} do DeepFace montado."
    )
    return 0


if __name__ == "__main__":
    sys.exit(run())
