from __future__ import annotations

import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from flowly_assistant.api_client import FlowlyAPIClient
from flowly_assistant.api_config import configured_api_base_url
from flowly_assistant.assistant_core.rest_assistant import assistant_from_http_body, tts_payload
from flowly_assistant.command_parser import (
    STRICT_PARAM_WORDS,
    CommandParser,
    is_write_command,
    plain_words,
    strict_param_value,
)
from flowly_assistant.commands import DISABLED_COMMAND_REPLY, DISABLED_COMMANDS
from flowly_assistant.nlp.moderation import ModerationService
from flowly_assistant.queues.analytics_queue import AnalyticsQueue
from flowly_assistant.storage.analytics_repository import AnalyticsRepository
from flowly_assistant.storage.conversation_state import ConversationStateRepository, ScopedConversationState

# channelId é o tipo de canal de entrada, nunca uma equipe (a API trata channelId com ObjectId como equipe).
ALLOWED_CHANNEL_IDS = {"web", "voice-assistant"}

# Desistencia num fluxo pendente: a frase inteira so tem estas palavras (e ao menos uma de cancelamento).
CANCEL_WORDS = frozenset({
    "cancelar", "cancela", "cancele", "cancelo", "sair", "sai", "saia", "parar", "pare", "encerrar", "encerra",
    "encerre", "desistir", "desisto", "esquece", "esqueca", "deixa", "deixe", "nao", "chega", "abortar", "aborta",
})
CANCEL_FILLER_WORDS = frozenset({
    "pode", "por", "favor", "pra", "para", "la", "isso", "tudo", "o", "a", "os", "as", "esse", "essa", "comando",
    "operacao", "acao", "criacao", "cadastro", "selecao", "tarefa", "equipe", "entao", "ah", "mesmo", "quero",
    "mais", "eu", "agora", "ja", "melhor", "de", "do", "da", "ok", "ta", "bom", "obrigado", "obrigada",
})


# Negacao numa resposta pendente ou na selecao de tarefa: encerra o fluxo ("Não altere", "nunca mude isso").
# Os verbos de cancelamento ficam no is_cancel_request, que exige a frase inteira (preserva "Cancelar assinatura...").
NEGATION_ANSWER_WORDS = frozenset({"nao", "nunca", "jamais", "nem"})

# Numeros e ordinais citados na selecao de tarefa ("11", "7ª", "sexta", "décima primeira", "onze").
# Deteccao ampla, interpretacao estreita: se a frase cita uma posicao que nao vira uma unica opcao
# valida, o assistente pede nova escolha e nunca cai na tarefa selecionada antes.
# "um"/"uma" ficam de fora porque sao artigos.
TASK_POSITION_WORDS = frozenset({
    "primeiro", "primeira", "segundo", "segunda", "terceiro", "terceira", "quarto", "quarta", "quinto", "quinta",
    "sexto", "sexta", "setimo", "setima", "oitavo", "oitava", "nono", "nona", "decimo", "decima",
    "vigesimo", "vigesima", "ultimo", "ultima", "penultimo", "penultima",
    "dois", "duas", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze",
    "catorze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove", "vinte",
})


