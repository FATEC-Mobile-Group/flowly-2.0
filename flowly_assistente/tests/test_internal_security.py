import unittest

from flowly_assistant.security import verify_internal_secret


class InternalSecretTests(unittest.TestCase):
    def test_missing_configuration_fails_closed(self):
        self.assertEqual(verify_internal_secret("", "anything"), "not_configured")

    def test_wrong_secret_is_rejected(self):
        self.assertEqual(verify_internal_secret("correct", "wrong"), "unauthorized")

    def test_matching_secret_is_accepted(self):
        self.assertEqual(verify_internal_secret("correct", "correct"), "ok")


if __name__ == "__main__":
    unittest.main()
