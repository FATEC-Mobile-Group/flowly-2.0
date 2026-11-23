"""Consultas de tarefas por periodo (somente leitura): hoje, atrasadas, semana, proxima semana, proximos dias,
pendencias e resumo do dia.

Os dados vem SO de GET /api/tarefas/minhas (tarefas do usuario autenticado em equipes que ele acessa; a API aplica a
autorizacao). Aqui so se filtra, ordena e descreve o que a API devolveu: nada e inventado e nada e gravado.

Datas
- dataEntrega e uma data sem hora: web e app enviam "AAAA-MM-DD" e a API guarda meia-noite UTC
  ("2026-11-23T00:00:00.000Z"). O dia civil e o prefixo ISO (mesma regra do Painel Geral e da tela Tarefas);
  converter para o fuso local faria a entrega de hoje parecer de ontem (e "atrasada") no Brasil.
- "Hoje" e o dia civil no fuso da aplicacao: FLOWLY_TIMEZONE (padrao America/Sao_Paulo).

Periodos
- hoje: entrega == hoje. amanha: entrega == hoje + 1.
- atrasadas: nao concluidas com entrega < hoje (concluidas e sem prazo nunca contam).
- semana: semana corrente de segunda a domingo (inclui dias ja passados desta semana).
- proxima semana: segunda a domingo da semana seguinte.
- proximos dias / proximas entregas: de hoje ate hoje + 7 dias (janela movel). Diferente de "esta semana":
  num sabado, "esta semana" termina amanha; "proximos dias" vai ate o sabado seguinte.
- pendencias: todas as nao concluidas.
- resumo: hoje + atrasadas + proximos 7 dias + a tarefa mais importante (regra fixa, ver most_important).
"""

from __future__ import annotations

import os
import re
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Any, Callable, Dict, List, Optional, Tuple

TIMEZONE_ENV = "FLOWLY_TIMEZONE"
DEFAULT_TIMEZONE = "America/Sao_Paulo"
UPCOMING_DAYS = 7
DISPLAY_LIMIT = 10
SPOKEN_LIMIT = 3
METADATA_LIMIT = 50

TASK_QUERY_KEYS = {
    "tasks_today": "today",
    "tasks_tomorrow": "tomorrow",
    "tasks_overdue": "overdue",
    "tasks_week": "week",
    "tasks_next_week": "next_week",
    "tasks_upcoming": "upcoming",
    "tasks_pending": "pending",
    "tasks_summary": "summary",
}
PERIOD_COMMANDS = {period: key for key, period in TASK_QUERY_KEYS.items()}

DONE_STATUS = "concluido"
URGENCY_RANK = {"alta": 3, "media": 2, "baixa": 1}
URGENCY_LABELS = {"alta": "alta", "media": "média", "baixa": "baixa"}
STATUS_LABELS = {"pendente": "não iniciada", "em_andamento": "em andamento", "concluido": "concluída"}

_DAY_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})(?:$|T)")

# Relogio injetavel nos testes.
_now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)  # noqa: E731


def app_timezone() -> Tuple[tzinfo, str]:
    name = str(os.getenv(TIMEZONE_ENV) or "").strip() or DEFAULT_TIMEZONE
    try:
        from zoneinfo import ZoneInfo

        return ZoneInfo(name), name
    except Exception:
        # Sem base de fusos (tzdata) na maquina: Brasilia nao tem horario de verao desde 2019, UTC-03:00 fixo.
        return timezone(timedelta(hours=-3)), DEFAULT_TIMEZONE


def today_local() -> date:
    tz, _name = app_timezone()
    return _now().astimezone(tz).date()


def due_day(task: Dict[str, Any]) -> Optional[date]:
    """Dia civil da entrega (prefixo ISO). Sem prazo ou invalido: None."""
    value = task.get("dataEntrega")
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).date() if value.tzinfo else value.date()
    match = _DAY_RE.match(str(value or "").strip())
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def is_done(task: Dict[str, Any]) -> bool:
    return str(task.get("status") or "").strip() == DONE_STATUS


def _urgency(task: Dict[str, Any]) -> int:
    return URGENCY_RANK.get(str(task.get("urgencia") or "").strip().lower(), 0)


def _title(task: Dict[str, Any]) -> str:
    return str(task.get("descricao") or task.get("titulo") or "Tarefa sem descrição").strip()


def _by_due_then_urgency(task: Dict[str, Any]) -> tuple:
    day = due_day(task)
    return (day or date.max, -_urgency(task), _title(task).lower())


def _by_urgency_then_due(task: Dict[str, Any]) -> tuple:
    day = due_day(task)
    return (-_urgency(task), day or date.max, _title(task).lower())


