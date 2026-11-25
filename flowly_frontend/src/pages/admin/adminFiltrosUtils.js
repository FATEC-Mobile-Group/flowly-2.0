// Pesquisa, filtros e ordenacao das paginas administrativas (Equipes e Tarefas) sobre os dados ja carregados.
// Nada aqui consulta a API nem autoriza nada: ids da URL so valem se estiverem na lista que a propria tela carregou.
import { diaDaEntrega, diferencaEmDias, estaAtrasada, estaConcluida, formatarDia } from '../dashboard/painelGeralUtils';
import { validObjectId } from '../../utils/navigationRequests';

const DIA_MS = 24 * 60 * 60 * 1000;
const LIMITE_BUSCA = 200;
const colecao = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

export const compararNomes = (a, b) => colecao.compare(a || '', b || '');
const compararIds = (a, b) => String(a?._id ?? '').localeCompare(String(b?._id ?? ''));

// ---------------------------------------------------------------------------------------------------------------
// Busca textual: sem diferenca de maiusculas, minusculas ou acentos; cada termo precisa aparecer em algum campo.

export const normalizarBusca = (texto) => String(texto ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

export function correspondeBusca(campos, busca) {
  const termos = normalizarBusca(busca).split(' ').filter(Boolean);
  if (termos.length === 0) return true;
  const normalizados = campos.map(normalizarBusca).filter(Boolean);
  return termos.every((termo) => normalizados.some((campo) => campo.includes(termo)));
}

const lerBusca = (params) => String(params.get('q') || '').trim().slice(0, LIMITE_BUSCA);

// ---------------------------------------------------------------------------------------------------------------
// Data de criacao (createdAt, um instante real). Nunca usa updatedAt no lugar.

export const instanteValido = (valor) => {
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor.getTime();
  if (typeof valor !== 'string' || valor.trim() === '') return null;
  const tempo = new Date(valor).getTime();
  return Number.isFinite(tempo) ? tempo : null;
};

// Dia civil da criacao no fuso de quem olha (ou no fuso informado). Sem data valida: o texto informado.
export function formatarDataCriacao(valor, semData = 'Data de criação indisponível', timeZone) {
  const tempo = instanteValido(valor);
  if (tempo === null) return semData;
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone }).format(tempo);
}

export const FILTROS_CRIACAO = [
  { valor: '', rotulo: 'Todas' },
  { valor: '7dias', rotulo: 'Últimos 7 dias' },
  { valor: '30dias', rotulo: 'Últimos 30 dias' },
  { valor: 'mais30dias', rotulo: 'Há mais de 30 dias' },
];

// Limites por instante: "ultimos N dias" = criado a partir de agora - N x 24 h (inclusive); "ha mais de 30 dias" =
// antes de agora - 30 x 24 h. Sem createdAt valido, o registro so aparece em "Todas" (nao inventamos a data).
export function correspondeCriacao(createdAt, filtro, agora) {
  if (!filtro) return true;
  const tempo = instanteValido(createdAt);
  if (tempo === null) return false;
  if (filtro === '7dias') return tempo >= agora - 7 * DIA_MS;
  if (filtro === '30dias') return tempo >= agora - 30 * DIA_MS;
  if (filtro === 'mais30dias') return tempo < agora - 30 * DIA_MS;
  return true;
}

// direcao -1: mais recentes primeiro; 1: mais antigas primeiro. Sem data valida fica sempre no fim.
const compararCriacao = (a, b, direcao) => {
  const ta = instanteValido(a);
  const tb = instanteValido(b);
  if (ta === null || tb === null) return ta === tb ? 0 : ta === null ? 1 : -1;
  return ta === tb ? 0 : direcao * (ta < tb ? -1 : 1);
};

const valorPermitido = (lista, valor) => lista.some((opcao) => opcao.valor === valor);

// ---------------------------------------------------------------------------------------------------------------
// Equipes

