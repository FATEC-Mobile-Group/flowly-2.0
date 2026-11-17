"""Pesos do VGG-Face dentro da imagem: download verificado no build, nada de download em execucao,
medicoes de tempo sem dados biometricos e pre-carregamento do modelo.

Servidor HTTP local, arquivos sinteticos e DeepFace falso: nada sai da maquina e nenhum modelo real e baixado.
"""

import hashlib
import importlib
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("FACE_SERVICE_SECRET", "segredo-de-teste")

import main  # noqa: E402
from test_face_processing import DATA_URL, RAW_BASE64, REFERENCE, UNAVAILABLE, FaceProcessingTestCase  # noqa: E402

FACE_DIR = Path(main.__file__).resolve().parent
PAYLOAD = b"pesos-sinteticos-" * 4096
PAYLOAD_SHA256 = hashlib.sha256(PAYLOAD).hexdigest()


def remove_tree(path):
    # Os pesos sao gravados somente leitura; no Windows o rmtree nao apaga esses arquivos sem liberar a escrita.
    for root, _dirs, files in os.walk(path):
        for name in files:
            os.chmod(os.path.join(root, name), stat.S_IREAD | stat.S_IWRITE)
    shutil.rmtree(path, ignore_errors=True)


def fetch_module():
    return importlib.import_module("fetch_face_weights")


def check_module():
    return importlib.import_module("check_face_model")


class _Handler(BaseHTTPRequestHandler):
    routes = {}

    def do_GET(self):  # noqa: N802 - nome da API do http.server
        body = self.routes.get(self.path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class WeightServerTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _Handler.routes = {
            "/ok.h5": PAYLOAD,
            "/outro.h5": b"x" * len(PAYLOAD),
            "/curto.h5": PAYLOAD[:-10],
        }
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="deepface-home-")
        self.addCleanup(remove_tree, self.home)
        self.target_dir = os.path.join(self.home, ".deepface", "weights")

    def fetch(self, *paths):
        return fetch_module().fetch_weights(
            [f"{self.base}{path}" for path in paths], self.target_dir, PAYLOAD_SHA256, len(PAYLOAD)
        )

    def leftovers(self):
        return sorted(os.listdir(self.target_dir)) if os.path.isdir(self.target_dir) else []


