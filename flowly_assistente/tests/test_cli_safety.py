"""Seguranca do modo CLI (flowly_assistant/assistant.py), com as mesmas travas do assistente web.

- delete_task nunca executa pelo CLI, com a chave de escrita ligada ou desligada.
- Com FLOWLY_ASSISTANT_WRITES_ENABLED desligada, toda escrita e recusada logo apos o reconhecimento: sem perguntar
  parametros, sem resolver nomes na API, sem pedir confirmacao e sem chamar a API.
- Com a chave ligada, escrita permitida continua exigindo permissao e confirmacao explicita.
- Consultas continuam funcionando.

Microfone, voz sintetizada e API sao simulados: nada sai da maquina e nenhum dado real e lido ou alterado.
"""

import builtins
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from flowly_assistant.api_client import APIError
from flowly_assistant.assistant import FlowlyAssistant
from flowly_assistant.command_parser import CommandParser
from flowly_assistant.commands import (
    DISABLED_COMMAND_REPLY,
    WRITES_DISABLED_REPLY,
    WRITES_ENABLED_ENV,
)
from flowly_assistant.speech_service import SpeechResult

TEAM_ID = "a" * 24
TASK_ID = "b" * 24
TEAM = {"_id": TEAM_ID, "nome": "Alfa"}
TASK = {"_id": TASK_ID, "descricao": "Relatorio final", "status": "pendente", "equipe": TEAM}

WRITE_METHODS = {
    "assign_to_me", "update_status", "timer", "add_comment", "add_subtask", "create_team", "create_task", "delete_task",
}


class UnexpectedPrompt(BaseException):
    """O CLI pediu entrada do usuario num cenario em que deveria recusar antes (BaseException: nao e engolida)."""


class FakeAPI:
    """Registra cada chamada; escritas so devolvem ok. Nenhuma rede."""

    def __init__(self, user_type):
        self.user_type = user_type
        self.calls = []

    def _record(self, name, *args):
        self.calls.append((name, args))

    @property
    def writes(self):
        return [call for call in self.calls if call[0] in WRITE_METHODS]

    # Consultas
    def me(self):
        self._record("me")
        return {"nome": "Conta Ficticia", "tipo": self.user_type}

    def list_users(self):
        self._record("list_users")
        return []

    def search_users(self, q):
        self._record("search_users", q)
        return []

    def list_my_teams(self):
        self._record("list_my_teams")
        return [TEAM]

    def list_teams(self):
        self._record("list_teams")
        return [TEAM]

    def team_members(self, team_id):
        self._record("team_members", team_id)
        return []

    def team_messages(self, team_id):
        self._record("team_messages", team_id)
        return []

    def task_details(self, task_id):
        self._record("task_details", task_id)
        return {"tarefa": TASK}

    def my_tasks(self):
        self._record("my_tasks")
        return [TASK]

    def backlog(self):
        self._record("backlog")
        return []

    def list_tasks(self):
        self._record("list_tasks")
        return [TASK]

    # Escritas
    def __getattr__(self, name):
        if name in WRITE_METHODS:
            def write(*args, **kwargs):
                self._record(name, *args, *kwargs.values())
                return {"ok": True}
            return write
        raise AttributeError(name)


class FakeSpeech:
    """Comandos digitados (modo texto). Acabado o roteiro, diz 'sair' para encerrar o loop."""

    def __init__(self, lines):
        self.lines = list(lines)

    def listen_text_fallback(self, prompt=""):
        return SpeechResult(text=self.lines.pop(0) if self.lines else "sair")

    def listen_once(self):
        raise RuntimeError("sem microfone nos testes")


def make_cli(user_type, commands):
    cli = FlowlyAssistant.__new__(FlowlyAssistant)
    cli.settings = SimpleNamespace(text_only=True, debug=False, user_type=user_type)
    cli.tts = SimpleNamespace(speak_async=lambda text: None)
    cli.speech = FakeSpeech(commands)
    cli.parser = CommandParser(threshold=78)
    cli.api = FakeAPI(user_type)
    cli.user_type = user_type
    cli.said = []
    cli._say = cli.said.append
    cli._ask = cli.said.append
    return cli


def run_cli(user_type, commands, answers=None, writes=None):
    """Roda o loop real do CLI. answers: respostas de input() (confirmacoes e parametros); None = nenhuma esperada."""
    cli = make_cli(user_type, commands)
    queue = list(answers or [])

    def scripted_input(prompt=""):
        if answers is None or not queue:
            raise UnexpectedPrompt(prompt)
        return queue.pop(0)

    env = {WRITES_ENABLED_ENV: writes} if writes is not None else {}
    with patch.dict(os.environ, env, clear=False), patch.object(builtins, "input", scripted_input):
        if writes is None:
            os.environ.pop(WRITES_ENABLED_ENV, None)
        with patch("builtins.print"):
            cli.run()
    return cli


