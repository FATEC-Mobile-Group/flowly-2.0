"""Classificadores Haar do OpenCV: carga real, arquivo ausente ou invalido, falha segura e verificacao do build.

O OpenCV 5.0.0.93 publica wheels com cv2/data contendo so __init__.py, sem nenhum classificador Haar.
Imagens sinteticas e DeepFace falso; nada e baixado nem instalado.
"""

import importlib
import io
import os
import re
import shutil
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import ANY, MagicMock, patch

import cv2

os.environ.setdefault("FACE_SERVICE_SECRET", "segredo-de-teste")

import main  # noqa: E402
from test_face_processing import DATA_URL, NO_FACE, REFERENCE, UNAVAILABLE, FaceProcessingTestCase  # noqa: E402

FACE_DIR = Path(main.__file__).resolve().parent
REAL_HAAR_DIR = cv2.data.haarcascades
FACE_FILE = "haarcascade_frontalface_default.xml"
EYE_FILE = "haarcascade_eye.xml"


def check_module():
    return importlib.import_module("check_opencv")


class HaarDirTestCase(unittest.TestCase):
    """Cada teste comeca sem classificador em cache e pode trocar a pasta cv2/data por uma temporaria."""

    def setUp(self):
        active = patch.object(main, "_FACE_CASCADE", None)
        active.start()
        self.addCleanup(active.stop)

    def use_haar_dir(self, *files, invalid=()):
        folder = tempfile.mkdtemp(prefix="haar-")
        self.addCleanup(shutil.rmtree, folder, True)
        Path(folder, "__init__.py").write_text('import os\n\nhaarcascades = os.path.join(os.path.dirname(__file__), "")\n')
        for name in files:
            shutil.copyfile(os.path.join(REAL_HAAR_DIR, name), os.path.join(folder, name))
        for name in invalid:
            Path(folder, name).write_text("<?xml version='1.0'?>\n<opencv_storage></opencv_storage>\n")
        active = patch.object(cv2.data, "haarcascades", folder + os.sep)
        active.start()
        self.addCleanup(active.stop)
        return folder

    def assert_unavailable(self, error, file_name, status):
        self.assertIsInstance(error, main.FaceProcessingError)
        self.assertEqual((error.category, error.stage), ("model_unavailable", "face_detection"))
        self.assertEqual(error.log_fields, {"haar_file": file_name, "haar_status": status})


class HaarCascadeLoadingTests(HaarDirTestCase):
    def test_classificadores_do_opencv_instalado_existem_e_carregam(self):
        for file_name in (main.HAAR_FACE_FILE, main.HAAR_EYE_FILE):
            with self.subTest(arquivo=file_name):
                self.assertTrue(os.path.isfile(main.haar_cascade_path(file_name)))
                self.assertFalse(main.load_haar_cascade(file_name).empty())

    def test_nomes_dos_arquivos_sao_os_usados_pelo_servico_e_pelo_deepface(self):
        self.assertEqual(main.HAAR_FACE_FILE, FACE_FILE)
        self.assertEqual(main.HAAR_EYE_FILE, EYE_FILE)

    def test_classificador_e_carregado_uma_vez_e_reaproveitado(self):
        with patch.object(main, "load_haar_cascade", wraps=main.load_haar_cascade) as load:
            first = main.get_face_cascade()
            second = main.get_face_cascade()

        self.assertIs(first, second)
        self.assertFalse(first.empty())
        self.assertEqual([call.args[0] for call in load.call_args_list], [FACE_FILE, EYE_FILE])

    def test_pasta_data_sem_xml_como_no_opencv_5(self):
        self.use_haar_dir()

        with self.assertRaises(main.FaceProcessingError) as ctx:
            main.get_face_cascade()

        self.assert_unavailable(ctx.exception, FACE_FILE, "missing")

    def test_xml_invalido(self):
        self.use_haar_dir(EYE_FILE, invalid=[FACE_FILE])

        with self.assertRaises(main.FaceProcessingError) as ctx:
            main.get_face_cascade()

        self.assert_unavailable(ctx.exception, FACE_FILE, "invalid")

    def test_classificador_de_olhos_ausente_tambem_indisponibiliza(self):
        self.use_haar_dir(FACE_FILE)

        with self.assertRaises(main.FaceProcessingError) as ctx:
            main.get_face_cascade()

        self.assert_unavailable(ctx.exception, EYE_FILE, "missing")
        self.assertIsNone(main._FACE_CASCADE)

    def test_cv2_sem_modulo_data(self):
        with patch.object(main.cv2, "data", types.SimpleNamespace()):
            with self.assertRaises(main.FaceProcessingError) as ctx:
                main.load_haar_cascade(FACE_FILE)

        self.assert_unavailable(ctx.exception, FACE_FILE, "missing")