# Ordinais que a selecao entende (posicao na lista, a partir de 0).
TASK_ORDINALS = {
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


def task_position_refs(text: str) -> set[str]:
    """Posicoes citadas na frase, como palavras inteiras sem acento ("a 7ª" -> {"7a"})."""
    return {word for word in plain_words(text) if word in TASK_POSITION_WORDS or any(ch.isdigit() for ch in word)}


# Acao pedida na selecao de tarefa. "para mim" sozinho nao e atribuicao ("mostra os detalhes para mim").
TASK_ASSIGN_WORDS = ("atribuir", "assumir", "pegar")
TASK_DETAIL_WORDS = ("detalhe", "detalhes", "informacao", "informacoes", "abrir", "mostrar")

# Palavras que acompanham um pedido sobre a tarefa ja escolhida ("pode atribuir essa pra mim, por favor").
# Sem numero, ordinal ou nome completo da lista, qualquer outra palavra indica uma tarefa que nao foi reconhecida
# ("atribuir configurar alerta para mim"): o assistente pede nova escolha e nao usa a tarefa escolhida antes.
TASK_FOLLOW_UP_WORDS = frozenset({
    "atribuir", "atribui", "atribua", "assumir", "assume", "assuma", "pegar", "pega", "pegue",
    "detalhe", "detalhes", "informacao", "informacoes", "abrir", "abre", "abra", "mostrar", "mostra", "mostre",
    "ver", "veja", "ler", "le", "leia", "fala", "fale", "diga", "diz",
    "tarefa", "essa", "esse", "esta", "este", "ela", "ele", "isso", "isto", "dessa", "desse", "desta", "deste",
    "dela", "dele", "nessa", "nesse", "mesma", "mesmo", "selecionada", "escolhida",
    "para", "pra", "pro", "mim", "me", "eu", "voce", "pode", "poderia", "por", "favor", "gentileza", "obrigado",
    "obrigada", "quero", "queria", "gostaria", "agora", "entao", "ok", "sim", "a", "o", "as", "os", "um", "uma",
    "e", "de", "da", "do", "das", "dos", "sobre", "mais", "com",
})

# Resposta a uma pergunta pendente que e so um comando ("minhas tarefas", "quais são minhas tarefas"):
# todas as palavras de uma frase do comando e, alem delas, no maximo estas.
COMMAND_ANSWER_FILLER_WORDS = frozenset({
    "por", "favor", "quero", "queria", "ver", "me", "mostra", "mostre", "mostrar", "quais", "qual", "sao", "e",
    "o", "a", "os", "as", "eu", "pode", "agora", "entao", "ok",
})
# Rotulo que torna explicito o valor de um campo ("nome Minhas Tarefas"); _normalize_param_value o remove.
PARAM_VALUE_LABELS = {"nome": "nome", "descricao": "descrição", "equipe": "equipe", "user": "usuário", "task_id": "tarefa"}


def command_in_answer(text: str, commands: list) -> Optional[Any]:
    """Comando que a resposta inteira pede: uma frase completa do comando e, no maximo, palavras de cortesia."""
    words = plain_words(text)
    for command in commands:
        for phrase in command.phrases:
            phrase_words = plain_words(phrase)
            if phrase_words and set(phrase_words) <= set(words) and all(
                word in phrase_words or word in COMMAND_ANSWER_FILLER_WORDS for word in words
            ):
                return command
    return None


# Respostas de consulta: reply_text (tela) traz a lista completa; tts.text (fala) resume.
SELECTABLE_TASK_LIMIT = 10  # tarefas guardadas no estado da conversa para selecao
SPOKEN_TASK_LIMIT = 5
SPOKEN_NAME_LIMIT = 8
ACCOUNT_TYPE_LABELS = {"admin": "administrador", "user": "colaborador"}
URGENCY_LABELS = {"baixa": "baixa", "media": "média", "alta": "alta"}


def _count(count: int, singular: str, plural: str) -> str:
    return f"{count} {singular if count == 1 else plural}"


def _dict_items(result: Any) -> list[Dict[str, Any]]:
    """Itens validos de uma lista da API; qualquer outro formato conta como lista vazia."""
    return [item for item in result if isinstance(item, dict)] if isinstance(result, list) else []


def _item_names(items: list[Dict[str, Any]]) -> list[str]:
    """So o campo nome: e-mail, foto (URL assinada) e IDs nunca entram no texto."""
    return [name for name in (str(item.get("nome") or "").strip() for item in items) if name]


def _names_text(names: list[str], total: int, *, limit: Optional[int] = None) -> str:
    """Tela (sem limite): todos os nomes. Fala: os primeiros `limit` e "e mais N" (N inclui itens sem nome)."""
    shown = names if limit is None else names[:limit]
    rest = total - len(shown)
    if rest <= 0:
        return ", ".join(shown)
    return ", ".join(shown) + f" e mais {rest}" + (" sem nome" if limit is None else "")


def _short_date(value: Any) -> Optional[str]:
    match = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(value or ""))
    return f"{match.group(3)}/{match.group(2)}/{match.group(1)}" if match else None


