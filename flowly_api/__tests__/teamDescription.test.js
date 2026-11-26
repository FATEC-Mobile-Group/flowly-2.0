// Descricao opcional da equipe (PR #65): criacao, criacao com Idempotency-Key e edicao, com clientes antigos que
// nao enviam o campo. Modelos simulados em memoria (nao equivale a um MongoDB real).
const request = require('supertest');
const mongoose = require('mongoose');

const mockState = { users: [], equipes: [] };
const mockExecute = jest.fn();

const mockQuery = (value) => {
  const query = Promise.resolve(value);
  ['populate', 'select', 'sort', 'lean', 'session'].forEach((method) => {
    query[method] = () => query;
  });
  return query;
};
const mockSame = (a, b) => String(a) === String(b);

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../services/storage', () => {
  const bucket = { file: jest.fn() };
  bucket.getSignedUrl = jest.fn(async (value) => value || '');
  bucket.getObjectPath = jest.fn();
  bucket.verifyFileAccessToken = jest.fn();
  return bucket;
});

jest.mock('../services/idempotencyService', () => {
  const real = jest.requireActual('../services/idempotencyService');
  return { ...real, createIdempotencyService: () => ({ execute: mockExecute }) };
});

jest.mock('../models/User', () => ({
  find: jest.fn((filter) =>
    mockQuery(
      mockState.users.filter(
        (user) => filter._id.$in.some((id) => mockSame(id, user._id)) &&
          (filter.tipo?.$in ? filter.tipo.$in.includes(user.tipo) : user.tipo === filter.tipo)
      )
    )
  ),
  findById: jest.fn((id) => mockQuery(mockState.users.find((user) => mockSame(user._id, id)) || null)),
}));

jest.mock('../models/Equipe', () => {
  const { Types } = jest.requireActual('mongoose');
  const byId = (id) => mockState.equipes.find((equipe) => mockSame(equipe._id, id)) || null;
  function Equipe(doc) {
    Object.assign(this, doc);
    this._id = new Types.ObjectId();
  }
  Equipe.prototype.save = jest.fn(async function save() {
    mockState.equipes.push({ ...this });
    return this;
  });
  Equipe.updateMany = jest.fn(async () => ({}));
  Equipe.find = jest.fn(() => mockQuery(mockState.equipes));
  Equipe.findById = jest.fn((id) => mockQuery(byId(id)));
  Equipe.findOne = jest.fn((filter) => {
    const equipe = byId(filter._id);
    // { membros: id } ou { $or: [{ membros: id }, { createdBy: id }] } (releitura do caminho idempotente).
    const usuario = filter.membros ?? filter.$or?.[0]?.membros;
    const membro = equipe && equipe.membros.some((id) => mockSame(id, usuario));
    return mockQuery(membro ? { ...equipe, membros: [...equipe.membros] } : null);
  });
  Equipe.findByIdAndUpdate = jest.fn((id, update) => {
    const equipe = byId(id);
    if (equipe) Object.assign(equipe, update);
    return mockQuery(equipe);
  });
  Equipe.findOneAndUpdate = jest.fn((filter, update) => {
    const equipe = byId(filter._id);
    if (equipe) Object.assign(equipe, update);
    return mockQuery(equipe);
  });
  Equipe.exists = jest.fn(async () => null);
  return Equipe;
});

const Equipe = require('../models/Equipe');
const { issueAuthToken } = require('../utils/faceAuth');
const { LIMITE_DESCRICAO_EQUIPE, lerDescricaoEquipe } = require('../utils/equipeDescricao');
const app = require('../app');

const LONGA = { erro: `A descrição da equipe deve ter no máximo ${LIMITE_DESCRICAO_EQUIPE} caracteres.` };
const NAO_TEXTO = { erro: 'A descrição da equipe deve ser um texto.' };