class FetchWeightsTests(WeightServerTestCase):
    def test_baixa_confere_e_grava_somente_leitura_no_caminho_do_deepface(self):
        path = self.fetch("/ok.h5")

        self.assertEqual(path, os.path.join(self.target_dir, "vgg_face_weights.h5"))
        self.assertEqual(Path(path).read_bytes(), PAYLOAD)
        self.assertFalse(os.access(path, os.W_OK))
        self.assertEqual(self.leftovers(), ["vgg_face_weights.h5"])

    def test_usa_o_espelho_quando_a_primeira_origem_falha(self):
        path = self.fetch("/nao-existe.h5", "/ok.h5")

        self.assertEqual(Path(path).read_bytes(), PAYLOAD)

    # O motivo aparece no log do build: quem ler precisa saber se o arquivo veio truncado ou diferente.
    def test_hash_diferente_falha_sem_deixar_arquivo(self):
        with self.assertRaisesRegex(fetch_module().WeightsError, "SHA-256"):
            self.fetch("/outro.h5")

        self.assertEqual(self.leftovers(), [])

    def test_arquivo_truncado_falha_sem_deixar_arquivo(self):
        with self.assertRaisesRegex(fetch_module().WeightsError, "tamanho"):
            self.fetch("/curto.h5")

        self.assertEqual(self.leftovers(), [])

    def test_arquivo_ja_valido_nao_e_baixado_de_novo(self):
        os.makedirs(self.target_dir)
        Path(self.target_dir, "vgg_face_weights.h5").write_bytes(PAYLOAD)

        path = self.fetch("/nao-existe.h5")

        self.assertEqual(Path(path).read_bytes(), PAYLOAD)

    def test_arquivo_corrompido_e_substituido(self):
        os.makedirs(self.target_dir)
        Path(self.target_dir, "vgg_face_weights.h5").write_bytes(b"corrompido")

        path = self.fetch("/ok.h5")

        self.assertEqual(Path(path).read_bytes(), PAYLOAD)

    def test_hash_e_tamanho_fixados_sao_os_da_release_oficial(self):
        module = fetch_module()

        self.assertEqual(module.PINNED_SHA256, "759266b9614d0fd5d65b97bf716818b746cc77ab5944c7bffc937c6ba9455d8c")
        self.assertEqual(module.PINNED_SIZE, 580085408)
        self.assertEqual(module.WEIGHTS_FILE, "vgg_face_weights.h5")

    def test_pesos_do_anti_spoofing_fixados_e_iguais_aos_que_o_servico_exige(self):
        module = fetch_module()

        self.assertEqual(
            module.FASNET_WEIGHTS,
            (
                ("2.7_80x80_MiniFASNetV2.h5", "da0de51d44dc3d9af808c6c2f6fe97dd174774fa66881c9fd291bde1a1174e04", 2234368, "FIRST_WEIGHTS_URL"),
                ("4_0_0_80x80_MiniFASNetV1SE.h5", "d2f4280c30d88dbd02d0d6691dcfbdd389316de398f94bb6cba30144e23889b0", 2288392, "SECOND_WEIGHTS_URL"),
            ),
        )
        self.assertEqual(tuple(name for name, *_ in module.FASNET_WEIGHTS), main.ANTI_SPOOFING_WEIGHT_FILES)
        self.assertEqual(
            [name for name, *_ in module.required_weights()],
            ["vgg_face_weights.h5", *main.ANTI_SPOOFING_WEIGHT_FILES],
        )

    def test_grava_cada_arquivo_com_o_proprio_nome(self):
        path = fetch_module().fetch_weights(
            [f"{self.base}/ok.h5"], self.target_dir, PAYLOAD_SHA256, len(PAYLOAD), "2.7_80x80_MiniFASNetV2.h5"
        )

        self.assertEqual(path, os.path.join(self.target_dir, "2.7_80x80_MiniFASNetV2.h5"))
        self.assertEqual(Path(path).read_bytes(), PAYLOAD)

    def test_origens_vem_do_deepface_instalado(self):
        module = fetch_module()
        lista = type("M", (), {"WEIGHTS_URL": ["https://a/vgg_face_weights.h5", "https://b/vgg_face_weights.h5"]})
        texto = type("M", (), {"WEIGHTS_URL": "https://a/vgg_face_weights.h5"})

        self.assertEqual(module.urls_from(lista), ["https://a/vgg_face_weights.h5", "https://b/vgg_face_weights.h5"])
        self.assertEqual(module.urls_from(texto), ["https://a/vgg_face_weights.h5"])

    def test_pasta_igual_a_do_deepface(self):
        module = fetch_module()
        with patch.dict(os.environ, {"DEEPFACE_HOME": "/opt/deepface"}):
            self.assertEqual(module.deepface_weights_dir(), os.path.join("/opt/deepface", ".deepface", "weights"))
        env = {key: value for key, value in os.environ.items() if key != "DEEPFACE_HOME"}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(module.deepface_weights_dir(), os.path.join(os.path.expanduser("~"), ".deepface", "weights"))


class RuntimeWeightsGuardTests(FaceProcessingTestCase):
    def setUp(self):
        super().setUp()
        self.home = tempfile.mkdtemp(prefix="deepface-home-")
        self.addCleanup(remove_tree, self.home)
        for active in (patch.object(main, "_MODEL_READY", False), patch.dict(os.environ, {"DEEPFACE_HOME": self.home})):
            active.start()
            self.addCleanup(active.stop)

    def place_weights(self):
        folder = Path(self.home, ".deepface", "weights")
        folder.mkdir(parents=True)
        # Producao exige os pesos do VGG-Face e os dois do anti-spoofing.
        for name in ("vgg_face_weights.h5", *main.ANTI_SPOOFING_WEIGHT_FILES):
            Path(folder, name).write_bytes(b"pesos")

    def test_caminho_e_o_do_deepface(self):
        self.assertEqual(main.model_weights_path(), os.path.join(self.home, ".deepface", "weights", "vgg_face_weights.h5"))

    def test_imagem_de_producao_sem_pesos_responde_503_sem_tentar_baixar(self):
        with patch.dict(os.environ, {"FACE_REQUIRE_LOCAL_WEIGHTS": "1"}):
            response = self.verify()

        line = self.assert_verify_failure(response, 503, UNAVAILABLE, "model_unavailable", "model_load")
        self.assertIn("weights=missing", line)
        self.assertNotIn(self.home, line)
        self.deepface.build_model.assert_not_called()

    def test_imagem_de_producao_com_pesos_carrega_o_modelo(self):
        self.place_weights()
        with patch.dict(os.environ, {"FACE_REQUIRE_LOCAL_WEIGHTS": "1"}):
            response = self.verify()

        self.assertEqual(response.status_code, 200)
        self.deepface.build_model.assert_any_call(main.MODEL)

    def test_desenvolvimento_local_continua_como_antes(self):
        env = {key: value for key, value in os.environ.items() if key != "FACE_REQUIRE_LOCAL_WEIGHTS"}
        with patch.dict(os.environ, env, clear=True):
            response = self.verify()

        self.assertEqual(response.status_code, 200)
        self.deepface.build_model.assert_any_call(main.MODEL)


