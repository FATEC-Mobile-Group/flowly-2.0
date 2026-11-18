// Calculos do Painel Geral sobre os dados ja carregados (GET /equipes e GET /tarefas). Nao consulta a API.

export const LIMITE_PROXIMAS_ENTREGAS = 5;

const nomes = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

const doisDigitos = (numero) => String(numero).padStart(2, '0');

// Dia civil local ("hoje" de quem esta olhando o painel), no formato AAAA-MM-DD.
export const chaveDiaLocal = (data = new Date()) =>
  `${data.getFullYear()}-${doisDigitos(data.getMonth() + 1)}-${doisDigitos(data.getDate())}`;

const diaExiste = (ano, mes, dia) => {
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
};

// Dia da entrega como foi gravado. O formulario (web e app) envia so a data e a API guarda meia-noite UTC
// ("2026-11-17T00:00:00.000Z"): o dia e o prefixo ISO, como a tela Tarefas ja le (split("T")[0]).
// Ler com getDate() no Brasil (UTC-3) daria o dia anterior.
export const diaDaEntrega = (valor) => {
  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime()) ? null : valor.toISOString().slice(0, 10);
  }
  if (typeof valor !== 'string') return null;

  const texto = valor.trim();
  const partes = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(texto);
  if (!partes || Number.isNaN(new Date(texto).getTime())) return null;
  const [, ano, mes, dia] = partes;
  return diaExiste(Number(ano), Number(mes), Number(dia)) ? `${ano}-${mes}-${dia}` : null;
};

const paraUTC = (chave) => {
  const [ano, mes, dia] = chave.split('-').map(Number);
  return Date.UTC(ano, mes - 1, dia);
};

// Dias de "de" ate "ate" (negativo se "ate" vem antes). Feito em UTC: sem efeito de horario de verao.
export const diferencaEmDias = (de, ate) => Math.round((paraUTC(ate) - paraUTC(de)) / 86400000);

export const formatarDia = (chave) => {
  const [ano, mes, dia] = chave.split('-');
  return `${dia}/${mes}/${ano}`;
};

export const estaConcluida = (tarefa) => tarefa?.status === 'concluido';

export const estaAtrasada = (tarefa, hoje) => {
  if (!tarefa || estaConcluida(tarefa)) return false;
  const dia = diaDaEntrega(tarefa.dataEntrega);
  return dia !== null && dia < hoje;
};

export const descreverPrazo = (dia, hoje) => {
  const dias = diferencaEmDias(hoje, dia);
  if (dias === 0) return 'Vence hoje';
  if (dias === 1) return 'Vence amanhã';
  if (dias === -1) return 'Venceu ontem';
  if (dias < 0) return `Venceu há ${-dias} dias`;
  return `Vence em ${dias} dias`;
};

// 646 -> "10h 46min". Arredonda para o minuto; valores invalidos ou negativos contam como zero.
export const formatarTempo = (minutos) => {
  const numero = Number(minutos);
  const total = Number.isFinite(numero) && numero > 0 ? Math.round(numero) : 0;
  const horas = Math.floor(total / 60);
  const resto = total % 60;
  if (horas === 0) return `${resto}min`;
  if (resto === 0) return `${horas}h`;
  return `${horas}h ${resto}min`;
};

export const idDaEquipe = (equipe) => (equipe?._id != null ? String(equipe._id) : null);

export const ordenarEquipesPorNome = (equipes) =>
  [...equipes].sort((a, b) => nomes.compare(a?.nome || '', b?.nome || '') || String(a?._id).localeCompare(String(b?._id)));

// So aceita equipe que veio da API: um id desconhecido (ou que sumiu apos atualizar) volta para "todas".
export function filtrarPorEquipe(equipes, tarefas, equipeId) {
  const listaEquipes = Array.isArray(equipes) ? equipes : [];
  const listaTarefas = Array.isArray(tarefas) ? tarefas : [];
  const id = equipeId ? String(equipeId) : '';
  const equipe = id ? listaEquipes.find((item) => idDaEquipe(item) === id) : undefined;

  if (!equipe) {
    return { equipeId: '', equipes: listaEquipes, tarefas: listaTarefas };
  }
  return {
    equipeId: id,
    equipes: [equipe],
    tarefas: listaTarefas.filter((tarefa) => idDaEquipe(tarefa?.equipe) === id),
  };
}

export const contarPorStatus = (tarefas) => [
  tarefas.filter((t) => t?.status === 'pendente').length,
  tarefas.filter((t) => t?.status === 'em_andamento').length,
  tarefas.filter((t) => t?.status === 'concluido').length,
];

// Total, concluidas e tempo seguem exatamente os calculos anteriores do painel.
export function calcularIndicadores(equipes, tarefas, hoje) {
  const totalTarefas = tarefas.length;
  const concluidas = tarefas.filter((t) => t?.status === 'concluido').length;
  const tempoMinutos = tarefas.reduce((acc, t) => acc + (t?.tempoGasto || 0), 0);
  const idsComTarefas = new Set(tarefas.map((t) => idDaEquipe(t?.equipe)).filter(Boolean));

  return {
    equipes: equipes.length,
    equipesComTarefas: equipes.filter((equipe) => idsComTarefas.has(idDaEquipe(equipe))).length,
    totalTarefas,
    concluidas,
    emAberto: totalTarefas - concluidas,
    percentualConcluido: totalTarefas > 0 ? Math.round((concluidas / totalTarefas) * 100) : 0,
    atrasadas: tarefas.filter((t) => estaAtrasada(t, hoje)).length,
    tempoMinutos,
    tempoFormatado: formatarTempo(tempoMinutos),
  };
}

// Tarefas nao concluidas com prazo valido, da entrega mais antiga (atrasadas primeiro) para a mais distante.
export function listarProximasEntregas(tarefas, hoje, limite = LIMITE_PROXIMAS_ENTREGAS) {
  const elegiveis = tarefas
    .filter((tarefa) => tarefa && !estaConcluida(tarefa))
    .map((tarefa, indice) => ({ tarefa, indice, dia: diaDaEntrega(tarefa.dataEntrega) }))
    .filter(({ dia }) => dia !== null)
    .sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0)
      || nomes.compare(a.tarefa.descricao || '', b.tarefa.descricao || '')
      || String(a.tarefa._id ?? a.indice).localeCompare(String(b.tarefa._id ?? b.indice)));

  return {
    total: elegiveis.length,
    itens: elegiveis.slice(0, limite).map(({ tarefa, indice, dia }) => ({
      id: tarefa._id != null ? String(tarefa._id) : `sem-id-${indice}`,
      descricao: tarefa.descricao || 'Tarefa sem descrição',
      equipe: tarefa.equipe?.nome || 'Equipe não informada',
      dia,
      data: formatarDia(dia),
      prazo: descreverPrazo(dia, hoje),
      atrasada: dia < hoje,
      venceHoje: dia === hoje,
    })),
  };
}
