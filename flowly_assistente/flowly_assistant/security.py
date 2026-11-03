from __future__ import annotations

import hmac


def verify_internal_secret(expected: str, provided: str) -> str:
    """Return configured, unauthorized, or ok for an internal shared secret."""
    normalized_expected = str(expected or "").strip()
    normalized_provided = str(provided or "").strip()
    if not normalized_expected:
        return "not_configured"
    if not hmac.compare_digest(normalized_expected, normalized_provided):
        return "unauthorized"
    return "ok"
