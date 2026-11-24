// "Meu Dia" do colaborador: agrupa as tarefas devolvidas por GET /tarefas/minhas (so as do proprio usuario).
// Datas: o dia de entrega e o dia civil gravado (prefixo ISO, diaDaEntrega) e "hoje" e o dia civil local de quem
// olha o painel (chaveDiaLocal) - a mesma semantica do Painel Geral.
//
// Grupos exclusivos (cada tarefa aparece uma unica vez):
//   atrasadas   - nao concluidas com entrega antes de hoje
//   hoje        - nao concluidas com entrega hoje
//   proximas    - nao concluidas com entrega de amanha ate hoje + 7 dias (hoje NAO entra: tem grupo proprio)
//   maisAdiante - nao concluidas com entrega depois de hoje + 7 dias
//   semPrazo    - nao concluidas sem data de entrega valida (nunca contam como atrasadas)
//   concluidas  - separadas das pendencias
import { descreverPrazo, diaDaEntrega, diferencaEmDias, estaConcluida, formatarDia } from '../dashboard/painelGeralUtils';

export const JANELA_PROXIMAS_DIAS = 7;

const PESO_URGENCIA = { alta: 3, media: 2, baixa: 1 };
const nomes = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

const peso = (tarefa) => PESO_URGENCIA[String(tarefa?.urgencia || '').toLowerCase()] || 0;

// Prazo mais antigo primeiro (sem prazo por ultimo); empate: maior urgencia, nome, id.
const porPrazoEUrgencia = (a, b) => {
  if (a.dia !== b.dia) {
    if (!a.dia) return 1;
    if (!b.dia) return -1;
    return a.dia < b.dia ? -1 : 1;
  }
  return (peso(b.tarefa) - peso(a.tarefa))
    || nomes.compare(a.tarefa.descricao || '', b.tarefa.descricao || '')
    || String(a.tarefa._id ?? a.indice).localeCompare(String(b.tarefa._id ?? b.indice));
};

const item = (tarefa, indice, dia, hoje) => ({
  id: tarefa._id != null ? String(tarefa._id) : null,
  tarefa,
  indice,
  dia,
  data: dia ? formatarDia(dia) : null,
  prazo: dia ? descreverPrazo(dia, hoje) : 'Sem prazo',
});

export function organizarMeuDia(tarefas, hoje) {
  const lista = Array.isArray(tarefas) ? tarefas.filter((tarefa) => tarefa && typeof tarefa === 'object') : [];
  const grupos = { atrasadas: [], hoje: [], proximas: [], maisAdiante: [], semPrazo: [], concluidas: [] };

  lista.forEach((tarefa, indice) => {
    const dia = diaDaEntrega(tarefa.dataEntrega);
    const entrada = item(tarefa, indice, dia, hoje);
    if (estaConcluida(tarefa)) {
      grupos.concluidas.push(entrada);
    } else if (!dia) {
      grupos.semPrazo.push(entrada);
    } else {
      const dias = diferencaEmDias(hoje, dia);
      if (dias < 0) grupos.atrasadas.push(entrada);
      else if (dias === 0) grupos.hoje.push(entrada);
      else if (dias <= JANELA_PROXIMAS_DIAS) grupos.proximas.push(entrada);
      else grupos.maisAdiante.push(entrada);
    }
  });

  ['atrasadas', 'hoje', 'proximas', 'maisAdiante', 'semPrazo'].forEach((nome) => grupos[nome].sort(porPrazoEUrgencia));
  // Concluidas: as de entrega mais recente primeiro.
  grupos.concluidas.sort((a, b) => -porPrazoEUrgencia(a, b));

  const pendentes = lista.length - grupos.concluidas.length;
  return {
    ...grupos,
    total: lista.length,
    pendentes,
    indicadores: {
      atrasadas: grupos.atrasadas.length,
      hoje: grupos.hoje.length,
      proximas: grupos.proximas.length,
    },
  };
}
