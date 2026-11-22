from __future__ import annotations

from dataclasses import dataclass, field
import re
import time
from typing import Any, Dict, Optional

import requests

from flowly_assistant.commands import WRITES_DISABLED_REPLY, assistant_writes_enabled
from flowly_assistant.iam_auth import IAMAuthError, serverless_auth_headers

IAM_UNAVAILABLE_REPLY = "Não consegui autenticar o assistente na API agora. Nada foi alterado."

READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
# Idempotency-Key so em escritas protegidas (nunca em GET; DELETE ja e bloqueado antes).
KEYED_METHODS = frozenset({"POST", "PUT", "PATCH"})
# Mesmo formato aceito pela API (UUID canonico, versoes 1 a 8, minusculo).
IDEMPOTENCY_KEY_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
CODE_PATTERN = re.compile(r"^[a-z][a-z_]{0,63}$")

# Categorias de erro (por status e, no 409/422, pelo code devolvido pela API).
IN_PROGRESS_CODES = frozenset({"idempotency_in_progress", "operation_in_progress", "operation_state_changed"})
UNKNOWN_CODES = frozenset({"idempotency_outcome_unknown", "operation_unknown"})


def _header(resp: Any, name: str) -> Optional[str]:
    headers = getattr(resp, "headers", None) or {}
    value = headers.get(name)
    if value is None:
        value = headers.get(name.lower())
    return None if value is None else str(value)


def _retry_after_seconds(resp: Any) -> Optional[int]:
    raw = (_header(resp, "Retry-After") or "").strip()
    return int(raw) if raw.isdigit() else None