export const ORDENS_EQUIPES = [
  { valor: 'recentes', rotulo: 'Mais recentes primeiro' },
  { valor: 'antigas', rotulo: 'Mais antigas primeiro' },
  { valor: 'nomeAZ', rotulo: 'Nome (A–Z)' },
  { valor: 'nomeZA', rotulo: 'Nome (Z–A)' },
];
export const ORDEM_PADRAO_EQUIPES = 'recentes';
export const FILTROS_EQUIPES_PADRAO = { busca: '', criacao: '', ordem: ORDEM_PADRAO_EQUIPES };

export function lerFiltrosEquipes(params) {
  const invalidos = [];
  const criacao = params.get('criacao') || '';
  const ordem = params.get('ordem') || ORDEM_PADRAO_EQUIPES;
  const criacaoValida = valorPermitido(FILTROS_CRIACAO, criacao);
  const ordemValida = valorPermitido(ORDENS_EQUIPES, ordem);
  if (!criacaoValida) invalidos.push('data de criação');
  if (!ordemValida) invalidos.push('ordenação');
  return {
    filtros: {
      busca: lerBusca(params),
      criacao: criacaoValida ? criacao : '',
      ordem: ordemValida ? ordem : ORDEM_PADRAO_EQUIPES,
    },
    invalidos,
  };
}

export function serializarFiltrosEquipes({ busca, criacao, ordem }) {
  const params = new URLSearchParams();
  const texto = String(busca || '').trim();
  if (texto) params.set('q', texto);
  if (criacao) params.set('criacao', criacao);
  if (ordem && ordem !== ORDEM_PADRAO_EQUIPES) params.set('ordem', ordem);
  return params;
}

export const equipesComFiltroAtivo = (filtros) => Boolean(filtros.busca || filtros.criacao);

const ordenadorEquipes = {
  recentes: (a, b) => compararCriacao(a?.createdAt, b?.createdAt, -1),
  antigas: (a, b) => compararCriacao(a?.createdAt, b?.createdAt, 1),
  nomeAZ: (a, b) => compararNomes(a?.nome, b?.nome),
  nomeZA: (a, b) => compararNomes(b?.nome, a?.nome),
};

export function filtrarEquipes(equipes, filtros, agora) {
  const lista = Array.isArray(equipes) ? equipes.filter(Boolean) : [];
  const ordenar = ordenadorEquipes[filtros.ordem] || ordenadorEquipes[ORDEM_PADRAO_EQUIPES];
  return lista
    .filter((equipe) => correspondeCriacao(equipe.createdAt, filtros.criacao, agora))
    .filter((equipe) => correspondeBusca([
      equipe.nome,
      ...(equipe.membros || []).flatMap((membro) => [membro?.nome, membro?.email]),
    ], filtros.busca))
    // Desempate estavel: nome e depois id, para a ordem nao mudar entre recarregamentos.
    .sort((a, b) => ordenar(a, b) || compararNomes(a?.nome, b?.nome) || compararIds(a, b));
}

// ---------------------------------------------------------------------------------------------------------------
// Tarefas

export const STATUS_TAREFA = [
  { valor: 'pendente', rotulo: 'Pendente' },
  { valor: 'em_andamento', rotulo: 'Em andamento' },
  { valor: 'concluido', rotulo: 'Concluída' },
];
export const URGENCIAS = [
  { valor: 'alta', rotulo: 'Alta' },
  { valor: 'media', rotulo: 'Média' },
  { valor: 'baixa', rotulo: 'Baixa' },
];
// Ordem explicita: alta > media > baixa. Valor desconhecido fica depois de todas, nas duas direcoes.
const PESO_URGENCIA = { alta: 3, media: 2, baixa: 1 };

const rotuloDe = (lista, valor, desconhecido) => lista.find((opcao) => opcao.valor === valor)?.rotulo || desconhecido;
export const rotuloStatus = (status) => rotuloDe(STATUS_TAREFA, status, 'Status não informado');
export const rotuloUrgencia = (urgencia) => rotuloDe(URGENCIAS, urgencia, 'Não informada');