class CliTestCase(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.pop(WRITES_ENABLED_ENV, None)

    def tearDown(self):
        os.environ.pop(WRITES_ENABLED_ENV, None)
        if self._saved is not None:
            os.environ[WRITES_ENABLED_ENV] = self._saved

    def assertRecognizedAs(self, utterance, key):
        match = CommandParser(threshold=78).match(utterance)
        self.assertIsNotNone(match, utterance)
        self.assertEqual(match.command.key, key, utterance)


class DeleteTaskTests(CliTestCase):
    DELETE_PHRASES = (
        "excluir tarefa Relatorio final",
        "apagar tarefa Relatorio final",
        f"deletar tarefa {TASK_ID}",
        "excluir a tarefa relatorio final agora",
    )

    def test_phrases_are_recognized_as_delete(self):
        for phrase in self.DELETE_PHRASES:
            with self.subTest(phrase=phrase):
                self.assertRecognizedAs(phrase, "delete_task")

    def test_delete_never_runs_with_writes_on_or_off(self):
        for writes in (None, "false", "true", "1", "yes", "on"):
            for phrase in self.DELETE_PHRASES:
                with self.subTest(writes=writes, phrase=phrase):
                    cli = run_cli("admin", [phrase], writes=writes)

                    self.assertIn(DISABLED_COMMAND_REPLY, cli.said)
                    # Recusa antes de resolver nomes, perguntar ou confirmar: nenhuma chamada a API.
                    self.assertEqual(cli.api.calls, [])

    def test_execute_refuses_delete_even_when_called_directly(self):
        cli = make_cli("admin", [])
        match = CommandParser(threshold=78).match(f"excluir tarefa {TASK_ID}")
        os.environ[WRITES_ENABLED_ENV] = "true"

        with self.assertRaises(APIError) as ctx:
            cli._execute(match, {"task_id": TASK_ID})

        self.assertEqual(str(ctx.exception), DISABLED_COMMAND_REPLY)
        self.assertEqual(cli.api.calls, [])


class WritesSwitchOffTests(CliTestCase):
    WRITE_CASES = (
        ("user", "pegar tarefa Relatorio final", "assign_to_me"),
        ("user", "marcar como concluido a tarefa Relatorio final", "update_status"),
        ("user", "iniciar cronometro da tarefa Relatorio final", "timer"),
        ("user", "adicionar comentario na tarefa Relatorio final", "add_comment"),
        ("user", "nova subtarefa na tarefa Relatorio final", "add_subtask"),
        ("admin", "criar equipe Beta", "create_team"),
        ("admin", "criar tarefa Revisar documento", "create_task"),
        # Sem parametros: mesmo assim nada e perguntado.
        ("user", "atualizar status", "update_status"),
        ("user", "comentar", "add_comment"),
    )

    def test_every_write_is_refused_before_params_api_or_confirmation(self):
        for writes in (None, "", "false", "0", "no", "off", "talvez"):
            for user_type, phrase, key in self.WRITE_CASES:
                with self.subTest(writes=writes, phrase=phrase):
                    self.assertRecognizedAs(phrase, key)

                    cli = run_cli(user_type, [phrase], writes=writes)

                    self.assertIn(WRITES_DISABLED_REPLY, cli.said)
                    self.assertEqual(cli.api.calls, [])
                    self.assertFalse(any("Confirma" in line for line in cli.said))

    def test_message_explains_nothing_was_changed(self):
        cli = run_cli("user", ["pegar tarefa Relatorio final"])

        self.assertIn("Nada foi alterado", WRITES_DISABLED_REPLY)
        self.assertEqual(cli.said[-2], WRITES_DISABLED_REPLY)
        self.assertEqual(cli.said[-1], "Encerrando. Até mais!")

    def test_execute_refuses_write_when_switch_is_off(self):
        cli = make_cli("user", [])
        match = CommandParser(threshold=78).match("pegar tarefa Relatorio final")

        with self.assertRaises(APIError) as ctx:
            cli._execute(match, {"task_id": TASK_ID})

        self.assertEqual(str(ctx.exception), WRITES_DISABLED_REPLY)
        self.assertEqual(cli.api.writes, [])

    def test_switch_is_read_on_each_command(self):
        command = CommandParser(threshold=78).match("pegar tarefa Relatorio final").command

        self.assertEqual(FlowlyAssistant._blocked_reply(command), WRITES_DISABLED_REPLY)
        os.environ[WRITES_ENABLED_ENV] = "true"
        self.assertIsNone(FlowlyAssistant._blocked_reply(command))
        os.environ[WRITES_ENABLED_ENV] = "false"
        self.assertEqual(FlowlyAssistant._blocked_reply(command), WRITES_DISABLED_REPLY)


class ReadsKeepWorkingTests(CliTestCase):
    READ_CASES = (
        ("user", "minhas tarefas", "my_tasks"),
        ("user", "backlog", "backlog"),
        ("user", "meu perfil", "me"),
        ("user", "minhas equipes", "list_my_teams"),
        ("admin", "listar tarefas", "list_tasks"),
        ("admin", "listar equipes", "list_teams"),
    )

    def test_reads_run_with_switch_off_after_confirmation(self):
        for user_type, phrase, api_method in self.READ_CASES:
            with self.subTest(phrase=phrase):
                cli = run_cli(user_type, [phrase], answers=["sim"])

                self.assertIn(api_method, [name for name, _ in cli.api.calls])
                self.assertEqual(cli.api.writes, [])
                self.assertNotIn(WRITES_DISABLED_REPLY, cli.said)

    def test_read_with_reference_resolves_and_runs(self):
        cli = run_cli("user", ["detalhes da tarefa Relatorio final"], answers=["sim"])

        self.assertIn(("task_details", (TASK_ID,)), cli.api.calls)
        self.assertEqual(cli.api.writes, [])


class WritesSwitchOnTests(CliTestCase):
    # assign_to_me pede a equipe ("Alfa") antes da confirmacao.
    def test_allowed_write_runs_only_after_explicit_yes(self):
        cli = run_cli("user", ["pegar tarefa Relatorio final"], answers=["Alfa", "sim"], writes="true")

        self.assertEqual(cli.api.writes, [("assign_to_me", (TASK_ID,))])
        self.assertTrue(any("Confirma" in line for line in cli.said))

    def test_no_answer_cancels_the_write(self):
        cli = run_cli("user", ["pegar tarefa Relatorio final"], answers=["Alfa", "nao"], writes="true")

        self.assertEqual(cli.api.writes, [])

    def test_unclear_answers_cancel_the_write(self):
        cli = run_cli("user", ["pegar tarefa Relatorio final"], answers=["Alfa", "talvez", "hum"], writes="true")

        self.assertEqual(cli.api.writes, [])

    def test_permission_is_still_checked(self):
        admin_on_user_write = run_cli("admin", ["pegar tarefa Relatorio final"], writes="true")
        user_on_admin_write = run_cli("user", ["criar equipe Beta"], writes="true")

        for cli in (admin_on_user_write, user_on_admin_write):
            self.assertIn("Você não tem permissão para esse comando.", cli.said)
            self.assertEqual(cli.api.calls, [])


class AmbiguousRecognitionTests(CliTestCase):
    def test_negated_or_incidental_delete_phrases_do_nothing(self):
        for phrase in ("não excluir tarefa", "nao quero excluir tarefa", "não, apagar tarefa"):
            for writes in (None, "true"):
                with self.subTest(phrase=phrase, writes=writes):
                    cli = run_cli("admin", [phrase], writes=writes)

                    self.assertEqual(cli.api.calls, [])
                    self.assertNotIn("Ação concluída com sucesso.", cli.said)

    def test_any_phrase_recognized_as_write_is_refused_while_switch_is_off(self):
        # Variacoes aproximadas: qualquer uma que o parser reconheca como escrita cai na recusa, sem chamar a API.
        for phrase in ("assumir tarefa relatorio", "pegar a tarefa relatorio final pra mim", "criar uma equipe nova"):
            match = CommandParser(threshold=78).match(phrase)
            if match is None or match.command.method not in {"POST", "PUT", "PATCH", "DELETE"}:
                continue
            with self.subTest(phrase=phrase):
                cli = run_cli("admin" if match.command.role_required == "admin" else "user", [phrase])

                self.assertIn(WRITES_DISABLED_REPLY, cli.said)
                self.assertEqual(cli.api.calls, [])

    def test_unrecognized_phrase_asks_to_repeat_and_calls_nothing(self):
        cli = run_cli("user", ["bom dia, tudo bem?"])

        self.assertIn("Não consegui identificar o comando. Pode repetir?", cli.said)
        self.assertEqual(cli.api.calls, [])


class ConfirmationAnswerTests(CliTestCase):
    """So "sim", "confirmo" ou "sim, confirmo" (resposta inteira, normalizada) autorizam; nada por prefixo."""

    POSITIVE = ("sim", "Sim", "  SIM  ", "sim!", "Sim.", "confirmo", "Confirmo.", "sim, confirmo", "Sim confirmo")
    AMBIGUOUS = (
        "sei lá", "só um momento", "será", "talvez", "s", "si", "simmm", "sim mas espera", "sim pode ser",
        "sim não", "sair", "sério", "sabe", "pode", "ok", "isso", "correto", "claro", "hum", "", "   ",
        "confirmo depois", "não sim",
    )
    NEGATIVE = ("não", "nao", "Não!", "n", "negativo", "cancela", "cancelar", "não sei", "nao confirmo", "cancele isso")

    def test_classification_of_answers(self):
        from flowly_assistant.assistant import classify_answer

        for answer in self.POSITIVE:
            with self.subTest(answer=answer):
                self.assertIs(classify_answer(answer), True)
        for answer in self.NEGATIVE:
            with self.subTest(answer=answer):
                self.assertIs(classify_answer(answer), False)
        # "não sim" comeca com negativa: cancela (lado seguro). O resto nao e confirmacao nem negativa.
        for answer in self.AMBIGUOUS:
            with self.subTest(answer=answer):
                self.assertIsNot(classify_answer(answer), True)
                if answer != "não sim":
                    self.assertIsNone(classify_answer(answer))

    def test_ambiguous_answers_never_execute_a_write(self):
        for answer in self.AMBIGUOUS:
            with self.subTest(answer=answer):
                cli = run_cli("user", ["pegar tarefa Relatorio final"], answers=["Alfa", answer, answer], writes="true")

                self.assertEqual(cli.api.writes, [])
                self.assertNotIn("Ação concluída com sucesso.", cli.said)

    def test_two_unclear_answers_cancel_even_if_a_yes_comes_later(self):
        cli = run_cli("user", ["pegar tarefa Relatorio final"], answers=["Alfa", "talvez", "sei lá", "sim"], writes="true")

        self.assertEqual(cli.api.writes, [])
        self.assertEqual(cli.said.count("Não entendi. Responda sim ou não."), 2)
        self.assertIn("Tudo bem. Vou ouvir novamente.", cli.said)

    def test_negative_answers_cancel_without_writing(self):
        for answer in self.NEGATIVE:
            with self.subTest(answer=answer):
                cli = run_cli("user", ["pegar tarefa Relatorio final"], answers=["Alfa", answer], writes="true")

                self.assertEqual(cli.api.writes, [])
                self.assertIn("Tudo bem. Vou ouvir novamente.", cli.said)

    def test_explicit_confirmations_execute_exactly_once(self):
        for answer in ("Sim.", "sim, confirmo", "CONFIRMO"):
            with self.subTest(answer=answer):
                cli = run_cli("user", ["pegar tarefa Relatorio final"], answers=["Alfa", answer], writes="true")

                self.assertEqual(cli.api.writes, [("assign_to_me", (TASK_ID,))])

    def test_unclear_then_explicit_yes_within_the_limit_executes(self):
        cli = run_cli("user", ["pegar tarefa Relatorio final"], answers=["Alfa", "talvez", "sim"], writes="true")

        self.assertEqual(cli.api.writes, [("assign_to_me", (TASK_ID,))])

    def test_ambiguous_answer_does_not_run_reads_either(self):
        cli = run_cli("user", ["minhas tarefas"], answers=["sei lá", "só um momento"])

        self.assertNotIn("my_tasks", [name for name, _ in cli.api.calls])

    def test_blocked_commands_never_reach_the_confirmation(self):
        for phrase, writes in ((f"excluir tarefa {TASK_ID}", "true"), ("pegar tarefa Relatorio final", None)):
            with self.subTest(phrase=phrase):
                cli = run_cli("admin" if "excluir" in phrase else "user", [phrase], writes=writes)

                self.assertFalse(any("Confirma" in line for line in cli.said))
                self.assertEqual(cli.api.calls, [])


class RoleListingTests(CliTestCase):
    def test_listar_tarefas_follows_the_profile(self):
        for user_type, api_method in (("user", "my_tasks"), ("admin", "list_tasks")):
            with self.subTest(user_type=user_type):
                cli = run_cli(user_type, ["listar tarefas"], answers=["sim"])
                self.assertEqual([name for name, _ in cli.api.calls], [api_method])
                self.assertNotIn("Você não tem permissão para esse comando.", cli.said)
                self.assertEqual(cli.api.writes, [])


class TaskPeriodQueryTests(CliTestCase):
    def test_period_queries_only_read_my_tasks_even_with_writes_on(self):
        for writes in (None, "true"):
            with self.subTest(writes=writes):
                # O CLI confirma cada comando (erro de transcricao), inclusive leituras.
                cli = run_cli("user", ["tarefas atrasadas", "o que tenho para hoje?"], answers=["sim", "sim"], writes=writes)
                self.assertEqual(cli.api.calls, [("my_tasks", ()), ("my_tasks", ())])
                self.assertEqual(cli.api.writes, [])
                # A tarefa ficticia nao tem prazo: nao e atrasada nem de hoje (nada inventado).
                self.assertIn("Você não tem tarefas atrasadas.", cli.said)
                self.assertIn("Você não tem tarefas previstas para hoje.", cli.said)


if __name__ == "__main__":
    unittest.main()
