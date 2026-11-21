// PUT /api/tarefas/:id/status (fluxo legado): regressao do log da pausa automatica do cronometro.
// Antes, a pausa por mudanca de status gravava o tipo 'cronometro_pausado_por_status', fora do enum do
// ActivityLog: o log falhava na validacao e era descartado em silencio. Agora usa 'cronometro_pausado' e o texto
// registra que a pausa foi automatica. ActivityLog e Notification usam os models REAIS (validacao de verdade);
// tarefa, usuario, equipe e Socket.IO sao simulados. Nenhuma conexao real.
const request = require('supertest');
const mongoose = require('mongoose');

jest.setTimeout(30000);

const mockDb = { users: [], tarefas: [], logs: [], logErros: [], notifications: [], emits: [] };
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

// Tarefa em memoria: findOne({ _id, user }).populate('equipe') devolve um documento que grava de volta os campos
// que o controller altera (status e cronometro) no save().
jest.mock('../models/Tarefa', () => {
  const CAMPOS = ['status', 'tempoGasto', 'cronometroAtivo', 'ultimaAtualizacaoCronometro', 'tempoExcedido'];
  const findOne = jest.fn((filter) => mockThenable(() => {
    const row = mockDb.tarefas.find((item) => mockSame(item._id, filter._id) && mockSame(item.user, filter.user));
    if (!row) return null;
    const doc = { ...row, equipe: { ...row.equipe }, anexos: [...(row.anexos || [])] };
    doc.save = jest.fn(async () => {
      CAMPOS.forEach((campo) => {
        if (doc[campo] === undefined) delete row[campo];
        else row[campo] = doc[campo];
      });
      return doc;
    });
    doc.toObject = () => {
      const { save, toObject, ...plain } = doc;
      return JSON.parse(JSON.stringify(plain));
    };
    return doc;
  }));
  return { findOne, find: jest.fn(() => mockThenable(() => [])), findById: jest.fn(() => mockThenable(() => null)) };
});

jest.mock('../models/ActivityLog', () => {
  const Real = jest.requireActual('../models/ActivityLog');
  function Model(data) {
    const doc = new Real(data);
    doc.save = async () => {
      try {
        await doc.validate(); // validacao real do schema (enum de tipoAcao)
      } catch (err) {
        mockDb.logErros.push(data.tipoAcao);
        throw err;
      }
      mockDb.logs.push(doc.toObject());
      return doc;
    };
    return doc;
  }
  Model.find = jest.fn(() => mockThenable(() => []));
  Model.Real = Real;
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
      return created;
    }),
  };
});

const { issueAuthToken } = require('../utils/faceAuth');
const ActivityLog = require('../models/ActivityLog');
const app = require('../app');

const id = () => new mongoose.Types.ObjectId().toString();