class APIError(RuntimeError):
    """Erro ao chamar a API Flowly.

    str(exc) continua sendo a mensagem de sempre (consumidores antigos usam so o texto). Atributos opcionais:
      kind: 'http' | 'timeout' | 'network' | 'invalid_response' | 'redirect' | 'blocked' | 'writes_disabled' |
            'invalid_request' | 'not_configured' | None (erros de negocio do proprio assistente)
      status_code, code (code da API, so se no formato snake_case), retry_after (segundos), replayed;
      may_have_executed: a escrita pode ter sido confirmada pela API mesmo sem resposta (timeout, rede, resposta
            ilegivel, redirecionamento) - nunca dizer ao usuario que nada foi alterado nesses casos;
      operation: visao publica da operacao devolvida em recusas das rotas de operacoes (sem dados privados).
    """

    def __init__(
        self,
        message: str = "",
        *,
        kind: Optional[str] = None,
        status_code: Optional[int] = None,
        code: Optional[str] = None,
        retry_after: Optional[int] = None,
        replayed: bool = False,
        method: Optional[str] = None,
        may_have_executed: bool = False,
        operation: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.status_code = status_code
        self.code = code if isinstance(code, str) and CODE_PATTERN.match(code) else None
        self.retry_after = retry_after
        self.replayed = bool(replayed)
        self.method = method
        self.may_have_executed = bool(may_have_executed)
        self.operation = operation

    @property
    def category(self) -> str:
        """Leitura estavel do erro: o 409 nao e tratado sempre do mesmo jeito."""
        # may_have_executed tambem vale para 5xx de escrita: a categoria continua sendo a do status (ex.:
        # 'unavailable'), e quem decide a recuperacao olha may_have_executed.
        if self.kind in ("timeout", "network", "invalid_response", "redirect"):
            return "outcome_uncertain" if self.may_have_executed else self.kind
        status = self.status_code
        if status is None:
            return self.kind or "error"
        if status == 400:
            return "invalid_input"
        if status == 401:
            return "unauthenticated"
        if status == 403:
            return "forbidden"
        if status == 404:
            return "not_found"
        if status == 409:
            if self.code in IN_PROGRESS_CODES:
                return "in_progress"
            if self.code == "claim_lost":
                return "claim_lost"
            if self.code in UNKNOWN_CODES:
                return "outcome_unknown"  # nunca sucesso, nunca nova execucao automatica
            return "conflict"
        if status == 410:
            return "expired"
        if status == 422:
            return "key_reused" if self.code == "idempotency_key_reused" else "unprocessable"
        if status == 503:
            return "unavailable"
        if status >= 500:
            return "server_error"
        return "http_error"


def _keyed(idempotency_key: Optional[str]) -> Dict[str, Any]:
    """So repassa a chave quando ela existe: sem chave, a chamada fica identica a de sempre."""
    return {} if idempotency_key is None else {"idempotency_key": idempotency_key}


@dataclass(frozen=True)
class APIResponse:
    """Resposta de sucesso com os metadados que a recuperacao precisa (sem cabecalhos sensiveis)."""

    status_code: int
    data: Any
    replayed: bool = False
    retry_after: Optional[int] = None


@dataclass
class FlowlyAPIClient:
    base_url: str
    token: str
    timeout_sec: float = 20.0
    debug: bool = False
    # Metadados da ultima resposta de sucesso (status, Idempotency-Replayed); a instancia e por pedido.
    last_response: Optional[APIResponse] = field(default=None, init=False, repr=False, compare=False)

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

    def request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict] = None,
        json: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        response = self.request_with_meta(method, path, params=params, json=json, idempotency_key=idempotency_key)
        self.last_response = response
        return response.data

    def request_with_meta(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict] = None,
        json: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
    ) -> APIResponse:
        method_upper = str(method or "").strip().upper()
        # Ultima barreira: o assistente nunca envia DELETE, venha o pedido de onde vier.
        if method_upper == "DELETE":
            raise APIError("O assistente não executa exclusões.", kind="blocked", method=method_upper)
        # Ultima barreira da chave temporaria: com escritas desligadas, nada alem de leitura sai daqui,
        # venha de confirmacao, selecao de tarefa, CLI ou qualquer outro caminho.
        if method_upper not in READ_METHODS and not assistant_writes_enabled():
            raise APIError(WRITES_DISABLED_REPLY, kind="writes_disabled", method=method_upper)
        headers = self._headers()
        extra: Dict[str, Any] = {}
        if idempotency_key is not None:
            # A chave vem da operacao compartilhada e e reenviada igual em toda tentativa; nunca vai em GET e nunca
            # aparece em mensagem ou log.
            if method_upper not in KEYED_METHODS:
                raise APIError("Idempotency-Key só pode acompanhar escritas.", kind="invalid_request", method=method_upper)
            if not isinstance(idempotency_key, str) or not IDEMPOTENCY_KEY_PATTERN.match(idempotency_key):
                raise APIError("Idempotency-Key inválida.", kind="invalid_request", method=method_upper)
            headers["Idempotency-Key"] = idempotency_key
            # Redirecionamento levaria a chave (cabecalho proprio) a outro destino: nao segue.
            extra["allow_redirects"] = False
        is_write = method_upper not in READ_METHODS
        url = f"{self.base_url.rstrip('/')}/{path.lstrip('/')}"
        # IAM opcional (FLOWLY_API_IAM_ENABLED=true): ID token do servico em X-Serverless-Authorization, ao lado do
        # JWT do usuario. Sem token, nada e enviado (falha segura, antes da rede).
        try:
            iam_headers = serverless_auth_headers(url)
        except IAMAuthError:
            raise APIError(IAM_UNAVAILABLE_REPLY, kind="not_configured", code="api_iam_unavailable",
                           method=method_upper) from None
        if iam_headers:
            headers.update(iam_headers)
            # Um redirecionamento levaria o cabecalho proprio (que o requests nao remove) a outro destino.
            extra["allow_redirects"] = False
        started = time.monotonic()
        if self.debug:
            qp = f" params={params}" if params else ""
            jb = f" json={json}" if json else ""
            print(f"[API] -> {method.upper()} {url}{qp}{jb}")
        try:
            resp = requests.request(
                method.upper(),
                url,
                headers=headers,
                params=params,
                json=json,
                timeout=self.timeout_sec,
                **extra,
            )
        except requests.Timeout as e:
            if self.debug:
                elapsed = time.monotonic() - started
                print(f"[API] !! timeout after {elapsed:.2f}s")
            raise APIError(
                f"Timeout ao chamar {method} {path} após {self.timeout_sec}s",
                kind="timeout", method=method_upper, may_have_executed=is_write,
            ) from e
        except requests.RequestException as e:
            if self.debug:
                elapsed = time.monotonic() - started
                print(f"[API] !! network error after {elapsed:.2f}s")
            raise APIError(
                f"Erro de rede ao chamar {method} {path}: {e}",
                kind="network", method=method_upper, may_have_executed=is_write,
            ) from e

        if self.debug:
            elapsed = time.monotonic() - started
            print(f"[API] <- HTTP {resp.status_code} ({elapsed:.2f}s)")

        if (idempotency_key is not None or iam_headers) and 300 <= resp.status_code < 400:
            raise APIError(
                f"Redirecionamento recusado em {method} {path}",
                kind="redirect", status_code=resp.status_code, method=method_upper,
                may_have_executed=True if idempotency_key is not None else is_write,
            )

        if resp.status_code >= 400:
            try:
                payload = resp.json()
            except Exception:
                payload = {"erro": resp.text}
            if not isinstance(payload, dict):
                payload = {"erro": str(payload)}

            msg = payload.get("erro") or payload.get("error") or payload.get("mensagem") or str(payload)
            raise APIError(
                f"HTTP {resp.status_code} em {method} {path}: {msg}",
                kind="http",
                status_code=resp.status_code,
                code=payload.get("code"),
                retry_after=_retry_after_seconds(resp),
                replayed=(_header(resp, "Idempotency-Replayed") or "").lower() == "true",
                method=method_upper,
                # 5xx numa escrita nao prova que nada mudou: a API pode falhar depois do commit (montando a
                # resposta) e um proxy/gateway pode responder 502/503/504 depois de entregar o pedido. A
                # recuperacao repete com a MESMA chave, o que e seguro.
                may_have_executed=is_write and resp.status_code >= 500,
            )

        replayed = (_header(resp, "Idempotency-Replayed") or "").lower() == "true"
        retry_after = _retry_after_seconds(resp)
        if resp.status_code == 204:
            return APIResponse(resp.status_code, None, replayed, retry_after)

        content_type = (resp.headers.get("content-type") or "").lower()
        if "application/json" in content_type:
            try:
                data = resp.json()
            except Exception as e:
                # Status de sucesso com corpo ilegivel: a escrita pode ter entrado.
                raise APIError(
                    f"Resposta inválida da API em {method} {path}",
                    kind="invalid_response", status_code=resp.status_code, method=method_upper,
                    may_have_executed=is_write, replayed=replayed,
                ) from e
            return APIResponse(resp.status_code, data, replayed, retry_after)
        return APIResponse(resp.status_code, resp.text, replayed, retry_after)

    # Usuário
    def me(self) -> Any:
        return self.request("GET", "/users/me")

    def list_users(self) -> Any:
        return self.request("GET", "/users")

    def search_users(self, q: str) -> Any:
        return self.request("GET", "/users/search", params={"q": q})

    # Equipes
    def list_teams(self) -> Any:
        return self.request("GET", "/equipes")

    def list_my_teams(self) -> Any:
        return self.request("GET", "/equipes/minhas")

    def team_members(self, team_id: str) -> Any:
        return self.request("GET", f"/equipes/{team_id}/membros")

    def team_messages(self, team_id: str) -> Any:
        return self.request("GET", f"/equipes/{team_id}/messages")

    def create_team(self, nome: str, membros: Optional[list[str]] = None, *, idempotency_key: Optional[str] = None) -> Any:
        return self.request("POST", "/equipes", json={"nome": nome, "membros": membros or []}, **_keyed(idempotency_key))

    # Tarefas
    def task_details(self, task_id: str) -> Any:
        return self.request("GET", f"/tarefas/{task_id}/detalhes")

    def add_comment(self, task_id: str, texto: str, *, idempotency_key: Optional[str] = None) -> Any:
        return self.request("POST", f"/tarefas/{task_id}/comentarios", json={"texto": texto}, **_keyed(idempotency_key))

    def add_subtask(self, task_id: str, descricao: str, *, idempotency_key: Optional[str] = None) -> Any:
        return self.request("POST", f"/tarefas/{task_id}/subtarefas", json={"descricao": descricao}, **_keyed(idempotency_key))

    def my_tasks(self) -> Any:
        return self.request("GET", "/tarefas/minhas")

    def backlog(self) -> Any:
        return self.request("GET", "/tarefas/backlog")

    def assign_to_me(self, task_id: str, *, idempotency_key: Optional[str] = None) -> Any:
        return self.request("PUT", f"/tarefas/{task_id}/atribuir-para-mim", **_keyed(idempotency_key))

    def update_status(self, task_id: str, status: str, *, idempotency_key: Optional[str] = None) -> Any:
        return self.request("PUT", f"/tarefas/{task_id}/status", json={"status": status}, **_keyed(idempotency_key))

    def timer(self, task_id: str, acao: str, *, idempotency_key: Optional[str] = None) -> Any:
        return self.request("PUT", f"/tarefas/{task_id}/cronometro", json={"acao": acao}, **_keyed(idempotency_key))

    def create_task(
        self,
        *,
        descricao: str,
        equipe: str,
        dataEntrega: str,
        urgencia: str,
        detalhes: Optional[str] = None,
        user: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        body: Dict[str, Any] = {
            "descricao": descricao,
            "equipe": equipe,
            "dataEntrega": dataEntrega,
            "urgencia": urgencia,
        }
        if detalhes:
            body["detalhes"] = detalhes
        if user is not None and user != "__none__":
            body["user"] = user
        return self.request("POST", "/tarefas", json=body, **_keyed(idempotency_key))

    def list_tasks(self, *, user: Optional[str] = None, equipe: Optional[str] = None) -> Any:
        params: Dict[str, Any] = {}
        if user:
            params["user"] = user
        if equipe:
            params["equipe"] = equipe
        return self.request("GET", "/tarefas", params=params or None)

    def delete_task(self, task_id: str) -> Any:
        # Bloqueado em request(): mantido so para o modo CLI falhar com mensagem clara.
        return self.request("DELETE", f"/tarefas/{task_id}")
