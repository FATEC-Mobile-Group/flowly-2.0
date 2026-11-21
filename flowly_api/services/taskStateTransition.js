// Transicao condicional do status/cronometro de uma tarefa (fluxos legados de PUT /:id/status e /:id/cronometro).
//
// Em vez de save() sobre um documento possivelmente desatualizado (que grava $set absolutos calculados a partir de
// uma leitura antiga), cada tentativa: le a tarefa, calcula a transicao, e grava com updateOne condicionado aos
// campos lidos que a transicao usou. matchedCount 0 = outra escrita mudou a tarefa entre a leitura e a gravacao:
// rele, revalida o responsavel, recalcula e tenta de novo, no maximo MAX_TENTATIVAS vezes.
//
// As partes puras (criterios, calculo da pausa, montagem do update) nao dependem do fluxo legado e podem ser
// reaproveitadas pelo caminho com Idempotency-Key, dentro de transacao.
const Tarefa = require('../models/Tarefa');

// 3 tentativas: um conflito exige outra escrita confirmada na mesma tarefa entre a nossa leitura e a nossa gravacao
// (janela de milissegundos, numa tarefa de um unico responsavel). Duas seguidas ja sao raras; tres indicam disputa
// anormal, e o cliente recebe 409 em vez de a requisicao ficar presa num laco.
const MAX_TENTATIVAS = 3;

class TaskTransitionConflictError extends Error {
  constructor(tentativas) {
    super(`Transicao da tarefa em conflito apos ${tentativas} tentativas`);
    this.name = 'TaskTransitionConflictError';
    this.tentativas = tentativas;
  }
}

// Campo ausente no banco chega ao documento Mongoose com o padrao do schema (status 'pendente', tempoGasto 0,
// cronometroAtivo/tempoExcedido false); tempoEstimado nao tem padrao. Os criterios aceitam o valor lido E as formas
// que o codigo legado trata como iguais a ele (ausente/null), senao um documento antigo nunca casaria.
const criterioBooleano = (valor) => (valor === true ? true : { $ne: true });
const criterioNumero = (valor) => (valor == null || valor === 0 ? { $in: [0, null] } : valor);
const criterioStatus = (valor) => (valor == null || valor === 'pendente' ? { $in: ['pendente', null] } : valor);

const inicioValido = (valor) => valor instanceof Date && Number.isFinite(valor.getTime());

// Estado lido que a transicao usou. Com o cronometro ativo, a pausa depende do instante de inicio, do tempo
// acumulado e do estimado (tempoExcedido): todos entram na condicao. Inativo, esses campos nao afetam a transicao.
const montarCondicao = (tarefa, userId) => {
  const condicao = {
    _id: tarefa._id,
    user: userId, // reatribuida no meio do caminho: o responsavel anterior nao grava
    status: criterioStatus(tarefa.status),
    cronometroAtivo: criterioBooleano(tarefa.cronometroAtivo),
  };
  if (tarefa.cronometroAtivo) {
    condicao.ultimaAtualizacaoCronometro = inicioValido(tarefa.ultimaAtualizacaoCronometro)
      ? tarefa.ultimaAtualizacaoCronometro
      : { $not: { $type: 'date' } }; // ausente, nulo ou invalido (so chega aqui sem pausa: status -> em_andamento)
    condicao.tempoGasto = criterioNumero(tarefa.tempoGasto);
    condicao.tempoEstimado = criterioNumero(tarefa.tempoEstimado);
    condicao.tempoExcedido = criterioBooleano(tarefa.tempoExcedido);
  }
  return condicao;
};

// Cronometro ativo cujo inicio nao permite contar o tempo: a pausa (manual ou por status) e recusada inteira, sem
// gravar nada, em vez de encerrar o cronometro com 0 minuto e perder o tempo trabalhado em silencio.
class TaskTimerInconsistentError extends Error {
  constructor(motivo, tarefaId) {
    super(`Cronometro inconsistente: ${motivo}`);
    this.name = 'TaskTimerInconsistentError';
    this.motivo = motivo; // 'inicio_ausente' | 'inicio_invalido' | 'inicio_no_futuro'
    this.tarefaId = tarefaId;
  }
}

// Tolerancia para inicio no futuro: menos de 1 minuto, a unidade de contagem. O inicio e gravado com o relogio da
// instancia que iniciou e a pausa usa o da instancia que pausa; uma diferenca pequena entre elas deixaria o inicio
// alguns segundos "no futuro" e o floor viraria -1, recusando uma pausa legitima feita logo depois do inicio. Abaixo
// de 1 minuto, contar 0 e o mesmo resultado que o floor ja daria para qualquer duracao real menor que 1 minuto, entao
// a tolerancia nao inventa tempo alem do arredondamento ja aceito. A partir de 1 minuto no futuro, nao ha leitura
// confiavel: recusa.
const TOLERANCIA_INICIO_FUTURO_MS = 60 * 1000;