class TimingTests(FaceProcessingTestCase):
    def timing_lines(self):
        return [line for line in self.logs.lines if line.startswith("face_timing ")]

    @staticmethod
    def fields(line):
        return dict(item.split("=", 1) for item in line.split()[1:])

    def test_requisicao_registra_cada_etapa_sem_dados_biometricos(self):
        with patch.object(main, "_MODEL_READY", True):
            response = self.verify()

        self.assertEqual(response.status_code, 200)
        lines = self.timing_lines()
        self.assertEqual(len(lines), 1, self.logs.lines)
        fields = self.fields(lines[0])
        self.assertEqual(fields["path"], "/verify")
        self.assertEqual(fields["status"], "200")
        for stage in ("total_ms", "decode_ms", "detect_ms", "embed_ms", "compare_ms"):
            self.assertGreaterEqual(float(fields[stage]), 0, stage)
        self.assertNotIn("model_ms", fields)
        for forbidden in (RAW_BASE64[:40], "0.7311", "0.2417", "segredo"):
            self.assertNotIn(forbidden, lines[0])

    def test_primeira_carga_do_modelo_aparece_na_requisicao_e_uma_unica_vez(self):
        with patch.object(main, "_MODEL_READY", False):
            self.verify()
            self.verify()

        loads = [line for line in self.logs.lines if line.startswith("face_model_load ")]
        self.assertEqual(len(loads), 1, self.logs.lines)
        self.assertIn("import_ms=", loads[0])
        self.assertIn("build_ms=", loads[0])
        first, second = (self.fields(line) for line in self.timing_lines())
        self.assertIn("model_ms", first)
        self.assertNotIn("model_ms", second)

    def test_falha_tambem_registra_o_tempo_total(self):
        self.verify(image="data:image/jpeg;base64,@@@@")
        self.post("/verify", {"reference_embedding": REFERENCE, "image_base64": DATA_URL}, secret="errado")

        statuses = [self.fields(line)["status"] for line in self.timing_lines()]
        self.assertEqual(statuses, ["400", "401"])

    def test_health_nao_registra_tempo(self):
        self.client.get("/health")

        self.assertEqual(self.timing_lines(), [])