export const FILTROS_PRAZO = [
  { valor: '', rotulo: 'Todos os prazos' },
  { valor: 'atrasadas', rotulo: 'Atrasadas' },
  { valor: 'hoje', rotulo: 'Vencem hoje' },
  { valor: '7dias', rotulo: 'Próximos 7 dias' },
  { valor: '30dias', rotulo: 'Próximos 30 dias' },
  { valor: 'semPrazo', rotulo: 'Sem prazo' },
];

// O dia do prazo e o dia gravado (diaDaEntrega, sem deslocamento de fuso); "hoje" e o dia local de quem olha.
// Atrasadas, hoje e proximos N dias consideram so tarefas nao concluidas (concluida nunca esta atrasada nem
// "vencendo"). Proximos N dias = de hoje ate hoje + N, inclusive. Sem prazo = data ausente ou invalida.
export function correspondePrazo(tarefa, filtro, hoje) {
  if (!filtro) return true;
  const dia = diaDaEntrega(tarefa?.dataEntrega);
  if (filtro === 'semPrazo') return dia === null;
  if (dia === null || estaConcluida(tarefa)) return false;
  if (filtro === 'atrasadas') return estaAtrasada(tarefa, hoje);
  const dias = diferencaEmDias(hoje, dia);
  if (filtro === 'hoje') return dias === 0;
  if (filtro === '7dias') return dias >= 0 && dias <= 7;
  if (filtro === '30dias') return dias >= 0 && dias <= 30;
  return true;
}

// Situacao do prazo para destacar na tela: so para tarefas nao concluidas com data valida.
export function situacaoPrazo(tarefa, hoje) {
  const dia = diaDaEntrega(tarefa?.dataEntrega);
  if (dia === null || estaConcluida(tarefa)) return null;
  if (dia < hoje) return 'atrasada';
  if (dia === hoje) return 'hoje';
  return null;
}

export const formatarPrazo = (tarefa) => {
  const dia = diaDaEntrega(tarefa?.dataEntrega);
  return dia ? formatarDia(dia) : 'Sem prazo';
};

// Responsavel: populado pela API ({ _id, nome }) ou nulo. Sem usuario = sem responsavel.
export const idDoResponsavel = (tarefa) => {
  const user = tarefa?.user;
  if (user == null) return null;
  const id = typeof user === 'object' ? user._id : user;
  return id == null ? null : String(id);
};
export const semResponsavel = (tarefa) => idDoResponsavel(tarefa) === null;
// Backlog disponivel: pendente e sem responsavel. Nao e um status: e o recorte que o colaborador pode assumir.
export const backlogDisponivel = (tarefa) => semResponsavel(tarefa) && tarefa?.status === 'pendente';

export const ATRIBUICAO_SEM_RESPONSAVEL = 'sem';
export const ATRIBUICAO_BACKLOG = 'backlog';

export const ORDENS_TAREFAS = [
  { valor: 'recentes', rotulo: 'Mais recentes' },
  { valor: 'antigas', rotulo: 'Mais antigas' },
  { valor: 'prazoProximo', rotulo: 'Vencimento mais próximo' },
  { valor: 'prazoDistante', rotulo: 'Vencimento mais distante' },
  { valor: 'urgenciaMaior', rotulo: 'Maior urgência' },
  { valor: 'urgenciaMenor', rotulo: 'Menor urgência' },
  { valor: 'nome', rotulo: 'Nome (A–Z)' },
];
export const ORDEM_PADRAO_TAREFAS = 'recentes';
export const FILTROS_TAREFAS_PADRAO = {
  busca: '',
  equipe: '',
  atribuicao: '',
  status: '',
  urgencia: '',
  prazo: '',
  criacao: '',
  ordem: ORDEM_PADRAO_TAREFAS,
};

export const idDaEquipeDaTarefa = (tarefa) => {
  const equipe = tarefa?.equipe;
  if (equipe == null) return null;
  const id = typeof equipe === 'object' ? equipe._id : equipe;
  return id == null ? null : String(id);
};