describe('PUT /api/tarefas/:id/status: log da pausa automatica do cronometro', () => {
  let admin;
  let colaborador;
  let tarefa;
  let token;

  const put = (status, { tarefaId = tarefa._id, tokenUsado = token } = {}) =>
    request(app).put(`/api/tarefas/${tarefaId}/status`).set('Authorization', `Bearer ${tokenUsado}`).send({ status });

  // Cronometro ativo ha 30 min (+10 s de folga para o floor nao depender de milissegundos). Date, como o campo do
  // schema chega num documento Mongoose real (texto ISO faria a subtracao de datas virar NaN).
  const comCronometroAtivo = (extra = {}) => Object.assign(tarefa, {
    cronometroAtivo: true,
    ultimaAtualizacaoCronometro: new Date(Date.now() - (30 * 60 + 10) * 1000),
    tempoGasto: 10,
    tempoEstimado: 20,
    tempoExcedido: false,
    ...extra,
  });

  beforeEach(() => {
    Object.keys(mockDb).forEach((name) => mockDb[name].splice(0, mockDb[name].length));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    admin = { _id: id(), nome: 'Admin Ficticio', tipo: 'admin', authVersion: 0 };
    colaborador = { _id: id(), nome: 'Pessoa Ficticia', tipo: 'user', authVersion: 0 };
    mockDb.users.push(admin, colaborador);
    tarefa = {
      _id: id(), descricao: 'Relatório', status: 'em_andamento', user: colaborador._id, createdBy: admin._id,
      equipe: { _id: id(), createdBy: admin._id, nome: 'Equipe Alfa' }, cronometroAtivo: false, tempoGasto: 0, anexos: [],
    };
    mockDb.tarefas.push(tarefa);
    token = issueAuthToken(colaborador);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('com cronometro ativo: registra a pausa com tipo valido e o texto da pausa automatica', async () => {
    comCronometroAtivo();
    const response = await put('concluido');
    expect(response.status).toBe(200);
    expect(mockDb.logErros).toEqual([]); // nenhum log rejeitado pela validacao
    expect(console.error).not.toHaveBeenCalledWith('Erro ao registrar log de atividade:', expect.anything());
    expect(mockDb.logs.map((log) => log.tipoAcao)).toEqual(['cronometro_pausado', 'atualizacao_status']);
    expect(mockDb.logs[0].detalhes).toBe('Cronômetro pausado automaticamente pela alteração de status para concluido. +30 mins');
    expect(mockDb.logs[1].detalhes).toBe('Status alterado para concluido'); // log de status continua igual
    expect(String(mockDb.logs[0].user)).toBe(colaborador._id);
    expect(String(mockDb.logs[0].tarefa)).toBe(tarefa._id);
  });

  test('a pausa continua seguindo a regra atual: tempo somado, cronometro desligado, tempo excedido marcado', async () => {
    comCronometroAtivo();
    expect((await put('pendente')).status).toBe(200);
    expect(tarefa).toMatchObject({ status: 'pendente', cronometroAtivo: false, tempoGasto: 40, tempoExcedido: true });
    expect(tarefa.ultimaAtualizacaoCronometro).toBeUndefined();
    expect(mockDb.logs[0].detalhes).toBe('Cronômetro pausado automaticamente pela alteração de status para pendente. +30 mins');
  });

  test('tempo dentro do estimado: soma os minutos e nao marca tempo excedido (calculo inalterado)', async () => {
    comCronometroAtivo({ tempoGasto: 5, tempoEstimado: 120 });
    expect((await put('concluido')).status).toBe(200);
    expect(tarefa).toMatchObject({ tempoGasto: 35, tempoExcedido: false, cronometroAtivo: false });
  });

  test('mudar para em_andamento com cronometro ativo: nao pausa e nao gera log de pausa', async () => {
    comCronometroAtivo();
    expect((await put('em_andamento')).status).toBe(200);
    expect(tarefa).toMatchObject({ cronometroAtivo: true, tempoGasto: 10 });
    expect(tarefa.ultimaAtualizacaoCronometro).toBeDefined();
    expect(mockDb.logs.map((log) => log.tipoAcao)).toEqual(['atualizacao_status']);
  });

  test('sem cronometro ativo: nenhum log de pausa, so o de status', async () => {
    expect((await put('concluido')).status).toBe(200);
    expect(mockDb.logs.map((log) => log.tipoAcao)).toEqual(['atualizacao_status']);
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 0 });
  });

  test('contratos HTTP e notificacoes inalterados', async () => {
    comCronometroAtivo();
    const response = await put('concluido');
    expect(Object.keys(response.body).sort()).toEqual(['msg', 'tarefa']);
    expect(response.body.msg).toBe('Status atualizado com sucesso');
    expect(response.body.tarefa).toMatchObject({ _id: tarefa._id, status: 'concluido', equipe: { nome: 'Equipe Alfa' } });
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.notifications[0].texto).toBe('Pessoa Ficticia marcou a tarefa "Relatório" como concluída');
    expect(String(mockDb.notifications[0].user)).toBe(admin._id);
    expect(mockDb.emits).toEqual([expect.objectContaining({ room: `user_${admin._id}`, event: 'notification_created' })]);

    expect((await put('invalido')).status).toBe(400);
    expect((await put('invalido')).body).toEqual({ erro: 'Status inválido' });
    const outro = { _id: id(), nome: 'Outra Pessoa', tipo: 'user', authVersion: 0 };
    mockDb.users.push(outro);
    const naoResponsavel = await put('concluido', { tokenUsado: issueAuthToken(outro) });
    expect(naoResponsavel.status).toBe(403);
    expect(naoResponsavel.body).toEqual({ erro: 'Você não pode editar essa tarefa' });
    expect((await put('concluido', { tokenUsado: issueAuthToken(admin) })).status).toBe(403); // isUser
  });

  test('por que a correcao era necessaria: o tipo antigo e rejeitado pelo model real', () => {
    const user = id();
    const antigo = new ActivityLog.Real({ tipoAcao: 'cronometro_pausado_por_status', detalhes: 'x', user, tarefa: tarefa._id });
    expect(antigo.validateSync()?.errors?.tipoAcao).toBeDefined();
    const novo = new ActivityLog.Real({ tipoAcao: 'cronometro_pausado', detalhes: 'x', user, tarefa: tarefa._id });
    expect(novo.validateSync()).toBeUndefined();
  });
});
