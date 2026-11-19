from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Dict, Optional, Tuple

from difflib import SequenceMatcher

from flowly_assistant.commands import Command, get_commands


OBJ_ID_RE = re.compile(r"\b[a-fA-F0-9]{24}\b")


NEGATION_TOKENS = {
    "não",
    "nao",
    "nega",
    "nunca",
    "jamais",
    "nem",
    "cancelar",
    "cancela",
    "deixa",
    "esquece",
}

# exit só quando a frase inteira é o comando (evita "pensei em sair mais cedo" -> exit)
EXIT_RE = re.compile(
    r"^(?:pode |por favor )?"
    r"(?:(?:sair|encerrar)(?: (?:d?o )?assistente)?|(?:parar|fechar) assistente)"
    r"(?: por favor)?$"
)


WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Verbos que alteram dados. Sem um comando de escrita explicito (e sem frase de consulta presente),
# a frase nao vira comando nenhum: melhor nao agir do que agir no comando errado.
WRITE_INTENT_RE = re.compile(
    r"\b(?:conclu\w*|exclu\w*|inclu\w*|apag\w*|delet\w*|remov\w*|adicion\w*|atribu\w*|assum\w*|alter\w*"
    r"|atualiz\w*|finaliz\w*|edit\w*|renome\w*|termin\w*|inici\w*|paus\w*"
    r"|cri(?:ar|e|a|o|ou)|mud(?:ar|e|a|o|ou)|marc(?:ar|a|ou|que))\b"
)


def is_write_command(command: Command) -> bool:
    return (command.method or "").strip().upper() in WRITE_METHODS


@dataclass
class Match:
    command: Command
    score: int
    params: Dict[str, str]


