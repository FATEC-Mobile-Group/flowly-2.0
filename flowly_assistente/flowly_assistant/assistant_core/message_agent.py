from __future__ import annotations

import difflib
import hmac
import os
import re
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from flowly_assistant.api_client import APIError, FlowlyAPIClient
from flowly_assistant.api_config import configured_api_base_url
from flowly_assistant.assistant_core.rest_assistant import (
    PROFILE_UNKNOWN_REPLY,
    assistant_from_http_body,
    coerce_jsonable,
    has_permission,
    is_object_id,
    tts_payload,
)
from flowly_assistant.command_parser import (
    NON_DIRECTIVE_FUTURE_WORDS,
    NON_DIRECTIVE_QUESTION_EXPRESSIONS,
    NON_DIRECTIVE_QUESTION_WORDS,
    STRICT_PARAM_WORDS,
    CommandParser,
    WRITE_INTENT_RE,
    extract_status_target,
    is_conditional_period_follow_up,
    is_write_command,
    period_follow_up_utterance,
    plain_words,
    strict_param_value,
)
from flowly_assistant.commands import (
    DISABLED_COMMAND_REPLY,
    DISABLED_COMMANDS,
    WRITES_DISABLED_REPLY,
    Command,
    assistant_writes_enabled,
)
from flowly_assistant.nlp.moderation import ModerationService
from flowly_assistant.operations_client import FINGERPRINT, UUID_V4, OperationsClient, params_fingerprint
from flowly_assistant.queues.analytics_queue import AnalyticsQueue
from flowly_assistant.storage.analytics_repository import AnalyticsRepository
from flowly_assistant.conversation_client import ConversationStateClient
from flowly_assistant.task_queries import (
    TASK_QUERY_KEYS,
    build_reply,
    feminine_number,
    metadata,
    selection_metadata,
    task_card,
    urgent_follow_up,
)
from flowly_assistant.operations_client import OPERATIONS_SECRET_ENV
from flowly_assistant.storage.conversation_memory import (
    MEMORY_SUFFIX,
    ConversationMemory,
    asked_fact_label,
    extract_stated_fact,
)
from flowly_assistant.storage.conversation_state import (
    ConversationStateConflict,
    ConversationStateRejected,
    ConversationStateUnavailable,
    SharedConversationState,
)

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


# Posicao (a partir de 0) de cada palavra de posicao na selecao. Separado de TASK_ORDINALS, que tambem e usado
# por trecho de texto em _select_task_from_text ("dez" esta dentro de "dezembro"); aqui so palavras inteiras.
_ORDINAL_STEMS = ("primeir", "segund", "terceir", "quart", "quint", "sext", "setim", "oitav", "non", "decim")
TASK_POSITION_INDEX = {
    **{stem + ending: index for index, stem in enumerate(_ORDINAL_STEMS) for ending in ("o", "a")},
    **{word: index for index, words in enumerate((
        (), ("dois", "duas"), ("tres",), ("quatro",), ("cinco",), ("seis",), ("sete",), ("oito",), ("nove",), ("dez",),
        ("onze",), ("doze",), ("treze",), ("catorze", "quatorze"), ("quinze",), ("dezesseis",), ("dezessete",),
        ("dezoito",), ("dezenove",), ("vinte",),
    )) for word in words},
    "vigesimo": 19,
    "vigesima": 19,
}
TASK_POSITION_FROM_END = {"ultimo": 1, "ultima": 1, "penultimo": 2, "penultima": 2}
_NUMERIC_POSITION_RE = re.compile(r"(\d{1,2})[ao]?")  # "7", "7a" (7ª), "7o" (7º)


def task_position_index(ref: str, count: int) -> Optional[int]:
    """Indice da lista de `count` tarefas para uma posicao citada, ou None (posicao desconhecida ou inexistente)."""
    numeric = _NUMERIC_POSITION_RE.fullmatch(ref)
    if numeric:
        index = int(numeric.group(1)) - 1
    elif ref in TASK_POSITION_FROM_END:
        index = count - TASK_POSITION_FROM_END[ref]
    else:
        index = TASK_POSITION_INDEX.get(ref)
    return index if index is not None and 0 <= index < count else None


# Acao pedida na selecao de tarefa. "para mim" sozinho nao e atribuicao ("mostra os detalhes para mim").
TASK_ASSIGN_WORDS = ("atribuir", "assumir", "pegar")
# Pedido de detalhes: palavras inteiras ("abra", "mostre", "veja"...), nunca trecho de outra palavra.
TASK_DETAIL_WORDS = frozenset({
    "detalhe", "detalhes", "informacao", "informacoes", "abrir", "abre", "abra", "mostrar", "mostra", "mostre",
    "ver", "veja", "ler", "le", "leia", "fala", "fale", "diga", "diz", "conta", "conte",
})
TASK_DETAIL_WORDS_WITH_MIM = frozenset({"detalhe", "detalhes", "informacao", "informacoes", "abrir", "mostrar"})

# Pergunta sobre um dado da tarefa escolhida ("qual é o prazo dela?", "em que equipe ela está?"). Resposta com os
# dados atuais da API (rota de detalhes), so o que foi perguntado; o que faltar e dito como ausente.
TASK_ATTRIBUTE_WORDS = (
    ("prazo", frozenset({"prazo", "vence", "vencer", "vencimento", "entrega", "entregar", "data"})),
    ("status", frozenset({
        "status", "situacao", "andamento", "concluida", "concluido", "terminada", "terminado", "finalizada",
        "finalizado", "pronta", "pronto", "feita", "feito",
    })),
    ("urgencia", frozenset({"urgencia", "prioridade", "urgente", "prioritaria", "prioritario"})),
    ("equipe", frozenset({"equipe", "time"})),
    ("descricao", frozenset({"descricao"})),
    ("responsavel", frozenset({"responsavel", "cuidando", "cuida"})),
)
# Rotulo de cada dado na pergunta de esclarecimento ("Você quis dizer a urgência?").
TASK_ATTRIBUTE_LABELS = {
    "prazo": "o prazo", "status": "o status", "urgencia": "a urgência", "prioridade": "a prioridade",
    "equipe": "a equipe", "descricao": "a descrição", "responsavel": "o responsável",
}
# Pergunta sobre a tarefa escolhida (mesmo com um dado desconhecido ou mal transcrito: "qual é a agência dela?").
TASK_QUESTION_WORDS = frozenset({"qual", "quando", "quem", "como", "onde", "quanto", "quanta"})
# Pedido sobre a lista ou sobre a propria pessoa, nao sobre uma tarefa: fica com os fluxos de antes.
TASK_ATTRIBUTE_EXCLUDED_WORDS = frozenset({
    "quais", "mais", "tarefas", "urgentes", "prioritarias", "prioritarios", "importantes",
    "minha", "minhas", "meu", "meus",
})
# Referencia explicita a uma unica tarefa (pronome pessoal); "essa"/"esta" so contam junto de "tarefa".
SINGLE_TASK_PRONOUNS = frozenset({"ela", "ele", "dela", "dele", "nela", "nele"})
SINGLE_TASK_DEMONSTRATIVES = frozenset({"essa", "esse", "esta", "este", "dessa", "desse", "desta", "deste"})


def refers_to_single_task(text: str) -> bool:
    words = set(plain_words(text))
    return bool(words & SINGLE_TASK_PRONOUNS) or ("tarefa" in words and bool(words & SINGLE_TASK_DEMONSTRATIVES))


# Quantidade, nao posicao: numero logo depois de artigo plural ("as três mais urgentes", "as 2").
PLURAL_ARTICLES = frozenset({"as", "os", "das", "dos"})
TASK_QUANTITY_WORDS = {
    "dois": 2, "duas": 2, "tres": 3, "quatro": 4, "cinco": 5, "seis": 6, "sete": 7, "oito": 8, "nove": 9, "dez": 10,
}


def requested_quantity(text: str) -> Optional[int]:
    words = plain_words(text)
    for previous, word in zip(words, words[1:]):
        if previous not in PLURAL_ARTICLES:
            continue
        if word.isdigit() and len(word) <= 2:
            return int(word) or None
        if word in TASK_QUANTITY_WORDS:
            return TASK_QUANTITY_WORDS[word]
    return None


# Dia da semana, nao posicao: "sexta-feira", "terça", "sábado", "domingo", ou segunda/quarta/quinta/sexta depois
# de preposicao de data ("de segunda", "na sexta", "até quinta"). "a sexta", "da sexta" e "a sexta tarefa" seguem
# sendo posicao.
WEEKDAY_ONLY_WORDS = frozenset({"feira", "terca", "sabado", "domingo"})
WEEKDAY_ORDINAL_WORDS = frozenset({"segunda", "quarta", "quinta", "sexta"})
WEEKDAY_PREPOSITIONS = frozenset({
    "de", "na", "no", "para", "pra", "ate", "desta", "dessa", "nesta", "nessa", "proxima", "toda", "todas",
})
WEEKDAY_UNSUPPORTED_REPLY = (
    "Ainda não consigo consultar tarefas por dia da semana. Nada foi alterado. "
    "Você pode pedir as de hoje, as de amanhã, as desta semana ou as da próxima semana."
)


def weekday_reference(text: str) -> bool:
    words = plain_words(text)
    if set(words) & WEEKDAY_ONLY_WORDS:
        return True
    return any(word in WEEKDAY_ORDINAL_WORDS and previous in WEEKDAY_PREPOSITIONS
               for previous, word in zip(words, words[1:]))

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
    "e", "de", "da", "do", "das", "dos", "sobre", "mais", "com", "conta", "conte",
})
# Palavras aceitas numa pergunta sobre um dado da tarefa, alem das de acompanhamento e dos proprios dados.
TASK_ATTRIBUTE_FILLER_WORDS = TASK_FOLLOW_UP_WORDS | {
    w for _attribute, vocabulary in TASK_ATTRIBUTE_WORDS for w in vocabulary
} | {
    "qual", "quando", "que", "quem", "em", "na", "no", "nela", "nele", "tem", "ta", "ja", "ainda", "hoje", "amanha",
    "atual", "atualmente", "dia", "tenho", "preciso", "devo", "foi", "sera", "esta",
}

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
# Acompanhamento sobre a lista mostrada ("e quais sao as mais urgentes?"): so leitura da lista ja guardada.
URGENCY_FOLLOW_UP_WORDS = frozenset({
    "urgente", "urgentes", "urgencia", "prioritaria", "prioritarias", "prioritario", "prioritarios",
    "importante", "importantes", "prioridade",
})
# Listagens de leitura que substituem uma lista aberta ("ver minhas atividades" depois de "listar tarefas").
# list_tasks de um colaborador vira my_tasks no RestAssistant (perfil lido de /users/me), nunca aqui.
LISTING_COMMAND_KEYS = frozenset(TASK_QUERY_KEYS) | {"my_tasks", "list_tasks", "backlog"}
# Depois de uma consulta sem lista numerada (vazia ou resumo): sem tarefas para "a 1"; vale so para trocar o periodo.
# Mesmo formato aceito pela API de conversas (selecao com lista vazia): nenhum formato novo de estado.
EMPTY_LISTING_CONTEXT = {"mode": "task_selection", "tasks": []}
SCOPE_CLARIFY_REPLY = (
    "A lista aberta é do backlog. Nada foi consultado. Para ver as suas tarefas desse período, diga, por exemplo, "
    "\"minhas tarefas de amanhã\"."
)


def _unassigned(task: Dict[str, Any]) -> bool:
    """Tarefa sem responsavel na lista guardada (backlog): nao e uma lista das proprias tarefas."""
    user = task.get("user")
    if isinstance(user, dict):
        return not str(user.get("nome") or user.get("_id") or "").strip()
    return not str(user or "").strip()


PERIOD_CLARIFY_REPLY = (
    "Não entendi se você quer a lista de tarefas desse período ou saber o prazo da tarefa {title}. "
    "Diga, por exemplo, \"e as de amanhã\" ou \"ela vence amanhã?\"."
)
PLAIN_LISTING_KEYS = frozenset({"my_tasks", "list_tasks", "backlog"})  # listagens sem filtro de data
AMBIGUOUS_LISTING_REPLY = (
    "Não entendi se você quer uma nova lista de tarefas ou uma tarefa da lista atual. Nada foi alterado. "
    "Diga, por exemplo, \"listar minhas tarefas\" ou \"detalhes da tarefa 1\"."
)
TASK_QUERY_UNAVAILABLE_REPLY = (
    "Não consegui consultar suas tarefas agora. Isso não quer dizer que você não tenha tarefas; "
    "tente novamente em instantes."
)
SPOKEN_TASK_LIMIT = 5
SPOKEN_NAME_LIMIT = 8
ACCOUNT_TYPE_LABELS = {"admin": "administrador", "user": "colaborador"}
URGENCY_LABELS = {"baixa": "baixa", "media": "média", "alta": "alta"}


