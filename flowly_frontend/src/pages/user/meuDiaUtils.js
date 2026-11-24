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

// ---------- Cronometro ----------
// tempoGasto (minutos) e o acumulado confirmado pela API; ultimaAtualizacaoCronometro e o inicio da sessao no relogio
// do SERVIDOR. Comparar esse instante com o relogio do navegador mistura dois relogios: com o navegador alguns
// segundos atrasado, a sessao comecava negativa ("-1h -1m -21s" era -21 s formatado com Math.floor).
// ancora: inicio da sessao no relogio do NAVEGADOR, gravado quando o proprio painel confirma o inicio; com ela a
// sessao e medida num relogio so. Sem ancora (pagina recarregada), so resta o horario do servidor: a diferenca de
// relogios nao e mensuravel daqui, entao a sessao nunca fica abaixo de zero (o tempo oficial e o que a API soma na
// pausa).
export const segundosDoCronometro = (tarefa, agora, ancora) => {
  const base = Math.max(0, Number(tarefa?.tempoGasto) || 0) * 60;
  if (!tarefa?.cronometroAtivo) return Math.floor(base);
  const inicioServidor = new Date(tarefa.ultimaAtualizacaoCronometro).getTime();
  if (!Number.isFinite(inicioServidor)) return Math.floor(base);
  const decorrido = ancora && ancora.inicioServidor === inicioServidor
    ? agora - ancora.inicioLocal
    : agora - inicioServidor;
  return Math.floor(base + Math.max(0, Math.floor(decorrido / 1000)));
};

// 3725 -> "1h 2m 5s". Valores invalidos ou negativos contam como zero.
export const formatarDuracao = (segundos) => {
  const total = Number.isFinite(Number(segundos)) ? Math.max(0, Math.floor(Number(segundos))) : 0;
  const horas = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  return `${horas}h ${mins}m ${total % 60}s`;
};

// Avisa outras partes da tela (ex.: FloatingTimer) que o cronometro de uma tarefa mudou na API.
export const EVENTO_CRONOMETRO = 'flowly:cronometro-atualizado';
export const avisarCronometroAtualizado = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENTO_CRONOMETRO));
};

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