class DetectorUnavailableEndpointTests(FaceProcessingTestCase, HaarDirTestCase):
    use_fake_cascade = False

    def setUp(self):
        FaceProcessingTestCase.setUp(self)
        HaarDirTestCase.setUp(self)
        self.empty_dir = self.use_haar_dir()

    def test_rotas_respondem_503_sem_rodar_o_modelo(self):
        routes = {
            "/verify": ({"reference_embedding": REFERENCE, "image_base64": DATA_URL}, {"match": False}),
            "/verify-multi": ({"reference_embeddings": [REFERENCE], "image_base64": DATA_URL}, {"match": False}),
            "/embed": ({"image_base64": DATA_URL}, {}),
        }
        for path, (payload, extra) in routes.items():
            with self.subTest(rota=path):
                response = self.post(path, payload)

                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.get_json(), {**extra, "face_detected": False, "erro": UNAVAILABLE})
                self.assertNotIn(self.empty_dir, response.get_data(as_text=True))
        self.deepface.build_model.assert_not_called()
        self.deepface.represent.assert_not_called()
        line = self.assert_logged("model_unavailable", "face_detection")
        self.assertIn(f"haar_file={FACE_FILE}", line)
        self.assertIn("haar_status=missing", line)

    def test_falha_nao_fica_em_cache_e_o_detector_volta_quando_o_arquivo_existe(self):
        self.assertEqual(self.verify().status_code, 503)

        with patch.object(cv2.data, "haarcascades", REAL_HAAR_DIR):
            response = self.verify()

        self.assert_verify_failure(response, 400, NO_FACE, "no_face", "face_detection")


class OriginalBehaviorTests(FaceProcessingTestCase):
    def test_rosto_detectado_segue_para_o_mesmo_modelo_com_os_mesmos_parametros(self):
        response = self.verify()

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["match"])
        self.deepface.represent.assert_called_once_with(
            img_path=ANY, model_name=main.MODEL, detector_backend=main.DETECTOR, enforce_detection=True
        )


class RealClassifierNoFaceTests(FaceProcessingTestCase, HaarDirTestCase):
    use_fake_cascade = False

    def setUp(self):
        FaceProcessingTestCase.setUp(self)
        HaarDirTestCase.setUp(self)

    def test_sem_rosto_com_o_classificador_real_carregado(self):
        response = self.verify()

        self.assert_verify_failure(response, 400, NO_FACE, "no_face", "face_detection")
        self.assertFalse(main._FACE_CASCADE.empty())
        self.deepface.represent.assert_not_called()


class BuildCheckTests(HaarDirTestCase):
    def setUp(self):
        super().setUp()
        self.check = check_module()
        self.deepface = MagicMock(name="DeepFace")
        module = types.ModuleType("deepface")
        module.DeepFace = self.deepface
        active = patch.dict(sys.modules, {"deepface": module})
        active.start()
        self.addCleanup(active.stop)

    def distributions(self, names):
        active = patch.object(self.check, "installed_opencv_distributions", return_value=names)
        active.start()
        self.addCleanup(active.stop)

    def test_instalacao_correta_passa_e_carrega_o_detector_do_deepface(self):
        self.distributions(["opencv-python-headless"])

        self.assertEqual(self.check.check_installation(), [])
        self.deepface.build_model.assert_called_once_with(model_name=main.DETECTOR, task="face_detector")

    def test_duas_distribuicoes_opencv_reprovam(self):
        self.distributions(["opencv-python", "opencv-python-headless"])

        problems = self.check.check_installation()

        self.assertEqual(len(problems), 1)
        self.assertIn("opencv-python", problems[0])

    def test_variante_contrib_junto_do_headless_reprova(self):
        # Exatamente o que o primeiro build real encontrou.
        self.distributions(["opencv-contrib-python-headless", "opencv-python-headless"])

        problems = self.check.check_installation()

        self.assertEqual(len(problems), 1)
        self.assertIn("opencv-contrib-python-headless", problems[0])
        self.deepface.build_model.assert_not_called()

    def test_nenhuma_distribuicao_opencv_reprova(self):
        self.distributions([])

        self.assertEqual(len(self.check.check_installation()), 1)

    def test_haar_ausente_reprova_os_dois_arquivos(self):
        self.distributions(["opencv-python-headless"])
        self.use_haar_dir()

        problems = self.check.check_installation()

        self.assertEqual(len(problems), 2)
        self.assertIn(FACE_FILE, problems[0])
        self.assertIn(EYE_FILE, problems[1])
        self.deepface.build_model.assert_not_called()

    def test_haar_invalido_reprova(self):
        self.distributions(["opencv-python-headless"])
        self.use_haar_dir(EYE_FILE, invalid=[FACE_FILE])

        problems = self.check.check_installation()

        self.assertEqual(len(problems), 1)
        self.assertIn("invalid", problems[0])

    def test_deepface_que_nao_importa_reprova(self):
        self.distributions(["opencv-python-headless"])
        broken = types.ModuleType("deepface")

        def missing(name):
            raise ModuleNotFoundError("No module named 'pandas'", name="pandas")

        broken.__getattr__ = missing
        with patch.dict(sys.modules, {"deepface": broken}):
            problems = self.check.check_installation()

        self.assertEqual(len(problems), 1)
        self.assertIn("ModuleNotFoundError", problems[0])

    def test_run_devolve_1_e_lista_os_problemas(self):
        self.distributions(["opencv-python", "opencv-python-headless"])
        err = io.StringIO()

        with redirect_stderr(err):
            self.assertEqual(self.check.run(), 1)

        self.assertIn("ERRO", err.getvalue())

    def test_run_devolve_0_quando_tudo_carrega(self):
        self.distributions(["opencv-python-headless"])
        out = io.StringIO()

        with redirect_stdout(out):
            self.assertEqual(self.check.run(), 0)

        self.assertIn(cv2.__version__, out.getvalue())

    def test_lista_distribuicoes_opencv_instaladas(self):
        names = self.check.installed_opencv_distributions()

        self.assertEqual(names, sorted(set(names)))
        self.assertTrue(all(name.startswith("opencv") for name in names))