describe('Descricao opcional da equipe', () => {
  let admin;
  let colaborador;
  let equipe;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const id = () => new mongoose.Types.ObjectId();
    admin = { _id: id(), nome: 'Admin', tipo: 'admin' };
    colaborador = { _id: id(), nome: 'Ana', tipo: 'user' };
    mockState.users = [admin, colaborador];
    equipe = {
      _id: id(),
      nome: 'Equipe Antiga',
      createdBy: admin._id,
      membros: [admin._id, colaborador._id],
      descricao: 'Equipe responsável pelo atendimento',
    };
    mockState.equipes = [equipe];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const token = () => `Bearer ${issueAuthToken(admin)}`;
  const criar = (body, headers = {}) => {
    const req = request(app).post('/api/equipes').set('Authorization', token());
    Object.entries(headers).forEach(([nome, valor]) => req.set(nome, valor));
    return req.send(body);
  };
  const editar = (body) => request(app).put(`/api/equipes/${equipe._id}`).set('Authorization', token()).send(body);

  describe('leitura do campo', () => {
    test.each([
      ['ausente', undefined, { ausente: true }],
      ['null remove', null, { valor: '' }],
      ['vazio remove', '   ', { valor: '' }],
      ['texto com espacos nas pontas', '  Suporte  ', { valor: 'Suporte' }],
      ['quebra de linha CRLF', 'a\r\nb', { valor: 'a\nb' }],
      ['no limite', 'x'.repeat(LIMITE_DESCRICAO_EQUIPE), { valor: 'x'.repeat(LIMITE_DESCRICAO_EQUIPE) }],
    ])('%s', (_rotulo, valor, esperado) => {
      expect(lerDescricaoEquipe(valor)).toEqual(esperado);
    });

    test.each([['numero', 12], ['objeto', { a: 1 }], ['lista', ['x']], ['booleano', true]])('%s e recusado', (_r, valor) => {
      expect(lerDescricaoEquipe(valor).erro).toBe(NAO_TEXTO.erro);
    });

    test('acima do limite e recusado (o limite e o mesmo do schema)', () => {
      expect(lerDescricaoEquipe('x'.repeat(LIMITE_DESCRICAO_EQUIPE + 1)).erro).toBe(LONGA.erro);
    });
  });

  describe('criacao sem Idempotency-Key', () => {
    test('grava a descricao sem espacos nas pontas', async () => {
      const res = await criar({ nome: 'nova equipe', membros: [String(colaborador._id)], descricao: '  Time de dados ' });

      expect(res.status).toBe(201);
      const criada = mockState.equipes[1];
      expect(criada.descricao).toBe('Time de dados');
      expect(res.body.descricao).toBe('Time de dados');
    });

    test('cliente antigo (sem o campo) cria a equipe sem descricao, como antes', async () => {
      const res = await criar({ nome: 'nova equipe', membros: [] });

      expect(res.status).toBe(201);
      expect(mockState.equipes[1]).not.toHaveProperty('descricao');
    });

    test('descricao vazia nao cria o campo', async () => {
      await criar({ nome: 'nova equipe', membros: [], descricao: '  ' });

      expect(mockState.equipes[1]).not.toHaveProperty('descricao');
    });

    test.each([
      ['longa', 'x'.repeat(LIMITE_DESCRICAO_EQUIPE + 1), LONGA],
      ['nao texto', { texto: 'x' }, NAO_TEXTO],
    ])('descricao %s: 400 sem gravar', async (_r, descricao, erro) => {
      const res = await criar({ nome: 'nova equipe', membros: [], descricao });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(erro);
      expect(mockState.equipes).toHaveLength(1);
      expect(Equipe.prototype.save).not.toHaveBeenCalled();
    });
  });

  describe('criacao com Idempotency-Key', () => {
    const CHAVE = { 'Idempotency-Key': 'chave-descricao-0001' };

    beforeEach(() => {
      mockExecute.mockResolvedValue({ outcome: 'failed', code: 'membros_nao_usuarios', statusCode: 400 });
    });

    test('descricao invalida responde 400 antes de reivindicar a chave', async () => {
      const res = await criar({ nome: 'nova', membros: [], descricao: 'x'.repeat(LIMITE_DESCRICAO_EQUIPE + 1) }, CHAVE);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(LONGA);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    test('sem descricao, o corpo da chave continua { nome, membros } (mesmo hash de antes)', async () => {
      await criar({ nome: 'nova', membros: [] }, CHAVE);

      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockExecute.mock.calls[0][0].body).toEqual({ nome: 'nova', membros: [] });
    });

    test('com descricao, ela entra no corpo da chave e na equipe gravada', async () => {
      mockExecute.mockImplementation(async (_pedido, executar) => {
        const resultado = await executar(undefined);
        return { outcome: 'executed', statusCode: resultado.statusCode, result: resultado };
      });

      const res = await criar({ nome: 'nova', membros: [], descricao: ' Squad móvel ' }, CHAVE);

      expect(mockExecute.mock.calls[0][0].body).toEqual({ nome: 'nova', membros: [], descricao: ' Squad móvel ' });
      expect(mockState.equipes[1].descricao).toBe('Squad móvel');
      expect(res.status).toBe(201);
    });
  });

  describe('edicao', () => {
    test('cliente antigo (sem o campo) nao apaga a descricao existente', async () => {
      const res = await editar({ nome: 'equipe antiga' });

      expect(res.status).toBe(200);
      expect(equipe.descricao).toBe('Equipe responsável pelo atendimento');
      expect(Equipe.findByIdAndUpdate.mock.calls[0][1]).toEqual({ nome: 'Equipe Antiga' });
    });

    test('atualiza a descricao', async () => {
      const res = await editar({ nome: 'Equipe Antiga', descricao: 'Nova descrição' });

      expect(res.status).toBe(200);
      expect(equipe.descricao).toBe('Nova descrição');
      expect(res.body.descricao).toBe('Nova descrição');
    });

    test('texto vazio remove a descricao', async () => {
      await editar({ nome: 'Equipe Antiga', descricao: '' });

      expect(equipe.descricao).toBe('');
    });

    test('junto com a lista de membros, a descricao vai na mesma gravacao condicional', async () => {
      await editar({ nome: 'Equipe Antiga', membros: [String(colaborador._id)], descricao: 'Com membros' });

      expect(Equipe.findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(Equipe.findOneAndUpdate.mock.calls[0][1]).toMatchObject({ descricao: 'Com membros' });
    });

    test('equipe antiga sem descricao continua editavel sem o campo', async () => {
      delete equipe.descricao;

      const res = await editar({ nome: 'Outra' });

      expect(res.status).toBe(200);
      expect(equipe).not.toHaveProperty('descricao');
    });

    test.each([
      ['longa', 'x'.repeat(LIMITE_DESCRICAO_EQUIPE + 1), LONGA],
      ['numero', 5, NAO_TEXTO],
    ])('descricao %s: 400 sem alterar nada', async (_r, descricao, erro) => {
      const res = await editar({ nome: 'Novo Nome', descricao });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(erro);
      expect(Equipe.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(Equipe.findOneAndUpdate).not.toHaveBeenCalled();
      expect(equipe.nome).toBe('Equipe Antiga');
    });
  });

  test('listagem devolve a descricao das equipes que tem e nada nas antigas', async () => {
    const antiga = { _id: new mongoose.Types.ObjectId(), nome: 'Sem descrição', createdBy: admin._id, membros: [admin._id] };
    mockState.equipes.push(antiga);

    const res = await request(app).get('/api/equipes').set('Authorization', token());

    expect(res.status).toBe(200);
    expect(res.body[0].descricao).toBe('Equipe responsável pelo atendimento');
    expect(res.body[1]).not.toHaveProperty('descricao');
  });
});