// Equipes para o filtro: as de GET /equipes (inclusive sem tarefas) mais as que aparecem nas tarefas, por id.
export function opcoesDeEquipe(equipes, tarefas) {
  const mapa = new Map();
  (Array.isArray(equipes) ? equipes : []).forEach((equipe) => {
    if (equipe?._id != null) mapa.set(String(equipe._id), equipe.nome || 'Equipe sem nome');
  });
  (Array.isArray(tarefas) ? tarefas : []).forEach((tarefa) => {
    const id = idDaEquipeDaTarefa(tarefa);
    if (id && !mapa.has(id)) mapa.set(id, tarefa.equipe?.nome || 'Equipe sem nome');
  });
  return [...mapa].map(([id, nome]) => ({ id, nome }))
    .sort((a, b) => compararNomes(a.nome, b.nome) || a.id.localeCompare(b.id));
}

export function opcoesDeResponsavel(tarefas) {
  const mapa = new Map();
  (Array.isArray(tarefas) ? tarefas : []).forEach((tarefa) => {
    const id = idDoResponsavel(tarefa);
    if (id && !mapa.has(id)) mapa.set(id, tarefa.user?.nome || 'Responsável sem nome');
  });
  return [...mapa].map(([id, nome]) => ({ id, nome }))
    .sort((a, b) => compararNomes(a.nome, b.nome) || a.id.localeCompare(b.id));
}

// contexto: { equipes: Set<id>, responsaveis: Set<id> } das listas carregadas, ou null enquanto carrega (ids com
// formato valido ficam provisorios e nada e marcado como invalido ate os dados chegarem).
// Responsavel, sem responsavel e backlog sao uma unica escolha; com mais de um, vale backlog > sem > responsavel.
export function lerFiltrosTarefas(params, contexto) {
  const invalidos = [];
  const filtros = { ...FILTROS_TAREFAS_PADRAO, busca: lerBusca(params) };

  const aceitarId = (valor, conhecidos, nome) => {
    if (!valor) return '';
    const id = validObjectId(valor);
    if (id && (!contexto || conhecidos.has(id))) return id;
    invalidos.push(nome);
    return '';
  };

  filtros.equipe = aceitarId(params.get('equipe'), contexto?.equipes, 'equipe');

  const backlog = params.get('backlog');
  const sem = params.get('semResponsavel');
  const responsavel = params.get('responsavel');
  if (backlog === '1') {
    filtros.atribuicao = ATRIBUICAO_BACKLOG;
    if (responsavel) invalidos.push('responsável');
  } else if (sem === '1') {
    filtros.atribuicao = ATRIBUICAO_SEM_RESPONSAVEL;
    if (responsavel) invalidos.push('responsável');
  } else {
    filtros.atribuicao = aceitarId(responsavel, contexto?.responsaveis, 'responsável');
  }
  if (backlog !== null && backlog !== '1') invalidos.push('backlog');
  if (sem !== null && sem !== '1') invalidos.push('sem responsável');

  [
    ['status', STATUS_TAREFA, 'status'],
    ['urgencia', URGENCIAS, 'urgência'],
    ['prazo', FILTROS_PRAZO, 'prazo'],
    ['criacao', FILTROS_CRIACAO, 'data de criação'],
  ].forEach(([chave, lista, nome]) => {
    const valor = params.get(chave);
    if (!valor) return;
    if (valorPermitido(lista, valor)) filtros[chave] = valor;
    else invalidos.push(nome);
  });

  const ordem = params.get('ordem');
  if (ordem) {
    if (valorPermitido(ORDENS_TAREFAS, ordem)) filtros.ordem = ordem;
    else invalidos.push('ordenação');
  }

  return { filtros, invalidos };
}

export function serializarFiltrosTarefas(filtros) {
  const params = new URLSearchParams();
  const texto = String(filtros.busca || '').trim();
  if (texto) params.set('q', texto);
  if (filtros.equipe) params.set('equipe', filtros.equipe);
  if (filtros.atribuicao === ATRIBUICAO_SEM_RESPONSAVEL) params.set('semResponsavel', '1');
  else if (filtros.atribuicao === ATRIBUICAO_BACKLOG) params.set('backlog', '1');
  else if (filtros.atribuicao) params.set('responsavel', filtros.atribuicao);
  ['status', 'urgencia', 'prazo', 'criacao'].forEach((chave) => {
    if (filtros[chave]) params.set(chave, filtros[chave]);
  });
  if (filtros.ordem && filtros.ordem !== ORDEM_PADRAO_TAREFAS) params.set('ordem', filtros.ordem);
  return params;
}

