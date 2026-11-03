from __future__ import annotations

import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from flowly_assistant.api_client import FlowlyAPIClient
from flowly_assistant.api_config import configured_api_base_url
from flowly_assistant.assistant_core.rest_assistant import assistant_from_http_body, tts_payload
from flowly_assistant.command_parser import CommandParser
from flowly_assistant.nlp.moderation import ModerationService
from flowly_assistant.queues.analytics_queue import AnalyticsQueue
from flowly_assistant.storage.analytics_repository import AnalyticsRepository
from flowly_assistant.storage.conversation_state import ConversationStateRepository, ScopedConversationState

# channelId é o tipo de canal de entrada, nunca uma equipe (a API trata channelId com ObjectId como equipe).
ALLOWED_CHANNEL_IDS = {"web", "voice-assistant"}


def authenticated_user_id(api: FlowlyAPIClient) -> Optional[str]:
    """Identidade confiável: o dono do JWT segundo a API (/users/me), nunca o userId do body."""
    try:
        me = api.me()
    except Exception:
        return None
    if not isinstance(me, dict):
        return None
    user_id = str(me.get("_id") or me.get("id") or "").strip()
    return user_id or None


class MessageAgent:
    """Event-oriented REST agent for /api/v1/messages."""

    def __init__(self, *, token: str, body: Dict[str, Any], debug: bool = False) -> None:
        self.body = body
        self.token = token
        self.debug = debug
        self.moderation = ModerationService()
        self.queue = AnalyticsQueue()
        self.parser = CommandParser(threshold=int(os.getenv("FLOWLY_MATCH_THRESHOLD", "78")))
        self.assistant = assistant_from_http_body(body, token, debug=debug)
        self.conversations = ConversationStateRepository()

    def handle_message(self) -> Tuple[Dict[str, Any], int]:
        content = str(self.body.get("content") or self.body.get("utterance") or self.body.get("text") or "").strip()
        channel_id = str(self.body.get("channelId") or self.body.get("channel_id") or "web").strip()
        if channel_id not in ALLOWED_CHANNEL_IDS:
            channel_id = "web"
        conversation_id = str(
            self.body.get("conversationId")
            or self.body.get("conversation_id")
            or channel_id
        )

        if not content:
            return self._error("missing_content", "Envie uma mensagem para eu processar.", 400)

        user_id = authenticated_user_id(self.assistant.api)
        if not user_id:
            return self._error("unauthorized", "Autenticação inválida.", 401)
        self.conversations = ScopedConversationState(self.conversations, user_id)

        moderation = self.moderation.moderate(content)
        if not moderation.allowed:
            return self._error(
                "blocked_by_moderation",
                "Não posso processar essa mensagem por segurança.",
                422,
                moderation={"reason": moderation.reason, "score": moderation.score},
            )

        event = {
            "id": str(uuid.uuid4()),
            "userId": user_id,
            "channelId": channel_id,
            # Equipe só entra no evento se confirmada pela API (ver _enrich_event_team_context).
            "teamId": None,
            "teamName": None,
            "content": content,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "source": self.body.get("source") or "frontend",
        }
        self._enrich_event_team_context(event, content)
        queue_result = self.queue.publish_message(event)

        pending = self.conversations.get(conversation_id)
        if pending:
            return self._continue_pending_command(
                conversation_id=conversation_id,
                pending=pending,
                content=content,
                event_id=event["id"],
                moderation_score=moderation.score,
                queue_result=queue_result,
            )

        match = self.parser.match(content)
        if match is None or match.command.key == "exit":
            text = "Mensagem recebida. Não identifiquei uma ação imediata."
            if match is not None and match.command.key == "exit":
                text = "Encerrando. Assistente em standby."
                self.conversations.clear(conversation_id)
            return {
                "ok": True,
                "messageId": event["id"],
                "moderation": {"allowed": True, "score": moderation.score},
                "queue": queue_result,
                "command": None if match is None else {"key": match.command.key},
                "action_executed": False,
                "reply_text": text,
                "tts": tts_payload(text, language=str(self.body.get("language") or "pt-BR")),
            }, 201

        supplied_params = self.body.get("params") if isinstance(self.body.get("params"), dict) else {}
        merged_params = {**supplied_params, **match.params}
        missing = [p for p in match.command.required_params if not merged_params.get(p)]
        if missing:
            self.conversations.save(
                conversation_id,
                {"command_key": match.command.key, "params": merged_params, "missing": missing},
            )
            text = self._question_for_param(missing[0], match.command.key)
            return self._awaiting_params_response(
                event_id=event["id"],
                moderation_score=moderation.score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                command_key=match.command.key,
                missing=missing,
                text=text,
            )

        command_payload, command_status = self.assistant.handle(content, supplied_params)
        status = 200 if command_payload.get("ok") else command_status
        if command_payload.get("ok"):
            command_payload = self._prepare_follow_up(
                conversation_id=conversation_id,
                command_key=match.command.key,
                payload=command_payload,
            )
        return {
            "ok": bool(command_payload.get("ok")),
            "messageId": event["id"],
            "moderation": {"allowed": True, "score": moderation.score},
            "queue": queue_result,
            "action_executed": bool(command_payload.get("ok")),
            **command_payload,
        }, status

    def _continue_pending_command(
        self,
        *,
        conversation_id: str,
        pending: Dict[str, Any],
        content: str,
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
    ) -> Tuple[Dict[str, Any], int]:
        if pending.get("mode") == "task_selection":
            return self._continue_task_selection(
                conversation_id=conversation_id,
                pending=pending,
                content=content,
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
            )

        command_key = str(pending.get("command_key") or "")
        command = next((cmd for cmd in self.parser.commands if cmd.key == command_key), None)
        if command is None:
            self.conversations.clear(conversation_id)
            return self._error("invalid_conversation", "Perdi o contexto do comando. Pode repetir?", 400)

        params = dict(pending.get("params") or {})
        missing = [p for p in pending.get("missing", command.required_params) if not params.get(p)]
        if not missing:
            self.conversations.clear(conversation_id)
            return self._error("invalid_conversation", "Esse comando já estava completo. Pode repetir?", 400)

        params[missing[0]] = self._normalize_param_value(missing[0], content)
        missing = [p for p in command.required_params if not params.get(p)]
        if missing:
            self.conversations.save(
                conversation_id,
                {"command_key": command.key, "params": params, "missing": missing},
            )
            return self._awaiting_params_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                command_key=command.key,
                missing=missing,
            text=self._question_for_param(missing[0], command.key),
            )

        utterance = f"{command.title} " + " ".join(f"{key} {value}" for key, value in params.items())
        command_payload, command_status = self.assistant.handle(utterance, params)
        if command_payload.get("ok"):
            self.conversations.clear(conversation_id)
            command_payload = self._prepare_follow_up(
                conversation_id=conversation_id,
                command_key=command.key,
                payload=command_payload,
            )
        else:
            self.conversations.save(
                conversation_id,
                {"command_key": command.key, "params": params, "missing": command_payload.get("missing") or []},
            )

        return {
            "ok": bool(command_payload.get("ok")),
            "messageId": event_id,
            "moderation": {"allowed": True, "score": moderation_score},
            "queue": queue_result,
            "action_executed": bool(command_payload.get("ok")),
            "conversation": {
                "id": conversation_id,
                "status": "completed" if command_payload.get("ok") else "awaiting_params",
            },
            **command_payload,
        }, 200 if command_payload.get("ok") else command_status

    def _prepare_follow_up(self, *, conversation_id: str, command_key: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        result = payload.get("result")
        if command_key in {"my_tasks", "backlog", "list_tasks"}:
            tasks = [task for task in result if isinstance(task, dict)] if isinstance(result, list) else []
            text = self._tasks_reply_text(tasks)
            if tasks:
                self.conversations.save(
                    conversation_id,
                    {
                        "mode": "task_selection",
                        "tasks": [self._compact_task(task) for task in tasks[:10]],
                    },
                )
                payload["conversation"] = {
                    "id": conversation_id,
                    "status": "browsing_tasks",
                    "options": ["details", "assign_to_me", "cancel"],
                }
            payload["reply_text"] = text
            payload["tts"] = tts_payload(text, language=str(self.body.get("language") or "pt-BR"))
            return payload

        if command_key in {"my_teams", "list_teams"}:
            teams = [team for team in result if isinstance(team, dict)] if isinstance(result, list) else []
            text = self._teams_reply_text(teams)
            payload["reply_text"] = text
            payload["tts"] = tts_payload(text, language=str(self.body.get("language") or "pt-BR"))
        return payload

    def _continue_task_selection(
        self,
        *,
        conversation_id: str,
        pending: Dict[str, Any],
        content: str,
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
    ) -> Tuple[Dict[str, Any], int]:
        text_norm = self._normalize_text(content)
        if self._is_cancel(text_norm):
            self.conversations.clear(conversation_id)
            text = "Tudo bem. Cancelei a selecao de tarefa e voltei para standby."
            return self._task_conversation_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                status="cancelled",
                text=text,
                ok=True,
                action_executed=False,
            )

        tasks = [task for task in pending.get("tasks", []) if isinstance(task, dict)]
        if not tasks:
            self.conversations.clear(conversation_id)
            return self._error("invalid_conversation", "Perdi a lista de tarefas. Pode pedir para listar novamente?", 400)

        selected_id = pending.get("selected_task_id")
        selected_task = next((task for task in tasks if task.get("_id") == selected_id), None)
        requested_task = self._select_task_from_text(text_norm, tasks)
        if requested_task:
            selected_task = requested_task

        action = self._task_follow_up_action(text_norm)
        if selected_task and not action:
            self.conversations.save(
                conversation_id,
                {**pending, "selected_task_id": selected_task.get("_id")},
            )
            text = (
                f"Selecionei {selected_task.get('descricao') or 'essa tarefa'}. "
                "Voce quer detalhes, atribuir para voce ou cancelar?"
            )
            return self._task_conversation_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                status="awaiting_task_action",
                text=text,
                ok=True,
                action_executed=False,
            )

        if not selected_task:
            text = "Qual tarefa voce quer abrir? Pode dizer o numero, como primeira ou segunda, ou pedir cancelar."
            return self._task_conversation_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                status="awaiting_task_selection",
                text=text,
                ok=True,
                action_executed=False,
            )

        try:
            if action == "assign":
                result = self.assistant.api.assign_to_me(str(selected_task["_id"]))
                self.conversations.clear(conversation_id)
                task = (result or {}).get("tarefa") if isinstance(result, dict) else selected_task
                text = f"Atribui a tarefa {self._task_title(task)} para voce."
                return self._task_conversation_response(
                    event_id=event_id,
                    moderation_score=moderation_score,
                    queue_result=queue_result,
                    conversation_id=conversation_id,
                    status="completed",
                    text=text,
                    ok=True,
                    action_executed=True,
                    result=result,
                    command={"key": "assign_to_me"},
                )

            result = self.assistant.api.task_details(str(selected_task["_id"]))
            text = self._task_details_reply_text(result)
            self.conversations.save(
                conversation_id,
                {**pending, "selected_task_id": selected_task.get("_id")},
            )
            return self._task_conversation_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                status="browsing_tasks",
                text=text,
                ok=True,
                action_executed=True,
                result=result,
                command={"key": "task_details"},
            )
        except Exception as exc:
            text = str(exc) or "Nao consegui concluir essa acao agora."
            return self._task_conversation_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                status="browsing_tasks",
                text=text,
                ok=False,
                action_executed=False,
                error="api_error",
            )

    def _task_conversation_response(
        self,
        *,
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
        conversation_id: str,
        status: str,
        text: str,
        ok: bool,
        action_executed: bool,
        **extra: Any,
    ) -> Tuple[Dict[str, Any], int]:
        return {
            "ok": ok,
            "messageId": event_id,
            "moderation": {"allowed": True, "score": moderation_score},
            "queue": queue_result,
            "action_executed": action_executed,
            "conversation": {"id": conversation_id, "status": status},
            "reply_text": text,
            "tts": tts_payload(text, language=str(self.body.get("language") or "pt-BR")),
            **extra,
        }, 200 if ok else 400

    def _compact_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        equipe = task.get("equipe")
        user = task.get("user")
        return {
            "_id": str(task.get("_id") or ""),
            "descricao": str(task.get("descricao") or "").strip(),
            "status": str(task.get("status") or "pendente").strip(),
            "urgencia": task.get("urgencia"),
            "dataEntrega": task.get("dataEntrega"),
            "equipe": {"nome": equipe.get("nome")} if isinstance(equipe, dict) else equipe,
            "user": {"nome": user.get("nome")} if isinstance(user, dict) else user,
        }

    def _tasks_reply_text(self, tasks: list[Dict[str, Any]]) -> str:
        if not tasks:
            return "Nao encontrei tarefas para listar."
        pieces = [f"Encontrei {len(tasks)} tarefa{'s' if len(tasks) != 1 else ''}."]
        for idx, task in enumerate(tasks[:5], start=1):
            equipe = task.get("equipe")
            equipe_nome = equipe.get("nome") if isinstance(equipe, dict) else None
            status = self._status_label(str(task.get("status") or "pendente"))
            team_text = f", equipe {equipe_nome}" if equipe_nome else ""
            pieces.append(f"{idx}. {self._task_title(task)}, status {status}{team_text}.")
        pieces.append("Voce pode pedir detalhes, atribuir uma tarefa para voce ou cancelar.")
        return " ".join(pieces)

    def _teams_reply_text(self, teams: list[Dict[str, Any]]) -> str:
        if not teams:
            return "Nao encontrei equipes vinculadas a voce."
        names = [str(team.get("nome") or "").strip() for team in teams if team.get("nome")]
        if not names:
            return f"Voce participa de {len(teams)} equipe{'s' if len(teams) != 1 else ''}."
        return f"Voce participa de {len(teams)} equipe{'s' if len(teams) != 1 else ''}: {', '.join(names[:8])}."

    def _task_details_reply_text(self, result: Any) -> str:
        tarefa = (result or {}).get("tarefa") if isinstance(result, dict) else None
        if not isinstance(tarefa, dict):
            return "Detalhes carregados."
        equipe = tarefa.get("equipe")
        user = tarefa.get("user")
        parts = [
            f"Tarefa {self._task_title(tarefa)}",
            f"status {self._status_label(str(tarefa.get('status') or 'pendente'))}",
        ]
        if isinstance(equipe, dict) and equipe.get("nome"):
            parts.append(f"equipe {equipe.get('nome')}")
        if isinstance(user, dict) and user.get("nome"):
            parts.append(f"responsavel {user.get('nome')}")
        elif not user:
            parts.append("sem responsavel")
        detalhes = str(tarefa.get("detalhes") or "").strip()
        if detalhes:
            parts.append(f"detalhes: {detalhes[:180]}")
        return ". ".join(parts) + ". Voce pode pedir outra tarefa, atribuir para voce ou cancelar."

    def _task_title(self, task: Any) -> str:
        if not isinstance(task, dict):
            return "sem descricao"
        return str(task.get("descricao") or task.get("titulo") or "sem descricao").strip()

    def _status_label(self, status: str) -> str:
        labels = {
            "pendente": "pendente",
            "em_andamento": "em andamento",
            "concluido": "concluida",
        }
        return labels.get(status, status.replace("_", " "))

    def _normalize_text(self, text: str) -> str:
        return " ".join((text or "").strip().lower().split())

    def _is_cancel(self, text: str) -> bool:
        return any(word in text for word in ("cancelar", "cancele", "sair", "encerrar", "parar"))

    def _task_follow_up_action(self, text: str) -> Optional[str]:
        if any(word in text for word in ("atribuir", "assumir", "pegar", "para mim")):
            return "assign"
        if any(word in text for word in ("detalhe", "detalhes", "informacao", "informacoes", "abrir", "mostrar")):
            return "details"
        return None

    def _select_task_from_text(self, text: str, tasks: list[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        number_match = re.search(r"\b(\d{1,2})\b", text)
        if number_match:
            idx = int(number_match.group(1)) - 1
            if 0 <= idx < len(tasks):
                return tasks[idx]
        ordinals = {
            "primeira": 0,
            "primeiro": 0,
            "segunda": 1,
            "segundo": 1,
            "terceira": 2,
            "terceiro": 2,
            "quarta": 3,
            "quarto": 3,
            "quinta": 4,
            "quinto": 4,
        }
        for word, idx in ordinals.items():
            if word in text and idx < len(tasks):
                return tasks[idx]
        for task in tasks:
            title = self._normalize_text(str(task.get("descricao") or ""))
            if title and (title in text or text in title):
                return task
        return None

    def _awaiting_params_response(
        self,
        *,
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
        conversation_id: str,
        command_key: str,
        missing: list[str],
        text: str,
    ) -> Tuple[Dict[str, Any], int]:
        return {
            "ok": True,
            "messageId": event_id,
            "moderation": {"allowed": True, "score": moderation_score},
            "queue": queue_result,
            "action_executed": False,
            "conversation": {
                "id": conversation_id,
                "status": "awaiting_params",
                "command": command_key,
                "missing": missing,
                "next_param": missing[0],
            },
            "reply_text": text,
            "tts": tts_payload(text, language=str(self.body.get("language") or "pt-BR")),
        }, 200

    def _normalize_param_value(self, param: str, value: str) -> str:
        raw = (value or "").strip()
        if param in {"nome", "descricao", "equipe", "user"}:
            raw = self._strip_spoken_label(raw, param)
        if param == "descricao":
            raw = self._strip_due_date_tail(raw)
        text = raw.lower().strip(" :,-")
        if param == "user":
            if text in {"nao", "não", "ninguem", "ninguém", "sem responsavel", "sem responsável"}:
                return "__none__"
            if text in {"eu", "mim", "para mim", "pra mim", "eu mesmo", "eu mesma"}:
                return "para mim"
            return raw
        if param == "task_id":
            return self._strip_spoken_label(self._strip_task_assignment_tail(raw), "task_id")
        if param == "dataEntrega":
            return self._normalize_due_date(raw)
        if param == "urgencia":
            if any(word in text for word in ("alta", "urgente", "prioridade alta")):
                return "alta"
            if any(word in text for word in ("media", "média", "normal")):
                return "media"
            return "baixa"
        if param == "status":
            if "andamento" in text:
                return "em_andamento"
            if "conclu" in text or "feito" in text or "final" in text:
                return "concluido"
            return "pendente"
        if param == "acao":
            return "iniciar" if raw.lower().startswith(("i", "come", "start")) else "pausar"
        return raw

    def _strip_spoken_label(self, value: str, param: str) -> str:
        text = " ".join((value or "").strip().split()).strip(" :,-")
        labels = {
            "nome": ("nome", "titulo", "título", "chamada", "com nome"),
            "descricao": ("descricao", "descrição", "detalhes", "detalhe"),
            "equipe": ("equipe", "time"),
            "user": ("usuario", "usuário", "responsavel", "responsável", "para"),
            "task_id": ("tarefa", "task"),
        }.get(param, ())
        lowered = text.lower()
        changed = True
        while changed:
            changed = False
            for label in labels:
                label_norm = label.lower()
                if lowered == label_norm:
                    return ""
                prefix = f"{label_norm} "
                if lowered.startswith(prefix):
                    text = text[len(prefix):].strip(" :,-")
                    lowered = text.lower()
                    changed = True
        return text

    def _strip_task_assignment_tail(self, value: str) -> str:
        text = " ".join((value or "").strip().split()).strip(" :,-")
        return re.split(
            r"\b(?:para\s+mim|atribuir\s+para|assumir|pegar|equipe|time)\b",
            text,
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0].strip(" :,-")

    def _normalize_due_date(self, value: str) -> str:
        text = (value or "").strip().lower()
        today = datetime.now().date()
        if text in {"hoje", "para hoje"}:
            return today.isoformat()
        if text in {"amanha", "amanhã", "para amanha", "para amanhã"}:
            return (today + timedelta(days=1)).isoformat()
        if "semana que vem" in text or "proxima semana" in text or "próxima semana" in text:
            return (today + timedelta(days=7)).isoformat()

        match = re.search(r"\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b", text)
        if match:
            day = int(match.group(1))
            month = int(match.group(2))
            year = int(match.group(3)) if match.group(3) else today.year
            if year < 100:
                year += 2000
            try:
                return datetime(year, month, day).date().isoformat()
            except ValueError:
                return value
        return value

    def _strip_due_date_tail(self, value: str) -> str:
        text = " ".join((value or "").strip().split()).strip(" :,-")
        return re.split(
            r"\b(?:dataentrega|data\s+entrega|data\s+de\s+entrega|prazo|entrega|urg[eê]ncia|urgencia|equipe|time|respons[aá]vel|responsavel)\b",
            text,
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0].strip(" :,-")

    def _enrich_event_team_context(self, event: Dict[str, Any], content: str) -> None:
        try:
            match = self.parser.match(content)
            if match is None:
                return
            params = dict(match.params)
            team_ref = params.get("team_id") or params.get("equipe")
            if not team_ref:
                return
            resolver_params = {"team_id": team_ref}
            self.assistant._resolve_refs(resolver_params, self.assistant._detect_user_type() or "user")
            team_id = str(resolver_params.get("team_id") or "")
            # Só aceita equipe do usuário autenticado (inclusive ObjectId digitado na mensagem).
            my_teams = self.assistant.api.list_my_teams()
            team = next(
                (t for t in my_teams or [] if isinstance(t, dict) and str(t.get("_id") or "") == team_id),
                None,
            )
            if team is None:
                return
            event["teamId"] = team_id
            event["teamName"] = str(team.get("nome") or "").strip() or resolver_params.get("_team_label")
        except Exception:
            return

    def _question_for_param(self, param: str, command_key: str = "") -> str:
        custom_questions = {
            "nome": "Qual é o nome da tarefa ou da equipe?",
            "descricao": "Qual é a descrição detalhada da tarefa?",
            "dataEntrega": "Qual é a data de entrega? Pode dizer hoje, amanhã ou uma data como 25/06/2026.",
            "urgencia": "Qual é o grau de urgência? Baixa, média ou alta?",
            "user": "Quer atribuir para alguém? Diga o nome do usuário ou diga não.",
        }
        if command_key == "create_task" and param == "nome":
            return "Qual é o nome da tarefa?"
        if command_key == "create_task" and param == "descricao":
            return "Qual é a descrição detalhada da tarefa?"
        if command_key == "create_team" and param == "nome":
            return "Qual é o nome da equipe?"
        if command_key == "assign_to_me" and param == "team_id":
            return "Em qual equipe esta a tarefa que voce quer atribuir para voce?"
        if command_key == "assign_to_me" and param == "task_id":
            return "Qual tarefa dessa equipe voce quer atribuir para voce?"
        if param in custom_questions:
            return custom_questions[param]

        questions = {
            "descricao": "Qual é a descrição da tarefa?",
            "equipe": "Para qual equipe?",
            "nome": "Qual é o nome?",
            "task_id": "Qual tarefa? Pode dizer o nome ou descrição.",
            "team_id": "Qual equipe?",
            "texto": "Qual texto devo adicionar?",
            "status": "Qual status? Pendente, em andamento ou concluído?",
            "acao": "Você quer iniciar ou pausar?",
            "q": "Qual termo devo buscar?",
        }
        return questions.get(param, f"Qual é o valor de {param}?")

    def _error(self, error: str, text: str, status: int, **extra: Any) -> Tuple[Dict[str, Any], int]:
        return {
            "ok": False,
            "error": error,
            **extra,
            "reply_text": text,
            "tts": tts_payload(text, language=str(self.body.get("language") or "pt-BR")),
        }, status


def standby_conversation(token: str, body: Dict[str, Any]) -> Tuple[Dict[str, Any], int]:
    user_id = authenticated_user_id(FlowlyAPIClient(base_url=configured_api_base_url(), token=token))
    if not user_id:
        return {"ok": False, "error": "unauthorized", "reply_text": "Autenticação inválida."}, 401

    conversation_id = str(body.get("conversationId") or body.get("conversation_id") or "").strip()
    if conversation_id:
        ScopedConversationState(ConversationStateRepository(), user_id).clear(conversation_id)
    text = "Assistente em standby."
    return {
        "ok": True,
        "status": "standby",
        "reply_text": text,
        "tts": {"enabled": False, "language": "pt-BR", "text": text},
    }, 200


def get_admin_insights(token: str, body: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, Any], int]:
    try:
        me = FlowlyAPIClient(base_url=configured_api_base_url(), token=token).me()
    except Exception:
        return {"ok": False, "error": "unauthorized", "reply_text": "Autenticação inválida."}, 401

    if str((me or {}).get("tipo") or "").lower() != "admin":
        return {"ok": False, "error": "forbidden", "reply_text": "Apenas administradores podem ver insights."}, 403

    return {"ok": True, "insights": AnalyticsRepository().aggregate(), "source": "mongodb"}, 200