const motivoInicioInconsistente = (inicio, agora) => {
  if (inicio === undefined || inicio === null) return 'inicio_ausente'; // ausente, nulo ou nao convertido pelo Mongoose
  if (!inicioValido(inicio)) return 'inicio_invalido';
  if (inicio.getTime() - agora.getTime() >= TOLERANCIA_INICIO_FUTURO_MS) return 'inicio_no_futuro';
  return null;
};

// Pausa: minutos inteiros (floor) desde o inicio, somados ao acumulado; tempoExcedido pela regra de sempre.
// Inicio ausente/invalido ou no futuro alem da tolerancia: TaskTimerInconsistentError (nada e gravado).
// Acumulado armazenado invalido e erro real (500), nao algo a corrigir em silencio: ausente vira o padrao 0 na
// leitura e null conta como 0 (como no codigo legado); undefined so aparece quando o Mongoose nao conseguiu converter
// o valor gravado. Nada nao finito (NaN/Infinity) chega ao update.
const calcularPausa = (tarefa, agora) => {
  const inicio = tarefa.ultimaAtualizacaoCronometro;
  const motivo = motivoInicioInconsistente(inicio, agora);
  if (motivo) {
    throw new TaskTimerInconsistentError(motivo, tarefa._id);
  }
  const minutos = Math.max(Math.floor((agora.getTime() - inicio.getTime()) / 60000), 0); // dentro da tolerancia: 0
  const base = tarefa.tempoGasto === null ? 0 : tarefa.tempoGasto;
  if (typeof base !== 'number' || !Number.isFinite(base)) {
    throw new Error('Tempo gasto armazenado invalido');
  }
  const tempoGasto = base + minutos;
  if (!Number.isFinite(tempoGasto)) {
    throw new Error('Tempo gasto calculado invalido');
  }
  const set = { tempoGasto, cronometroAtivo: false };
  if (tarefa.tempoEstimado && tempoGasto > tarefa.tempoEstimado) {
    set.tempoExcedido = true;
  }
  return { minutos, set };
};

const mesmoValor = (a, b) => {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
};

// Update com so os campos da transicao. updatedAt so muda quando algum campo muda de fato, como no save() antigo
// (que nao gravava nada quando nada mudava); timestamps desligado no updateOne para o valor ser exatamente este.
const montarUpdate = (tarefa, { set, unset = [] }, agora) => {
  const $set = { ...set };
  const mudou = unset.some((campo) => tarefa[campo] != null) ||
    Object.entries(set).some(([campo, valor]) => !mesmoValor(tarefa[campo], valor));
  if (mudou) {
    $set.updatedAt = agora;
  }
  const update = { $set };
  if (unset.length > 0) {
    update.$unset = Object.fromEntries(unset.map((campo) => [campo, '']));
  }
  return update;
};

// O documento lido passa a refletir exatamente o que foi confirmado (resposta montada como antes, sem nova leitura).
const aplicarNoDocumento = (tarefa, update) => {
  Object.entries(update.$set || {}).forEach(([campo, valor]) => { tarefa[campo] = valor; });
  Object.keys(update.$unset || {}).forEach((campo) => { tarefa[campo] = undefined; });
};

// ler(): consulta a tarefa ja filtrada pelo responsavel (null = sem acesso). calcular(tarefa, agora): devolve
// { erro } (recusa de negocio, ex.: 400) ou { set, unset?, ...dados }. Retorna:
//   { tipo: 'sem_acesso' } | { tipo: 'recusada', erro } | { tipo: 'aplicada', tarefa, transicao, tentativas }.
// Erro do banco sobe sem virar conflito; so matchedCount 0 conta como conflito.
const executarTransicao = async ({ ler, calcular, userId, maxTentativas = MAX_TENTATIVAS }) => {
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa += 1) {
    const tarefa = await ler();
    if (!tarefa) {
      return { tipo: 'sem_acesso' };
    }
    const agora = new Date(); // a cada tentativa: o tempo sai da leitura e do instante desta tentativa
    const transicao = calcular(tarefa, agora);
    if (transicao.erro) {
      return { tipo: 'recusada', erro: transicao.erro };
    }
    const update = montarUpdate(tarefa, transicao, agora);
    const resultado = await Tarefa.updateOne(montarCondicao(tarefa, userId), update, {
      timestamps: false,
      runValidators: true,
    });
    if (!resultado || typeof resultado.matchedCount !== 'number') {
      throw new Error('Gravacao da tarefa sem confirmacao do banco');
    }
    if (resultado.matchedCount === 1) {
      aplicarNoDocumento(tarefa, update);
      return { tipo: 'aplicada', tarefa, transicao, tentativas: tentativa };
    }
  }
  throw new TaskTransitionConflictError(maxTentativas);
};

module.exports = {
  MAX_TENTATIVAS,
  TaskTransitionConflictError,
  TaskTimerInconsistentError,
  TOLERANCIA_INICIO_FUTURO_MS,
  montarCondicao,
  calcularPausa,
  montarUpdate,
  executarTransicao,
};
