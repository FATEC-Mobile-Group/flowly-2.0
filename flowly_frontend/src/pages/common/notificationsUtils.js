// Central de notificacoes: categorias, apresentacao dos alertas, pesquisa, filtros e agrupamento por data, sobre a
// lista ja carregada (GET /notificacoes: as 100 mais recentes). Nada aqui grava ou altera registros.
import { correspondeBusca } from '../admin/adminFiltrosUtils';
import { chaveDiaLocal, diferencaEmDias } from '../dashboard/painelGeralUtils';
import { NOTIFICATION_TYPE_LABELS } from '../../utils/navigationRequests';

export const LIMITE_LISTA_API = 100; // notificationController.listarNotificacoes: .limit(100)

// Categorias que existem no backend: o tipo (task, chat, team, system) e, dentro de system, o alerta de equipe
// (metadata.kind 'team_insight_alert', enviado so a administradores).
export const CATEGORIA_ALERTA = 'alerta';
export const CATEGORIAS = [
  { valor: 'task', rotulo: 'Tarefas' },
  { valor: 'chat', rotulo: 'Mensagens' },
  { valor: 'team', rotulo: 'Equipes' },
  { valor: CATEGORIA_ALERTA, rotulo: 'Alertas de moderação', somenteAdmin: true },
  { valor: 'system', rotulo: 'Sistema' },
];
export const STATUS_LEITURA = [
  { valor: '', rotulo: 'Todas' },
  { valor: 'nao_lidas', rotulo: 'Não lidas' },
  { valor: 'lidas', rotulo: 'Lidas' },
];

const metadataDe = (notificacao) =>
  (notificacao?.metadata && typeof notificacao.metadata === 'object' ? notificacao.metadata : {});

export const ehAlerta = (notificacao) =>
  notificacao?.tipo === 'system' && metadataDe(notificacao).kind === 'team_insight_alert';

export function categoriaDe(notificacao) {
  if (ehAlerta(notificacao)) return CATEGORIA_ALERTA;
  return ['task', 'chat', 'team'].includes(notificacao?.tipo) ? notificacao.tipo : 'system';
}

// ------------------------------------------------------------------------------------------------------------
// Alertas. Mesma gravidade textual e escopos dos Insights (PR #64): high = Alto, medium = Moderado, low = Atencao.

const GRAVIDADES = { high: 'Alto', medium: 'Moderado', low: 'Atenção' };
export const ESCOPOS = { individual: 'Individual', coletivo: 'Coletivo', historico: 'Histórico sem escopo' };

// Notificacoes antigas (e as coletivas atuais) terminam com "Risco N%." - um percentual heuristico, nao uma
// probabilidade. So esse trecho final, exatamente nesse formato, e removido; o resto da mensagem fica igual.
const PERCENTUAL_DE_RISCO = /\s*Risco\s+\d{1,3}(?:[.,]\d+)?\s?%\.?\s*$/i;
export const removerPercentualDeRisco = (texto) => String(texto ?? '').replace(PERCENTUAL_DE_RISCO, '').trim();

// Alertas historicos (sem metadata.scope) foram gravados antes da separacao individual x coletivo; o formato
// "Alerta de comportamento na equipe X: <pessoa> teve ..." citava a pessoa sem vinculo confiavel. So os formatos
// historicos sem nomes sao exibidos como estao; os demais viram um texto generico (o registro nao e alterado).
const HISTORICOS_SEM_NOME = [/^Alerta critico na equipe /i, /^Acompanhamento recomendado na equipe /i];
const HISTORICO_COM_PESSOA = /^Alerta de comportamento na equipe (.+?): /i;

function textoDoHistorico(texto) {
  const limpo = removerPercentualDeRisco(texto);
  if (HISTORICOS_SEM_NOME.some((formato) => formato.test(limpo))) return limpo;
  const comPessoa = HISTORICO_COM_PESSOA.exec(limpo);
  if (comPessoa) {
    return `Alerta de comportamento na equipe ${comPessoa[1]}: sinais de linguagem inadequada ou bloqueios recorrentes de um participante.`;
  }
  return 'Alerta registrado antes da classificação por escopo. Abra o alerta para ver a equipe e as ocorrências.';
}

