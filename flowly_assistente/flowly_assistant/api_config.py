from __future__ import annotations

import os
from urllib.parse import urlparse

LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def configured_api_base_url() -> str:
    """Return the trusted API URL configured by the deployment environment."""
    return str(
        os.getenv("FLOWLY_API_BASE_URL")
        or os.getenv("FLOWLY_API_URL")
        or "http://localhost:5000/api"
    ).strip()


def validated_api_base_url() -> str:
    """URL da API do ambiente (nunca do pedido), conferida antes de receber credenciais internas.

    Recusa esquema diferente de http/https, usuario/senha na URL, query ou fragmento, e http fora da maquina local
    (o segredo interno so viaja por https). Levanta ValueError sem repetir a URL (pode conter credenciais).
    """
    url = configured_api_base_url().rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("URL da API invalida")
    if parsed.username or parsed.password or parsed.query or parsed.fragment or "@" in parsed.netloc:
        raise ValueError("URL da API invalida")
    if parsed.scheme == "http" and parsed.hostname not in LOCAL_HOSTS:
        raise ValueError("URL da API sem https")
    return url
