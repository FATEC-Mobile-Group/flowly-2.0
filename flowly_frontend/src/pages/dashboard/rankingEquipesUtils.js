// Ranking do Painel Geral: agrupa as tarefas ja carregadas pela tela. Nao consulta a API.

export const LIMITE_RANKING = 5;

const nomes = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

const taxaConclusao = (equipe) => (equipe.total > 0 ? equipe.concluidas / equipe.total : 0);

const compararIds = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const compararNomes = (a, b) => nomes.compare(a.nome, b.nome) || compararIds(a, b);

// Concluidas decide; empates caem para taxa de conclusao, volume, em andamento e por fim o nome.
export const compararEquipes = (a, b) =>
  b.concluidas - a.concluidas
  || taxaConclusao(b) - taxaConclusao(a)
  || b.total - a.total
  || b.emAndamento - a.emAndamento
  || compararNomes(a, b);

export const percentualConcluido = (equipe) => Math.round(taxaConclusao(equipe) * 100);

export function montarRankingEquipes(equipes, tarefas) {
  const porEquipe = new Map();

  (Array.isArray(equipes) ? equipes : []).forEach((equipe, indice) => {
    const id = equipe?._id != null ? String(equipe._id) : `sem-id-${indice}`;
    porEquipe.set(id, {
      id,
      nome: equipe?.nome || 'Equipe sem nome',
      total: 0,
      concluidas: 0,
      emAndamento: 0,
      pendentes: 0,
    });
  });

  (Array.isArray(tarefas) ? tarefas : []).forEach((tarefa) => {
    const equipeId = tarefa?.equipe?._id;
    const equipe = equipeId != null ? porEquipe.get(String(equipeId)) : undefined;
    if (!equipe) return;

    equipe.total += 1;
    if (tarefa.status === 'concluido') equipe.concluidas += 1;
    else if (tarefa.status === 'em_andamento') equipe.emAndamento += 1;
    else if (tarefa.status === 'pendente') equipe.pendentes += 1;
  });

  const todas = [...porEquipe.values()];
  const comTarefas = todas.filter((equipe) => equipe.total > 0).sort(compararEquipes);
  const semTarefas = todas.filter((equipe) => equipe.total === 0).sort(compararNomes);

  return {
    comTarefas,
    semTarefas,
    totalEquipes: todas.length,
    haConcluidas: comTarefas.some((equipe) => equipe.concluidas > 0),
  };
}