def _normalize(text: str) -> str:
    text = (text or "").strip().lower()
    text = re.sub(r"[\t\n\r]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text


def _words(text: str) -> list:
    return re.findall(r"\w+", text)


def _has_negation(text: str) -> bool:
    return any(tok in NEGATION_TOKENS for tok in _words(text))


def _contains_phrase(text: str, phrases: Tuple[str, ...]) -> bool:
    return any(re.search(rf"(?<!\w){re.escape(p)}(?!\w)", text) for p in phrases)


def _ratio(a: str, b: str) -> int:
    return int(round(SequenceMatcher(None, a, b).ratio() * 100))


def _token_set_ratio(a: str, b: str) -> int:
    a = _normalize(a)
    b = _normalize(b)
    if not a or not b:
        return 0

    tokens_a = set(a.split())
    tokens_b = set(b.split())
    intersection = tokens_a & tokens_b
    diff_a = tokens_a - intersection
    diff_b = tokens_b - intersection

    sect = " ".join(sorted(intersection))
    combo_a = " ".join(sorted(intersection | diff_a))
    combo_b = " ".join(sorted(intersection | diff_b))

    return max(_ratio(sect, combo_a), _ratio(sect, combo_b), _ratio(combo_a, combo_b))


def extract_object_id(text: str) -> Optional[str]:
    m = OBJ_ID_RE.search(text or "")
    return m.group(0) if m else None


def plain_words(text: str) -> list[str]:
    """Palavras em minusculas e sem acento ("Não, deixa pra lá" -> ["nao", "deixa", "pra", "la"])."""
    ascii_text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii")
    return re.findall(r"[a-z0-9]+", ascii_text.lower())


# Valores aceitos para parametros que viram escrita. Palavra inteira, sem valor padrao:
# desconhecido ou dois valores diferentes na mesma frase -> None (o assistente pergunta de novo).
STATUS_WORDS = {
    "pendente": "pendente", "pendentes": "pendente",
    "andamento": "em_andamento",
    "concluido": "concluido", "concluida": "concluido", "concluidos": "concluido", "concluidas": "concluido",
    "concluir": "concluido", "conclui": "concluido",
    "finalizado": "concluido", "finalizada": "concluido", "finalizar": "concluido",
    "feito": "concluido", "feita": "concluido",
}
TIMER_ACTION_WORDS = {
    "iniciar": "iniciar", "inicia": "iniciar", "inicie": "iniciar",
    "comecar": "iniciar", "comeca": "iniciar", "comece": "iniciar", "start": "iniciar",
    "pausar": "pausar", "pausa": "pausar", "pause": "pausar",
    "parar": "pausar", "pare": "pausar", "stop": "pausar",
}
URGENCY_WORDS = {
    "alta": "alta", "urgente": "alta",
    "media": "media", "normal": "media",
    "baixa": "baixa",
}
STRICT_PARAM_WORDS = {"status": STATUS_WORDS, "acao": TIMER_ACTION_WORDS, "urgencia": URGENCY_WORDS}


def _strict_choice(text: str, vocabulary: Dict[str, str]) -> Optional[str]:
    values = {vocabulary[word] for word in plain_words(text) if word in vocabulary}
    return values.pop() if len(values) == 1 else None


def strict_param_value(param: str, value: str) -> Optional[str]:
    """Valor canonico de status/acao/urgencia, ou None se desconhecido ou ambiguo."""
    return _strict_choice(str(value or ""), STRICT_PARAM_WORDS[param])


def extract_status(text: str) -> Optional[str]:
    return _strict_choice(text, STATUS_WORDS)


def extract_timer_action(text: str) -> Optional[str]:
    return _strict_choice(text, TIMER_ACTION_WORDS)


# Na frase inicial, o novo valor nao pode vir do nome da tarefa ("mudar status da tarefa pendente de aprovação").
_STATUS_MARKERS = {"para", "como"}
_STATUS_MARKER_FILLERS = {"o", "a", "status", "de", "em"}
_TASK_ANCHORS = {"tarefa", "task"}


def extract_status_target(text: str) -> Optional[str]:
    """Novo status so quando indicado explicitamente: "para concluído", "como concluída", "para em andamento".

    "para pendente e concluído" (duas opcoes) e ambiguo -> None.
    """
    words = plain_words(text)
    values = set()

    def status_from(index: int) -> Tuple[Optional[str], int]:
        while index < len(words) and words[index] in _STATUS_MARKER_FILLERS:
            index += 1
        return (STATUS_WORDS.get(words[index]) if index < len(words) else None), index

    for i, word in enumerate(words):
        if word not in _STATUS_MARKERS:
            continue
        value, j = status_from(i + 1)
        if value is None:
            continue
        values.add(value)
        if j + 1 < len(words) and words[j + 1] in {"e", "ou"}:
            other, _k = status_from(j + 2)
            if other:
                values.add(other)
    return values.pop() if len(values) == 1 else None


def extract_timer_action_target(text: str) -> Optional[str]:
    """Acao do cronometro so no trecho do comando, antes de "tarefa" ("iniciar cronômetro da tarefa X")."""
    words = plain_words(text)
    cut = next((i for i, word in enumerate(words) if word in _TASK_ANCHORS), len(words))
    return _strict_choice(" ".join(words[:cut]), TIMER_ACTION_WORDS)


def extract_free_text_after(text: str, anchors: Tuple[str, ...]) -> Optional[str]:
    t = _normalize(text)
    for a in anchors:
        if a in t:
            idx = t.find(a)
            frag = t[idx + len(a) :].strip(" :,-")
            frag = OBJ_ID_RE.sub("", frag).strip()
            if len(frag) >= 3:
                return frag
    return None


def clean_labeled_value(value: str, labels: Tuple[str, ...]) -> str:
    text = _normalize(value)
    changed = True
    while changed:
        changed = False
        for label in labels:
            label_norm = _normalize(label).strip(" :,-")
            if text == label_norm:
                return ""
            prefix = f"{label_norm} "
            if text.startswith(prefix):
                text = text[len(prefix) :].strip(" :,-")
                changed = True
    return text


def remove_team_tail(value: str) -> str:
    text = _normalize(value)
    return re.split(r"\b(?:para|na|no|da|do)?\s*(?:equipe|time)\b", text, maxsplit=1)[0].strip(" :,-")


def extract_labeled_segment(text: str, labels: Tuple[str, ...], stop_labels: Tuple[str, ...]) -> Optional[str]:
    source = _normalize(text)
    label_pattern = "|".join(re.escape(_normalize(label)) for label in labels)
    stop_pattern = "|".join(re.escape(_normalize(label)) for label in stop_labels)
    match = re.search(rf"\b(?:{label_pattern})\b\s*[:,-]?\s*(.+)", source)
    if not match:
        return None
    value = match.group(1).strip(" :,-")
    if stop_pattern:
        value = re.split(rf"\b(?:{stop_pattern})\b", value, maxsplit=1)[0].strip(" :,-")
    value = re.sub(r"\b(para|na|no|da|do|em)$", "", value).strip(" :,-")
    return value if len(value) >= 2 else None


def remove_task_detail_tail(value: str) -> str:
    text = remove_team_tail(value)
    return re.split(
        r"\b(?:descri[cç][aã]o|descricao|detalhes|detalhe|data|entrega|urg[eê]ncia|urgencia|respons[aá]vel|responsavel)\b",
        text,
        maxsplit=1,
    )[0].strip(" :,-")


def remove_due_date_tail(value: str) -> str:
    text = _normalize(value)
    return re.split(
        r"\b(?:dataentrega|data\s+entrega|data\s+de\s+entrega|prazo|entrega|urg[eê]ncia|urgencia|equipe|time|respons[aá]vel|responsavel)\b",
        text,
        maxsplit=1,
    )[0].strip(" :,-")


def remove_assignee_tail(value: str) -> str:
    text = _normalize(value)
    return re.split(
        r"\b(?:para\s+mim|atribuir\s+para|designar\s+para|respons[aÃ¡]vel|responsavel|usu[aÃ¡]rio|usuario|equipe|time)\b",
        text,
        maxsplit=1,
    )[0].strip(" :,-")


def clean_team_ref(value: str) -> str:
    text = _normalize(value)
    return re.split(
        r"\b(?:tarefa|task|para\s+mim|atribuir\s+para|designar\s+para|respons[aÃ¡]vel|responsavel|usu[aÃ¡]rio|usuario)\b",
        text,
        maxsplit=1,
    )[0].strip(" :,-")


class CommandParser:
    def __init__(self, threshold: int = 78) -> None:
        self.threshold = threshold
        self.commands = get_commands()

    def match(self, utterance: str) -> Optional[Match]:
        raw = utterance or ""
        text = _normalize(raw)
        if not text:
            return None

        # false-positive guard: negation (antes dos atalhos, que disparam ações de escrita)
        if _has_negation(text):
            return None

        # hard-priority: exit
        if EXIT_RE.fullmatch(" ".join(_words(text))):
            cmd = next(c for c in self.commands if c.key == "exit")
            return Match(command=cmd, score=100, params={})

        # Escrita: so quando a frase traz todas as palavras de uma frase do comando, nunca por
        # semelhanca de letras ("concluir tarefa" nao pode virar "excluir tarefa").
        write_cmd, ambiguous_write = self._explicit_write_match(text)
        if ambiguous_write:
            return None
        if write_cmd is not None:
            return Match(command=write_cmd, score=100, params=self._extract_params(write_cmd, raw))

        read_commands = [c for c in self.commands if c.key != "exit" and not is_write_command(c)]

        # Prefer exact phrase matches (avoids fuzzy ties where superset phrases score 100).
        for cmd in read_commands:
            for phrase in cmd.phrases:
                if _normalize(phrase) == text:
                    params = self._extract_params(cmd, raw)
                    return Match(command=cmd, score=100, params=params)

        # Intencao de escrita sem comando de escrita explicito: ambigua, nao executa nada.
        if WRITE_INTENT_RE.search(text) and not self._has_read_phrase(text, read_commands):
            return None

        # Semelhanca aproximada so entre comandos de consulta.
        best: Optional[Tuple[Command, int, int, int]] = None
        for cmd in read_commands:
            for phrase in cmd.phrases:
                phrase_norm = _normalize(phrase)
                score = _token_set_ratio(text, phrase_norm)
                plain = _ratio(text, phrase_norm)
                extra = len(set(phrase_norm.split()) - set(text.split()))
                rank = (score, plain, -extra)
                if best is None or rank > (best[1], best[2], best[3]):
                    best = (cmd, score, plain, -extra)

        if best is None:
            return None

        cmd, score, _plain, _extra_neg = best
        if score < self.threshold:
            return None

        params = self._extract_params(cmd, raw)
        return Match(command=cmd, score=score, params=params)

    def _explicit_write_match(self, text: str) -> Tuple[Optional[Command], bool]:
        """Comando de escrita cujas palavras de alguma frase aparecem todas no texto.

        Frase continua vence frase espalhada; empate entre comandos diferentes e ambiguo.
        Retorna (comando, ambiguo).
        """
        words = set(_words(text))
        candidates = []
        for cmd in self.commands:
            if not is_write_command(cmd):
                continue
            for phrase in cmd.phrases:
                phrase_norm = _normalize(phrase)
                tokens = _words(phrase_norm)
                if tokens and set(tokens) <= words:
                    rank = (_contains_phrase(text, (phrase_norm,)), len(tokens))
                    candidates.append((rank, cmd))
        if not candidates:
            return None, False
        best_rank = max(rank for rank, _cmd in candidates)
        best = {cmd.key: cmd for rank, cmd in candidates if rank == best_rank}
        if len(best) > 1:
            return None, True
        return next(iter(best.values())), False

    def _has_read_phrase(self, text: str, read_commands: list) -> bool:
        words = set(_words(text))
        return any(
            set(_words(_normalize(phrase))) <= words
            for cmd in read_commands
            for phrase in cmd.phrases
        )

    def _extract_params(self, cmd: Command, raw: str) -> Dict[str, str]:
        text = raw or ""
        params: Dict[str, str] = {}

        # common IDs
        if "task_id" in cmd.required_params:
            tid = extract_object_id(text)
            if tid:
                params["task_id"] = tid
            else:
                # permite referenciar por nome/descrição (o assistente resolve para ObjectId)
                ref = extract_free_text_after(text, ("tarefa", "task"))
                if ref:
                    params["task_id"] = ref
        if "team_id" in cmd.required_params:
            team_id = extract_object_id(text)
            if team_id:
                params["team_id"] = team_id
            else:
                ref = extract_free_text_after(text, ("equipe", "time", "team"))
                if ref:
                    params["team_id"] = ref

        if cmd.key == "assign_to_me":
            task_ref = extract_labeled_segment(
                text,
                ("tarefa", "task"),
                ("equipe", "time", "para mim", "atribuir para mim", "assumir", "pegar"),
            )
            if task_ref:
                params["task_id"] = remove_assignee_tail(task_ref)

        if cmd.key == "add_comment":
            texto = extract_free_text_after(text, ("dizendo", "texto", "comentário", "comentario"))
            if texto:
                params["texto"] = texto

        if cmd.key == "add_subtask":
            descricao = extract_free_text_after(text, ("subtarefa", "descrição", "descricao"))
            if descricao:
                params["descricao"] = descricao

        if cmd.key == "search_users":
            q = extract_free_text_after(text, ("buscar", "procurar", "usuário", "usuario"))
            if q:
                params["q"] = q

        if cmd.key == "update_status":
            st = extract_status_target(text)
            if st:
                params["status"] = st

        if cmd.key == "timer":
            acao = extract_timer_action_target(text)
            if acao:
                params["acao"] = acao

        if cmd.key == "create_team":
            nome = extract_free_text_after(text, ("equipe", "time"))
            if nome:
                params["nome"] = clean_labeled_value(nome, ("nome", "chamada", "com nome"))

        if cmd.key == "create_task":
            nome = extract_labeled_segment(
                text,
                ("nome da tarefa", "titulo da tarefa", "título da tarefa", "nome", "titulo", "título"),
                ("descricao detalhada", "descrição detalhada", "descricao", "descrição", "detalhes", "detalhe", "dataentrega", "data entrega", "data de entrega", "data", "entrega", "prazo", "urgencia", "urgência", "equipe", "time", "responsavel", "responsável"),
            )
            if nome:
                params["nome"] = clean_labeled_value(nome, ("nome da tarefa", "titulo da tarefa", "título da tarefa", "nome", "chamada", "titulo", "título"))

            detalhes = extract_labeled_segment(
                text,
                ("descricao detalhada", "descrição detalhada", "descricao", "descrição", "detalhes", "detalhe"),
                ("dataentrega", "data entrega", "data de entrega", "data", "entrega", "prazo", "urgencia", "urgência", "equipe", "time", "responsavel", "responsável"),
            )
            if detalhes:
                params["descricao"] = remove_due_date_tail(clean_labeled_value(detalhes, ("descricao detalhada", "descrição detalhada", "descricao", "descrição", "detalhes", "detalhe")))

            equipe_id = extract_object_id(text)
            if equipe_id:
                params["equipe"] = equipe_id
            else:
                equipe_nome = extract_free_text_after(text, ("equipe", "time"))
                if equipe_nome:
                    params["equipe"] = equipe_nome
            user_ref = extract_labeled_segment(
                text,
                ("responsavel", "responsavel", "usuario", "usuario", "atribuir para", "designar para", "para"),
                ("dataentrega", "data entrega", "data de entrega", "data", "entrega", "prazo", "urgencia", "urgencia", "equipe", "time"),
            )
            if user_ref:
                params["user"] = clean_labeled_value(
                    user_ref,
                    ("responsavel", "responsavel", "usuario", "usuario", "atribuir para", "designar para", "para"),
                )
            descricao = extract_free_text_after(text, ("tarefa", "criar", "adicionar"))
            if descricao and _normalize(descricao) not in {"tarefa", "nova tarefa", "criar tarefa", "adicionar tarefa"}:
                params["nome"] = remove_assignee_tail(remove_team_tail(clean_labeled_value(descricao, ("nome", "chamada", "titulo", "título"))))

        if cmd.key == "create_task":
            labeled_nome = extract_labeled_segment(
                text,
                ("nome da tarefa", "titulo da tarefa", "título da tarefa", "nome", "titulo", "título"),
                ("descricao detalhada", "descrição detalhada", "descricao", "descrição", "detalhes", "detalhe", "dataentrega", "data entrega", "data de entrega", "data", "entrega", "prazo", "urgencia", "urgência", "equipe", "time", "responsavel", "responsável"),
            )
            if labeled_nome:
                params["nome"] = clean_labeled_value(labeled_nome, ("nome da tarefa", "titulo da tarefa", "título da tarefa", "nome", "chamada", "titulo", "título"))
            if params.get("nome"):
                params["nome"] = remove_task_detail_tail(params["nome"])

        if params.get("equipe") and not OBJ_ID_RE.fullmatch(params["equipe"]):
            params["equipe"] = clean_team_ref(params["equipe"])
        if params.get("team_id") and not OBJ_ID_RE.fullmatch(params["team_id"]):
            params["team_id"] = clean_team_ref(params["team_id"])

        return params