class BuildRecipeTests(unittest.TestCase):
    """Receita do build: OpenCV 4.x fixado, uma unica distribuicao e verificacao antes de publicar."""

    def read(self, name):
        return (FACE_DIR / name).read_text(encoding="utf-8")

    def pins(self):
        lines = [line.split("#")[0].strip() for line in self.read("constraints.txt").splitlines()]
        return dict(line.split("==") for line in lines if "==" in line)

    def test_constraints_fixam_as_duas_variantes_na_mesma_versao_4x(self):
        pins = self.pins()

        # OpenCV: as duas variantes fixadas na mesma versao 4.x. DeepFace: a versao validada do anti-spoofing.
        self.assertEqual(set(pins), {"opencv-python-headless", "opencv-python", "deepface"})
        self.assertEqual(pins["deepface"], "0.0.105")
        self.assertEqual(pins["opencv-python-headless"], pins["opencv-python"])
        self.assertTrue(pins["opencv-python-headless"].startswith("4."))

    def test_requirements_aplicam_as_constraints_e_mantem_deepface_e_tensorflow(self):
        lines = [line.strip() for line in self.read("requirements.txt").splitlines()]

        self.assertIn("-c constraints.txt", lines)
        for unchanged in ("deepface>=0.0.93", "tensorflow>=2.15.0", "tf-keras>=2.21.0"):
            self.assertIn(unchanged, lines)

    OPENCV_VARIANTS = {
        "opencv-python",
        "opencv-python-headless",
        "opencv-contrib-python",
        "opencv-contrib-python-headless",
    }

    def test_dockerfile_remove_as_quatro_variantes_depois_de_todas_as_dependencias(self):
        dockerfile = self.read("Dockerfile")
        uninstalls = list(re.finditer(r"pip uninstall -y ([^\\\n&]+)", dockerfile))

        self.assertEqual(len(uninstalls), 1)
        self.assertEqual(set(uninstalls[0].group(1).split()), self.OPENCV_VARIANTS)
        cleanup = uninstalls[0].start()
        self.assertLess(dockerfile.index("pip install --no-cache-dir -r requirements.txt"), cleanup)
        # Depois da limpeza, so o headless volta e sem dependencias: nada pode reinstalar outra variante.
        installs_after = [
            dockerfile[match.start():dockerfile.index("\n", match.start())].strip()
            for match in re.finditer(r"pip install", dockerfile)
            if match.start() > cleanup
        ]
        self.assertEqual(installs_after, ["pip install --no-cache-dir --no-deps -c constraints.txt opencv-python-headless"])

    def test_dockerfile_deixa_so_o_headless_e_verifica_antes_de_publicar(self):
        dockerfile = self.read("Dockerfile")
        steps = [
            "COPY requirements.txt constraints.txt ./",
            "pip install --no-cache-dir -r requirements.txt",
            "pip uninstall -y opencv-python opencv-python-headless opencv-contrib-python opencv-contrib-python-headless",
            "pip install --no-cache-dir --no-deps -c constraints.txt opencv-python-headless",
            "COPY main.py check_opencv.py ./",
            "RUN python check_opencv.py",
            "CMD exec gunicorn",
        ]
        positions = [dockerfile.find(step) for step in steps]

        self.assertNotIn(-1, positions, dict(zip(steps, positions)))
        self.assertEqual(positions, sorted(positions))

    def test_dockerfile_mantem_modelo_detector_limiar_e_servidor(self):
        dockerfile = self.read("Dockerfile")

        for line in ("ENV FACE_MODEL=VGG-Face", "ENV FACE_DETECTOR=opencv", "ENV FACE_MATCH_THRESHOLD=0.4"):
            self.assertIn(line, dockerfile)
        self.assertRegex(dockerfile, re.compile(r"--workers 1 --threads 4 --timeout 120 main:app"))


if __name__ == "__main__":
    unittest.main()