def week_range(today: date, *, offset_weeks: int = 0) -> Tuple[date, date]:
    monday = today - timedelta(days=today.weekday()) + timedelta(weeks=offset_weeks)
    return monday, monday + timedelta(days=6)


def period_range(period: str, today: date) -> Optional[Tuple[date, date]]:
    if period == "today":
        return today, today
    if period == "tomorrow":
        return today + timedelta(days=1), today + timedelta(days=1)
    if period == "week":
        return week_range(today)
    if period == "next_week":
        return week_range(today, offset_weeks=1)
    if period == "upcoming":
        return today, today + timedelta(days=UPCOMING_DAYS)
    return None


def _tasks(result: Any) -> List[Dict[str, Any]]:
    return [item for item in result if isinstance(item, dict)] if isinstance(result, list) else []


def run_query(period: str, raw_tasks: Any, today: Optional[date] = None) -> Dict[str, Any]:
    """Filtra a lista da API para o periodo. Retorna um dicionario serializavel (vai em `result`)."""
    today = today or today_local()
    tasks = _tasks(raw_tasks)
    open_tasks = [task for task in tasks if not is_done(task)]
    rng = period_range(period, today)
    base: Dict[str, Any] = {
        "type": period,
        "today": today.isoformat(),
        "timezone": app_timezone()[1],
        "range": {"from": rng[0].isoformat(), "to": rng[1].isoformat()} if rng else None,
    }

    if period == "summary":
        overdue = sorted((t for t in open_tasks if (d := due_day(t)) and d < today), key=_by_due_then_urgency)
        due_today = sorted((t for t in open_tasks if due_day(t) == today), key=_by_urgency_then_due)
        upcoming = sorted(
            (t for t in open_tasks if (d := due_day(t)) and today < d <= today + timedelta(days=UPCOMING_DAYS)),
            key=_by_due_then_urgency,
        )
        top = most_important(overdue + due_today)
        return {
            **base,
            "range": {"from": today.isoformat(), "to": (today + timedelta(days=UPCOMING_DAYS)).isoformat()},
            "overdue": overdue,
            "dueToday": due_today,
            "upcoming": upcoming,
            "doneToday": sum(1 for t in tasks if is_done(t) and due_day(t) == today),
            "withoutDueDate": sum(1 for t in open_tasks if due_day(t) is None),
            "mostImportant": top,
            "tasks": overdue + due_today + upcoming,
        }

    if period == "overdue":
        selected = sorted((t for t in open_tasks if (d := due_day(t)) and d < today), key=_by_due_then_urgency)
        done_in_range = 0
    elif period == "pending":
        selected = sorted(open_tasks, key=_by_due_then_urgency)
        done_in_range = 0
    elif rng is not None:
        start, end = rng
        in_range = [t for t in tasks if (d := due_day(t)) and start <= d <= end]
        selected = sorted((t for t in in_range if not is_done(t)), key=_by_urgency_then_due if period == "today" else _by_due_then_urgency)
        done_in_range = sum(1 for t in in_range if is_done(t))
    else:
        raise ValueError(f"periodo desconhecido: {period}")

    result = {**base, "tasks": selected, "doneInRange": done_in_range}
    if period == "upcoming" and not selected:
        later = sorted((t for t in open_tasks if (d := due_day(t)) and d > rng[1]), key=_by_due_then_urgency)
        result["nextAfter"] = later[0] if later else None
    if period == "pending":
        result["withoutDueDate"] = sum(1 for t in selected if due_day(t) is None)
        result["overdueCount"] = sum(1 for t in selected if (d := due_day(t)) and d < today)
    if period == "week":
        result["overdueCount"] = sum(1 for t in selected if (d := due_day(t)) and d < today)
    return result


