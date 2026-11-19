from __future__ import annotations

from dataclasses import dataclass
import time
from typing import Any, Dict, Optional

import requests


class APIError(RuntimeError):
    """Erro ao chamar a API Flowly."""
    pass


@dataclass
class FlowlyAPIClient:
    base_url: str
    token: str
    timeout_sec: float = 20.0
    debug: bool = False

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

    def request(self, method: str, path: str, *, params: Optional[dict] = None, json: Optional[dict] = None) -> Any:
        # Ultima barreira: o assistente nunca envia DELETE, venha o pedido de onde vier.
        if str(method or "").strip().upper() == "DELETE":
            raise APIError("O assistente não executa exclusões.")
        url = f"{self.base_url.rstrip('/')}/{path.lstrip('/')}"
        started = time.monotonic()
        if self.debug:
            qp = f" params={params}" if params else ""
            jb = f" json={json}" if json else ""
            print(f"[API] -> {method.upper()} {url}{qp}{jb}")
        try:
            resp = requests.request(
                method.upper(),
                url,
                headers=self._headers(),
                params=params,
                json=json,
                timeout=self.timeout_sec,
            )
        except requests.Timeout as e:
            if self.debug:
                elapsed = time.monotonic() - started
                print(f"[API] !! timeout after {elapsed:.2f}s")
            raise APIError(f"Timeout ao chamar {method} {path} após {self.timeout_sec}s") from e
        except requests.RequestException as e:
            if self.debug:
                elapsed = time.monotonic() - started
                print(f"[API] !! network error after {elapsed:.2f}s")
            raise APIError(f"Erro de rede ao chamar {method} {path}: {e}") from e

        if self.debug:
            elapsed = time.monotonic() - started
            print(f"[API] <- HTTP {resp.status_code} ({elapsed:.2f}s)")

        if resp.status_code >= 400:
            try:
                payload = resp.json()
            except Exception:
                payload = {"erro": resp.text}

            msg = payload.get("erro") or payload.get("error") or payload.get("mensagem") or str(payload)
            raise APIError(f"HTTP {resp.status_code} em {method} {path}: {msg}")

        if resp.status_code == 204:
            return None

        content_type = (resp.headers.get("content-type") or "").lower()
        if "application/json" in content_type:
            return resp.json()
        return resp.text

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

    def create_team(self, nome: str, membros: Optional[list[str]] = None) -> Any:
        return self.request("POST", "/equipes", json={"nome": nome, "membros": membros or []})

    # Tarefas
    def task_details(self, task_id: str) -> Any:
        return self.request("GET", f"/tarefas/{task_id}/detalhes")

    def add_comment(self, task_id: str, texto: str) -> Any:
        return self.request("POST", f"/tarefas/{task_id}/comentarios", json={"texto": texto})

    def add_subtask(self, task_id: str, descricao: str) -> Any:
        return self.request("POST", f"/tarefas/{task_id}/subtarefas", json={"descricao": descricao})

    def my_tasks(self) -> Any:
        return self.request("GET", "/tarefas/minhas")

    def backlog(self) -> Any:
        return self.request("GET", "/tarefas/backlog")

    def assign_to_me(self, task_id: str) -> Any:
        return self.request("PUT", f"/tarefas/{task_id}/atribuir-para-mim")

    def update_status(self, task_id: str, status: str) -> Any:
        return self.request("PUT", f"/tarefas/{task_id}/status", json={"status": status})

    def timer(self, task_id: str, acao: str) -> Any:
        return self.request("PUT", f"/tarefas/{task_id}/cronometro", json={"acao": acao})

    def create_task(
        self,
        *,
        descricao: str,
        equipe: str,
        dataEntrega: str,
        urgencia: str,
        detalhes: Optional[str] = None,
        user: Optional[str] = None,
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
        return self.request("POST", "/tarefas", json=body)

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
