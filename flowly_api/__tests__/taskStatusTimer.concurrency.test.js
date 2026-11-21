// PUT /api/tarefas/:id/status e /:id/cronometro (fluxos legados): gravacao condicional e concorrencia.
//
// O que e simulado: o banco e um vetor em memoria. findOne devolve um documento Mongoose REAL (hydrate, com os
// padroes do schema para campos ausentes e conversao de tipos de verdade). updateOne passa o filtro e o update pela
// conversao real do Mongoose e depois avalia o filtro e aplica o update de forma atomica (sem await entre a
// avaliacao e a aplicacao), com a semantica do MongoDB para null/ausente, $in, $ne e $not/$type. Ganchos pausam
// uma requisicao entre a leitura e a gravacao, ou mudam o banco logo antes da gravacao, para criar o conflito.
// ActivityLog e Notification usam a validacao dos models reais. Nenhuma conexao real.
const request = require('supertest');
const mongoose = require('mongoose');

jest.setTimeout(30000);

const mockDb = {
  users: [], equipes: [], tarefas: [], logs: [], logErros: [], notifications: [], emits: [], eventos: [], gravacoes: [],
  leituras: 0,
};
const mockHooks = { aposLer: null, antesDeGravar: null, falhaGravacao: null, resultadoGravacao: null };
const mockSame = (a, b) => a != null && b != null && String(a) === String(b);
const mockThenable = (produce) => {
  const query = {
    select: () => query,
    populate: () => query,
    session: () => query,
    then: (resolve, reject) => Promise.resolve().then(produce).then(resolve, reject),
  };
  return query;
};
// Copia profunda que preserva Date (o banco guarda valores, nunca referencias compartilhadas com o documento).
const mockClone = (value) => {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(mockClone);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mockClone(item)]));
  }
  return value;
};
// Semantica do MongoDB para o subconjunto usado: { campo: null } casa ausente ou nulo; $in com null idem.
const mockEq = (value, cond) => {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (value === null || value === undefined) return false;
  if (typeof cond === 'boolean' || typeof cond === 'number') return value === cond;
  return String(value) === String(cond); // ObjectId x texto
};
const mockIsOperator = (cond) =>
  cond !== null && typeof cond === 'object' && cond.constructor === Object && Object.keys(cond).some((key) => key.startsWith('$'));
const mockCond = (value, cond) => {
  if (!mockIsOperator(cond)) return mockEq(value, cond);
  return Object.entries(cond).every(([op, arg]) => {
    if (op === '$in') return arg.some((item) => mockEq(value, item));
    if (op === '$ne') return !mockEq(value, arg);
    if (op === '$not') {
      if (Object.keys(arg).length !== 1 || arg.$type !== 'date') throw new Error('$not nao suportado no teste');
      return !(value instanceof Date);
    }
    throw new Error(`operador nao suportado no teste: ${op}`);
  });
};
const mockMatches = (row, filter) => Object.entries(filter).every(([campo, cond]) => mockCond(row[campo], cond));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
jest.mock('../services/storage', () => {
  const bucket = { file: jest.fn() };
  bucket.getSignedUrl = jest.fn(async (value) => value || '');
  bucket.getObjectPath = jest.fn();
  bucket.verifyFileAccessToken = jest.fn();
  return bucket;
});
jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));
jest.mock('../utils/socketInstance', () => ({
  setIo: jest.fn(),
  getIo: () => ({ to: (room) => ({ emit: (event, payload) => mockDb.emits.push({ room, event, payload }) }) }),
}));
jest.mock('../models/User', () => ({
  findById: jest.fn((id) => mockThenable(() => mockDb.users.find((user) => mockSame(user._id, id)) || null)),
  find: jest.fn(() => mockThenable(() => [])),
  findOne: jest.fn(() => mockThenable(() => null)),
}));
jest.mock('../models/Equipe', () => ({
  find: jest.fn(() => mockThenable(() => [])),
  findOne: jest.fn(() => mockThenable(() => null)),
  findById: jest.fn(() => mockThenable(() => null)),
  updateMany: jest.fn(async () => ({})),
}));