class PreloadTests(FaceProcessingTestCase):
    def test_pre_carrega_e_registra_o_tempo_de_inicializacao_quando_habilitado(self):
        with patch.object(main, "_MODEL_READY", False), patch.dict(os.environ, {"FACE_PRELOAD_MODEL": "1"}):
            main.preload_model_if_enabled()

        self.deepface.build_model.assert_any_call(main.MODEL)
        main.get_face_cascade.assert_called()
        startup = [line for line in self.logs.lines if line.startswith("face_startup ")]
        self.assertEqual(len(startup), 1, self.logs.lines)
        self.assertIn("model_ready=true", startup[0])
        self.assertIn("total_ms=", startup[0])

    def test_sem_a_variavel_nao_carrega_nada(self):
        env = {key: value for key, value in os.environ.items() if key != "FACE_PRELOAD_MODEL"}
        with patch.dict(os.environ, env, clear=True):
            main.preload_model_if_enabled()

        self.deepface.build_model.assert_not_called()

    def development_env(self, **extra):
        env = {key: value for key, value in os.environ.items() if key != "FACE_REQUIRE_LOCAL_WEIGHTS"}
        return patch.dict(os.environ, {**env, "FACE_PRELOAD_MODEL": "1", **extra}, clear=True)

    def production_env(self, **extra):
        return patch.dict(os.environ, {"FACE_PRELOAD_MODEL": "1", "FACE_REQUIRE_LOCAL_WEIGHTS": "1", **extra})

    def test_em_desenvolvimento_falha_no_pre_carregamento_nao_derruba_o_processo(self):
        self.deepface.build_model.side_effect = ValueError("pesos corrompidos /opt/deepface")
        with patch.object(main, "_MODEL_READY", False), self.development_env():
            main.preload_model_if_enabled()

        startup = [line for line in self.logs.lines if line.startswith("face_startup ")]
        self.assertIn("model_ready=false", startup[0])
        self.assertNotIn("/opt/deepface", "\n".join(self.logs.lines))

    def assert_startup_fails(self):
        with self.assertRaises(main.ModelPreloadError) as ctx:
            main.preload_model_if_enabled()
        logged = "\n".join(self.logs.lines)
        for forbidden in ("/opt/deepface", "segredo", "0.7311"):
            self.assertNotIn(forbidden, str(ctx.exception))
            self.assertNotIn(forbidden, logged)
        startup = [line for line in self.logs.lines if line.startswith("face_startup ")]
        self.assertIn("model_ready=false", startup[0])
        return ctx.exception

    def test_em_producao_vgg_face_que_nao_carrega_derruba_a_inicializacao(self):
        self.deepface.build_model.side_effect = ValueError("pesos corrompidos /opt/deepface segredo")
        with patch.object(main, "_MODEL_READY", False), self.production_env():
            self.assert_startup_fails()

        self.assert_logged("model_unavailable", "model_load")

    def test_em_producao_haar_que_nao_carrega_derruba_a_inicializacao(self):
        missing = main.FaceProcessingError(
            "model_unavailable", "face_detection", "Classificador facial ausente",
            haar_file=main.HAAR_FACE_FILE, haar_status="missing",
        )
        with patch.object(main, "_MODEL_READY", False), patch.object(main, "get_face_cascade", side_effect=missing), self.production_env():
            self.assert_startup_fails()

        self.assert_logged("model_unavailable", "face_detection")

    def test_em_producao_sem_pesos_derruba_a_inicializacao_sem_tentar_carregar(self):
        empty_home = tempfile.mkdtemp(prefix="deepface-home-")
        self.addCleanup(remove_tree, empty_home)
        with patch.object(main, "_MODEL_READY", False), self.production_env(DEEPFACE_HOME=empty_home):
            self.assert_startup_fails()

        self.deepface.build_model.assert_not_called()
        self.assertIn("weights=missing", self.assert_logged("model_unavailable", "model_load"))

    def test_em_producao_com_tudo_carregado_sobe_normalmente(self):
        # Pasta propria com os tres arquivos: o teste nao depende dos pesos instalados nesta maquina.
        home = tempfile.mkdtemp(prefix="deepface-home-")
        self.addCleanup(remove_tree, home)
        folder = Path(home, ".deepface", "weights")
        folder.mkdir(parents=True)
        for name in ("vgg_face_weights.h5", *main.ANTI_SPOOFING_WEIGHT_FILES):
            Path(folder, name).write_bytes(b"pesos")
        with patch.object(main, "_MODEL_READY", False), self.production_env(DEEPFACE_HOME=home):
            main.preload_model_if_enabled()
            self.assertTrue(main._MODEL_READY)


class HealthReadinessTests(FaceProcessingTestCase):
    def health(self):
        response = self.client.get("/health")
        return response.status_code, response.get_json()

    def test_com_pre_carregamento_e_modelo_indisponivel_health_nao_sinaliza_sucesso(self):
        with patch.object(main, "_MODEL_READY", False), patch.dict(os.environ, {"FACE_PRELOAD_MODEL": "1"}):
            status, body = self.health()

        self.assertEqual(status, 503)
        self.assertEqual(body, {"status": "unavailable", "service": "flowly_iot_face"})

    def test_com_pre_carregamento_e_haar_indisponivel_health_nao_sinaliza_sucesso(self):
        missing = main.FaceProcessingError("model_unavailable", "face_detection", haar_status="missing")
        with patch.object(main, "_MODEL_READY", True), patch.object(main, "get_face_cascade", side_effect=missing), \
                patch.dict(os.environ, {"FACE_PRELOAD_MODEL": "1"}):
            status, _body = self.health()

        self.assertEqual(status, 503)

    def test_com_pre_carregamento_e_tudo_pronto_health_ok(self):
        with patch.object(main, "_MODEL_READY", True), patch.dict(os.environ, {"FACE_PRELOAD_MODEL": "1"}):
            status, body = self.health()

        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")

    def test_em_desenvolvimento_health_continua_como_antes(self):
        env = {key: value for key, value in os.environ.items() if key != "FACE_PRELOAD_MODEL"}
        with patch.object(main, "_MODEL_READY", False), patch.dict(os.environ, env, clear=True):
            status, body = self.health()

        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")