def most_important(candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Regra fixa: maior urgencia; empate, a entrega mais antiga; depois o nome. So entre atrasadas e de hoje."""
    if not candidates:
        return None
    return sorted(candidates, key=_by_urgency_then_due)[0]


# --- Texto ----------------------------------------------------------------------------------------------------

def _count(n: int, singular: str, plural: str) -> str:
    return f"{n} {singular if n == 1 else plural}"


def _fmt_day(day: Optional[date]) -> str:
    return day.strftime("%d/%m") if day else "sem prazo"


def _deadline(task: Dict[str, Any], today: date) -> str:
    day = due_day(task)
    if day is None:
        return "sem prazo"
    diff = (day - today).days
    if diff == 0:
        return "vence hoje"
    if diff == 1:
        return "vence amanhã"
    if diff == -1:
        return "venceu ontem"
    if diff < 0:
        return f"venceu há {-diff} dias ({_fmt_day(day)})"
    return f"vence em {_fmt_day(day)}"


def _line(task: Dict[str, Any], today: date, *, spoken: bool) -> str:
    parts = [_title(task), STATUS_LABELS.get(str(task.get("status") or "pendente"), "não iniciada"), _deadline(task, today)]
    urgency = URGENCY_LABELS.get(str(task.get("urgencia") or "").strip().lower())
    if urgency and not spoken:
        parts.append(f"urgência {urgency}")
    equipe = task.get("equipe")
    if not spoken and isinstance(equipe, dict) and str(equipe.get("nome") or "").strip():
        parts.append(f"equipe {str(equipe.get('nome')).strip()}")
    return ", ".join(parts)


def _status_breakdown(tasks: List[Dict[str, Any]]) -> str:
    doing = sum(1 for t in tasks if str(t.get("status") or "") == "em_andamento")
    todo = len(tasks) - doing
    if not tasks:
        return ""
    if doing and todo:
        return (f"{_count(doing, 'está em andamento', 'estão em andamento')} e "
                f"{_count(todo, 'ainda não foi iniciada', 'ainda não foram iniciadas')}.")
    if doing:
        return "Todas estão em andamento." if len(tasks) > 1 else "Ela está em andamento."
    return "Nenhuma foi iniciada ainda." if len(tasks) > 1 else "Ela ainda não foi iniciada."


def _listing(tasks: List[Dict[str, Any]], today: date) -> Tuple[str, str]:
    shown = tasks[:DISPLAY_LIMIT]
    display = "; ".join(f"{i}. {_line(t, today, spoken=False)}" for i, t in enumerate(shown, start=1)) + "."
    if len(tasks) > len(shown):
        display += f" Mais {_count(len(tasks) - len(shown), 'tarefa', 'tarefas')} na tela de Tarefas."
    said = " ".join(f"{i}. {_line(t, today, spoken=True)}." for i, t in enumerate(tasks[:SPOKEN_LIMIT], start=1))
    if len(tasks) > SPOKEN_LIMIT:
        said += f" E mais {len(tasks) - SPOKEN_LIMIT} na tela."
    return display, said


def _urgent_note(tasks: List[Dict[str, Any]], today: date) -> str:
    top = sorted(tasks, key=_by_urgency_then_due)[0] if tasks else None
    if top is None or _urgency(top) < URGENCY_RANK["alta"]:
        return ""
    return f"A mais urgente é {_title(top)} ({_deadline(top, today)})."


SELECTION_HINT = "Você pode pedir detalhes de uma delas pelo número."

PERIOD_TEXT = {
    "today": ("para hoje", "Você não tem tarefas previstas para hoje."),
    "tomorrow": ("para amanhã", "Você não tem tarefas previstas para amanhã."),
    "week": ("nesta semana", "Você não tem tarefas abertas com entrega nesta semana."),
    "next_week": ("na próxima semana", "Você não tem tarefas abertas com entrega na próxima semana."),
    "upcoming": ("nos próximos 7 dias", "Você não tem entregas nos próximos 7 dias."),
}


def build_reply(query: Dict[str, Any]) -> Tuple[str, str]:
    """(texto da tela, fala). So com os dados de run_query."""
    period = query["type"]
    today = date.fromisoformat(query["today"])
    tasks: List[Dict[str, Any]] = query.get("tasks") or []

    if period == "summary":
        return _summary_reply(query, today)

    if period == "overdue":
        if not tasks:
            text = "Você não tem tarefas atrasadas."
            return text, text
        header = f"Você tem {_count(len(tasks), 'tarefa atrasada', 'tarefas atrasadas')}."
        extra = " ".join(x for x in (_status_breakdown(tasks), _urgent_note(tasks, today)) if x)
        display, said = _listing(tasks, today)
        return (f"{header} {extra} {display} {SELECTION_HINT}".replace("  ", " "),
                f"{header} {extra} {said}".replace("  ", " "))

    if period == "pending":
        if not tasks:
            text = "Você não tem tarefas pendentes."
            return text, text
        header = f"Você tem {_count(len(tasks), 'tarefa em aberto', 'tarefas em aberto')}."
        notes = []
        if query.get("overdueCount"):
            notes.append(f"{_count(query['overdueCount'], 'está atrasada', 'estão atrasadas')}.")
        if query.get("withoutDueDate"):
            notes.append(f"{_count(query['withoutDueDate'], 'não tem prazo', 'não têm prazo')}.")
        extra = " ".join(notes + [_status_breakdown(tasks)])
        display, said = _listing(tasks, today)
        return f"{header} {extra} {display} {SELECTION_HINT}", f"{header} {extra} {said}"

    label, empty = PERIOD_TEXT[period]
    done = query.get("doneInRange") or 0
    done_note = f" {_count(done, 'tarefa desse período já foi concluída', 'tarefas desse período já foram concluídas')}." if done else ""
    if not tasks:
        text = empty + done_note
        if period == "upcoming" and query.get("nextAfter"):
            nxt = query["nextAfter"]
            text += f" A próxima entrega é {_title(nxt)}, em {_fmt_day(due_day(nxt))}."
        return text, text
    noun = "entrega" if period == "upcoming" else "tarefa"
    header = f"Você tem {_count(len(tasks), noun, noun + 's')} {label}."
    notes = [_status_breakdown(tasks)]
    if period == "week" and query.get("overdueCount"):
        notes.append(f"{_count(query['overdueCount'], 'delas já venceu', 'delas já venceram')}.")
    notes.append(_urgent_note(tasks, today))
    extra = " ".join(x for x in notes if x) + done_note
    display, said = _listing(tasks, today)
    return f"{header} {extra} {display} {SELECTION_HINT}", f"{header} {extra} {said}"


def _summary_reply(query: Dict[str, Any], today: date) -> Tuple[str, str]:
    overdue = query.get("overdue") or []
    due_today = query.get("dueToday") or []
    upcoming = query.get("upcoming") or []
    parts = []
    if due_today:
        parts.append(f"Hoje você tem {_count(len(due_today), 'tarefa', 'tarefas')}: "
                     + ", ".join(_title(t) for t in due_today[:SPOKEN_LIMIT])
                     + (f" e mais {len(due_today) - SPOKEN_LIMIT}" if len(due_today) > SPOKEN_LIMIT else "") + ".")
    else:
        parts.append("Você não tem tarefas previstas para hoje.")
    if query.get("doneToday"):
        parts.append(f"{_count(query['doneToday'], 'tarefa de hoje já foi concluída', 'tarefas de hoje já foram concluídas')}.")
    parts.append(f"{_count(len(overdue), 'tarefa atrasada', 'tarefas atrasadas')}." if overdue else "Nenhuma tarefa atrasada.")
    if upcoming:
        nxt = upcoming[0]
        parts.append(f"Nos próximos 7 dias, {_count(len(upcoming), 'entrega', 'entregas')}; a próxima é "
                     f"{_title(nxt)}, em {_fmt_day(due_day(nxt))}.")
    else:
        parts.append("Nenhuma entrega nos próximos 7 dias.")
    top = query.get("mostImportant")
    if top:
        reason = []
        urgency = URGENCY_LABELS.get(str(top.get("urgencia") or "").strip().lower())
        if urgency:
            reason.append(f"urgência {urgency}")
        reason.append(_deadline(top, today))
        parts.append(f"Prioridade sugerida: {_title(top)} ({', '.join(reason)}).")
    text = " ".join(parts)
    return text, text


def metadata(query: Dict[str, Any]) -> Dict[str, Any]:
    """Representacao segura para a interface: so campos da tarefa ja devolvidos pela API ao proprio usuario."""
    tasks = query.get("tasks") or []
    items = []
    for task in tasks[:METADATA_LIMIT]:
        day = due_day(task)
        equipe = task.get("equipe")
        items.append({
            "id": str(task.get("_id") or ""),
            "titulo": _title(task),
            "status": str(task.get("status") or "pendente"),
            "dataEntrega": day.isoformat() if day else None,
            "urgencia": str(task.get("urgencia") or "") or None,
            "equipe": str(equipe.get("nome")) if isinstance(equipe, dict) and equipe.get("nome") else None,
        })
    return {
        "type": query["type"],
        "today": query["today"],
        "timezone": query["timezone"],
        "range": query.get("range"),
        "total": len(tasks),
        "tasks": items,
    }


def urgent_follow_up(tasks: List[Dict[str, Any]], today: Optional[date] = None) -> Tuple[List[Dict[str, Any]], str, str]:
    """Acompanhamento "e quais sao as mais urgentes?" sobre a lista ja mostrada (sem nova consulta)."""
    today = today or today_local()
    if not tasks:
        text = "A lista anterior não tem tarefas."
        return [], text, text
    best = max(_urgency(t) for t in tasks)
    if best == 0:
        text = "As tarefas da lista anterior não têm urgência informada."
        return [], text, text
    top = sorted((t for t in tasks if _urgency(t) == best), key=_by_due_then_urgency)
    label = {3: "alta", 2: "média", 1: "baixa"}[best]
    prefix = "" if best == 3 else "Nenhuma tem urgência alta. "
    header = f"{prefix}{_count(len(top), 'tarefa tem', 'tarefas têm')} urgência {label}."
    display, said = _listing(top, today)
    return top, f"{header} {display} {SELECTION_HINT}", f"{header} {said}"
