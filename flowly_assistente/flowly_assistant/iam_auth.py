"""Autenticacao IAM opcional para chamar uma API Flowly privada no Cloud Run (servico -> servico).

Desligada por padrao. So liga com FLOWLY_API_IAM_ENABLED=true; sem isso nada muda (nenhum cabecalho a mais,
nenhuma dependencia carregada, mesmo comportamento de redirecionamento de antes).

Ligada:
- obtem um ID token assinado pelo Google para o audience FLOWLY_API_IAM_AUDIENCE (URL-base do servico Cloud Run,
  sem /api), com a identidade da conta de servico do proprio servico (metadata server no Cloud Run) via a
  biblioteca oficial google-auth;
- envia o token em X-Serverless-Authorization: Bearer <ID token>. O Authorization continua com o JWT do usuario
  (a API Flowly segue validando o usuario e a sessao), e a credencial interna e a Idempotency-Key ficam iguais;
- so envia para o mesmo destino do audience (esquema + host + porta); qualquer outro destino e recusado;
- falha de forma segura: sem audience valido, sem a biblioteca ou sem conseguir o token, nada e enviado
  (IAMAuthError, sem detalhes). Nunca registra o token nem o coloca em mensagens de erro.

O token fica em cache por audience ate pouco antes de vencer (o exp do proprio token); o Google emite tokens de 1 h.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
from typing import Dict, Optional, Tuple
from urllib.parse import urlparse

IAM_ENABLED_ENV = "FLOWLY_API_IAM_ENABLED"
IAM_AUDIENCE_ENV = "FLOWLY_API_IAM_AUDIENCE"
IAM_HEADER = "X-Serverless-Authorization"
REFRESH_MARGIN_SEC = 300  # renova com folga antes do exp (relogio e latencia)

_lock = threading.Lock()
_cache: Dict[str, Tuple[str, float]] = {}  # audience -> (token, renovar a partir de)


class IAMAuthError(Exception):
    """Nao foi possivel autenticar o servico no IAM. A mensagem nunca traz token nem detalhe da credencial."""


def iam_enabled() -> bool:
    """Opt-in explicito: so o valor "true" (sem diferenciar maiusculas) liga."""
    return str(os.getenv(IAM_ENABLED_ENV) or "").strip().lower() == "true"


def _origin(url: str) -> Optional[str]:
    parsed = urlparse(str(url or "").strip())
    if parsed.scheme != "https" or not parsed.hostname:
        return None
    if parsed.username or parsed.password or "@" in parsed.netloc:
        return None
    default_port = parsed.port in (None, 443)
    return f"https://{parsed.hostname.lower()}" + ("" if default_port else f":{parsed.port}")


def iam_audience() -> str:
    """Audience configurado: so a URL-base HTTPS do servico (sem caminho, query ou fragmento)."""
    raw = str(os.getenv(IAM_AUDIENCE_ENV) or "").strip()
    parsed = urlparse(raw)
    origin = _origin(raw)
    if not origin or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.params:
        raise IAMAuthError("Audience IAM ausente ou invalido.")
    return origin


def _expiry(token: str) -> Optional[float]:
    """exp do ID token (so para o cache; a assinatura e conferida pelo Cloud Run, nao aqui)."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        exp = json.loads(base64.urlsafe_b64decode(payload.encode("ascii"))).get("exp")
        return float(exp) if isinstance(exp, (int, float)) and not isinstance(exp, bool) else None
    except Exception:
        return None


def _fetch_id_token(audience: str) -> str:
    try:
        from google.auth.transport.requests import Request
        from google.oauth2 import id_token
    except Exception:
        raise IAMAuthError("Biblioteca google-auth indisponivel.") from None
    try:
        token = id_token.fetch_id_token(Request(), audience)
    except Exception:
        # Sem o texto da excecao (pode descrever a credencial do ambiente).
        raise IAMAuthError("Nao foi possivel obter o ID token do servico.") from None
    if not isinstance(token, str) or token.count(".") != 2:
        raise IAMAuthError("ID token invalido.")
    return token


def _token_for(audience: str) -> str:
    with _lock:
        cached = _cache.get(audience)
        if cached and time.time() < cached[1]:
            return cached[0]
        token = _fetch_id_token(audience)
        exp = _expiry(token)
        if exp is not None and exp - REFRESH_MARGIN_SEC > time.time():
            _cache[audience] = (token, exp - REFRESH_MARGIN_SEC)
        else:
            _cache.pop(audience, None)  # sem prazo confiavel: nao reaproveita
        return token


def serverless_auth_headers(url: str) -> Dict[str, str]:
    """Cabecalho IAM para este destino, ou {} com IAM desligado. Levanta IAMAuthError (falha segura)."""
    if not iam_enabled():
        return {}
    audience = iam_audience()
    if _origin(url) != audience:
        raise IAMAuthError("Destino diferente do audience IAM.")
    return {IAM_HEADER: f"Bearer {_token_for(audience)}"}


def clear_cache() -> None:
    """Descarta tokens em cache (testes, troca de configuracao)."""
    with _lock:
        _cache.clear()
