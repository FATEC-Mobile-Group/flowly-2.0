// Metadados das consultas de tarefas do assistente (campo opcional `query` da resposta de /api/v1/messages).
// Contrato: flowly_assistente/flowly_assistant/task_queries.py (metadata). Qualquer coisa fora do formato
// esperado e descartada: sem `query` valido a mensagem continua so com reply_text.

export const QUERY_TYPES = new Set([
  'today', 'tomorrow', 'overdue', 'week', 'next_week', 'upcoming', 'pending', 'summary',
]);

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
const URGENCIES = new Set(['alta', 'media', 'baixa']);

export const STATUS_LABELS = {
  pendente: 'Não iniciada',
  em_andamento: 'Em andamento',
  concluido: 'Concluída',
};

export const URGENCY_LABELS = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };

const validDay = (value) => {
  if (typeof value !== 'string') return null;
  const match = DAY_RE.exec(value);
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? value : null;
};

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

const parseTask = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const titulo = text(raw.titulo);
  if (!titulo) return null;
  const id = typeof raw.id === 'string' && OBJECT_ID_RE.test(raw.id) ? raw.id : null;
  const status = typeof raw.status === 'string' ? raw.status : 'pendente';
  return {
    id,
    titulo,
    status,
    dataEntrega: validDay(raw.dataEntrega),
    urgencia: URGENCIES.has(raw.urgencia) ? raw.urgencia : null,
    equipe: text(raw.equipe),
  };
};

// Consulta valida ou null. Itens sem titulo sao ignorados; total nunca fica menor que os itens recebidos.
export function parseAssistantQuery(raw) {
  if (!raw || typeof raw !== 'object' || !QUERY_TYPES.has(raw.type)) return null;
  const today = validDay(raw.today);
  if (!today || !Array.isArray(raw.tasks)) return null;
  const tasks = raw.tasks.map(parseTask).filter(Boolean);
  const total = Number.isInteger(raw.total) && raw.total >= tasks.length ? raw.total : tasks.length;
  return { type: raw.type, today, total, tasks };
}

const dayNumber = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

export const formatDay = (day) => {
  const [, m, d] = day.split('-');
  return `${d}/${m}`;
};

// Prazo relativo ao "hoje" informado pelo proprio assistente (mesmo fuso usado no filtro).
export function describeDeadline(task, today) {
  if (!task.dataEntrega) return 'Sem prazo';
  const diff = dayNumber(task.dataEntrega) - dayNumber(today);
  if (diff === 0) return 'Vence hoje';
  if (diff === 1) return 'Vence amanhã';
  if (diff === -1) return 'Venceu ontem';
  if (diff < 0) return `Venceu há ${-diff} dias`;
  return `Vence em ${formatDay(task.dataEntrega)}`;
}

export const isOverdue = (task, today) =>
  task.status !== 'concluido' && Boolean(task.dataEntrega) && task.dataEntrega < today;

// Indicadores do resumo do dia: so quando a lista recebida esta completa (total == itens).
export function summaryCounts(query) {
  if (query.type !== 'summary' || query.total !== query.tasks.length) return null;
  const counts = { overdue: 0, today: 0, upcoming: 0 };
  query.tasks.forEach((task) => {
    if (!task.dataEntrega) return;
    if (task.dataEntrega < query.today) counts.overdue += 1;
    else if (task.dataEntrega === query.today) counts.today += 1;
    else counts.upcoming += 1;
  });
  return counts;
}

// O reply_text das listagens termina com "1. ...; 2. ..." e a dica de selecao. Com os cartoes na tela, mostra so
// a introducao (contagens, status, mais urgente) e a dica; sem lista reconhecivel, o texto inteiro.
export function splitReplyText(replyText) {
  const full = String(replyText || '').trim();
  const start = full.search(/(^|\s)1\.\s/);
  if (start <= 0) return { intro: full, hint: '', listed: false };
  const hintMatch = full.slice(start).match(/Você pode pedir detalhes[^.]*\./);
  return { intro: full.slice(0, start).trim(), hint: hintMatch ? hintMatch[0] : '', listed: true };
}