jest.mock('../models/Tarefa', () => {
  const EquipeReal = jest.requireActual('../models/Equipe'); // documento real para o caminho populado
  const Real = jest.requireActual('../models/Tarefa');

  const ler = async (filter, populate) => {
    mockDb.leituras += 1;
    const numero = mockDb.leituras;
    const row = mockDb.tarefas.find((item) => mockMatches(item, filter));
    let doc = null;
    if (row) {
      // hydrate simples, como no findOne real: valor gravado que nao converte fica invalido e chega undefined.
      doc = Real.hydrate(mockClone(row));
      if (populate) {
        const equipe = mockDb.equipes.find((item) => mockSame(item._id, row.equipe));
        doc.equipe = EquipeReal.hydrate({ _id: equipe._id, createdBy: equipe.createdBy, nome: equipe.nome });
      }
    }
    // Pausa DEPOIS de tirar a foto da leitura: o que acontecer no banco agora deixa esta leitura desatualizada.
    if (mockHooks.aposLer) await mockHooks.aposLer({ numero, filter });
    return doc;
  };

  return {
    findOne: jest.fn((filter) => {
      let populate = false;
      const query = {
        populate: () => {
          populate = true;
          return query;
        },
        then: (resolve, reject) => ler(filter, populate).then(resolve, reject),
      };
      return query;
    }),
    updateOne: jest.fn(async (filter, update, options = {}) => {
      // Conversao real do Mongoose (tipos do filtro e do update); a query nunca e executada.
      const query = Real.updateOne(filter, update, options);
      query.cast(Real);
      query._castUpdate(query._update);
      const chamada = {
        numero: mockDb.gravacoes.length + 1,
        filtro: query.getFilter(),
        update: mockClone(update),
        timestamps: query._mongooseOptions.timestamps,
        runValidators: query.getOptions().runValidators,
      };
      mockDb.gravacoes.push(chamada);
      if (mockHooks.antesDeGravar) await mockHooks.antesDeGravar(chamada);
      if (mockHooks.falhaGravacao) throw mockHooks.falhaGravacao;
      if (mockHooks.resultadoGravacao) return mockHooks.resultadoGravacao;
      // Atomico: avaliar o filtro e aplicar acontecem sem nenhum await no meio.
      const row = mockDb.tarefas.find((item) => mockMatches(item, chamada.filtro));
      if (!row) {
        mockDb.eventos.push('gravacao:conflito');
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      Object.entries(update.$set || {}).forEach(([campo, valor]) => { row[campo] = mockClone(valor); });
      Object.keys(update.$unset || {}).forEach((campo) => { delete row[campo]; });
      mockDb.eventos.push('gravacao:aplicada');
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    }),
    find: jest.fn(() => mockThenable(() => [])),
    findById: jest.fn(() => mockThenable(() => null)),
  };
});

jest.mock('../models/ActivityLog', () => {
  const Real = jest.requireActual('../models/ActivityLog');
  function Model(data) {
    const doc = new Real(data);
    doc.save = async () => {
      try {
        await doc.validate();
      } catch (err) {
        mockDb.logErros.push(data.tipoAcao);
        throw err;
      }
      mockDb.logs.push(doc.toObject());
      mockDb.eventos.push(`log:${data.tipoAcao}`);
      return doc;
    };
    return doc;
  }
  Model.find = jest.fn(() => mockThenable(() => []));
  return Model;
});

jest.mock('../models/Notification', () => {
  const Real = jest.requireActual('../models/Notification');
  return {
    insertMany: jest.fn(async (docs) => {
      const created = [];
      for (const data of docs) {
        const doc = new Real(data);
        await doc.validate();
        created.push(doc.toObject());
      }
      mockDb.notifications.push(...created);
      mockDb.eventos.push('notificacao');
      return created;
    }),
  };
});

const { issueAuthToken } = require('../utils/faceAuth');
const app = require('../app');

const id = () => new mongoose.Types.ObjectId().toString();
const MSG_CONFLITO = 'A tarefa foi alterada por outra operação ao mesmo tempo. Tente novamente.';
const MSG_INCONSISTENTE = 'O cronômetro desta tarefa está inconsistente: o horário de início está ausente, '
  + 'inválido ou no futuro. Nenhum tempo foi contabilizado e a tarefa não foi alterada.';
const CAMPOS_DA_TRANSICAO = ['status', 'tempoGasto', 'cronometroAtivo', 'tempoExcedido', 'ultimaAtualizacaoCronometro', 'updatedAt'];
const NAO_FALSIFICAR_ALEM_DE_DATE = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout',
];