export function apresentarAlerta(notificacao) {
  const metadata = metadataDe(notificacao);
  const escopo = metadata.scope === 'user' ? 'individual' : metadata.scope === 'team' ? 'coletivo' : 'historico';
  const codigo = Object.prototype.hasOwnProperty.call(GRAVIDADES, metadata.alertLevel) ? metadata.alertLevel : null;
  const texto = escopo === 'historico' ? textoDoHistorico(notificacao?.texto) : removerPercentualDeRisco(notificacao?.texto);
  return { escopo, rotuloEscopo: ESCOPOS[escopo], gravidade: codigo ? { codigo, rotulo: GRAVIDADES[codigo] } : null, texto };
}

// Titulo e texto exibidos (a pesquisa usa o mesmo texto: nada suprimido volta pela busca).
export function apresentarNotificacao(notificacao) {
  const categoria = categoriaDe(notificacao);
  if (categoria === CATEGORIA_ALERTA) {
    const alerta = apresentarAlerta(notificacao);
    return { categoria, titulo: `Alerta ${alerta.rotuloEscopo.toLowerCase()}`, texto: alerta.texto, alerta };
  }
  return {
    categoria,
    titulo: NOTIFICATION_TYPE_LABELS[notificacao?.tipo] || NOTIFICATION_TYPE_LABELS.system,
    texto: String(notificacao?.texto ?? ''),
    alerta: null,
  };
}

// ------------------------------------------------------------------------------------------------------------
// Datas: hoje, ontem e anteriores pelo dia local de quem olha. Sem data valida: "anteriores", no fim.

const instante = (valor) => {
  const tempo = new Date(valor ?? '').getTime();
  return Number.isFinite(tempo) ? tempo : null;
};

export const GRUPOS = [
  { chave: 'hoje', rotulo: 'Hoje' },
  { chave: 'ontem', rotulo: 'Ontem' },
  { chave: 'anteriores', rotulo: 'Anteriores' },
];

export function grupoDaData(valor, hoje) {
  const tempo = instante(valor);
  if (tempo === null) return 'anteriores';
  const dias = diferencaEmDias(chaveDiaLocal(new Date(tempo)), hoje);
  if (dias <= 0) return 'hoje';
  return dias === 1 ? 'ontem' : 'anteriores';
}

export function formatarHorario(valor, hoje) {
  const tempo = instante(valor);
  if (tempo === null) return 'Data indisponível';
  const hora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(tempo);
  if (grupoDaData(valor, hoje) !== 'anteriores') return hora;
  return `${new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(tempo)} às ${hora}`;
}

export const ordenarRecentes = (lista) => [...lista].sort((a, b) => {
  const ta = instante(a?.createdAt);
  const tb = instante(b?.createdAt);
  if (ta === null || tb === null) return ta === tb ? 0 : ta === null ? 1 : -1;
  return tb - ta;
});

export const FILTROS_PADRAO = { busca: '', status: '', categoria: '' };

export function filtrarNotificacoes(lista, filtros) {
  return ordenarRecentes((Array.isArray(lista) ? lista : []).filter(Boolean))
    .filter((n) => !filtros.status || (filtros.status === 'lidas' ? Boolean(n.lida) : !n.lida))
    .filter((n) => !filtros.categoria || categoriaDe(n) === filtros.categoria)
    .filter((n) => {
      const { titulo, texto } = apresentarNotificacao(n);
      return correspondeBusca([titulo, texto], filtros.busca);
    });
}

export function agruparPorData(lista, hoje) {
  const grupos = new Map(GRUPOS.map((grupo) => [grupo.chave, []]));
  lista.forEach((n) => grupos.get(grupoDaData(n.createdAt, hoje)).push(n));
  return GRUPOS.map((grupo) => ({ ...grupo, itens: grupos.get(grupo.chave) })).filter((grupo) => grupo.itens.length > 0);
}

// Junta listas pelo _id (a primeira vence): resposta da API + notificacoes recebidas pelo socket durante a carga.
export function juntarPorId(...listas) {
  const vistos = new Set();
  const resultado = [];
  listas.flat().forEach((n) => {
    const id = n && n._id != null ? String(n._id) : null;
    if (!id || vistos.has(id)) return;
    vistos.add(id);
    resultado.push(n);
  });
  return resultado;
}
