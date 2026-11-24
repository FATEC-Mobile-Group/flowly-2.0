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
// Acumulado confirmado pela API, em segundos: tempoGastoSegundos (preciso) quando a API o envia; tarefa anterior a
// esse campo usa tempoGasto (minutos) * 60, a mesma base historica que a API usa ao pausar.
export const acumuladoEmSegundos = (tarefa) => {
  const preciso = tarefa?.tempoGastoSegundos;
  if (typeof preciso === 'number' && Number.isFinite(preciso) && preciso >= 0) return Math.floor(preciso);
  return Math.max(0, Math.floor((Number(tarefa?.tempoGasto) || 0) * 60));
};

// Ancora para uma sessao que ja chega ativa da API (F5, voltar a pagina): parte da sessao que da para medir neste
// instante (nunca negativa) e dali em diante segue o relogio do navegador. Sem ela, com o relogio do servidor
// adiantado, "agora - inicio" ficava negativo, o piso segurava em zero e o contador parecia parado ate o navegador
// alcancar o horario do servidor. null quando a tarefa nao esta ativa ou o inicio e invalido.
// offsetMs (opcional): estimativa de (relogio do servidor - relogio do navegador) medida neste navegador; corrige a
// parte da sessao anterior ao carregamento. Sem medicao, a estimativa e 0 (o piso em zero continua valendo).
export const ancoraNaCarga = (tarefa, agoraLocal, offsetMs = null) => {
  if (!tarefa?.cronometroAtivo) return null;
  const inicioServidor = new Date(tarefa.ultimaAtualizacaoCronometro).getTime();
  if (!Number.isFinite(inicioServidor)) return null;
  const correcao = Number.isFinite(offsetMs) ? offsetMs : 0;
  const decorrido = Math.max(0, agoraLocal + correcao - inicioServidor);
  return { inicioServidor, inicioLocal: agoraLocal - decorrido };
};

// ---------- Ancoras e diferenca de relogio desta aba (sessionStorage) ----------
// A API nao informa o horario dela (o cabecalho Date nao e exposto pelo CORS e tem precisao de 1 s); o unico
// horario do servidor e o inicio da sessao. Por isso:
// - a ancora de uma sessao fica salva na aba: depois do F5 ou ao trocar de pagina, a mesma sessao continua medida
//   pelo mesmo relogio (sem perder os segundos que o "agora - inicio" com relogios diferentes omitiria);
// - ao iniciar, o servidor grava o inicio entre o envio e a resposta do PUT: inicio - (envio + resposta) / 2 estima
//   a diferenca entre os relogios, com erro de ate metade do tempo de ida e volta. Ela so corrige sessoes que chegam
//   ativas sem ancora salva (iniciadas em outra aba ou aparelho).
// Nada disso e fonte de verdade: o tempo gravado e sempre o que a API calcula na pausa.
const CHAVE_ANCORAS = 'flowly:cronometro-ancoras';
const CHAVE_OFFSET = 'flowly:relogio-offset';
export const INCERTEZA_MAXIMA_OFFSET_MS = 5000;

const lerJson = (chave, padrao) => {
  try {
    const valor = JSON.parse(sessionStorage.getItem(chave) || 'null');
    return valor ?? padrao;
  } catch {
    return padrao;
  }
};
const gravarJson = (chave, valor) => {
  try {
    sessionStorage.setItem(chave, JSON.stringify(valor));
  } catch {
    // Sem sessionStorage (modo privado): vale so a ancora em memoria desta pagina.
  }
};

const ancoraValida = (ancora) => ancora && Number.isFinite(ancora.inicioServidor) && Number.isFinite(ancora.inicioLocal);

export const lerAncoraSalva = (tarefa) => {
  const inicioServidor = new Date(tarefa?.ultimaAtualizacaoCronometro).getTime();
  const salvas = lerJson(CHAVE_ANCORAS, {});
  const ancora = salvas && typeof salvas === 'object' ? salvas[String(tarefa?._id)] : null;
  return ancoraValida(ancora) && ancora.inicioServidor === inicioServidor ? ancora : null;
};

export const salvarAncora = (tarefaId, ancora) => {
  if (!ancoraValida(ancora)) return;
  const salvas = lerJson(CHAVE_ANCORAS, {});
  gravarJson(CHAVE_ANCORAS, { ...(salvas && typeof salvas === 'object' ? salvas : {}), [String(tarefaId)]: ancora });
};

export const removerAncora = (tarefaId) => {
  const salvas = lerJson(CHAVE_ANCORAS, {});
  if (!salvas || typeof salvas !== 'object' || !(String(tarefaId) in salvas)) return;
  const { [String(tarefaId)]: _removida, ...resto } = salvas;
  gravarJson(CHAVE_ANCORAS, resto);
};

// Mantem salvas so as ancoras das sessoes ainda ativas (ids informados).
export const manterAncoras = (idsAtivos) => {
  const salvas = lerJson(CHAVE_ANCORAS, {});
  if (!salvas || typeof salvas !== 'object') return;
  const ativos = new Set([...idsAtivos].map(String));
  const filtradas = Object.fromEntries(Object.entries(salvas).filter(([id]) => ativos.has(id)));
  if (Object.keys(filtradas).length !== Object.keys(salvas).length) gravarJson(CHAVE_ANCORAS, filtradas);
};

// Medicao no inicio confirmado: devolve a ancora local da sessao ((envio + resposta) / 2) e guarda a diferenca
// estimada entre os relogios quando a incerteza e pequena.
export const medirInicio = (inicioServidor, envioLocal, respostaLocal) => {
  const meio = (envioLocal + respostaLocal) / 2;
  const incerteza = Math.max(0, (respostaLocal - envioLocal) / 2);
  if (incerteza <= INCERTEZA_MAXIMA_OFFSET_MS) {
    gravarJson(CHAVE_OFFSET, { offsetMs: inicioServidor - meio, incertezaMs: incerteza });
  }
  return { inicioServidor, inicioLocal: Math.min(meio, respostaLocal) };
};

export const lerOffsetRelogio = () => {
  const medicao = lerJson(CHAVE_OFFSET, null);
  return medicao && Number.isFinite(medicao.offsetMs) && Number.isFinite(medicao.incertezaMs)
    && medicao.incertezaMs <= INCERTEZA_MAXIMA_OFFSET_MS ? medicao.offsetMs : null;
};

// Ancora a usar para uma sessao ativa: a salva desta aba (mesmo inicio) ou uma nova a partir da carga, corrigida
// pela diferenca de relogio medida (quando houver).
export const ancoraDaSessao = (tarefa, agoraLocal) => lerAncoraSalva(tarefa)
  || ancoraNaCarga(tarefa, agoraLocal, lerOffsetRelogio());

export const segundosDoCronometro = (tarefa, agora, ancora) => {
  const base = acumuladoEmSegundos(tarefa);
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