// Espera por contagem de voltas (nao por Date: o teste do minuto congela o relogio).
const waitFor = async (condicao, rotulo) => {
  for (let volta = 0; volta < 1000; volta += 1) {
    if (condicao()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`tempo esgotado esperando: ${rotulo}`);
};

describe('status e cronometro legados: gravacao condicional e concorrencia', () => {
  let admin;
  let colaborador;
  let outro;
  let equipe;
  let tarefa;
  let token;

  const putStatus = (status, tokenUsado = token) =>
    request(app).put(`/api/tarefas/${tarefa._id}/status`).set('Authorization', `Bearer ${tokenUsado}`).send({ status });
  const putCronometro = (acao, tokenUsado = token) =>
    request(app).put(`/api/tarefas/${tarefa._id}/cronometro`).set('Authorization', `Bearer ${tokenUsado}`).send({ acao });
  const tiposLog = () => mockDb.logs.map((log) => log.tipoAcao);
  const detalhesLog = () => mockDb.logs.map((log) => log.detalhes);
  // Cronometro ativo ha N minutos (+10 s de folga, para o floor nao depender de milissegundos).
  const ativo = (minutos, extra = {}) => Object.assign(tarefa, {
    cronometroAtivo: true,
    ultimaAtualizacaoCronometro: new Date(Date.now() - (minutos * 60 + 10) * 1000),
    ...extra,
  });

  // A requisicao A para logo depois da leitura de numero `numeroLeitura`; enquanto isso roda `duranteAPausa`
  // (outra requisicao ate o fim, ou uma escrita direta no banco); depois A e liberada. Liberacao sempre no finally.
  const comLeituraPausada = async (numeroLeitura, requisicaoA, duranteAPausa) => {
    let liberar;
    const portao = new Promise((resolve) => { liberar = resolve; });
    let pausada = false;
    mockHooks.aposLer = async ({ numero }) => {
      if (numero === numeroLeitura) {
        pausada = true;
        await portao;
      }
    };
    const respostaA = requisicaoA().then((response) => response);
    try {
      await waitFor(() => pausada, 'leitura da requisicao A');
      await duranteAPausa();
    } finally {
      liberar();
    }
    return respostaA;
  };

  // Muda o banco logo antes das gravacoes indicadas (a gravacao chega ao "servidor" depois da mudanca).
  const mudarAntesDeGravar = (porGravacao) => {
    mockHooks.antesDeGravar = async ({ numero }) => {
      if (porGravacao[numero]) porGravacao[numero]();
    };
  };

  beforeEach(() => {
    Object.keys(mockDb).forEach((name) => {
      if (Array.isArray(mockDb[name])) mockDb[name].splice(0, mockDb[name].length);
    });
    mockDb.leituras = 0;
    Object.keys(mockHooks).forEach((name) => { mockHooks[name] = null; });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    admin = { _id: id(), nome: 'Admin Ficticio', tipo: 'admin', authVersion: 0 };
    colaborador = { _id: id(), nome: 'Pessoa Ficticia', tipo: 'user', authVersion: 0 };
    outro = { _id: id(), nome: 'Outra Pessoa', tipo: 'user', authVersion: 0 };
    mockDb.users.push(admin, colaborador, outro);
    equipe = { _id: id(), createdBy: admin._id, nome: 'Equipe Alfa' };
    mockDb.equipes.push(equipe);
    tarefa = {
      _id: id(),
      descricao: 'Relatório',
      detalhes: 'Detalhe original',
      dataEntrega: new Date('2026-12-01T00:00:00.000Z'),
      createdBy: admin._id,
      status: 'em_andamento',
      user: colaborador._id,
      equipe: equipe._id,
      tempoEstimado: 120,
      tempoGasto: 10,
      cronometroAtivo: false,
      urgencia: 'baixa',
      tempoExcedido: false,
      tags: ['relatorio'],
      subtarefas: [],
      anexos: [],
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    };
    mockDb.tarefas.push(tarefa);
    token = issueAuthToken(colaborador);
  });

  afterEach(() => {
    Object.keys(mockHooks).forEach((name) => { mockHooks[name] = null; });
    jest.useRealTimers();
    jest.restoreAllMocks();
    // Em nenhum teste um numero nao finito (NaN/Infinity) chega a um update.
    mockDb.gravacoes.forEach(({ update }) => {
      Object.values(update.$set || {}).forEach((valor) => {
        if (typeof valor === 'number') expect(Number.isFinite(valor)).toBe(true);
        if (valor instanceof Date) expect(Number.isFinite(valor.getTime())).toBe(true);
      });
    });
  });

  test('1. status normal: grava so o status, condicionado ao estado lido; mesmo status repete log e notificacao', async () => {
    const response = await putStatus('concluido');
    expect(response.status).toBe(200);
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 10 });
    expect(mockDb.gravacoes).toHaveLength(1);
    const [gravacao] = mockDb.gravacoes;
    expect(Object.keys(gravacao.update.$set).sort()).toEqual(['status', 'updatedAt']);
    expect(gravacao.update.$unset).toBeUndefined();
    expect(gravacao).toMatchObject({ timestamps: false, runValidators: true });
    expect(String(gravacao.filtro._id)).toBe(tarefa._id);
    expect(String(gravacao.filtro.user)).toBe(colaborador._id);
    expect(gravacao.filtro).toMatchObject({ status: 'em_andamento', cronometroAtivo: { $ne: true } });
    expect(gravacao.filtro.tempoGasto).toBeUndefined(); // inativo: o tempo nao participa da transicao
    expect(mockDb.eventos).toEqual(['gravacao:aplicada', 'log:atualizacao_status', 'notificacao']);

    // Mesmo status de novo: nada muda (nem updatedAt, como no save antigo), mas log e notificacao continuam.
    const updatedAt = tarefa.updatedAt.getTime();
    expect((await putStatus('concluido')).status).toBe(200);
    expect(mockDb.gravacoes[1].update).toEqual({ $set: { status: 'concluido' } });
    expect(tarefa.updatedAt.getTime()).toBe(updatedAt);
    expect(tiposLog()).toEqual(['atualizacao_status', 'atualizacao_status']);
    expect(mockDb.notifications).toHaveLength(2);
  });

  test('2. pausa automatica ao mudar status: soma o tempo, remove o inicio e loga depois de gravar', async () => {
    ativo(30, { tempoEstimado: 20 });
    const inicio = tarefa.ultimaAtualizacaoCronometro;
    const response = await putStatus('concluido');
    expect(response.status).toBe(200);
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 40, tempoExcedido: true });
    expect('ultimaAtualizacaoCronometro' in tarefa).toBe(false);
    const [gravacao] = mockDb.gravacoes;
    expect(gravacao.filtro).toMatchObject({ cronometroAtivo: true, tempoGasto: 10, tempoEstimado: 20, tempoExcedido: { $ne: true } });
    expect(gravacao.filtro.ultimaAtualizacaoCronometro.getTime()).toBe(inicio.getTime());
    expect(gravacao.update.$unset).toEqual({ ultimaAtualizacaoCronometro: '' });
    expect(mockDb.eventos).toEqual(['gravacao:aplicada', 'log:cronometro_pausado', 'log:atualizacao_status', 'notificacao']);
    expect(detalhesLog()).toEqual([
      'Cronômetro pausado automaticamente pela alteração de status para concluido. +30 mins',
      'Status alterado para concluido',
    ]);
    expect(response.body.tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 40, tempoExcedido: true });
    expect(response.body.tarefa.ultimaAtualizacaoCronometro).toBeUndefined();
  });

  test('3. inicio normal: liga o cronometro com o instante da gravacao (sem exigir em_andamento, como hoje)', async () => {
    tarefa.status = 'concluido';
    const antes = Date.now();
    const response = await putCronometro('iniciar');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ msg: 'Cronômetro iniciardo com sucesso', tempoExcedido: false });
    expect(tarefa.cronometroAtivo).toBe(true);
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBeGreaterThanOrEqual(antes);
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBe(tarefa.updatedAt.getTime());
    expect(Object.keys(mockDb.gravacoes[0].update.$set).sort()).toEqual(['cronometroAtivo', 'ultimaAtualizacaoCronometro', 'updatedAt']);
    expect(mockDb.eventos).toEqual(['gravacao:aplicada', 'log:cronometro_iniciado']);
    expect(detalhesLog()).toEqual(['Cronômetro iniciado']);
  });

  test('4. pausa manual normal: soma os minutos inteiros e mantem o inicio gravado (regra atual)', async () => {
    ativo(30);
    const inicio = tarefa.ultimaAtualizacaoCronometro.getTime();
    const response = await putCronometro('pausar');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ msg: 'Cronômetro pausardo com sucesso', tempoExcedido: false });
    expect(tarefa).toMatchObject({ cronometroAtivo: false, tempoGasto: 40, tempoExcedido: false, status: 'em_andamento' });
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBe(inicio);
    expect(mockDb.gravacoes[0].update.$unset).toBeUndefined();
    expect(Object.keys(mockDb.gravacoes[0].update.$set).sort()).toEqual(['cronometroAtivo', 'tempoGasto', 'updatedAt']);
    expect(mockDb.eventos).toEqual(['gravacao:aplicada', 'log:cronometro_pausado']);
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);
  });

  test('5. dois inicios simultaneos: so um vale; o outro rele e recebe o 400 de sempre', async () => {
    let inicioB;
    const respostaA = await comLeituraPausada(1, () => putCronometro('iniciar'), async () => {
      const respostaB = await putCronometro('iniciar');
      expect(respostaB.status).toBe(200);
      inicioB = tarefa.ultimaAtualizacaoCronometro.getTime();
    });
    expect(respostaA.status).toBe(400);
    expect(respostaA.body).toEqual({ erro: 'Cronômetro já está ativo' });
    expect(tarefa.cronometroAtivo).toBe(true);
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBe(inicioB); // o inicio valido nao foi sobrescrito
    expect(tiposLog()).toEqual(['cronometro_iniciado']);
    expect(mockDb.eventos).toEqual(['gravacao:aplicada', 'log:cronometro_iniciado', 'gravacao:conflito']);
    expect(mockDb.leituras).toBe(3); // A, B, releitura de A
  });

  test('6. duas pausas simultaneas: o tempo entra uma vez so; a outra recebe o 400 de sempre', async () => {
    ativo(30);
    const respostaA = await comLeituraPausada(1, () => putCronometro('pausar'), async () => {
      expect((await putCronometro('pausar')).status).toBe(200);
    });
    expect(respostaA.status).toBe(400);
    expect(respostaA.body).toEqual({ erro: 'Cronômetro já está pausado' });
    expect(tarefa).toMatchObject({ cronometroAtivo: false, tempoGasto: 40 });
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);
  });

  test('7. inicio concorrente com mudanca de status: o resultado equivale a uma das ordens em serie', async () => {
    // a) O status leu o cronometro parado; o inicio grava antes. O status rele, ve o cronometro ativo e pausa (+0).
    tarefa.status = 'pendente';
    const respostaStatus = await comLeituraPausada(1, () => putStatus('concluido'), async () => {
      expect((await putCronometro('iniciar')).status).toBe(200);
    });
    expect(respostaStatus.status).toBe(200);
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 10 });
    expect('ultimaAtualizacaoCronometro' in tarefa).toBe(false);
    expect(tiposLog()).toEqual(['cronometro_iniciado', 'cronometro_pausado', 'atualizacao_status']);
    expect(detalhesLog()[1]).toBe('Cronômetro pausado automaticamente pela alteração de status para concluido. +0 mins');

    // b) O inicio leu primeiro; o status grava antes (sem cronometro ativo, nada a pausar). O inicio rele e liga:
    //    tarefa concluida com cronometro ativo, o mesmo que a ordem "status, depois inicio" ja permite hoje.
    mockDb.logs.splice(0, mockDb.logs.length);
    mockDb.leituras = 0;
    tarefa.status = 'em_andamento';
    const respostaInicio = await comLeituraPausada(1, () => putCronometro('iniciar'), async () => {
      expect((await putStatus('concluido')).status).toBe(200);
    });
    expect(respostaInicio.status).toBe(200);
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: true });
    expect(tiposLog()).toEqual(['atualizacao_status', 'cronometro_iniciado']);
  });

  test('8. pausa manual concorrente com mudanca de status: o tempo entra uma vez, nas duas ordens', async () => {
    // a) A pausa manual leu; o status pausa antes (+30). A manual rele, ve parado: 400, sem log.
    ativo(30);
    const respostaPausa = await comLeituraPausada(1, () => putCronometro('pausar'), async () => {
      expect((await putStatus('concluido')).status).toBe(200);
    });
    expect(respostaPausa.status).toBe(400);
    expect(respostaPausa.body).toEqual({ erro: 'Cronômetro já está pausado' });
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 40 });
    expect(detalhesLog()).toEqual([
      'Cronômetro pausado automaticamente pela alteração de status para concluido. +30 mins',
      'Status alterado para concluido',
    ]);

    // b) O status leu; a pausa manual grava antes (+30). O status rele e so muda o status, sem pausar de novo.
    mockDb.logs.splice(0, mockDb.logs.length);
    mockDb.leituras = 0;
    Object.assign(tarefa, { status: 'em_andamento', tempoGasto: 10 });
    ativo(30);
    const respostaStatus = await comLeituraPausada(1, () => putStatus('pendente'), async () => {
      expect((await putCronometro('pausar')).status).toBe(200);
    });
    expect(respostaStatus.status).toBe(200);
    expect(tarefa).toMatchObject({ status: 'pendente', cronometroAtivo: false, tempoGasto: 40 });
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins', 'Status alterado para pendente']);
  });

  test('9. duas mudancas de status simultaneas: a pausa conta uma vez; as duas registram e notificam', async () => {
    ativo(30);
    const respostaA = await comLeituraPausada(1, () => putStatus('concluido'), async () => {
      expect((await putStatus('pendente')).status).toBe(200);
    });
    expect(respostaA.status).toBe(200);
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 40 });
    expect(detalhesLog()).toEqual([
      'Cronômetro pausado automaticamente pela alteração de status para pendente. +30 mins',
      'Status alterado para pendente',
      'Status alterado para concluido',
    ]);
    expect(mockDb.notifications.map((item) => item.texto)).toEqual([
      'Pessoa Ficticia marcou a tarefa "Relatório" como pendente',
      'Pessoa Ficticia marcou a tarefa "Relatório" como concluída',
    ]);
  });

  test('10. responsavel muda entre a leitura e a gravacao: o anterior nao grava (403), sem log nem notificacao', async () => {
    ativo(30);
    const respostaStatus = await comLeituraPausada(1, () => putStatus('concluido'), async () => {
      tarefa.user = outro._id; // reatribuicao pelo admin (outra rota)
    });
    expect(respostaStatus.status).toBe(403);
    expect(respostaStatus.body).toEqual({ erro: 'Você não pode editar essa tarefa' });
    expect(tarefa).toMatchObject({ status: 'em_andamento', cronometroAtivo: true, tempoGasto: 10, user: outro._id });

    tarefa.user = colaborador._id;
    mockDb.leituras = 0;
    const respostaPausa = await comLeituraPausada(1, () => putCronometro('pausar'), async () => {
      tarefa.user = outro._id;
    });
    expect(respostaPausa.status).toBe(403);
    expect(respostaPausa.body).toEqual({ erro: 'Acesso negado à tarefa' });
    expect(tarefa).toMatchObject({ cronometroAtivo: true, tempoGasto: 10 });
    expect(mockDb.eventos).toEqual(['gravacao:conflito', 'gravacao:conflito']);
    expect(mockDb.logs).toEqual([]);
    expect(mockDb.notifications).toEqual([]);
  });

  test('11. tempoEstimado muda durante o calculo: a pausa recalcula o tempo excedido com o estimado novo', async () => {
    ativo(30, { tempoEstimado: 120 });
    const resposta = await comLeituraPausada(1, () => putCronometro('pausar'), async () => {
      tarefa.tempoEstimado = 20; // edicao do admin entre a leitura e a gravacao
    });
    expect(resposta.status).toBe(200);
    expect(resposta.body.tempoExcedido).toBe(true);
    expect(tarefa).toMatchObject({ tempoGasto: 40, tempoExcedido: true, tempoEstimado: 20 });
    expect(mockDb.gravacoes.map((item) => item.filtro.tempoEstimado)).toEqual([120, 20]);
    expect(mockDb.gravacoes[0].update.$set.tempoExcedido).toBeUndefined(); // a conta com o estimado velho nao valeu
  });

  test('12. conflito com releitura: a nova tentativa calcula a partir do estado novo (sem perder tempo)', async () => {
    ativo(30);
    // Entre a leitura e a gravacao do status, outra sessao pausou (+30) e reiniciou ha 5 minutos.
    const resposta = await comLeituraPausada(1, () => putStatus('concluido'), async () => {
      Object.assign(tarefa, { tempoGasto: 40, ultimaAtualizacaoCronometro: new Date(Date.now() - (5 * 60 + 10) * 1000) });
    });
    expect(resposta.status).toBe(200);
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 45 }); // 10 + 30 + 5
    expect(mockDb.gravacoes).toHaveLength(2);
    expect(mockDb.leituras).toBe(2);
    expect(mockDb.gravacoes[1].filtro.tempoGasto).toBe(40);
    expect(detalhesLog()[0]).toBe('Cronômetro pausado automaticamente pela alteração de status para concluido. +5 mins');
  });

  test('12b. so tempoGasto muda entre a leitura e a gravacao: rele e soma sobre o acumulado novo (sem perder minutos)', async () => {
    ativo(30); // tempoGasto 10, ativo ha 30 min
    const inicio = tarefa.ultimaAtualizacaoCronometro.getTime();
    // Outra escrita muda EXCLUSIVAMENTE o acumulado (cronometroAtivo, inicio e demais campos intactos).
    mudarAntesDeGravar({ 1: () => { tarefa.tempoGasto = 25; } });
    const resposta = await putCronometro('pausar');
    expect(resposta.status).toBe(200);
    // Primeiro o efeito observavel: 25 + 30. Gravar a partir da leitura velha daria 40 (15 minutos perdidos).
    expect(tarefa).toMatchObject({ tempoGasto: 55, cronometroAtivo: false });
    expect(mockDb.eventos).toEqual(['gravacao:conflito', 'gravacao:aplicada', 'log:cronometro_pausado']);
    expect(mockDb.leituras).toBe(2);
    expect(mockDb.gravacoes.map((item) => item.filtro.tempoGasto)).toEqual([10, 25]);
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBe(inicio); // pausa manual mantem o inicio (regra atual)
    expect(resposta.body.tarefa.tempoGasto).toBe(55);
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);
  });

  test('13. tentativas esgotadas: 409, nada gravado, sem log nem notificacao (status e cronometro)', async () => {
    const alternarStatus = () => { tarefa.status = tarefa.status === 'pendente' ? 'em_andamento' : 'pendente'; };
    mudarAntesDeGravar({ 1: alternarStatus, 2: alternarStatus, 3: alternarStatus });
    const respostaStatus = await putStatus('concluido');
    expect(respostaStatus.status).toBe(409);
    expect(respostaStatus.body).toEqual({ erro: MSG_CONFLITO });
    expect(tarefa.status).not.toBe('concluido');

    mudarAntesDeGravar({ 4: alternarStatus, 5: alternarStatus, 6: alternarStatus });
    const respostaCronometro = await putCronometro('iniciar');
    expect(respostaCronometro.status).toBe(409);
    expect(respostaCronometro.body).toEqual({ erro: MSG_CONFLITO });
    expect(tarefa.cronometroAtivo).toBe(false);

    expect(mockDb.gravacoes).toHaveLength(6); // 3 + 3: o limite e respeitado
    expect(mockDb.leituras).toBe(6);
    expect(mockDb.eventos.every((evento) => evento === 'gravacao:conflito')).toBe(true);
    expect(mockDb.logs).toEqual([]);
    expect(mockDb.notifications).toEqual([]);
    expect(mockDb.emits).toEqual([]);
  });

  test('14. falha real do banco: 500 de sempre, sem nova tentativa, sem log; resposta sem confirmacao tambem', async () => {
    ativo(30);
    mockHooks.falhaGravacao = Object.assign(new Error('conexao interrompida'), { name: 'MongoNetworkError' });
    const respostaStatus = await putStatus('concluido');
    expect(respostaStatus.status).toBe(500);
    expect(respostaStatus.body).toEqual({ erro: 'Erro ao atualizar status' });
    const respostaPausa = await putCronometro('pausar');
    expect(respostaPausa.status).toBe(500);
    expect(respostaPausa.body).toEqual({ erro: 'Erro ao controlar cronômetro' });
    expect(mockDb.gravacoes).toHaveLength(2); // uma por requisicao: erro do banco nao vira conflito

    mockHooks.falhaGravacao = null;
    mockHooks.resultadoGravacao = { acknowledged: false };
    expect((await putCronometro('pausar')).status).toBe(500);
    expect(mockDb.gravacoes).toHaveLength(3);

    expect(tarefa).toMatchObject({ status: 'em_andamento', cronometroAtivo: true, tempoGasto: 10 });
    expect(mockDb.logs).toEqual([]);
    expect(mockDb.notifications).toEqual([]);
  });

  test('15. ActivityLog so depois da gravacao confirmada (tentativa em conflito nao registra nada)', async () => {
    ativo(30);
    mudarAntesDeGravar({ 1: () => { tarefa.tempoEstimado = 119; } });
    expect((await putStatus('concluido')).status).toBe(200);
    expect(mockDb.eventos).toEqual([
      'gravacao:conflito', 'gravacao:aplicada', 'log:cronometro_pausado', 'log:atualizacao_status', 'notificacao',
    ]);
  });

  test('16. tentativas internas nao duplicam logs: dois conflitos, um log, com os minutos da tentativa que valeu', async () => {
    ativo(30);
    mudarAntesDeGravar({ 1: () => { tarefa.tempoEstimado = 119; }, 2: () => { tarefa.tempoEstimado = 118; } });
    const resposta = await putCronometro('pausar');
    expect(resposta.status).toBe(200);
    expect(mockDb.gravacoes).toHaveLength(3);
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);
    expect(tarefa.tempoGasto).toBe(40);
  });

  test('17. notificacao do status mantida: mesmo texto e destinatario, uma vez, mesmo com releitura', async () => {
    tarefa.createdBy = null; // destinatario vem do criador da equipe (populate da releitura)
    mudarAntesDeGravar({ 1: () => { tarefa.detalhes = 'mudou'; tarefa.status = 'pendente'; } });
    expect((await putStatus('concluido')).status).toBe(200);
    expect(mockDb.gravacoes).toHaveLength(2);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.notifications[0]).toMatchObject({
      texto: 'Pessoa Ficticia marcou a tarefa "Relatório" como concluída',
      tipo: 'task',
    });
    expect(String(mockDb.notifications[0].user)).toBe(admin._id);
    expect(mockDb.notifications[0].metadata).toMatchObject({ status: 'concluido' });
    expect(mockDb.emits).toEqual([expect.objectContaining({ room: `user_${admin._id}`, event: 'notification_created' })]);

    // Quem muda o status e o proprio criador: nao notifica (regra atual).
    mockDb.notifications.splice(0, mockDb.notifications.length);
    tarefa.createdBy = colaborador._id;
    mockHooks.antesDeGravar = null;
    expect((await putStatus('pendente')).status).toBe(200);
    expect(mockDb.notifications).toEqual([]);
  });

  test('18. respostas HTTP preservadas', async () => {
    const status = await putStatus('em_andamento');
    expect(Object.keys(status.body).sort()).toEqual(['msg', 'tarefa']);
    expect(status.body.msg).toBe('Status atualizado com sucesso');
    expect(status.body.tarefa).toMatchObject({ _id: tarefa._id, status: 'em_andamento', equipe: { nome: 'Equipe Alfa' } });

    const inicio = await putCronometro('iniciar');
    expect(Object.keys(inicio.body).sort()).toEqual(['msg', 'tarefa', 'tempoExcedido']);
    expect(inicio.body.tarefa).toMatchObject({ _id: tarefa._id, cronometroAtivo: true });

    const gravacoes = mockDb.gravacoes.length;
    expect((await putStatus('invalido')).body).toEqual({ erro: 'Status inválido' });
    expect((await putCronometro('parar')).body).toEqual({ erro: 'Ação inválida.' });
    expect((await putCronometro('iniciar')).body).toEqual({ erro: 'Cronômetro já está ativo' });
    const naoResponsavel = issueAuthToken(outro);
    const s403 = await putStatus('concluido', naoResponsavel);
    expect([s403.status, s403.body]).toEqual([403, { erro: 'Você não pode editar essa tarefa' }]);
    const c403 = await putCronometro('pausar', naoResponsavel);
    expect([c403.status, c403.body]).toEqual([403, { erro: 'Acesso negado à tarefa' }]);
    expect((await putStatus('concluido', issueAuthToken(admin))).status).toBe(403); // isUser
    expect((await putCronometro('pausar', issueAuthToken(admin))).status).toBe(403);
    expect(mockDb.gravacoes).toHaveLength(gravacoes); // nenhuma recusa grava
    expect((await putCronometro('pausar')).status).toBe(200);
    expect((await putCronometro('pausar')).body).toEqual({ erro: 'Cronômetro já está pausado' });
  });

  test('19. campos nao relacionados alterados por outra rota no meio do caminho sao preservados', async () => {
    ativo(30);
    const resposta = await comLeituraPausada(1, () => putStatus('concluido'), async () => {
      Object.assign(tarefa, { descricao: 'Nova descrição', detalhes: 'Novo detalhe', tags: ['nova'], urgencia: 'alta' });
      tarefa.subtarefas.push({ _id: id(), descricao: 'Sub nova', concluida: false });
    });
    expect(resposta.status).toBe(200);
    expect(mockDb.eventos[0]).toBe('gravacao:aplicada'); // nao sao condicao: nao ha conflito nem regravacao
    expect(tarefa).toMatchObject({
      descricao: 'Nova descrição', detalhes: 'Novo detalhe', tags: ['nova'], urgencia: 'alta',
      status: 'concluido', cronometroAtivo: false, tempoGasto: 40,
    });
    expect(tarefa.subtarefas.map((sub) => sub.descricao)).toEqual(['Sub nova']);
    expect((await putCronometro('iniciar')).status).toBe(200);
    expect((await putCronometro('pausar')).status).toBe(200);
    mockDb.gravacoes.forEach(({ update }) => {
      Object.keys(update.$set).forEach((campo) => expect(CAMPOS_DA_TRANSICAO).toContain(campo));
      Object.keys(update.$unset || {}).forEach((campo) => expect(campo).toBe('ultimaAtualizacaoCronometro'));
    });
  });

  test('20. tentativa que atravessa o limite de um minuto: grava e loga os minutos da tentativa que valeu', async () => {
    const T0 = Date.parse('2026-11-20T10:00:00.000Z');
    jest.useFakeTimers({ doNotFake: NAO_FALSIFICAR_ALEM_DE_DATE, now: T0 + (29 * 60 + 59.5) * 1000 });
    token = issueAuthToken(colaborador);
    Object.assign(tarefa, { cronometroAtivo: true, ultimaAtualizacaoCronometro: new Date(T0), tempoGasto: 10, tempoEstimado: 100 });
    mudarAntesDeGravar({
      1: () => {
        jest.setSystemTime(T0 + (30 * 60 + 0.5) * 1000); // o relogio passa de 29:59 para 30:00
        tarefa.tempoEstimado = 39; // e outra escrita muda o estimado: conflito
      },
    });
    const resposta = await putCronometro('pausar');
    expect(resposta.status).toBe(200);
    expect(mockDb.gravacoes.map((item) => item.update.$set.tempoGasto)).toEqual([39, 40]); // 29 min, depois 30 min
    expect(tarefa).toMatchObject({ tempoGasto: 40, tempoExcedido: true, cronometroAtivo: false });
    expect(tarefa.updatedAt.getTime()).toBe(T0 + (30 * 60 + 0.5) * 1000);
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);
    expect(resposta.body).toMatchObject({ tempoExcedido: true, tarefa: { tempoGasto: 40 } });
  });

  describe('representacao real dos campos e valores invalidos', () => {
    test('documento antigo sem os campos de status/cronometro: os padroes do schema casam com o ausente', async () => {
      ['status', 'tempoGasto', 'cronometroAtivo', 'tempoExcedido', 'tempoEstimado', 'ultimaAtualizacaoCronometro']
        .forEach((campo) => delete tarefa[campo]);
      expect((await putCronometro('iniciar')).status).toBe(200);
      expect(mockDb.gravacoes[0].filtro).toMatchObject({ status: { $in: ['pendente', null] }, cronometroAtivo: { $ne: true } });
      const pausa = await putCronometro('pausar');
      expect(pausa.status).toBe(200);
      expect(mockDb.gravacoes[1].filtro).toMatchObject({ tempoGasto: { $in: [0, null] }, tempoEstimado: { $in: [0, null] } });
      expect(tarefa).toMatchObject({ cronometroAtivo: false, tempoGasto: 0 });
    });

    test('valores nulos gravados: tratados como o codigo legado trata (falsy), sem conflito', async () => {
      Object.assign(tarefa, { status: null, tempoGasto: null, tempoEstimado: null, tempoExcedido: null });
      ativo(30);
      expect((await putStatus('concluido')).status).toBe(200);
      expect(mockDb.gravacoes).toHaveLength(1);
      expect(tarefa).toMatchObject({ status: 'concluido', tempoGasto: 30, cronometroAtivo: false });
    });

    // Cronometro ativo com inicio que nao permite contar o tempo: recusa controlada (409), tarefa intacta.
    const INICIOS_INCONSISTENTES = [
      ['ausente', 'inicio_ausente', () => { delete tarefa.ultimaAtualizacaoCronometro; }],
      ['nulo', 'inicio_ausente', () => { tarefa.ultimaAtualizacaoCronometro = null; }],
      ['invalido (texto gravado que nao converte)', 'inicio_ausente', () => { tarefa.ultimaAtualizacaoCronometro = 'nao-e-data'; }],
      ['no futuro (10 min)', 'inicio_no_futuro', () => { tarefa.ultimaAtualizacaoCronometro = new Date(Date.now() + 10 * 60 * 1000); }],
    ];
    const prepararInconsistente = (aplicar) => {
      Object.assign(tarefa, { cronometroAtivo: true, tempoGasto: 10, status: 'em_andamento' });
      aplicar();
      return mockClone(tarefa);
    };
    const esperarRecusaInconsistente = (resposta, antes, motivo) => {
      expect(resposta.status).toBe(409);
      expect(resposta.body).toEqual({ erro: MSG_INCONSISTENTE });
      expect(tarefa).toEqual(antes); // tempo, cronometro, status e inicio exatamente como estavam
      expect(mockDb.gravacoes).toEqual([]);
      expect(mockDb.logs).toEqual([]);
      expect(mockDb.notifications).toEqual([]);
      expect(mockDb.emits).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith('Cronômetro inconsistente; operação recusada:', motivo, tarefa._id);
    };

    test.each(INICIOS_INCONSISTENTES)('pausa manual com inicio %s: 409, nada gravado, sem log', async (_rotulo, motivo, aplicar) => {
      const antes = prepararInconsistente(aplicar);
      esperarRecusaInconsistente(await putCronometro('pausar'), antes, motivo);
    });

    test.each(INICIOS_INCONSISTENTES)('mudanca de status com cronometro ativo e inicio %s: 409, status nao muda, sem notificacao', async (_rotulo, motivo, aplicar) => {
      const antes = prepararInconsistente(aplicar);
      esperarRecusaInconsistente(await putStatus('concluido'), antes, motivo);
    });

    test('inconsistencia descoberta so na releitura: recusa sem gravar a tentativa anterior', async () => {
      ativo(30);
      const resposta = await comLeituraPausada(1, () => putStatus('concluido'), async () => {
        tarefa.ultimaAtualizacaoCronometro = null; // outra escrita corrompe o inicio no meio do caminho
      });
      expect(resposta.status).toBe(409);
      expect(resposta.body).toEqual({ erro: MSG_INCONSISTENTE });
      expect(mockDb.eventos).toEqual(['gravacao:conflito']); // a 1a tentativa nao casou; a 2a nem chegou a gravar
      expect(tarefa).toMatchObject({ status: 'em_andamento', cronometroAtivo: true, tempoGasto: 10, ultimaAtualizacaoCronometro: null });
      expect(mockDb.logs).toEqual([]);
    });

    test('inicio ate 1 minuto no futuro (diferenca de relogio entre instancias): pausa valida com 0 minuto', async () => {
      ativo(0, { ultimaAtualizacaoCronometro: new Date(Date.now() + 30 * 1000) });
      const resposta = await putCronometro('pausar');
      expect(resposta.status).toBe(200);
      expect(tarefa).toMatchObject({ cronometroAtivo: false, tempoGasto: 10 });
      expect(detalhesLog()).toEqual(['Cronômetro pausado. +0 mins']);
    });

    test('limite da tolerancia: exatamente 1 minuto no futuro ja e inconsistente (relogio congelado)', async () => {
      const agora = Date.parse('2026-11-20T10:00:00.000Z');
      jest.useFakeTimers({ doNotFake: NAO_FALSIFICAR_ALEM_DE_DATE, now: agora });
      token = issueAuthToken(colaborador);
      Object.assign(tarefa, { cronometroAtivo: true, ultimaAtualizacaoCronometro: new Date(agora + 59999) });
      expect((await putCronometro('pausar')).status).toBe(200);
      Object.assign(tarefa, { cronometroAtivo: true, ultimaAtualizacaoCronometro: new Date(agora + 60000) });
      const recusa = await putCronometro('pausar');
      expect(recusa.status).toBe(409);
      expect(recusa.body).toEqual({ erro: MSG_INCONSISTENTE });
    });

    test('cronometro inativo com inicio antigo, nulo ou invalido nao bloqueia status nem novo inicio', async () => {
      for (const antigo of [new Date('2020-01-01T00:00:00.000Z'), null, 'nao-e-data', new Date(Date.now() + 3600 * 1000)]) {
        Object.assign(tarefa, { cronometroAtivo: false, status: 'em_andamento', ultimaAtualizacaoCronometro: antigo, tempoGasto: 10 });
        expect((await putStatus('concluido')).status).toBe(200);
        expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 10 });
        expect((await putCronometro('iniciar')).status).toBe(200);
        expect(tarefa.cronometroAtivo).toBe(true);
        expect(tarefa.ultimaAtualizacaoCronometro).toBeInstanceOf(Date);
      }
    });

    test('status para em_andamento com cronometro ativo e inicio invalido: nao pausa, entao nao e recusado', async () => {
      Object.assign(tarefa, { cronometroAtivo: true, status: 'pendente', ultimaAtualizacaoCronometro: null });
      expect((await putStatus('em_andamento')).status).toBe(200);
      expect(mockDb.gravacoes[0].filtro.ultimaAtualizacaoCronometro).toEqual({ $not: { $type: 'date' } });
      expect(tarefa).toMatchObject({ status: 'em_andamento', cronometroAtivo: true, ultimaAtualizacaoCronometro: null });
    });

    test('tempo valido continua contabilizado normalmente (manual e por status)', async () => {
      ativo(45, { tempoEstimado: 50 });
      expect((await putCronometro('pausar')).body).toMatchObject({ tempoExcedido: true, tarefa: { tempoGasto: 55 } });
      ativo(1);
      expect((await putStatus('concluido')).status).toBe(200);
      expect(tarefa).toMatchObject({ tempoGasto: 56, cronometroAtivo: false, status: 'concluido' });
      expect(detalhesLog()).toEqual([
        'Cronômetro pausado. +45 mins',
        'Cronômetro pausado automaticamente pela alteração de status para concluido. +1 mins',
        'Status alterado para concluido',
      ]);
    });

    test('falha real do banco com inicio valido continua 500 (erro, nao conflito nem inconsistencia)', async () => {
      ativo(30);
      mockHooks.falhaGravacao = Object.assign(new Error('timeout de escrita'), { name: 'MongoServerSelectionError' });
      const resposta = await putStatus('concluido');
      expect([resposta.status, resposta.body]).toEqual([500, { erro: 'Erro ao atualizar status' }]);
      expect(mockDb.gravacoes).toHaveLength(1);
      expect(console.warn).not.toHaveBeenCalledWith('Cronômetro inconsistente; operação recusada:', expect.anything(), expect.anything());
    });

    test.each([
      ['texto que nao converte', 'abc'],
      ['Infinity', Infinity],
    ])('tempo acumulado invalido gravado (%s): erro real (500), nada gravado, sem log', async (_rotulo, valor) => {
      ativo(30, { tempoGasto: valor });
      const resposta = await putCronometro('pausar');
      expect(resposta.status).toBe(500);
      expect(mockDb.gravacoes).toEqual([]);
      expect(mockDb.logs).toEqual([]);
      expect(tarefa.tempoGasto).toBe(valor);
    });
  });
});