class ProcessStartupTests(unittest.TestCase):
    """O mesmo import que o worker do gunicorn faz: se lancar, o worker nao sobe e o gunicorn encerra."""

    def test_import_em_producao_sem_pesos_encerra_o_processo_sem_vazar_dados(self):
        empty_home = tempfile.mkdtemp(prefix="deepface-home-")
        self.addCleanup(remove_tree, empty_home)
        secret = "segredo-que-nao-pode-aparecer"
        env = {
            **os.environ,
            "FACE_PRELOAD_MODEL": "1",
            "FACE_REQUIRE_LOCAL_WEIGHTS": "1",
            "DEEPFACE_HOME": empty_home,
            "FACE_SERVICE_SECRET": secret,
            "PYTHONIOENCODING": "utf-8",
        }

        # Rede bloqueada no subprocesso: mesmo com a trava quebrada, o teste nunca baixa os pesos de verdade.
        result = subprocess.run(
            [sys.executable, "-c", "import check_face_model; check_face_model.block_network(); import main"],
            cwd=FACE_DIR, env=env,
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
        )

        output = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ModelPreloadError", output)
        self.assertIn("weights=missing", output)
        self.assertNotIn(secret, output)
        self.assertNotIn(empty_home, output)


class BuildModelCheckTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix="pesos-")
        self.addCleanup(remove_tree, self.folder)
        self.path = os.path.join(self.folder, "vgg_face_weights.h5")

    def test_arquivo_conferido_por_tamanho_e_hash(self):
        Path(self.path).write_bytes(PAYLOAD)

        self.assertEqual(check_module().check_weights_file(self.path, PAYLOAD_SHA256, len(PAYLOAD)), [])

    def test_ausente_tamanho_ou_hash_errado_reprovam(self):
        module = check_module()
        self.assertEqual(len(module.check_weights_file(self.path, PAYLOAD_SHA256, len(PAYLOAD))), 1)

        Path(self.path).write_bytes(PAYLOAD[:-1])
        self.assertIn("tamanho", module.check_weights_file(self.path, PAYLOAD_SHA256, len(PAYLOAD))[0])

        Path(self.path).write_bytes(b"y" * len(PAYLOAD))
        self.assertIn("SHA-256", module.check_weights_file(self.path, PAYLOAD_SHA256, len(PAYLOAD))[0])

    def test_rede_desligada_registra_qualquer_tentativa(self):
        module = check_module()
        attempts = module.block_network()
        try:
            import socket

            with self.assertRaises(OSError):
                socket.create_connection(("127.0.0.1", 9))
        finally:
            module.restore_network()

        self.assertEqual(len(attempts), 1)


class DockerRecipeTests(unittest.TestCase):
    def read(self, name):
        return (FACE_DIR / name).read_text(encoding="utf-8")

    def test_pesos_entram_no_build_antes_do_codigo_e_sao_verificados_sem_rede(self):
        dockerfile = self.read("Dockerfile")
        steps = [
            "pip install --no-cache-dir -r requirements.txt",
            "ENV DEEPFACE_HOME=/opt/deepface",
            "ENV DEEPFACE_BACKEND_ENGINE=tensorflow",
            # As verificacoes do build rodam com a mesma trava de producao.
            "ENV FACE_REQUIRE_LOCAL_WEIGHTS=1",
            "COPY fetch_face_weights.py ./",
            "RUN python fetch_face_weights.py",
            "COPY main.py check_opencv.py ./",
            "RUN python check_opencv.py",
            "COPY check_face_model.py ./",
            "RUN python check_face_model.py",
            # Depois das verificacoes: importar main.py nelas nao deve pre-carregar o modelo.
            "ENV FACE_PRELOAD_MODEL=1",
            "CMD exec gunicorn",
        ]
        positions = [dockerfile.find(step) for step in steps]

        self.assertNotIn(-1, positions, dict(zip(steps, positions)))
        self.assertEqual(positions, sorted(positions))

    def test_build_nao_libera_download_em_execucao(self):
        dockerfile = self.read("Dockerfile")

        self.assertNotIn("FACE_REQUIRE_LOCAL_WEIGHTS=0", dockerfile)
        self.assertNotIn("vgg_face_weights.h5", self.read(".dockerignore"))


if __name__ == "__main__":
    unittest.main()