def is_cancel_request(text: str, *, param: Optional[str] = None) -> bool:
    """Frases como "cancelar", "sair" ou "não, deixa pra lá" encerram o fluxo e nunca viram valor de campo."""
    words = plain_words(text)
    cancel = {word for word in words if word in CANCEL_WORDS}
    if not cancel or any(word not in CANCEL_WORDS and word not in CANCEL_FILLER_WORDS for word in words):
        return False
    # Na pergunta do responsavel, "não" sozinho significa "sem responsável", e nao desistencia.
    if param == "user" and cancel <= {"nao"}:
        return False
    return True


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

        if match.command.key in DISABLED_COMMANDS:
            return self._disabled_command_response(
                event_id=event["id"],
                moderation_score=moderation.score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                command_key=match.command.key,
            )

        supplied_params = self.body.get("params") if isinstance(self.body.get("params"), dict) else {}
        merged_params = {**supplied_params, **match.params}
        # status/acao/urgencia desconhecidos (na frase ou nos params) contam como faltando: o assistente pergunta.
        for param in STRICT_PARAM_WORDS:
            if merged_params.get(param):
                merged_params[param] = strict_param_value(param, merged_params[param]) or ""
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

        # Estado salvo antes da desativacao (ou forjado) tambem nao executa.
        if command.key in DISABLED_COMMANDS:
            return self._disabled_command_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                command_key=command.key,
            )

        params = dict(pending.get("params") or {})
        missing = [p for p in pending.get("missing", command.required_params) if not params.get(p)]
        if not missing:
            self.conversations.clear(conversation_id)
            return self._error("invalid_conversation", "Esse comando já estava completo. Pode repetir?", 400)

        if self._wants_to_stop(content, missing[0]):
            self.conversations.clear(conversation_id)
            return self._task_conversation_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                status="cancelled",
                text=f"Tudo bem, cancelei: {command.title}. Nada foi alterado.",
                ok=True,
                action_executed=False,
                command={"key": command.key},
            )

        # "minhas tarefas" em resposta a "Qual é o nome da equipe?" criava a equipe "Minhas Tarefas". Resposta que e
        # so um comando nao vira valor de escrita: o fluxo continua pendente e o assistente pergunta o que fazer.
        if is_write_command(command) and missing[0] not in STRICT_PARAM_WORDS:
            if command_in_answer(content, self.parser.commands) is not None:
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
                    text=self._command_answer_question(content, missing[0], command.title),
                )

        value = self._normalize_param_value(missing[0], content)
        if missing[0] in STRICT_PARAM_WORDS and not value:
            # Resposta desconhecida: nada de valor padrao; o fluxo continua pendente e a pergunta se repete.
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
                text=self._invalid_answer_question(missing[0]),
            )
        params[missing[0]] = value
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
            tasks = _dict_items(result)
            display, spoken = self._tasks_reply(tasks)
            if tasks:
                self.conversations.save(
                    conversation_id,
                    {
                        "mode": "task_selection",
                        "tasks": [self._compact_task(task) for task in tasks[:SELECTABLE_TASK_LIMIT]],
                    },
                )
                payload["conversation"] = {
                    "id": conversation_id,
                    "status": "browsing_tasks",
                    "options": ["details", "assign_to_me", "cancel"],
                }
            return self._with_reply(payload, display, spoken)

        team_label = str((payload.get("params") or {}).get("_team_label") or "").strip()
        if command_key in {"my_teams", "list_teams"}:
            display, spoken = self._teams_reply(_dict_items(result))
        elif command_key == "me":
            display, spoken = self._profile_reply(result)
        elif command_key == "task_details":
            display, spoken = self._task_details_reply(result, follow_up=False)
        elif command_key == "team_members":
            display, spoken = self._members_reply(_dict_items(result), team_label)
        elif command_key in {"list_users", "search_users"}:
            display, spoken = self._users_reply(_dict_items(result))
        elif command_key == "team_messages":
            display, spoken = self._messages_reply(_dict_items(result), team_label)
        else:
            return payload
        return self._with_reply(payload, display, spoken)

    def _with_reply(self, payload: Dict[str, Any], display: str, spoken: str) -> Dict[str, Any]:
        """reply_text e o texto da tela; tts.text e a fala. Mantem enabled/language ja calculados pelo assistente."""
        previous = payload.get("tts") if isinstance(payload.get("tts"), dict) else {}
        payload["reply_text"] = display
        payload["tts"] = tts_payload(
            spoken,
            enabled=bool(previous.get("enabled", True)),
            language=str(previous.get("language") or self.body.get("language") or "pt-BR"),
        )
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
        # Negacao tambem cancela: "não quero atribuir para mim" nao pode virar atribuicao.
        if (
            self._is_cancel(text_norm)
            or is_cancel_request(content)
            or bool(NEGATION_ANSWER_WORDS & set(plain_words(content)))
        ):
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
        position_refs = task_position_refs(content)
        named_tasks = self._tasks_named_in(content, tasks)
        approximate = False
        if position_refs:
            requested_task = self._task_for_position_refs(position_refs, named_tasks, tasks)
        elif named_tasks:
            # Nome completo de uma unica tarefa vale mais que trechos de outros nomes; dois nomes sao conflito.
            requested_task = named_tasks[0] if len(named_tasks) == 1 else None
        else:
            requested_task = self._select_task_from_text(text_norm, tasks)
            approximate = requested_task is not None  # trecho de nome: seleciona, mas nao autoriza escrita
        # "atribuir configurar alerta para mim" com a 7 selecionada atribuia a 7: palavra que nao e acao nem
        # complemento, sem numero ou nome reconhecido, e uma tarefa que o assistente nao identificou.
        unknown_ref = requested_task is None and any(word not in TASK_FOLLOW_UP_WORDS for word in plain_words(content))
        if requested_task is None and (position_refs or named_tasks or unknown_ref):
            # "atribuir a 11 para mim" com a 7 selecionada atribuia a 7; "a 11 da Marketing" e
            # "Marketing e Configurar Alertas" atribuiam a Marketing. Numero/ordinal invalido, referencias a
            # tarefas diferentes ou tarefa desconhecida: descarta a selecao anterior e nao chama a API.
            self.conversations.save(
                conversation_id,
                {key: value for key, value in pending.items() if key != "selected_task_id"},
            )
            options = "; ".join(f"{idx}. {self._task_title(task)}" for idx, task in enumerate(tasks, start=1))
            text = (
                f"Não identifiquei uma única tarefa da lista. Opções disponíveis: {options}. "
                "Diga o número de uma delas ou cancelar."
            )
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
        if requested_task:
            selected_task = requested_task

        # Palavras do nome citado ("Pegar feedback") nao decidem a acao.
        action = self._task_follow_up_action(self._words_outside_names(content, named_tasks))
        if action == "assign" and approximate:
            action = None
        if selected_task and action in (None, "conflict"):
            self.conversations.save(
                conversation_id,
                {**pending, "selected_task_id": selected_task.get("_id")},
            )
            text = (
                f"Selecionei {selected_task.get('descricao') or 'essa tarefa'}. "
                "Voce quer detalhes, atribuir para voce ou cancelar?"
            )
            if action == "conflict":
                text = (
                    "Você pediu detalhes e atribuição na mesma frase. "
                    f"Selecionei {selected_task.get('descricao') or 'essa tarefa'}. "
                    "Você quer ver os detalhes ou atribuir para você?"
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
            text, spoken = self._task_details_reply(result, follow_up=True)
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
                spoken=spoken,
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
        spoken: Optional[str] = None,
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
            "tts": tts_payload(spoken or text, language=str(self.body.get("language") or "pt-BR")),
            **extra,
        }, 200 if ok else 400

    def _wants_to_stop(self, content: str, param: str) -> bool:
        """Desistencia ou negacao numa pergunta pendente: encerra o fluxo e nunca vira valor de campo.

        Sem isso, "Não altere o status" virava status "pendente" (e "Não inicie o cronômetro", acao "pausar").
        """
        if param == "user" and self._normalize_param_value("user", content) == "__none__":
            return False  # na pergunta do responsavel, "não" significa "sem responsável"
        return is_cancel_request(content, param=param) or bool(NEGATION_ANSWER_WORDS & set(plain_words(content)))

    def _disabled_command_response(
        self,
        *,
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
        conversation_id: str,
        command_key: str,
    ) -> Tuple[Dict[str, Any], int]:
        """Comando desativado: limpa o estado pendente e responde sem chamar a API."""
        self.conversations.clear(conversation_id)
        return {
            "ok": False,
            "error": "command_disabled",
            "messageId": event_id,
            "moderation": {"allowed": True, "score": moderation_score},
            "queue": queue_result,
            "action_executed": False,
            "command": {"key": command_key},
            "conversation": {"id": conversation_id, "status": "cancelled"},
            "reply_text": DISABLED_COMMAND_REPLY,
            "tts": tts_payload(DISABLED_COMMAND_REPLY, language=str(self.body.get("language") or "pt-BR")),
        }, 403

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

    def _task_summary(self, task: Dict[str, Any], *, spoken: bool) -> str:
        """Linha de uma tarefa. Fala: nome, status e equipe. Tela: tambem urgencia e data de entrega."""
        parts = [self._task_title(task), f"status {self._status_label(str(task.get('status') or 'pendente'))}"]
        urgencia = URGENCY_LABELS.get(str(task.get("urgencia") or "").strip().lower())
        if urgencia and not spoken:
            parts.append(f"urgência {urgencia}")
        equipe = task.get("equipe")
        if isinstance(equipe, dict) and str(equipe.get("nome") or "").strip():
            parts.append(f"equipe {str(equipe.get('nome')).strip()}")
        entrega = None if spoken else _short_date(task.get("dataEntrega"))
        if entrega:
            parts.append(f"entrega {entrega}")
        return ", ".join(parts)

    def _tasks_reply(self, tasks: list[Dict[str, Any]]) -> Tuple[str, str]:
        """Tela: as opcoes selecionaveis (as mesmas guardadas no estado). Fala: no maximo cinco."""
        if not tasks:
            text = "Não encontrei tarefas para listar."
            return text, text
        options = tasks[:SELECTABLE_TASK_LIMIT]
        header = f"Encontrei {_count(len(tasks), 'tarefa', 'tarefas')}."
        follow_up = "Você pode pedir detalhes, atribuir uma tarefa para você ou cancelar."

        listed = "; ".join(f"{idx}. {self._task_summary(task, spoken=False)}" for idx, task in enumerate(options, start=1))
        display = f"{header} Opções para seleção: {listed}."
        outside = len(tasks) - len(options)
        if outside:
            verb = "fica" if outside == 1 else "ficam"
            display += f" Mais {_count(outside, 'tarefa', 'tarefas')} {verb} fora desta seleção; veja todas na tela de Tarefas."

        said = " ".join(
            f"{idx}. {self._task_summary(task, spoken=True)}." for idx, task in enumerate(options[:SPOKEN_TASK_LIMIT], start=1)
        )
        spoken = f"{header} {said}"
        more_options = len(options) - SPOKEN_TASK_LIMIT
        if more_options > 0:
            spoken += f" Há mais {_count(more_options, 'opção', 'opções')} na tela."
        return f"{display} {follow_up}", f"{spoken} {follow_up}"

    def _teams_reply(self, teams: list[Dict[str, Any]]) -> Tuple[str, str]:
        """Tela: todos os nomes de equipe. Fala: ate oito e quantas faltam. Membros nunca entram no texto."""
        if not teams:
            text = "Não encontrei equipes vinculadas a você."
            return text, text
        names = _item_names(teams)
        header = f"Você participa de {_count(len(teams), 'equipe', 'equipes')}"
        if not names:
            return f"{header}.", f"{header}."
        display = f"{header}: {_names_text(names, len(teams))}."
        spoken = f"{header}: {_names_text(names, len(teams), limit=SPOKEN_NAME_LIMIT)}."
        if len(teams) > SPOKEN_NAME_LIMIT:
            spoken += " A lista completa está na tela."
        return display, spoken

    def _profile_reply(self, result: Any) -> Tuple[str, str]:
        """Tela: nome, tipo de conta e e-mail. Fala: nome e tipo. Sem IDs, foto ou campos de biometria."""
        if not isinstance(result, dict):
            text = "Não consegui ler os dados do seu perfil."
            return text, text
        nome = str(result.get("nome") or "").strip()
        tipo = ACCOUNT_TYPE_LABELS.get(str(result.get("tipo") or "").strip().lower())
        email = str(result.get("email") or "").strip()
        spoken_parts = [part for part in (nome, f"conta de {tipo}" if tipo else "") if part]
        display_parts = spoken_parts + ([f"e-mail {email}"] if email else [])
        if not display_parts:
            text = "Seu perfil não tem nome, tipo de conta ou e-mail para mostrar."
            return text, text
        display = "Seu perfil: " + ", ".join(display_parts) + "."
        spoken = "Seu perfil: " + ", ".join(spoken_parts) + "." if spoken_parts else "Seu perfil está na tela."
        return display, spoken

    def _members_reply(self, members: list[Dict[str, Any]], team_label: str) -> Tuple[str, str]:
        """Quantidade e nomes dos membros; sem e-mail, foto ou IDs."""
        team = f"A equipe {team_label}" if team_label else "A equipe"
        if not members:
            text = f"{team} não tem membros para mostrar."
            return text, text
        header = f"{team} tem {_count(len(members), 'membro', 'membros')}"
        names = _item_names(members)
        if not names:
            return f"{header}.", f"{header}."
        display = f"{header}: {_names_text(names, len(members))}."
        spoken = f"{header}: {_names_text(names, len(members), limit=SPOKEN_NAME_LIMIT)}."
        if len(members) > SPOKEN_NAME_LIMIT:
            spoken += " A lista completa está na tela."
        return display, spoken

    def _users_reply(self, users: list[Dict[str, Any]]) -> Tuple[str, str]:
        """Listar ou buscar usuarios: quantidade e nomes; o e-mail de terceiros nunca entra no texto."""
        if not users:
            text = "Não encontrei usuários."
            return text, text
        header = f"Encontrei {_count(len(users), 'usuário', 'usuários')}"
        names = _item_names(users)
        if not names:
            return f"{header}.", f"{header}."
        display = f"{header}: {_names_text(names, len(users))}."
        spoken = f"{header}: {_names_text(names, len(users), limit=SPOKEN_NAME_LIMIT)}."
        if len(users) > SPOKEN_NAME_LIMIT:
            spoken += " A lista completa está na tela."
        return display, spoken

    def _messages_reply(self, messages: list[Dict[str, Any]], team_label: str) -> Tuple[str, str]:
        """Quantidade de mensagens e autor da mais recente; o conteudo do historico nunca e reproduzido."""
        chat = f"O chat da equipe {team_label}" if team_label else "O chat da equipe"
        if not messages:
            text = f"{chat} não tem mensagens."
            return text, text
        text = f"{chat} tem {_count(len(messages), 'mensagem', 'mensagens')}."
        # A API ordena da mais antiga para a mais recente; createdAt desempata se vier fora de ordem.
        latest = max(enumerate(messages), key=lambda pair: (str(pair[1].get("createdAt") or ""), pair[0]))[1]
        author = latest.get("user")
        author_name = str(author.get("nome") or "").strip() if isinstance(author, dict) else ""
        if author_name:
            text += f" A mais recente é de {author_name}."
        return text, text

    def _task_details_reply(self, result: Any, *, follow_up: bool) -> Tuple[str, str]:
        """Tela: nome, status, equipe, responsavel e detalhes. Fala: sem os detalhes. Sem comentarios nem logs.

        follow_up: so no fluxo de selecao, onde "outra tarefa" e "atribuir" continuam valendo.
        """
        tarefa = (result or {}).get("tarefa") if isinstance(result, dict) else None
        if not isinstance(tarefa, dict):
            text = "Não consegui ler os detalhes dessa tarefa."
            return text, text
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
        spoken = ". ".join(parts) + "."
        detalhes = str(tarefa.get("detalhes") or "").strip()
        display = ". ".join(parts + [f"detalhes: {detalhes[:180]}"]) + "." if detalhes else spoken
        if follow_up:
            suffix = " Voce pode pedir outra tarefa, atribuir para voce ou cancelar."
            return display + suffix, spoken + suffix
        return display, spoken

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
        """assign, details, conflict (os dois na mesma frase: pergunta antes de escrever) ou None."""
        assign = any(word in text for word in TASK_ASSIGN_WORDS)
        details = any(word in text for word in TASK_DETAIL_WORDS)
        if assign and details:
            return "conflict"
        return "assign" if assign else "details" if details else None

    def _words_outside_names(self, content: str, named_tasks: list[Dict[str, Any]]) -> str:
        """A frase sem acento, sem os nomes completos das tarefas citadas."""
        words = plain_words(content)
        for task in named_tasks:
            title = plain_words(str(task.get("descricao") or ""))
            if not title:
                continue
            kept, index = [], 0
            while index < len(words):
                if words[index:index + len(title)] == title:
                    index += len(title)
                else:
                    kept.append(words[index])
                    index += 1
            words = kept
        return " ".join(words)

    def _tasks_named_in(self, content: str, tasks: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
        """Tarefas citadas pelo nome completo, em palavras inteiras.

        Um nome que so aparece dentro de outro nome citado nao conta ("login" em "revisar cadastro e login").
        """
        words = plain_words(content)
        spans = []
        for task in tasks:
            title = plain_words(str(task.get("descricao") or ""))
            if not title:
                continue
            for start in range(len(words) - len(title) + 1):
                if words[start:start + len(title)] == title:
                    spans.append((start, start + len(title), task))
        named = {}
        for start, end, task in spans:
            if not any(s <= start and end <= e and e - s > end - start for s, e, _other in spans):
                named[str(task.get("_id"))] = task
        return list(named.values())

    def _task_for_position_refs(
        self, refs: set[str], named: list[Dict[str, Any]], tasks: list[Dict[str, Any]]
    ) -> Optional[Dict[str, Any]]:
        """Tarefa unica apontada por numeros/ordinais e nomes completos da frase; None se invalida ou em conflito.

        Cada numero/ordinal valido e cada nome dito por inteiro indicam uma tarefa; todas precisam coincidir.
        Numero fora da lista so e aceito se fizer parte do nome citado ("Sprint 15"), nunca e ignorado.
        """
        candidates = {str(task.get("_id")): task for task in named}
        explained = set().union(*(task_position_refs(str(task.get("descricao") or "")) for task in named))
        for ref in refs:
            idx = int(ref) - 1 if ref.isdigit() else TASK_ORDINALS.get(ref)
            if idx is not None and 0 <= idx < len(tasks):
                candidates[str(tasks[idx].get("_id"))] = tasks[idx]
            elif ref not in explained:
                return None
        return next(iter(candidates.values())) if len(candidates) == 1 else None

    def _select_task_from_text(self, text: str, tasks: list[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        number_match = re.search(r"\b(\d{1,2})\b", text)
        if number_match:
            idx = int(number_match.group(1)) - 1
            if 0 <= idx < len(tasks):
                return tasks[idx]
        for word, idx in TASK_ORDINALS.items():
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
        if param in STRICT_PARAM_WORDS:
            # Sem valor padrao: resposta desconhecida volta vazia e a pergunta se repete.
            return strict_param_value(param, raw) or ""
        return raw

    def _command_answer_question(self, content: str, param: str, title: str) -> str:
        answer = " ".join(content.split()).strip(" .,;:!?")
        label = PARAM_VALUE_LABELS.get(param)
        keep = (
            f"Para continuar em {title} usando esse valor, diga: {label} {answer}."
            if label
            else f"Para continuar em {title}, responda com outras palavras."
        )
        return f'"{answer}" também é um comando. {keep} Para trocar de comando, diga cancelar.'

    def _invalid_answer_question(self, param: str) -> str:
        return {
            "status": "Não entendi o status. Responda pendente, em andamento ou concluído.",
            "acao": "Não entendi. Você quer iniciar ou pausar o cronômetro?",
            "urgencia": "Não entendi a urgência. Responda baixa, média ou alta.",
        }[param]

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