export const tarefasComFiltroAtivo = (filtros) => Boolean(
  filtros.busca || filtros.equipe || filtros.atribuicao || filtros.status
  || filtros.urgencia || filtros.prazo || filtros.criacao,
);

function correspondeAtribuicao(tarefa, atribuicao) {
  if (!atribuicao) return true;
  if (atribuicao === ATRIBUICAO_SEM_RESPONSAVEL) return semResponsavel(tarefa);
  if (atribuicao === ATRIBUICAO_BACKLOG) return backlogDisponivel(tarefa);
  return idDoResponsavel(tarefa) === atribuicao;
}

const pesoUrgencia = (tarefa) => PESO_URGENCIA[tarefa?.urgencia] || 0;

// Prazo: datas validas em ordem (direcao 1 = mais proximo primeiro); sem prazo valido sempre no fim.
const compararPrazo = (a, b, direcao) => {
  const da = diaDaEntrega(a?.dataEntrega);
  const db = diaDaEntrega(b?.dataEntrega);
  if (da === null || db === null) return da === db ? 0 : da === null ? 1 : -1;
  return da === db ? 0 : direcao * (da < db ? -1 : 1);
};

const compararUrgencia = (a, b, direcao) => {
  const pa = pesoUrgencia(a);
  const pb = pesoUrgencia(b);
  if (pa === 0 || pb === 0) return pa === pb ? 0 : pa === 0 ? 1 : -1;
  return direcao * (pb - pa);
};

const ordenadorTarefas = {
  recentes: (a, b) => compararCriacao(a?.createdAt, b?.createdAt, -1),
  antigas: (a, b) => compararCriacao(a?.createdAt, b?.createdAt, 1),
  prazoProximo: (a, b) => compararPrazo(a, b, 1) || compararUrgencia(a, b, 1),
  prazoDistante: (a, b) => compararPrazo(a, b, -1) || compararUrgencia(a, b, 1),
  urgenciaMaior: (a, b) => compararUrgencia(a, b, 1) || compararPrazo(a, b, 1),
  urgenciaMenor: (a, b) => compararUrgencia(a, b, -1) || compararPrazo(a, b, 1),
  nome: () => 0,
};

// nomesEquipes: Map id -> nome, para pesquisar pelo nome atual da equipe mesmo que a tarefa traga so o id.
export function filtrarTarefas(tarefas, filtros, { hoje, agora, nomesEquipes } = {}) {
  const lista = Array.isArray(tarefas) ? tarefas.filter(Boolean) : [];
  const ordenar = ordenadorTarefas[filtros.ordem] || ordenadorTarefas[ORDEM_PADRAO_TAREFAS];
  return lista
    .filter((tarefa) => !filtros.equipe || idDaEquipeDaTarefa(tarefa) === filtros.equipe)
    .filter((tarefa) => correspondeAtribuicao(tarefa, filtros.atribuicao))
    .filter((tarefa) => !filtros.status || tarefa.status === filtros.status)
    .filter((tarefa) => !filtros.urgencia || tarefa.urgencia === filtros.urgencia)
    .filter((tarefa) => correspondePrazo(tarefa, filtros.prazo, hoje))
    .filter((tarefa) => correspondeCriacao(tarefa.createdAt, filtros.criacao, agora))
    .filter((tarefa) => correspondeBusca([
      tarefa.descricao,
      tarefa.detalhes,
      tarefa.equipe?.nome || nomesEquipes?.get(idDaEquipeDaTarefa(tarefa)),
      tarefa.user?.nome,
    ], filtros.busca))
    .sort((a, b) => ordenar(a, b) || compararNomes(a?.descricao, b?.descricao) || compararIds(a, b));
}