def _count(count: int, singular: str, plural: str) -> str:
    return f"{count} {singular if count == 1 else plural}"


def _parse_instant(value: Any) -> Optional[datetime]:
    """Instante ISO-8601 COM fuso (como a API envia). Sem fuso, malformado ou de outro tipo: None."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


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


# Confirmacao de escrita: toda escrita completa (digitada ou falada; o channelId nao distingue as duas) e
# preparada sem alterar nada e so executa com uma confirmacao explicita numa mensagem posterior.
# A frase inteira so pode ter estas palavras e ao menos uma de confirmacao: "sim" sozinho nao confirma.
CONFIRMATION_WORDS = frozenset({"confirmar", "confirmo", "confirma", "confirme", "confirmado"})
CONFIRMATION_FILLER_WORDS = frozenset({"sim", "pode", "por", "favor", "ok", "entao", "agora", "isso", "eu"})
# A confirmacao de escrita mora na API (/api/assistant/operations), nunca no arquivo local: o prazo, o uso unico
# (claim atomico), a chave de idempotencia e o desfecho sao da operacao compartilhada. O estado local guarda so
# perguntas de campos e selecao de tarefas (ate a etapa 6A.3).
ACTIVE_OPERATION_STATUSES = frozenset({"pending", "executing", "retry_pending"})
# Execucao dentro do lease do claim (padrao 180 s na API; o valor real vem do proprio claim). Tudo medido com
# relogio monotonico a partir do envio do claim (antes do inicio do lease no servidor: conservador).
LEASE_FALLBACK_SEC = 180.0
WRITE_TIMEOUT_CAP_SEC = 30.0  # nenhuma escrita protegida espera mais que isto (o timeout_sec do corpo nao vale)
COMPLETE_RESERVE_SEC = 40.0  # registrar o desfecho (ate 10 s) + margem de latencia e de relogio
MIN_WRITE_TIMEOUT_SEC = 5.0  # sem esta folga, a escrita nem comeca
MAX_CONFIRM_WINDOW_SEC = 600.0  # teto do prazo de confirmacao na API (120 s por padrao); acima disso, nao reutiliza
# Parametros executaveis por comando (o mesmo contrato da API de operacoes). Rotulos (_task_label...) e qualquer
# outra chave ficam fora: o resumo ja leva o que e so de apresentacao.
EXECUTABLE_PARAMS = {
    "create_team": (("nome",), ()),
    "create_task": (("nome", "dataEntrega", "urgencia", "equipe"), ("descricao", "user")),
    "add_comment": (("task_id", "texto"), ()),
    "add_subtask": (("task_id", "descricao"), ()),
    "assign_to_me": (("task_id",), ("team_id",)),
    "update_status": (("task_id", "status"), ()),
    "timer": (("task_id", "acao"), ()),
}
PARAM_TEXT_LIMITS = {"nome": 120, "descricao": 2000, "texto": 2000}
PARAM_LABELS = {"nome": "o nome", "descricao": "a descrição", "texto": "o texto"}
SUMMARY_LIMIT = 4000
SHARED_UNAVAILABLE_REPLY = (
    "As alterações pelo assistente estão indisponíveis no momento. Nada foi alterado. "
    "Você pode fazer essa alteração pelas telas do Flowly."
)
UNVERIFIED_CREATE_REPLY = "Não consegui confirmar se o pedido foi registrado. Nada foi alterado. Repita o pedido em instantes."
UNVERIFIED_STATE_REPLY = (
    "Não consegui verificar a confirmação pendente agora, então nada foi executado nem cancelado. "
    "Tente de novo em instantes."
)
# Contexto compartilhado da conversa (API): indisponivel, alterado por outra mensagem ou descartado.
CONTEXT_UNAVAILABLE_REPLY = (
    "Não consegui recuperar o andamento desta conversa agora. Nada foi alterado. "
    "Repita em instantes; consultas diretas, como \"minhas tarefas\", continuam funcionando."
)
CONTEXT_CONFLICT_REPLY = (
    "Recebi outra mensagem nesta conversa ao mesmo tempo e não usei esta resposta. Nada foi alterado. "
    "Pode repetir?"
)
CONTEXT_REJECTED_REPLY = (
    "Não consegui guardar essa resposta: ficou longa demais ou em um formato inesperado. Nada foi alterado. "
    "Envie uma versão mais curta."
)
CONTEXT_SENSITIVE_REPLY = (
    "Essa resposta parece conter uma credencial ou chave e não foi guardada. Nada foi alterado. Envie sem esse trecho."
)
# Mensagem sem pedido reconhecido: diz o que nao fez e o que da para pedir, sem fingir que entendeu ou lembrou.
FALLBACK_REPLY = (
    "Não entendi um pedido nessa mensagem e não alterei nada. Você pode dizer, por exemplo: \"minhas tarefas\", "
    "\"backlog\", \"minhas equipes\" ou \"criar tarefa\"."
)
TASK_HELP_REPLY = (
    "Posso listar suas tarefas, mostrar os detalhes de uma tarefa e criar ou atualizar tarefas, sempre com a sua "
    "confirmação. Nada foi alterado. Para começar, diga \"minhas tarefas\"."
)
MEMORY_POSSESSIVE = {"prioridade": "sua", "foco": "seu", "objetivo": "seu", "meta": "sua"}
MEMORY_NONE = {"prioridade": "nenhuma prioridade registrada", "foco": "nenhum foco registrado",
               "objetivo": "nenhum objetivo registrado", "meta": "nenhuma meta registrada"}
CONTEXT_DISCARDED_REPLY = (
    "Perdi o andamento desta conversa e descartei o que estava guardado. Nada foi alterado. Pode repetir o pedido?"
)

NON_DIRECTIVE_REPLIES = {
    "pergunta": (
        "Isso parece uma pergunta, não um pedido. Não identifiquei uma instrução direta. Nada foi alterado. "
        "Para executar, faça o pedido diretamente."
    ),
    "negacao": "Não identifiquei uma instrução direta para executar agora. Nada foi alterado.",
    "futuro": "Não identifiquei uma instrução direta para executar agora. Nada foi alterado.",
    "conflito": (
        "Sua mensagem pede mais de uma ação, incluindo uma alteração. Nada foi alterado. Peça uma ação por vez."
    ),
}


def is_confirmation(text: str) -> bool:
    """Confirmacao explicita: "confirmar", "sim, confirmo", "pode confirmar". Negacao, pergunta ("confirmar?") ou
    qualquer outro conteudo nao confirma."""
    words = plain_words(text)
    return "?" not in (text or "") and bool(set(words) & CONFIRMATION_WORDS) and all(
        word in CONFIRMATION_WORDS or word in CONFIRMATION_FILLER_WORDS for word in words
    )


def is_non_directive_text(text: str) -> bool:
    """Pergunta, intencao futura ou "sem": descreve uma acao, mas nao a pede agora."""
    words = plain_words(text)
    joined = f" {' '.join(words)} "
    return (
        "sem" in words
        or bool(set(words) & (NON_DIRECTIVE_QUESTION_WORDS | NON_DIRECTIVE_FUTURE_WORDS))
        or any(f" {expression} " in joined for expression in NON_DIRECTIVE_QUESTION_EXPRESSIONS)
    )


def authenticated_user_id(source: Any) -> Optional[str]:
    """Identidade confiável: o dono do JWT segundo a API (/users/me), nunca o userId do body.

    source: o RestAssistant desta mensagem (perfil lido uma vez e reaproveitado so nela) ou um FlowlyAPIClient.
    """
    try:
        me = source.authenticated_profile() if hasattr(source, "authenticated_profile") else source.me()
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
        # Contexto da conversa: compartilhado pela API (definido depois da autenticacao; nada local).
        self.conversations: Any = None
        self.context_available = True
        self.user_id: Optional[str] = None
        self._operations_client: Optional[OperationsClient] = None
        # Consulta completa equivalente a uma troca de periodo sobre a lista aberta (so nesta mensagem).
        self._command_content: Optional[str] = None

    def _operations(self) -> OperationsClient:
        """Cliente das confirmacoes compartilhadas (JWT do usuario + segredo interno do ambiente)."""
        if self._operations_client is None:
            self._operations_client = OperationsClient(self.token)
        return self._operations_client

    def _shared_conversations(self) -> SharedConversationState:
        return SharedConversationState(
            ConversationStateClient(self.token),
            forbidden_values=(self.token, os.getenv(OPERATIONS_SECRET_ENV) or ""),
        )

    def handle_message(self) -> Tuple[Dict[str, Any], int]:
        """Mensagem da conversa. Conflito de versao ou contexto indisponivel no meio do fluxo viram respostas
        controladas: o contexto e sempre gravado ANTES de qualquer escrita, entao nada foi executado."""
        try:
            return self._handle_message()
        except ConversationStateRejected as exc:
            text = CONTEXT_SENSITIVE_REPLY if exc.code == "state_sensitive" else CONTEXT_REJECTED_REPLY
            return self._context_error("conversation_state_rejected", text, 400)
        except ConversationStateConflict:
            return self._context_error("conversation_state_conflict", CONTEXT_CONFLICT_REPLY, 409)
        except ConversationStateUnavailable:
            return self._context_error("conversation_state_unavailable", CONTEXT_UNAVAILABLE_REPLY, 503)

    def _context_error(self, error: str, text: str, status: int) -> Tuple[Dict[str, Any], int]:
        conversation_id = str(self.body.get("conversationId") or self.body.get("conversation_id") or "")
        return self._error(error, text, status, action_executed=False,
                           conversation={"id": conversation_id, "status": "unverified"})

    def _memory(self) -> ConversationMemory:
        return ConversationMemory(
            ConversationStateClient(self.token),
            forbidden_values=(self.token, os.getenv(OPERATIONS_SECRET_ENV) or ""),
        )

    def _conversation_memory_response(
        self, *, conversation_id: str, content: str, event_id: str, moderation_score: float, queue_result: Dict[str, Any],
    ) -> Optional[Tuple[Dict[str, Any], int]]:
        """Guarda ou responde um fato explicito da conversa. Nunca cria, confirma, cancela ou executa nada."""
        stated = extract_stated_fact(content)
        asked = None if stated else asked_fact_label(content)
        if not stated and not asked:
            return None

        def reply(text: str, status: str, *, http: int = 201, error: Optional[str] = None):
            payload: Dict[str, Any] = {
                "ok": error is None,
                "messageId": event_id,
                "moderation": {"allowed": True, "score": moderation_score},
                "queue": queue_result,
                "command": None,
                "action_executed": False,
                "conversation": {"id": conversation_id, "status": status},
                "reply_text": text,
                "tts": tts_payload(text, language=str(self.body.get("language") or "pt-BR")),
            }
            if error:
                payload["error"] = error
            return payload, http

        memory = self._memory()
        if stated:
            label, value = stated
            try:
                memory.remember(conversation_id, label, value)
            except ConversationStateUnavailable:
                return reply("Não consegui guardar essa informação agora. Nada foi alterado.", "memory_unavailable",
                             http=503, error="conversation_memory_unavailable")
            return reply(f'Anotei {MEMORY_POSSESSIVE[label]} {label}: "{value}". Não criei nem alterei nada.', "noted")
        try:
            value = memory.facts(conversation_id).get(asked)
        except ConversationStateUnavailable:
            return reply("Não consegui consultar o que foi dito nesta conversa agora. Nada foi alterado.",
                         "memory_unavailable", http=503, error="conversation_memory_unavailable")
        if value:
            return reply(f'Você mencionou nesta conversa que {MEMORY_POSSESSIVE[asked]} {asked} é: "{value}".', "answered")
        return reply(f"Não tenho {MEMORY_NONE[asked]} nesta conversa. Se quiser, diga, por exemplo: "
                     f'"minha {asked} de hoje é ...".', "answered")

    def _is_context_free_read(self, content: str) -> bool:
        """Consulta direta e completa, que nao depende de resposta anterior nem escreve (ex.: "minhas tarefas").
        Usada so quando o contexto compartilhado esta indisponivel; confirmacoes, respostas soltas e escritas nao."""
        if is_confirmation(content) or is_non_directive_text(content):
            return False
        match = self.parser.match(content)
        if match is None or match.command.key == "exit" or is_write_command(match.command):
            return False
        if match.command.key in DISABLED_COMMANDS:
            return True  # recusa fixa (exclusao), sem contexto
        merged = {str(k): str(v) for k, v in (match.params or {}).items() if v is not None}
        return all(merged.get(param) for param in match.command.required_params)

    def _handle_message(self) -> Tuple[Dict[str, Any], int]:
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
        if conversation_id.endswith(MEMORY_SUFFIX):
            # Chave reservada da memoria da conversa: nunca usada como conversa (nao vira estado de comando).
            return self._error("invalid_conversation", "Identificador de conversa inválido.", 400)

        user_id = authenticated_user_id(self.assistant)
        if not user_id:
            return self._error("unauthorized", "Autenticação inválida.", 401)
        self.user_id = user_id
        if self.conversations is None:
            self.conversations = self._shared_conversations()

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

        # Contexto da conversa: lido UMA vez aqui (o version lido vale para toda gravacao desta mensagem).
        try:
            self.conversations.load(conversation_id)
        except ConversationStateUnavailable:
            self.context_available = False
        if not self.context_available:
            # Sem contexto: so consultas diretas (que nao dependem de resposta anterior nem escrevem) seguem.
            if not self._is_context_free_read(content):
                return self._context_error("conversation_state_unavailable", CONTEXT_UNAVAILABLE_REPLY, 503)
        elif self.conversations.was_discarded(conversation_id):
            return self._context_error("invalid_conversation", CONTEXT_DISCARDED_REPLY, 409)

        if assistant_writes_enabled():
            # A confirmacao pendente (ou em execucao) desta conversa vem da API, em qualquer instancia.
            shared = self._handle_shared_operation(
                conversation_id=conversation_id,
                content=content,
                event_id=event["id"],
                moderation_score=moderation.score,
                queue_result=queue_result,
            )
            if shared is not None:
                return shared
        else:
            # Chave desligada: nenhuma confirmacao executa. Resumo preparado antes do desligamento: qualquer resposta
            # o descarta (cancela a operacao pendente, melhor esforco) e avisa que as alteracoes estao desligadas.
            disabled = self._writes_disabled_shared(conversation_id, content)
            if disabled is not None:
                return self._writes_disabled_response(
                    event_id=event["id"],
                    moderation_score=moderation.score,
                    queue_result=queue_result,
                    conversation_id=conversation_id,
                    command_key=disabled,
                )

        pending = self.conversations.get(conversation_id)
        if pending and pending.get("mode") == "task_selection" and not pending.get("tasks"):
            # Consulta anterior sem lista: so "e as de hoje?" continua; qualquer outra mensagem segue sem contexto.
            follow_up = None if is_confirmation(content) else period_follow_up_utterance(content)
            if follow_up:
                self._command_content = follow_up
            else:
                self.conversations.clear(conversation_id)
            pending = None
        if pending and pending.get("mode") == "task_selection":
            if weekday_reference(content) and not is_confirmation(content):
                # "tarefas de sexta-feira", "e as de quarta?": nunca vira a 6ª/4ª tarefa; a lista aberta continua.
                return self._task_conversation_response(
                    event_id=event["id"],
                    moderation_score=moderation.score,
                    queue_result=queue_result,
                    conversation_id=conversation_id,
                    status="browsing_tasks",
                    text=WEEKDAY_UNSUPPORTED_REPLY,
                    ok=True,
                    action_executed=False,
                )
            listing = self._listing_request(content, pending)
            if listing == "clarify_scope":
                return self._task_conversation_response(
                    event_id=event["id"],
                    moderation_score=moderation.score,
                    queue_result=queue_result,
                    conversation_id=conversation_id,
                    status="browsing_tasks",
                    text=SCOPE_CLARIFY_REPLY,
                    ok=True,
                    action_executed=False,
                )
            if listing == "clarify_period":
                selected = next((t for t in pending.get("tasks", []) if isinstance(t, dict)
                                 and t.get("_id") == pending.get("selected_task_id")), None)
                return self._task_conversation_response(
                    event_id=event["id"],
                    moderation_score=moderation.score,
                    queue_result=queue_result,
                    conversation_id=conversation_id,
                    status="browsing_tasks",
                    text=PERIOD_CLARIFY_REPLY.format(title=self._task_title(selected)),
                    ok=True,
                    action_executed=False,
                )
            if listing == "new":
                pending = None  # a resposta da nova consulta grava (ou limpa) a selecao
            elif listing == "ambiguous":
                return self._task_conversation_response(
                    event_id=event["id"],
                    moderation_score=moderation.score,
                    queue_result=queue_result,
                    conversation_id=conversation_id,
                    status="awaiting_task_selection",
                    text=AMBIGUOUS_LISTING_REPLY,
                    ok=True,
                    action_executed=False,
                )
        if pending:
            return self._continue_pending_command(
                conversation_id=conversation_id,
                pending=pending,
                content=content,
                event_id=event["id"],
                moderation_score=moderation.score,
                queue_result=queue_result,
            )

        # Afirmacao de um fato ("minha prioridade de hoje e X") ou pergunta sobre ele: memoria curta da conversa,
        # separada dos comandos. Vem antes do parser: uma afirmacao nunca vira comando, mesmo citando um.
        memory_response = self._conversation_memory_response(
            conversation_id=conversation_id, content=content, event_id=event["id"],
            moderation_score=moderation.score, queue_result=queue_result,
        )
        if memory_response is not None:
            return memory_response

        # Troca de periodo com lista aberta: o comando e a consulta completa equivalente (so leitura).
        command_content = self._command_content or content
        match = None if is_confirmation(content) else self.parser.match(command_content)
        if (
            not is_confirmation(content)
            and (match is None or match.command.key in PLAIN_LISTING_KEYS)
            and weekday_reference(content)
        ):
            # Sem consulta por dia da semana: resposta clara, em vez de listar tudo ignorando o dia.
            return {
                "ok": True,
                "messageId": event["id"],
                "moderation": {"allowed": True, "score": moderation.score},
                "queue": queue_result,
                "command": None,
                "action_executed": False,
                "reply_text": WEEKDAY_UNSUPPORTED_REPLY,
                "tts": tts_payload(WEEKDAY_UNSUPPORTED_REPLY, language=str(self.body.get("language") or "pt-BR")),
            }, 201
        if match is None or match.command.key == "exit":
            text = FALLBACK_REPLY
            reason = None if match is not None else self.parser.non_directive_reason(content)
            if reason:
                text = NON_DIRECTIVE_REPLIES[reason]
                if reason in ("pergunta", "conflito"):
                    text = self._status_read_hint(content) or text
            elif match is None and is_confirmation(content):
                # Confirmacao repetida, antiga ou de outra conversa: nao ha nada guardado para executar.
                text = "Não há nenhuma operação aguardando confirmação. Nada foi alterado."
            elif match is None and set(plain_words(content)) & {"tarefa", "tarefas"}:
                text = TASK_HELP_REPLY
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

        if is_write_command(match.command) and not assistant_writes_enabled():
            # Chave temporaria desligada: nem pergunta campos nem prepara resumo.
            return self._writes_disabled_response(
                event_id=event["id"],
                moderation_score=moderation.score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                command_key=match.command.key,
            )

        supplied_params = self.body.get("params") if isinstance(self.body.get("params"), dict) else {}
        # Rotulos internos (_task_label etc.) vem so da resolucao no servidor: o cliente nao escolhe o resumo.
        supplied_params = {k: v for k, v in supplied_params.items() if not str(k).startswith("_")}
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

        if is_write_command(match.command):
            # Escrita completa numa unica frase: prepara (so leituras) e pede confirmacao; nada e alterado aqui.
            response, response_status = self._request_write_confirmation(
                conversation_id=conversation_id,
                command=match.command,
                params=merged_params,
                event_id=event["id"],
                moderation_score=moderation.score,
                queue_result=queue_result,
            )
            if not response.get("ok") and response.get("missing"):
                # Valor recusado (data ambigua, texto longo demais): pergunta de novo so esse campo.
                try:
                    self.conversations.save(
                        conversation_id,
                        # O valor recusado (ex.: texto acima do limite) nao e guardado: a pergunta volta para ele.
                        {"command_key": match.command.key, "missing": response["missing"],
                         "params": {k: v for k, v in merged_params.items() if k not in response["missing"]}},
                    )
                except ConversationStateRejected:
                    # O restante do pedido tambem nao cabe no contexto: a recusa acima continua verdadeira (nada
                    # alterado, enviar mais curto) e nada fica guardado; o pedido inteiro precisa ser refeito.
                    return response, response_status
                response["conversation"] = {"id": conversation_id, "status": "awaiting_params"}
            return response, response_status

        command_payload, command_status = self.assistant.handle(command_content, supplied_params)
        status = 200 if command_payload.get("ok") else command_status
        if (
            not command_payload.get("ok")
            and match.command.key in LISTING_COMMAND_KEYS
            and command_payload.get("error") in {"api_error", "internal_error"}
        ):
            command_payload.pop("message", None)  # detalhe tecnico da falha nao vai para a tela
            command_payload = self._with_reply(
                command_payload, TASK_QUERY_UNAVAILABLE_REPLY, TASK_QUERY_UNAVAILABLE_REPLY
            )
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
        if pending.get("mode") == "write_confirmation":
            # Confirmacao local antiga (anterior as confirmacoes compartilhadas) ou forjada: nunca executa.
            self.conversations.clear(conversation_id)
            return self._task_conversation_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                status="cancelled",
                text="Esse pedido de confirmação não é mais válido. Nada foi alterado. Se ainda quiser, faça o pedido de novo.",
                ok=True,
                action_executed=False,
                command={"key": str(pending.get("command_key") or "")},
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
        # Pergunta de escrita aberta antes do desligamento: encerra sem usar a resposta.
        if is_write_command(command) and not assistant_writes_enabled():
            return self._writes_disabled_response(
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

        # "confirmar" enquanto o assistente ainda pergunta um campo nao confirma nada e nunca vira valor
        # (equipe "Confirmar"): a pergunta se repete e a confirmacao so vale depois do resumo.
        if is_confirmation(content):
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
                text="Ainda não há nada para confirmar. " + self._question_for_param(missing[0], command.key),
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

        if is_write_command(command):
            # Ultima resposta de um fluxo de escrita: usa os valores coletados (sem reinterpretar a frase),
            # resolve os alvos e mostra o resumo. Nada e alterado sem a confirmacao seguinte.
            response, response_status = self._request_write_confirmation(
                conversation_id=conversation_id,
                command=command,
                params=params,
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
            )
            if not response.get("ok"):
                self.conversations.save(
                    conversation_id,
                    {"command_key": command.key, "missing": response.get("missing") or [],
                     "params": {k: v for k, v in params.items() if k not in (response.get("missing") or [])}},
                )
                response["conversation"] = {"id": conversation_id, "status": "awaiting_params"}
            return response, response_status

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
        if command_key in TASK_QUERY_KEYS and isinstance(result, dict) and result.get("type"):
            return self._task_query_follow_up(conversation_id=conversation_id, payload=payload, query=result)
        if command_key in {"my_tasks", "backlog", "list_tasks"}:
            tasks = _dict_items(result)
            display, spoken = self._tasks_reply(tasks)
            if tasks:
                # Cartoes na tela: a mesma lista numerada guardada para "detalhes da 1" (opcional; o texto continua).
                payload["query"] = selection_metadata(
                    command_key, [self._compact_task(task) for task in tasks[:SELECTABLE_TASK_LIMIT]], len(tasks)
                )
            # Sem contexto compartilhado, a lista e so mostrada: nada de selecao guardada (nem opcoes oferecidas).
            if tasks and self.context_available:
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
            elif self.context_available and command_key == "my_tasks":
                # Nova lista vazia das proprias tarefas: a selecao anterior nao vale mais para "a 1"; so a troca de
                # periodo ("e as de hoje?"), que tambem consulta as proprias tarefas, continua na proxima mensagem.
                self.conversations.save(conversation_id, dict(EMPTY_LISTING_CONTEXT))
            elif self.context_available:
                # Backlog ou listagem geral vazia: outro escopo; nenhuma continuacao por periodo a partir dela.
                self.conversations.clear(conversation_id)
            return self._with_reply(payload, display, spoken)

        team_label = str((payload.get("params") or {}).get("_team_label") or "").strip()
        if command_key in {"my_teams", "list_teams"}:
            display, spoken = self._teams_reply(_dict_items(result))
        elif command_key == "me":
            display, spoken = self._profile_reply(result)
        elif command_key == "task_details":
            display, spoken = self._task_details_reply(result, follow_up=False)
            if isinstance(result, dict) and isinstance(result.get("tarefa"), dict):
                payload["task"] = task_card(result["tarefa"], self.user_id)
        elif command_key == "team_members":
            display, spoken = self._members_reply(_dict_items(result), team_label)
        elif command_key in {"list_users", "search_users"}:
            display, spoken = self._users_reply(_dict_items(result))
        elif command_key == "team_messages":
            display, spoken = self._messages_reply(_dict_items(result), team_label)
        else:
            return payload
        return self._with_reply(payload, display, spoken)

    def _listing_request(self, content: str, pending: Dict[str, Any]) -> Optional[str]:
        """Com uma lista aberta: "new" (nova listagem de leitura, que substitui a lista), "ambiguous" (pede uma
        listagem geral mas cita numero/nome de uma tarefa da lista) ou None (acompanhamento da lista atual).
        Usa so o parser existente; escritas, confirmacoes e acompanhamentos ("detalhes da 1") nunca sao "new"."""
        if is_confirmation(content):
            return None
        match = self.parser.match(content)
        if match is None:
            # Troca de periodo sobre a lista aberta ("e as de amanhã?"): vira a consulta completa equivalente.
            follow_up = period_follow_up_utterance(content)
            if follow_up:
                # A troca de periodo consulta so as proprias tarefas: sobre uma lista de outro escopo (backlog, com
                # tarefas sem responsavel) pergunta em vez de trocar o escopo em silencio.
                if any(_unassigned(task) for task in pending.get("tasks", []) if isinstance(task, dict)):
                    return "clarify_scope"
                # "e se amanhã?" com uma tarefa escolhida: pode ser sobre ela; pergunta em vez de listar.
                if is_conditional_period_follow_up(content) and pending.get("selected_task_id"):
                    return "clarify_period"
                self._command_content = follow_up
                return "new"
            return None
        if match.command.key not in LISTING_COMMAND_KEYS:
            return None
        if match.command.key in TASK_QUERY_KEYS:
            if refers_to_single_task(content):
                return None  # "ela vence amanhã?": pergunta sobre a tarefa escolhida, nao uma nova lista
            return "new"  # periodo explicito; numeros ("proximos 7 dias") fazem parte da data
        tasks = [task for task in pending.get("tasks", []) if isinstance(task, dict)]
        if task_position_refs(content) or self._tasks_named_in(content, tasks):
            return "ambiguous"
        return "new"

    def _task_query_follow_up(self, *, conversation_id: str, payload: Dict[str, Any], query: Dict[str, Any]) -> Dict[str, Any]:
        """Consulta por periodo: texto so com os dados filtrados, metadados para a interface e a lista guardada
        para "detalhes da 1" / "e quais sao as mais urgentes?". Nada e gravado alem do contexto da conversa."""
        display, spoken = build_reply(query)
        payload["query"] = metadata(query)
        tasks = [task for task in (query.get("tasks") or []) if isinstance(task, dict)]
        if self.context_available:
            if tasks and query.get("type") != "summary":
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
            else:
                # Sem lista numerada: nenhuma selecao antiga continua valendo para "a 1"; so a troca de periodo
                # ("e amanhã?") continua valendo na proxima mensagem.
                self.conversations.save(conversation_id, dict(EMPTY_LISTING_CONTEXT))
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

    # --- Confirmacao de escrita (compartilhada) ----------------------------------------------------------------
    #
    # Preparar: so leituras; o resumo e os parametros executaveis sao montados aqui, a operacao e criada na API e
    # so entao o resumo e mostrado. Confirmar: a operacao pendente da conversa (lida da API) e reivindicada (claim)
    # e a escrita usa SO o commandKey/params do claim e a idempotencyKey da operacao. Desfecho registrado na API.
    # Nada disso depende do arquivo local; "confirmar" nunca executa a partir dele.

    def _request_write_confirmation(
        self,
        *,
        conversation_id: str,
        command: Command,
        params: Dict[str, Any],
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
    ) -> Tuple[Dict[str, Any], int]:
        """Valida permissao e valores e resolve os alvos (so GET); cria a confirmacao compartilhada."""
        payload, status = self.assistant.prepare_write(command, params)
        if not payload.get("ok"):
            return {
                "messageId": event_id,
                "moderation": {"allowed": True, "score": moderation_score},
                "queue": queue_result,
                "action_executed": False,
                **payload,
            }, status
        resolved = dict(payload.get("params") or {})
        self._fill_target_labels(resolved)
        return self._create_shared_confirmation(
            conversation_id=conversation_id,
            command=command,
            resolved=resolved,
            event_id=event_id,
            moderation_score=moderation_score,
            queue_result=queue_result,
        )

    def _request_selection_assign_confirmation(
        self,
        *,
        conversation_id: str,
        task: Dict[str, Any],
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
    ) -> Tuple[Dict[str, Any], int]:
        """Atribuicao pedida na lista de tarefas: o alvo ja e o ID da lista; confere a permissao antes do resumo."""
        command = next(cmd for cmd in self.parser.commands if cmd.key == "assign_to_me")
        user_type = self.assistant._detect_user_type()
        # Fail-closed como no prepare_write: sem perfil identificado tambem nao prepara.
        if not user_type or not has_permission(user_type, command.role_required):
            self.conversations.clear(conversation_id)
            return self._task_conversation_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                status="cancelled",
                text=PROFILE_UNKNOWN_REPLY if not user_type else "Você não tem permissão para esse comando. Nada foi alterado.",
                ok=False,
                action_executed=False,
                error="user_type_unknown" if not user_type else "forbidden",
            )[0], 403
        return self._create_shared_confirmation(
            conversation_id=conversation_id,
            command=command,
            resolved={"task_id": str(task.get("_id") or ""), "_task_label": self._selection_task_label(task)},
            event_id=event_id,
            moderation_score=moderation_score,
            queue_result=queue_result,
        )

    def _selection_task_label(self, task: Dict[str, Any]) -> str:
        equipe = task.get("equipe")
        team_name = str(equipe.get("nome") or "").strip() if isinstance(equipe, dict) else ""
        return f"{self._task_title(task)} (equipe {team_name})" if team_name else self._task_title(task)

    def _executable_params(self, command_key: str, resolved: Dict[str, Any]) -> Tuple[Dict[str, str], Optional[Tuple[str, str]]]:
        """So os campos que o comando executa, ja resolvidos e validos. Devolve (params, None) ou ({}, (campo, texto))."""
        required, optional = EXECUTABLE_PARAMS[command_key]
        params: Dict[str, str] = {}
        for name in required + optional:
            value = resolved.get(name)
            value = "" if value is None else str(value).strip() if name not in PARAM_TEXT_LIMITS else str(value)
            if not value.strip():
                if name in required:
                    return {}, (name, "Faltam informações para esse comando. Nada foi alterado.")
                continue
            if name in ("task_id", "equipe") and not is_object_id(value):
                return {}, (name, "Não consegui identificar o alvo desse comando. Nada foi alterado. Pode repetir?")
            if name == "team_id" and not is_object_id(value):
                continue  # equipe so ajudou a achar a tarefa; a atribuicao usa a tarefa
            if name == "user" and value != "__none__" and not is_object_id(value):
                return {}, (name, "Não consegui identificar o responsável. Nada foi alterado. Diga o nome do usuário ou diga não.")
            if name == "dataEntrega":
                try:
                    valid = bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)) and date.fromisoformat(value)
                except ValueError:
                    valid = False
                if not valid:
                    return {}, (name, f'Não entendi a data de entrega "{value}". Diga uma data como 25/06/2026, hoje '
                                      "ou amanhã. Nada foi alterado.")
            limit = PARAM_TEXT_LIMITS.get(name)
            if limit and len(value) > limit:
                # Nunca cortado em silencio: o pedido volta para reformular.
                return {}, (name, f"{PARAM_LABELS[name].capitalize()} tem {len(value)} caracteres e o limite é {limit}. "
                                  "Envie uma versão mais curta. Nada foi alterado.")
            params[name] = value
        return params, None

    def _create_shared_confirmation(
        self,
        *,
        conversation_id: str,
        command: Command,
        resolved: Dict[str, Any],
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
        execute_now_text: Optional[str] = None,
    ) -> Tuple[Dict[str, Any], int]:
        """Cria a operacao na API e so entao pede a confirmacao (ou executa, se execute_now_text: resposta explicita
        a uma tarefa ja selecionada e mostrada)."""
        summary = self._write_summary(command.key, resolved)
        exec_params, problem = self._executable_params(command.key, resolved)
        if problem or len(summary) > SUMMARY_LIMIT:
            field, text = problem or ("", "O pedido ficou longo demais para confirmar. Envie uma versão mais curta. Nada foi alterado.")
            return {
                "ok": False,
                "error": "invalid_params",
                "messageId": event_id,
                "moderation": {"allowed": True, "score": moderation_score},
                "queue": queue_result,
                "action_executed": False,
                "command": {"key": command.key},
                "missing": [field] if field else [],
                "reply_text": text,
                "tts": tts_payload(text, language=str(self.body.get("language") or "pt-BR")),
            }, 400

        def finish(status: str, text: str, *, ok: bool = False, http: Optional[int] = None, **extra: Any):
            response, code = self._task_conversation_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                status=status,
                text=text,
                ok=ok,
                action_executed=False,
                command={"key": command.key},
                **extra,
            )
            return response, http or code

        ops = self._operations()
        try:
            operation = ops.create(conversation_id=conversation_id, command_key=command.key, params=exec_params, summary=summary)
        except APIError as exc:
            if exc.kind == "writes_disabled":
                return self._writes_disabled_response(
                    event_id=event_id, moderation_score=moderation_score, queue_result=queue_result,
                    conversation_id=conversation_id, command_key=command.key,
                )
            if exc.kind in ("not_configured", "invalid_request") or exc.category in ("unauthenticated", "forbidden"):
                # Sem confirmacao compartilhada nao ha escrita (nenhum fallback local).
                return finish("unavailable", SHARED_UNAVAILABLE_REPLY, error="shared_confirmation_unavailable", http=503)
            if exc.code == "conversation_busy":
                return self._busy_response(exc.operation, finish)
            if exc.may_have_executed or exc.kind in ("timeout", "network", "invalid_response", "redirect") \
                    or (exc.status_code or 0) >= 500:
                # A criacao pode ter entrado sem resposta: consulta a conversa antes de concluir qualquer coisa.
                operation = self._recover_created_operation(conversation_id, command.key, summary)
                if operation is None:
                    return finish("unverified", UNVERIFIED_CREATE_REPLY, error="confirmation_unverified", http=503)
                if operation.get("status") != "pending":
                    return self._busy_response(operation, finish)
                if not self._is_created_operation(operation, command.key, summary, exec_params):
                    return self._refuse_divergent_operation(operation, conversation_id, finish)
            else:
                return finish("cancelled", "Não consegui preparar esse pedido. Nada foi alterado.", error="invalid_params", http=400)

        self.conversations.clear(conversation_id)  # o estado local nao participa da confirmacao
        if execute_now_text is not None:
            return self._confirm_shared(
                operation=operation, conversation_id=conversation_id, event_id=event_id,
                moderation_score=moderation_score, queue_result=queue_result, success_text=execute_now_text,
            )
        stored_summary = str(operation.get("summary") or summary)
        text = (
            f"Confirme a operação: {stored_summary}. Nada foi alterado ainda. "
            'Para executar, diga "confirmar". Para desistir, diga "cancelar".'
        )
        return {
            "ok": True,
            "messageId": event_id,
            "moderation": {"allowed": True, "score": moderation_score},
            "queue": queue_result,
            "action_executed": False,
            "command": {"key": command.key, "title": command.title},
            "conversation": {
                "id": conversation_id,
                "status": "awaiting_confirmation",
                "command": command.key,
                "operation_id": operation.get("operationId"),
                "expires_in": self._expires_in(operation),
                "summary": stored_summary,
            },
            "reply_text": text,
            "tts": tts_payload(text, language=str(self.body.get("language") or "pt-BR")),
        }, 200

    def _recover_created_operation(self, conversation_id: str, command_key: str, summary: str) -> Optional[Dict[str, Any]]:
        """Resposta perdida na criacao: a operacao atual da conversa, se der para ler; None se nao der."""
        try:
            operation = self._operations().current(conversation_id=conversation_id)
        except APIError:
            return None
        if not operation or operation.get("status") not in ACTIVE_OPERATION_STATUSES:
            return None
        return operation

    @staticmethod
    def _is_created_operation(operation: Dict[str, Any], command_key: str, summary: str, params: Dict[str, str]) -> bool:
        """A operacao encontrada e exatamente a que este pedido criou? Comando, resumo, impressao digital dos
        parametros executaveis (calculada aqui sobre os mesmos params enviados), status e prazo compativeis."""
        if operation.get("status") != "pending" or operation.get("commandKey") != command_key \
                or operation.get("summary") != summary:
            return False
        expected = params_fingerprint(command_key, params)
        received = operation.get("paramsFingerprint")
        if not expected or not isinstance(received, str) or not FINGERPRINT.fullmatch(received) \
                or not hmac.compare_digest(received, expected):
            return False
        created, expires = _parse_instant(operation.get("createdAt")), _parse_instant(operation.get("expiresAt"))
        if created is None or expires is None:
            return False
        window = (expires - created).total_seconds()
        return 0 < window <= MAX_CONFIRM_WINDOW_SEC and expires > datetime.now(timezone.utc)

    def _refuse_divergent_operation(self, operation: Dict[str, Any], conversation_id: str, finish) -> Tuple[Dict[str, Any], int]:
        """Resposta perdida e a pendente da conversa NAO e exatamente este pedido (comando, resumo, impressao digital
        ou prazo divergentes, ou metadados ausentes): conflito explicito. Nao reutiliza, nao cria outra, nao cancela,
        nao faz claim nem escreve; a operacao existente fica intacta, com o seu prazo. O resumo dela nao e repetido
        (pode ser igual ao deste pedido com outros parametros); cancelar fica a criterio da pessoa."""
        return finish(
            "conflict",
            "Não consegui confirmar se o seu pedido foi registrado: já existe outra confirmação pendente nesta "
            "conversa, que não corresponde exatamente a ele. Nada foi alterado. Se quiser, diga \"cancelar\" para "
            "descartá-la e depois faça o novo pedido.",
            http=409, error="confirmation_mismatch",
        )

    def _busy_response(self, operation: Optional[Dict[str, Any]], finish) -> Tuple[Dict[str, Any], int]:
        """Ja existe operacao ativa na conversa: nunca substitui; mostra a que esta valendo."""
        summary = str((operation or {}).get("summary") or "um pedido anterior")
        if (operation or {}).get("status") == "pending":
            text = (f"Já existe uma confirmação pendente nesta conversa: {summary}. Nada foi alterado. "
                    'Diga "confirmar" para executá-la ou "cancelar" para desistir.')
            status = "awaiting_confirmation"
        else:
            text = f"Há uma operação em andamento nesta conversa: {summary}. Aguarde a conclusão antes de pedir outra alteração."
            status = "operation_in_progress"
        extra = {"error": "conversation_busy"}
        if operation and operation.get("operationId"):
            extra["operation"] = {"id": operation.get("operationId"), "status": operation.get("status")}
        response, code = finish(status, text, http=409, **extra)
        if operation and operation.get("operationId") and operation.get("status") == "pending":
            response["conversation"].update(self._operation_binding(operation))  # a tela mostra a que esta valendo
        return response, code

    @staticmethod
    def _expires_in(operation: Dict[str, Any]) -> int:
        """Prazo informado pela API (expiresAt - createdAt, os dois do relogio do servidor)."""
        try:
            created = datetime.fromisoformat(str(operation["createdAt"]).replace("Z", "+00:00"))
            expires = datetime.fromisoformat(str(operation["expiresAt"]).replace("Z", "+00:00"))
            return max(int((expires - created).total_seconds()), 0)
        except Exception:
            return 0

    def _writes_disabled_shared(self, conversation_id: str, content: str) -> Optional[str]:
        """Chave desligada. Devolve o commandKey a citar na resposta de desligado, ou None (segue o fluxo normal).

        So leitura e cancelamento na API (nada de claim): operacao pendente da conversa e cancelada; em
        execucao/recuperacao fica como esta (nao da para cancelar) e "confirmar" so recebe o aviso.
        """
        unreachable = False
        try:
            operation = self._operations().current(conversation_id=conversation_id)
        except APIError:
            operation, unreachable = None, True  # sem como consultar: com a chave desligada nada executa
        if operation and operation.get("status") == "pending":
            try:
                self._operations().cancel(operation_id=operation["operationId"], conversation_id=conversation_id)
            except APIError:
                pass  # o prazo da API encerra; o claim e recusado enquanto a chave estiver desligada
            self.conversations.clear(conversation_id)
            return str(operation.get("commandKey") or "")
        if not is_confirmation(content):
            return None
        if operation and operation.get("status") in ACTIVE_OPERATION_STATUSES:
            return "confirm"  # em execucao/recuperacao: nada e retomado com a chave desligada
        if unreachable and not self.conversations.get(conversation_id):
            return "confirm"  # nao deu para verificar: so o aviso de desligado (verdadeiro: nada foi alterado)
        return None  # nada pendente: resposta de sempre ("Não há nenhuma operação aguardando confirmação")

    def _handle_shared_operation(
        self,
        *,
        conversation_id: str,
        content: str,
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
    ) -> Optional[Tuple[Dict[str, Any], int]]:
        """Operacao da conversa na API. None = segue o fluxo normal (leituras, novos pedidos, perguntas)."""
        try:
            operation = self._operations().current(conversation_id=conversation_id)
        except APIError:
            # Fluxo local em andamento (perguntas de campos, selecao): segue local; "cancelar" encerra so ele.
            if self.conversations.get(conversation_id):
                return None
            if is_confirmation(content) or is_cancel_request(content):
                return self._task_conversation_response(
                    event_id=event_id, moderation_score=moderation_score, queue_result=queue_result,
                    conversation_id=conversation_id, status="unverified", text=UNVERIFIED_STATE_REPLY,
                    ok=False, action_executed=False, error="confirmation_unverified",
                )
            return None
        if not operation:
            return None
        if operation.get("status") in ACTIVE_OPERATION_STATUSES:
            return self._continue_shared_operation(
                operation=operation, conversation_id=conversation_id, content=content, event_id=event_id,
                moderation_score=moderation_score, queue_result=queue_result,
            )
        if is_confirmation(content):
            return self._terminal_operation_response(operation, conversation_id, event_id, moderation_score, queue_result)
        return None

    def _terminal_operation_response(self, operation, conversation_id, event_id, moderation_score, queue_result):
        """"confirmar" depois do fim: nunca executa de novo; diz o que aconteceu com a ultima operacao."""
        summary = str(operation.get("summary") or "a operação")
        status = operation.get("status")
        texts = {
            "completed": (f"Não há nenhuma operação aguardando confirmação. A última já foi confirmada e concluída: "
                          f"{summary}. Nada foi executado de novo."),
            "failed": f"Essa operação não foi concluída: {summary}. Nada foi executado de novo. Se ainda quiser, faça o pedido de novo.",
            "cancelled": "Não há nenhuma operação aguardando confirmação. Nada foi alterado.",
            "expired": (f"O pedido de confirmação expirou: {summary}. Nada foi alterado. "
                        "Se ainda quiser, faça o pedido de novo."),
            "unknown": (f"Não foi possível confirmar o resultado de: {summary}. Por segurança, não vou repetir. "
                        "Confira no Flowly se a alteração foi feita."),
        }
        return self._task_conversation_response(
            event_id=event_id, moderation_score=moderation_score, queue_result=queue_result,
            conversation_id=conversation_id, status=str(status), text=texts.get(status, texts["cancelled"]),
            ok=True, action_executed=False, command={"key": operation.get("commandKey")},
        )

    def _continue_shared_operation(
        self,
        *,
        operation: Dict[str, Any],
        conversation_id: str,
        content: str,
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
    ) -> Optional[Tuple[Dict[str, Any], int]]:
        summary = str(operation.get("summary") or "a operação pendente")
        status = operation.get("status")
        # O estado local so e descartado quando esta mensagem resolve a operacao (confirmar, ou qualquer resposta a
        # uma pendente); com a operacao em execucao/recuperacao, fluxos locais (selecao, perguntas) seguem intactos.
        local_flow = self.conversations.get(conversation_id)

        def finish(status_text: str, text: str, **extra: Any) -> Tuple[Dict[str, Any], int]:
            return self._task_conversation_response(
                event_id=event_id, moderation_score=moderation_score, queue_result=queue_result,
                conversation_id=conversation_id, status=status_text, text=text, ok=True, action_executed=False,
                command={"key": operation.get("commandKey")}, **extra,
            )

        # A confirmacao vale so para a operacao que a pessoa viu: o navegador reenvia o operationId do resumo
        # mostrado. Ausente, malformado ou de outra operacao: nada e executado NEM cancelado; a operacao atual e
        # reapresentada. O operationId nao substitui autenticacao, intencao explicita, dono, conversa, prazo ou claim.
        client_operation = str(self.body.get("operationId") or self.body.get("operation_id") or "").strip()
        bound = bool(client_operation) and hmac.compare_digest(client_operation, str(operation.get("operationId") or ""))
        if client_operation and not bound:
            return self._represent_operation(
                operation, conversation_id, event_id, moderation_score, queue_result, error="confirmation_mismatch",
                text=f"Essa confirmação não corresponde à operação desta conversa. Nada foi alterado. A operação atual é: "
                     f"{summary}. Confira o resumo e confirme ou cancele de novo.",
            )
        if is_confirmation(content):
            if not bound:
                return self._represent_operation(
                    operation, conversation_id, event_id, moderation_score, queue_result, error="operation_id_required",
                    text=f"Não consegui ligar essa confirmação ao resumo mostrado. Nada foi alterado. A operação "
                         f"aguardando é: {summary}. Confira o resumo e confirme de novo.",
                )
            self.conversations.clear(conversation_id)
            return self._confirm_shared(
                operation=operation, conversation_id=conversation_id, event_id=event_id,
                moderation_score=moderation_score, queue_result=queue_result,
            )
        wants_cancel = is_cancel_request(content) or bool(NEGATION_ANSWER_WORDS & set(plain_words(content)))
        if status == "pending":
            if wants_cancel or self._is_new_command(content):
                # Cancelamento explicito, negativa ou outro comando: cancela sem executar (regra de sempre).
                ok_text = (
                    f"Tudo bem, cancelei: {summary}. Nada foi alterado."
                    if wants_cancel
                    else f"Não recebi uma confirmação explícita, então cancelei: {summary}. Nada foi alterado. "
                         'Para executar, faça o pedido de novo e responda "confirmar".'
                )
                self.conversations.clear(conversation_id)
                return self._cancel_shared(operation, conversation_id, event_id, moderation_score, queue_result, ok_text=ok_text)
            # Resposta ambigua ("sim", "ok", ruido, transcricao incompleta): nao executa e nao cancela.
            return self._represent_operation(
                operation, conversation_id, event_id, moderation_score, queue_result, error=None,
                text=f"Não entendi se você quer confirmar. Nada foi alterado. Continua aguardando: {summary}. "
                     'Diga "confirmar" ou "cancelar".',
            )
        if wants_cancel and not local_flow:  # com fluxo local, o "cancelar" e dele
            tail = ('Para concluir com segurança, sem repetir, diga "confirmar".' if status == "retry_pending"
                    else "Aguarde o resultado.")
            return finish(str(status), f"Não é possível cancelar: {summary} já foi confirmada e pode ter sido aplicada. {tail}")
        return None  # em execucao/recuperacao: leituras e perguntas seguem normalmente

    def _is_new_command(self, content: str) -> bool:
        """Outro pedido claro (comando reconhecido, inclusive "sair"), distinto de ruido ou resposta ambigua."""
        if is_confirmation(content) or is_non_directive_text(content):
            return False
        return self.parser.match(content) is not None

    def _represent_operation(self, operation, conversation_id, event_id, moderation_score, queue_result, *,
                             error: Optional[str], text: str) -> Tuple[Dict[str, Any], int]:
        """Mostra de novo a operacao aguardando (resumo guardado na API e seu operationId), sem executar nem
        cancelar. Com error: recusa controlada (409); sem error: so lembrete (200)."""
        status = str(operation.get("status") or "")
        extra: Dict[str, Any] = {"error": error} if error else {}
        response, code = self._task_conversation_response(
            event_id=event_id, moderation_score=moderation_score, queue_result=queue_result,
            conversation_id=conversation_id, status="awaiting_confirmation" if status == "pending" else status,
            text=text, ok=error is None, action_executed=False, command={"key": operation.get("commandKey")}, **extra,
        )
        response["conversation"].update(self._operation_binding(operation))
        return response, (409 if error else code)

    @staticmethod
    def _operation_binding(operation: Dict[str, Any]) -> Dict[str, Any]:
        """Campos publicos que o navegador guarda para confirmar exatamente esta operacao."""
        expires = _parse_instant(operation.get("expiresAt"))
        remaining = max(0, int((expires - datetime.now(timezone.utc)).total_seconds())) if expires else 0
        return {
            "command": operation.get("commandKey"),
            "operation_id": operation.get("operationId"),
            "summary": str(operation.get("summary") or ""),
            "expires_in": remaining,
        }

    def _cancel_shared(self, operation, conversation_id, event_id, moderation_score, queue_result, *, ok_text: str):
        summary = str(operation.get("summary") or "a operação pendente")
        try:
            self._operations().cancel(operation_id=operation["operationId"], conversation_id=conversation_id)
            status, text = "cancelled", ok_text
        except APIError as exc:
            code = exc.code
            if exc.category == "in_progress":
                status, text = "operation_in_progress", f"Não consegui cancelar: {summary} já está em execução. Aguarde o resultado."
            elif exc.category == "expired" or code == "operation_expired":
                status, text = "expired", f"O pedido já tinha expirado: {summary}. Nada foi alterado."
            elif code == "operation_cancelled":
                status, text = "cancelled", ok_text
            elif code == "operation_completed":
                status, text = "completed", f"Essa operação já tinha sido concluída: {summary}."
            elif code == "operation_unknown":
                status, text = "unknown", (f"Não foi possível confirmar o resultado de: {summary}. Por segurança, "
                                           "não vou repetir. Confira no Flowly se a alteração foi feita.")
            elif exc.category == "not_found":
                status, text = "cancelled", "Não encontrei a confirmação pendente. Nada foi alterado."
            else:
                status, text = "unverified", (f"Não consegui confirmar o cancelamento agora: {summary}. "
                                              'Para não executar, não diga "confirmar"; o pedido expira sozinho em instantes.')
        return self._task_conversation_response(
            event_id=event_id, moderation_score=moderation_score, queue_result=queue_result,
            conversation_id=conversation_id, status=status, text=text, ok=True, action_executed=False,
            command={"key": operation.get("commandKey")},
        )

    def _confirm_shared(
        self,
        *,
        operation: Dict[str, Any],
        conversation_id: str,
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
        success_text: Optional[str] = None,
    ) -> Tuple[Dict[str, Any], int]:
        """Confirmacao explicita: claim atomico na API e escrita com os params e a chave do claim."""
        summary = str(operation.get("summary") or "a operação pendente")
        operation_id = str(operation.get("operationId") or "")
        command = next((cmd for cmd in self.parser.commands if cmd.key == operation.get("commandKey")), None)

        def finish(status: str, text: str, *, ok: bool = False, executed: bool = False, http: Optional[int] = None, **extra):
            response, code = self._task_conversation_response(
                event_id=event_id, moderation_score=moderation_score, queue_result=queue_result,
                conversation_id=conversation_id, status=status, text=text, ok=ok, action_executed=executed,
                command={"key": command.key, "title": command.title} if command else {"key": operation.get("commandKey")},
                **extra,
            )
            response["conversation"]["operation_id"] = operation_id
            return response, http or code

        if not assistant_writes_enabled():
            return self._writes_disabled_response(
                event_id=event_id, moderation_score=moderation_score, queue_result=queue_result,
                conversation_id=conversation_id, command_key=str(operation.get("commandKey") or ""),
            )
        if command is None or not is_write_command(command) or command.key in DISABLED_COMMANDS:
            return finish("cancelled", "Não encontrei uma operação válida para confirmar. Nada foi alterado.")

        # Consultas preliminares ANTES do claim (o lease so comeca depois delas). Perfil desconhecido ou sem
        # permissao: fail-closed (nenhum claim, nenhuma escrita) e a pendente e consumida (cancelada) na API. So diz
        # que cancelou quando a API confirma; o estado local ja foi descartado e nao participa de nada.
        user_type = self.assistant._detect_user_type()
        if not user_type or not has_permission(user_type, command.role_required):
            error = "user_type_unknown" if not user_type else "forbidden"
            reason = "Não consegui confirmar o seu perfil agora" if not user_type else "Você não tem permissão para esse comando"
            if operation.get("status") != "pending":
                # Em recuperacao: a tentativa anterior pode ter sido aplicada; nada e executado nem dado como desfeito.
                return finish(str(operation.get("status") or "unverified"),
                              f"{reason}, então não executei nada agora. A tentativa anterior de: {summary} pode ter "
                              "sido aplicada; confira no Flowly.", error=error, http=403)
            if self._cancel_confirmed(operation_id, conversation_id):
                text = (PROFILE_UNKNOWN_REPLY if not user_type
                        else "Você não tem permissão para esse comando. Nada foi alterado.")
                return finish("cancelled", text, error=error, http=403, cancellation="confirmed")
            return finish("cancel_unverified",
                          f"{reason}, então nada foi executado. Não consegui confirmar o cancelamento do pedido: "
                          f"{summary}. Se não quiser mais, diga \"cancelar\"; sem confirmação, ele expira sozinho.",
                          error=error, http=403, cancellation="unverified")

        started = time.monotonic()
        try:
            claim = self._operations().claim(operation_id=operation_id, conversation_id=conversation_id)
        except APIError as exc:
            return self._claim_refusal(exc, summary, finish)

        # Daqui em diante so o que veio do claim: comando, parametros e chave da operacao. Claim incompleto,
        # malformado ou incoerente: nada e enviado (sem lease presumido, sem chave nova, sem params locais).
        claim_token, command_key, params, idempotency_key, lease = self._checked_claim(
            claim, operation_id=operation_id, conversation_id=conversation_id, command_key=command.key)
        if lease is None:
            if claim_token:
                # So o detentor de um claimToken valido registra algo: a operacao volta para recuperacao.
                self._release_for_recovery(operation_id, conversation_id, claim_token, {"code": "claim_invalid"})
            return finish("unverified", f"Não consegui executar com segurança: {summary}. Nada foi enviado. "
                                        'Diga "confirmar" novamente em instantes ou faça pelas telas do Flowly.',
                          error="claim_invalid", http=503)
        remaining = lease - (time.monotonic() - started)
        write_timeout = min(WRITE_TIMEOUT_CAP_SEC, remaining - COMPLETE_RESERVE_SEC)
        if write_timeout < MIN_WRITE_TIMEOUT_SEC:
            # Sem folga para escrever e registrar com seguranca: nada e enviado; a operacao volta para recuperacao
            # com a MESMA chave.
            self._release_for_recovery(operation_id, conversation_id, claim_token, {"code": "lease_budget_exhausted"})
            return finish("retry_pending", f"Não consegui executar agora com segurança: {summary}. Nada foi enviado. "
                                           'Diga "confirmar" novamente em instantes.', error="lease_budget_exhausted", http=503)

        try:
            response = self.assistant.execute_with_key(
                command_key, params, idempotency_key=idempotency_key, timeout_sec=write_timeout,
            )
        except APIError as exc:
            return self._record_write_error(exc, operation_id, conversation_id, claim_token, summary, finish)
        except Exception:
            # Erro inesperado no meio da escrita: nao da para afirmar que nada mudou.
            return self._record_uncertain(operation_id, conversation_id, claim_token, {"code": "client_error"}, summary, finish,
                                          error="internal_error", http=500)

        result: Dict[str, Any] = {"httpStatus": int(response.status_code), "replayed": bool(response.replayed)}
        resource_id = self._resource_id(response.data)
        if resource_id:
            result["resourceId"] = resource_id
        try:
            self._operations().complete(operation_id=operation_id, conversation_id=conversation_id,
                                        claim_token=claim_token, outcome="completed", result=result)
        except APIError:
            # A API publica confirmou a escrita; o registro fica para a recuperacao (mesma chave, sem duplicar).
            pass
        text = success_text or f"Confirmado. Operação concluída: {summary}."
        return finish("completed", text, ok=True, executed=True, params=params, result=coerce_jsonable(response.data),
                      replayed=bool(response.replayed))

    @staticmethod
    def _lease_seconds(claim: Dict[str, Any]) -> Optional[float]:
        """Duracao do lease pelo proprio claim (leaseUntil - updatedAt, os dois do relogio do servidor).

        None se faltar, estiver malformado (sem fuso inclusive) ou nao for positivo: nada e presumido. Lease maior
        que o padrao e limitado a ele (usar menos tempo que o concedido e sempre seguro)."""
        lease_until, claimed_at = _parse_instant(claim.get("leaseUntil")), _parse_instant(claim.get("updatedAt"))
        if lease_until is None or claimed_at is None:
            return None
        seconds = (lease_until - claimed_at).total_seconds()
        return min(seconds, LEASE_FALLBACK_SEC) if seconds > 0 else None

    def _checked_claim(self, claim: Any, *, operation_id: str, conversation_id: str, command_key: str):
        """(claim_token, command_key, params, idempotency_key, lease) do claim, com lease None se ele nao for
        seguro para executar. claim_token so vem preenchido quando e um UUID v4 (o unico que pode registrar)."""
        if not isinstance(claim, dict):
            return "", "", {}, "", None
        token = claim.get("claimToken")
        claim_token = token if isinstance(token, str) and UUID_V4.fullmatch(token) else ""
        key = claim.get("idempotencyKey")
        idempotency_key = key if isinstance(key, str) and UUID_V4.fullmatch(key) else ""
        raw_params = claim.get("params")
        params: Dict[str, str] = {}
        params_ok = False
        if isinstance(raw_params, dict) and claim.get("commandKey") == command_key and command_key in EXECUTABLE_PARAMS:
            checked, problem = self._executable_params(command_key, raw_params)
            # Os params do claim precisam ja ser exatamente os executaveis (nada a mais, nada ajustado).
            params_ok = problem is None and checked == raw_params
            params = dict(checked) if params_ok else {}
        coherent = (
            claim.get("operationId") == operation_id
            and claim.get("conversationId") == conversation_id
            and claim.get("status") == "executing"
            and idempotency_key != operation_id
        )
        lease = self._lease_seconds(claim)
        if not (claim_token and idempotency_key and params_ok and coherent) or lease is None:
            return claim_token, "", {}, "", None
        return claim_token, command_key, params, idempotency_key, lease

    def _cancel_confirmed(self, operation_id: str, conversation_id: str) -> bool:
        """Cancela a pendente; True so quando a API confirma que ela nao pode mais ser executada (cancelada agora, ou
        ja cancelada/expirada). Timeout, rede, 5xx, em execucao ou qualquer outra recusa: False (nao verificado)."""
        try:
            self._operations().cancel(operation_id=operation_id, conversation_id=conversation_id)
            return True
        except APIError as exc:
            state = (exc.operation or {}).get("status") if exc.kind == "http" else None
            return state in ("cancelled", "expired") and exc.code in ("operation_cancelled", "operation_expired")

    @staticmethod
    def _resource_id(data: Any) -> Optional[str]:
        if isinstance(data, dict):
            for candidate in (data.get("_id"), (data.get("tarefa") or {}).get("_id") if isinstance(data.get("tarefa"), dict) else None,
                              (data.get("equipe") or {}).get("_id") if isinstance(data.get("equipe"), dict) else None):
                if isinstance(candidate, str) and is_object_id(candidate):
                    return candidate.lower()
        return None

    def _claim_refusal(self, exc: APIError, summary: str, finish) -> Tuple[Dict[str, Any], int]:
        """Claim recusado ou sem resposta: nenhuma escrita foi enviada por este pedido."""
        code, category = exc.code, exc.category
        if exc.kind == "writes_disabled":
            return finish("cancelled", WRITES_DISABLED_REPLY, error="assistant_writes_disabled", http=403)
        if category == "in_progress":
            return finish("operation_in_progress", f"Essa operação já está sendo executada: {summary}. Aguarde o resultado.",
                          error="operation_in_progress", http=409)
        if category == "expired" or code == "operation_expired":
            return finish("expired", f"O pedido expirou antes da confirmação: {summary}. Nada foi alterado. "
                                     "Se ainda quiser, faça o pedido de novo.", ok=True)
        if code == "operation_completed":
            return finish("completed", f"Essa operação já foi confirmada e concluída: {summary}. Nada foi executado de novo.", ok=True)
        if code == "operation_cancelled":
            return finish("cancelled", "Essa operação já foi cancelada. Nada foi executado.", ok=True)
        if code == "operation_failed":
            return finish("failed", f"Essa operação não foi concluída: {summary}. Nada foi executado de novo.", ok=True)
        if code == "operation_unknown" or category == "outcome_unknown":
            return finish("unknown", f"Não foi possível confirmar o resultado de: {summary}. Por segurança, não vou repetir. "
                                     "Confira no Flowly se a alteração foi feita.", error="outcome_unknown")
        if category == "not_found":
            return finish("cancelled", "Não encontrei uma operação válida para confirmar. Nada foi alterado.")
        if exc.kind == "not_configured":
            return finish("unavailable", SHARED_UNAVAILABLE_REPLY, error="shared_confirmation_unavailable", http=503)
        # Claim sem resposta (timeout, rede, 5xx): pode ter sido registrado, mas a escrita nao foi enviada.
        return finish("unverified", f"Não consegui iniciar a execução agora: {summary}. Nenhuma alteração foi enviada "
                                    'por este pedido. Diga "confirmar" novamente em instantes.', error="claim_unverified", http=503)

    def _record_write_error(self, exc: APIError, operation_id, conversation_id, claim_token, summary, finish):
        """Erro da escrita publica: definitivo -> failed; incerto -> recuperacao com a mesma chave; desconhecido
        -> unknown. Nunca diz que nada mudou quando a escrita pode ter entrado."""
        result = {k: v for k, v in (("httpStatus", exc.status_code), ("code", exc.code or exc.kind)) if v}
        if exc.category in ("outcome_unknown", "key_reused"):
            self._complete_quietly(operation_id, conversation_id, claim_token, "unknown", result)
            return finish("unknown", f"Não foi possível confirmar o resultado de: {summary}. Por segurança, não vou repetir. "
                                     "Confira no Flowly se a alteração foi feita.", error="outcome_unknown")
        if exc.kind in ("writes_disabled", "blocked", "invalid_request"):
            # Recusado aqui, antes da rede: nada foi enviado (recusa definitiva). Encerra como failed para nao
            # prender a conversa em recuperacao; um novo pedido gera outra confirmacao.
            self._complete_quietly(operation_id, conversation_id, claim_token, "failed", {"code": exc.kind})
            if exc.kind == "writes_disabled":
                return finish("cancelled", WRITES_DISABLED_REPLY, error="assistant_writes_disabled", http=403)
            return finish("failed", f"Não consegui executar: {summary}. Nada foi enviado.", error=exc.kind, http=400)
        if exc.may_have_executed or exc.category in ("in_progress", "outcome_uncertain"):
            return self._record_uncertain(operation_id, conversation_id, claim_token, result, summary, finish)
        # Recusa definitiva e verificavel da API publica (400/401/403/404/409 de negocio...): nada foi aplicado.
        self._complete_quietly(operation_id, conversation_id, claim_token, "failed", result)
        return finish("failed", str(exc) or "Não consegui concluir essa ação agora.", error="api_error")

    def _record_uncertain(self, operation_id, conversation_id, claim_token, result, summary, finish, *,
                          error="outcome_uncertain", http=None):
        """Resultado incerto: a operacao vai para recuperacao (mesma chave); nada e repetido agora."""
        status = None
        try:
            status = (self._operations().retry(operation_id=operation_id, conversation_id=conversation_id,
                                               claim_token=claim_token, result=result) or {}).get("status")
        except APIError:
            pass  # o lease vence e a recuperacao continua possivel com a mesma chave
        if status == "unknown":
            return finish("unknown", f"Não foi possível confirmar o resultado de: {summary}. Por segurança, não vou repetir. "
                                     "Confira no Flowly se a alteração foi feita.", error="outcome_unknown")
        return finish("retry_pending", f"Não consegui confirmar se a alteração foi feita: {summary}. Ela pode ter sido aplicada. "
                                       'Para concluir com segurança, sem repetir, diga "confirmar"; ou confira no Flowly.',
                      error=error, http=http)

    def _release_for_recovery(self, operation_id, conversation_id, claim_token, result) -> None:
        try:
            self._operations().retry(operation_id=operation_id, conversation_id=conversation_id,
                                     claim_token=claim_token, result=result)
        except APIError:
            pass  # sem registro, o lease vence e a operacao fica recuperavel do mesmo jeito

    def _complete_quietly(self, operation_id, conversation_id, claim_token, outcome, result) -> None:
        try:
            self._operations().complete(operation_id=operation_id, conversation_id=conversation_id,
                                        claim_token=claim_token, outcome=outcome, result=result or None)
        except APIError:
            pass  # o estado fica para a recuperacao/expiracao; nada e repetido por isso

    def _fill_target_labels(self, params: Dict[str, str]) -> None:
        """Alvo informado ja como ID (params do cliente): busca o nome real so com leituras, para o resumo."""
        try:
            if is_object_id(params.get("task_id", "")) and not params.get("_task_label"):
                details = self.assistant.api.task_details(params["task_id"])
                tarefa = (details or {}).get("tarefa") if isinstance(details, dict) else None
                if isinstance(tarefa, dict) and tarefa.get("descricao"):
                    params["_task_label"] = str(tarefa["descricao"]).strip()
            team_id = params.get("equipe") or params.get("team_id") or ""
            if is_object_id(team_id) and not params.get("_team_label"):
                team = next(
                    (t for t in _dict_items(self.assistant.api.list_my_teams()) if str(t.get("_id") or "") == team_id),
                    None,
                )
                if team and team.get("nome"):
                    params["_team_label"] = str(team["nome"]).strip()
        except Exception:
            return  # sem nome, o resumo diz "indicada"; a execucao continua exigindo a confirmacao

    def _write_summary(self, command_key: str, params: Dict[str, str]) -> str:
        """Resumo do que sera executado, com os alvos reais resolvidos (sem IDs nem e-mail de terceiros)."""
        task = params.get("_task_label")
        task_name = f'tarefa "{task}"' if task else "tarefa indicada"
        task_text, of_task, in_task = f"a {task_name}", f"da {task_name}", f"na {task_name}"
        if command_key == "create_team":
            return f'criar a equipe "{self.assistant._title_case_name(params.get("nome", ""))}"'
        if command_key == "create_task":
            team = params.get("_team_label")
            user_label = str(params.get("_user_label") or "").split(" (")[0].strip()
            if params.get("user") == "__none__":
                user_label = "sem responsável"
            parts = [
                f'criar a tarefa "{params.get("nome", "")}"',
                f'na equipe "{team}"' if team else "na equipe indicada",
                f"com entrega em {_short_date(params.get('dataEntrega')) or params.get('dataEntrega', '')}",
                f"urgência {URGENCY_LABELS.get(params.get('urgencia', ''), params.get('urgencia', ''))}",
                f"responsável: {user_label or 'usuário indicado'}",
            ]
            return ", ".join(parts)
        if command_key == "assign_to_me":
            return f"atribuir {task_text} para você"
        if command_key == "update_status":
            return f"mudar o status {of_task} para {self._status_label(params.get('status', ''))}"
        if command_key == "timer":
            verbo = "iniciar" if params.get("acao") == "iniciar" else "pausar"
            return f"{verbo} o cronômetro {of_task}"
        if command_key == "add_comment":
            return f'comentar {in_task}: "{params.get("texto", "")}"'
        if command_key == "add_subtask":
            return f'adicionar a subtarefa "{params.get("descricao", "")}" {in_task}'
        command = next((cmd for cmd in self.parser.commands if cmd.key == command_key), None)
        return command.title if command else command_key

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

        attribute_response = self._task_attribute_response(
            conversation_id=conversation_id,
            pending=pending,
            content=content,
            tasks=tasks,
            event_id=event_id,
            moderation_score=moderation_score,
            queue_result=queue_result,
        )
        if attribute_response is not None:
            return attribute_response

        words = set(plain_words(content))
        quantity = requested_quantity(content)
        if quantity is not None:
            # "as três mais urgentes": quantidade, nao a 3ª tarefa. Sem pedido de urgencia ("mostre as duas"),
            # pergunta em vez de escolher uma tarefa (e nunca escreve).
            if words & URGENCY_FOLLOW_UP_WORDS and not self._tasks_named_in(content, tasks):
                top, display, spoken = urgent_follow_up(tasks, limit=quantity)
                if top:
                    self.conversations.save(conversation_id, {"mode": "task_selection", "tasks": top})
                return self._task_conversation_response(
                    event_id=event_id,
                    moderation_score=moderation_score,
                    queue_result=queue_result,
                    conversation_id=conversation_id,
                    status="browsing_tasks" if top else "awaiting_task_selection",
                    text=display,
                    spoken=spoken,
                    ok=True,
                    action_executed=False,
                    **({"query": selection_metadata("urgent", top, len(top))} if top else {}),
                )
            text = (
                f"Você quer uma tarefa da lista ou as {quantity} mais urgentes? Nada foi alterado. "
                "Diga, por exemplo, \"detalhes da terceira\" ou \"as três mais urgentes\"."
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
        if words & URGENCY_FOLLOW_UP_WORDS and not task_position_refs(content) and not self._tasks_named_in(content, tasks):
            top, display, spoken = urgent_follow_up(tasks)
            if top:
                # A numeracao mostrada passa a ser a da nova lista.
                self.conversations.save(conversation_id, {"mode": "task_selection", "tasks": top})
            return self._task_conversation_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                status="browsing_tasks" if top else "awaiting_task_selection",
                text=display,
                spoken=spoken,
                ok=True,
                action_executed=False,
                **({"query": selection_metadata("urgent", top, len(top))} if top else {}),
            )

        selected_id = pending.get("selected_task_id")
        selected_task = next((task for task in tasks if task.get("_id") == selected_id), None)
        position_refs = task_position_refs(content)
        named_tasks = self._tasks_named_in(content, tasks)
        # "como pegar a 3?", "vou pegar a 3 amanhã", "sem pegar a 3": descreve a atribuicao, mas nao a pede.
        words_outside = self._words_outside_names(content, named_tasks)
        if self._task_follow_up_action(words_outside) in ("assign", "conflict") and is_non_directive_text(words_outside):
            return self._task_conversation_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                status="awaiting_task_action" if selected_task else "awaiting_task_selection",
                text=(
                    "Não identifiquei um pedido direto para atribuir uma tarefa. Nada foi alterado. "
                    "Para atribuir, diga por exemplo: atribuir a tarefa 1 para mim."
                ),
                ok=True,
                action_executed=False,
            )
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
        if (
            unknown_ref and selected_task and not position_refs and not named_tasks
            and self._task_follow_up_action(words_outside) not in ("assign", "conflict")
            and self._is_selected_task_question(content)
        ):
            # Pergunta de leitura sobre a tarefa escolhida que nao foi entendida (ex.: "agência" no lugar de
            # "urgência"): a selecao continua para a pessoa reformular; nada e executado.
            return self._task_conversation_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                status="browsing_tasks",
                text=self._unknown_question_reply(content, selected_task),
                ok=True,
                action_executed=False,
            )
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
                "Você quer detalhes, atribuir para você ou cancelar?"
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

        if action == "assign" and not assistant_writes_enabled():
            # Chave desligada: a lista e a tarefa escolhida continuam valendo para consultas (detalhes).
            self.conversations.save(conversation_id, {**pending, "selected_task_id": selected_task.get("_id")})
            return self._writes_disabled_response(
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                conversation_id=conversation_id,
                command_key="assign_to_me",
                clear=False,
                status="awaiting_task_action",
            )

        # Atribuir sem confirmacao so quando a tarefa ja tinha sido selecionada e mostrada ("Selecionei X" ou os
        # detalhes) e esta mensagem e a resposta a essa escolha. Numero ou nome dito agora (sujeito a erro de
        # transcricao, "3" x "13") passa pelo resumo com o nome da tarefa e pela confirmacao explicita.
        # A referencia dita nesta frase vale mesmo quando coincide com a selecao anterior ("atribuir a 7 para mim" com
        # a 7 ja escolhida): a fala pode ter sido mal transcrita, entao o resumo com o nome e a confirmacao continuam.
        if action == "assign" and (
            position_refs or named_tasks or str(selected_task.get("_id")) != str(selected_id or "")
        ):
            return self._request_selection_assign_confirmation(
                conversation_id=conversation_id,
                task=selected_task,
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
            )

        if action == "assign":
            # Resposta explicita a uma tarefa ja selecionada e mostrada: executa sem novo resumo, mas pela operacao
            # compartilhada (criar + claim + escrita com a chave da operacao), como qualquer escrita.
            command = next(cmd for cmd in self.parser.commands if cmd.key == "assign_to_me")
            return self._create_shared_confirmation(
                conversation_id=conversation_id,
                command=command,
                resolved={"task_id": str(selected_task.get("_id") or ""),
                          "_task_label": self._selection_task_label(selected_task)},
                event_id=event_id,
                moderation_score=moderation_score,
                queue_result=queue_result,
                execute_now_text=f"Atribui a tarefa {self._task_title(selected_task)} para voce.",
            )

        try:
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
                **({"task": task_card(result["tarefa"], self.user_id)}
                   if isinstance(result, dict) and isinstance(result.get("tarefa"), dict) else {}),
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

    def _status_read_hint(self, content: str) -> Optional[str]:
        """"Qual o status da tarefa X?" / "ver status da tarefa X": consulta, nao alteracao. Sugere o comando de
        leitura. Frases com um novo status ("como mudar ... para concluído") mantem a resposta de pergunta."""
        if "status" not in plain_words(content) or extract_status_target(content):
            return None
        found = re.search(r"\btarefa\s+(.+)$", " ".join(content.split()), flags=re.IGNORECASE)
        name = found.group(1).strip(" ?!.,;:\"'") if found else ""
        example = f'"detalhes da tarefa {name}"' if name else '"detalhes da tarefa" seguido do nome da tarefa'
        return (
            "Entendi como uma consulta, não como um pedido de alteração. Nada foi alterado. "
            f"Para ver o status, diga: {example}."
        )

    def _writes_disabled_response(
        self,
        *,
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
        conversation_id: str,
        command_key: str,
        clear: bool = True,
        status: str = "cancelled",
    ) -> Tuple[Dict[str, Any], int]:
        """Escritas desligadas pela chave temporaria: responde sem chamar a API e descarta o fluxo de escrita."""
        if clear:
            self.conversations.clear(conversation_id)
        return {
            "ok": False,
            "error": "assistant_writes_disabled",
            "messageId": event_id,
            "moderation": {"allowed": True, "score": moderation_score},
            "queue": queue_result,
            "action_executed": False,
            "command": {"key": command_key},
            "conversation": {"id": conversation_id, "status": status},
            "reply_text": WRITES_DISABLED_REPLY,
            "tts": tts_payload(WRITES_DISABLED_REPLY, language=str(self.body.get("language") or "pt-BR")),
        }, 403

    def _is_selected_task_question(self, content: str) -> bool:
        """Frase de pergunta ("qual...", "quando...", "e o ...?", com "ela/dela") sem verbo de escrita."""
        words = plain_words(content)
        if not words or WRITE_INTENT_RE.search(" ".join(words)):
            return False
        # "o prazo da tarefa configurar alerta": cita outra tarefa pelo nome; nunca vale para a tarefa escolhida.
        if "tarefa" in words and any(w not in TASK_ATTRIBUTE_FILLER_WORDS for w in words[words.index("tarefa") + 1:]):
            return False
        return bool(set(words) & (TASK_QUESTION_WORDS | SINGLE_TASK_PRONOUNS)) or (words[0] == "e" and len(words) <= 4)

    def _unknown_question_reply(self, content: str, task: Dict[str, Any]) -> str:
        title = self._task_title(task)
        unknown = [w for w in plain_words(content) if w not in TASK_ATTRIBUTE_FILLER_WORDS and len(w) >= 4]
        for word in unknown:
            close = difflib.get_close_matches(word, list(TASK_ATTRIBUTE_LABELS), n=1, cutoff=0.75)
            if close:
                label = TASK_ATTRIBUTE_LABELS[close[0]]
                return (f"Não entendi qual informação você quer sobre a tarefa {title}. "
                        f"Você quis dizer {label}? Pergunte, por exemplo: \"qual é {label} dela?\"")
        return (f"Não entendi qual informação você quer sobre a tarefa {title}. "
                "Você quer saber o prazo, a urgência, o status, a equipe ou o responsável?")

    def _task_attributes_asked(self, content: str, named_tasks: list[Dict[str, Any]]) -> list[str]:
        """Dados perguntados sobre uma tarefa ("prazo", "status"...), na ordem fixa; [] se a frase nao e so isso.

        Qualquer palavra fora do vocabulario (outra tarefa, verbo de escrita), pedido sobre a lista ("quais as mais
        urgentes?") ou sobre a pessoa ("qual é minha prioridade?") devolve [] e segue os fluxos de antes.
        """
        outside = self._words_outside_names(content, named_tasks)
        if self._task_follow_up_action(outside) in ("assign", "conflict"):
            return []
        refs = task_position_refs(content)
        words = [word for word in outside.split() if word not in refs]
        if not words or set(words) & TASK_ATTRIBUTE_EXCLUDED_WORDS:
            return []
        if any(word not in TASK_ATTRIBUTE_FILLER_WORDS for word in words):
            return []
        return [attribute for attribute, vocabulary in TASK_ATTRIBUTE_WORDS if vocabulary & set(words)]

    def _task_attribute_response(
        self,
        *,
        conversation_id: str,
        pending: Dict[str, Any],
        content: str,
        tasks: list[Dict[str, Any]],
        event_id: str,
        moderation_score: float,
        queue_result: Dict[str, Any],
    ) -> Optional[Tuple[Dict[str, Any], int]]:
        """Responde uma pergunta sobre um dado da tarefa (so leitura). None: nao e uma pergunta dessas, ou a
        referencia nao vale (os fluxos de antes tratam: posicao invalida descarta a selecao, sem chamar a API)."""
        named_tasks = self._tasks_named_in(content, tasks)
        attributes = self._task_attributes_asked(content, named_tasks)
        if not attributes:
            return None
        refs = task_position_refs(content)
        selected_id = pending.get("selected_task_id")
        selected_task = next((task for task in tasks if task.get("_id") == selected_id), None)
        if refs:
            target = self._task_for_position_refs(refs, named_tasks, tasks)
        elif named_tasks:
            target = named_tasks[0] if len(named_tasks) == 1 else None
        else:
            target = selected_task
            if target is None:
                if attributes == ["urgencia"] and not set(plain_words(content)) & SINGLE_TASK_PRONOUNS:
                    return None  # "qual é a prioridade?" sem tarefa escolhida: as mais urgentes da lista, como antes
                text = "De qual tarefa da lista? Diga o número dela, por exemplo \"o prazo da tarefa 2\", ou cancelar."
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
        if target is None:
            return None

        # Dados atuais da tarefa (status e prazo mudam): nunca os da lista guardada.
        try:
            result = self.assistant.api.task_details(str(target["_id"]))
        except Exception:
            text = "Não consegui consultar essa tarefa agora. Nada foi alterado. Tente de novo em instantes."
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
        tarefa = (result or {}).get("tarefa") if isinstance(result, dict) else None
        if not isinstance(tarefa, dict):
            text = "Não consegui ler os dados dessa tarefa. Nada foi alterado."
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

        text = f"Tarefa {self._task_title(tarefa)}: " + "; ".join(
            self._task_attribute_text(tarefa, attribute) for attribute in attributes
        ) + "."
        self.conversations.save(conversation_id, {**pending, "selected_task_id": target.get("_id")})
        return self._task_conversation_response(
            event_id=event_id,
            moderation_score=moderation_score,
            queue_result=queue_result,
            conversation_id=conversation_id,
            status="browsing_tasks",
            text=text,
            ok=True,
            action_executed=True,
            command={"key": "task_details"},
        )

    def _task_attribute_text(self, tarefa: Dict[str, Any], attribute: str) -> str:
        """Um dado da tarefa, como veio da API; ausente e dito como ausente (nunca inventado)."""
        if attribute == "prazo":
            entrega = _short_date(tarefa.get("dataEntrega"))
            return f"prazo {entrega}" if entrega else "sem prazo definido"
        if attribute == "status":
            status = str(tarefa.get("status") or "").strip()
            return f"status {self._status_label(status)}" if status else "status não informado"
        if attribute == "urgencia":
            urgencia = URGENCY_LABELS.get(str(tarefa.get("urgencia") or "").strip().lower())
            return f"urgência {urgencia}" if urgencia else "sem urgência definida"
        if attribute == "equipe":
            equipe = tarefa.get("equipe")
            nome = str(equipe.get("nome") or "").strip() if isinstance(equipe, dict) else ""
            return f"equipe {nome}" if nome else "sem equipe informada"
        if attribute == "responsavel":
            user = tarefa.get("user")
            nome = str(user.get("nome") or "").strip() if isinstance(user, dict) else ""
            return f"responsável {nome}" if nome else "sem responsável"
        detalhes = str(tarefa.get("detalhes") or "").strip()
        return f"descrição: {detalhes[:180]}" if detalhes else "sem descrição cadastrada"

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
        # Fala: "duas tarefas" (o navegador leria "2 tarefas" como "dois tarefas"); a tela segue com o numeral.
        spoken_header = f"Encontrei {feminine_number(len(tasks))} {'tarefa' if len(tasks) == 1 else 'tarefas'}."
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
        spoken = f"{spoken_header} {said}"
        more_options = len(options) - SPOKEN_TASK_LIMIT
        if more_options > 0:
            spoken += f" Há mais {feminine_number(more_options)} {'opção' if more_options == 1 else 'opções'} na tela."
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
            suffix = " Você pode pedir outra tarefa, atribuir para você ou cancelar."
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
        assign = any(word in text for word in TASK_ASSIGN_WORDS)  # inalterado: nenhuma forma nova vira escrita
        words = set(plain_words(text))
        # Com "para mim" ("mostra a 3 para mim"), so as palavras de antes contam como detalhes: a frase pode ser um
        # pedido de atribuicao mal dito, entao a tarefa so e selecionada e o assistente pergunta.
        details = bool(words & (TASK_DETAIL_WORDS_WITH_MIM if "mim" in words else TASK_DETAIL_WORDS))
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
            idx = task_position_index(ref, len(tasks))
            if idx is not None:
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
            self.assistant._resolve_refs(resolver_params, self.assistant._detect_user_type(reuse=True) or "user")
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
    context_cleared = True
    if conversation_id:
        # Saiu da conversa: o contexto dela (pergunta pendente, selecao) e removido na API, sem condicao de versao.
        # Sem confirmacao da API, nao diz que limpou; o prazo do contexto encerra de qualquer forma.
        context_cleared = SharedConversationState(ConversationStateClient(token)).clear_unconditional(conversation_id)
        if not conversation_id.endswith(MEMORY_SUFFIX):
            # Os fatos ditos nesta conversa tambem saem (melhor esforco; o TTL encerra de qualquer forma).
            context_cleared = ConversationMemory(ConversationStateClient(token)).clear_unconditional(conversation_id) \
                and context_cleared
        if assistant_writes_enabled():
            # Saiu da conversa: a confirmacao pendente dela nao deve continuar executavel (melhor esforco; o prazo
            # da API encerra de qualquer forma). Execucao ja reivindicada nunca e cancelada.
            try:
                operations = OperationsClient(token)
                current = operations.current(conversation_id=conversation_id)
                if current and current.get("status") == "pending":
                    operations.cancel(operation_id=current["operationId"], conversation_id=conversation_id)
            except APIError:
                pass
    text = "Assistente em standby."
    extra: Dict[str, Any] = {}
    if not context_cleared:
        extra["context_cleared"] = False
        text = ("Assistente em standby. Não consegui limpar o andamento desta conversa agora; ele expira sozinho "
                "em alguns minutos.")
    return {
        "ok": True,
        "status": "standby",
        **extra,
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
