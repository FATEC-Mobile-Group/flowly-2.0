import unittest

from flowly_assistant.command_parser import CommandParser


WRITE_COMMANDS = {"create_task", "create_team", "assign_to_me", "update_status", "timer", "add_comment", "add_subtask", "delete_task"}


class CommandParserNegationTests(unittest.TestCase):
    """DC-02: frases negativas ou com palavras incidentais não podem disparar comandos."""

    def setUp(self):
        self.parser = CommandParser(threshold=78)

    def _key(self, utterance):
        match = self.parser.match(utterance)
        return match.command.key if match else None

    def test_negated_write_commands_do_not_match(self):
        for utterance in (
            "não criar tarefa agora",
            "nao quero criar tarefa",
            "não quero pegar tarefa",
            "nao quero pegar tarefa",
            "não, criar tarefa",
            "nao criar equipe",
        ):
            with self.subTest(utterance=utterance):
                self.assertIsNone(self._key(utterance))

    def test_incidental_exit_word_does_not_exit(self):
        for utterance in (
            "pensei em sair mais cedo, minhas tarefas",
            "não sei sair do app",
            "desencerrar",
        ):
            with self.subTest(utterance=utterance):
                self.assertNotEqual(self._key(utterance), "exit")
                self.assertNotIn(self._key(utterance), WRITE_COMMANDS)

    def test_negated_exit_does_not_exit(self):
        self.assertIsNone(self._key("não quero sair"))


class CommandParserPositiveTests(unittest.TestCase):
    """Comandos legítimos continuam reconhecidos como antes da correção do DC-02."""

    def setUp(self):
        self.parser = CommandParser(threshold=78)

    def _key(self, utterance):
        match = self.parser.match(utterance)
        return match.command.key if match else None

    def test_create_task(self):
        for utterance in ("criar tarefa", "quero criar uma tarefa", "nova tarefa", "adicionar tarefa"):
            with self.subTest(utterance=utterance):
                self.assertEqual(self._key(utterance), "create_task")

    def test_create_task_keeps_extracted_params(self):
        match = self.parser.match("adicionar tarefa relatorio para equipe dev")
        self.assertEqual(match.command.key, "create_task")
        self.assertEqual(match.params, {"equipe": "dev", "nome": "relatorio"})

    def test_create_team(self):
        match = self.parser.match("criar equipe marketing")
        self.assertEqual(match.command.key, "create_team")
        self.assertEqual(match.params, {"nome": "marketing"})

    def test_assign_to_me(self):
        for utterance in ("pegar tarefa", "atribuir para mim", "assumir tarefa", "atribuir tarefa para mim"):
            with self.subTest(utterance=utterance):
                self.assertEqual(self._key(utterance), "assign_to_me")

    def test_assign_to_me_keeps_extracted_params(self):
        match = self.parser.match("pegar a tarefa relatorio")
        self.assertEqual(match.command.key, "assign_to_me")
        self.assertEqual(match.params, {"task_id": "relatorio"})

    def test_exit(self):
        for utterance in (
            "sair",
            "Sair.",
            "encerrar",
            "parar assistente",
            "fechar assistente",
            "encerrar assistente",
            "sair do assistente",
            "pode sair",
            "sair por favor",
        ):
            with self.subTest(utterance=utterance):
                self.assertEqual(self._key(utterance), "exit")

    def test_read_commands(self):
        self.assertEqual(self._key("minhas tarefas"), "my_tasks")
        self.assertEqual(self._key("listar equipes"), "list_teams")


if __name__ == "__main__":
    unittest.main()
