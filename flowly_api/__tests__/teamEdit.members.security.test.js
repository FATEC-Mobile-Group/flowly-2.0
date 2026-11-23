const request = require('supertest');
const mongoose = require('mongoose');

const mockState = { users: [], equipes: [] };

// Consulta do Mongoose: pode ser aguardada direto ou encadeada com populate e select.
const mockQuery = (value) => {
  const query = Promise.resolve(value);
  ['populate', 'select', 'sort'].forEach((method) => {
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
  const byId = (id) => mockState.equipes.find((equipe) => mockSame(equipe._id, id)) || null;
  return {
    // Como o MongoDB: garante o criador como membro das equipes que ele criou.
    updateMany: jest.fn(async (filter) => {
      mockState.equipes
        .filter((equipe) => mockSame(equipe.createdBy, filter.createdBy))
        .forEach((equipe) => {
          if (!equipe.membros.some((id) => mockSame(id, filter.createdBy))) equipe.membros.push(filter.createdBy);
        });
      return {};
    }),
    find: jest.fn(() => mockQuery(mockState.equipes)),
    // Como o banco: a leitura devolve uma copia do momento da consulta, nao o documento vivo.
    findOne: jest.fn((filter) => {
      const equipe = byId(filter._id);
      const membro = equipe && equipe.membros.some((id) => mockSame(id, filter.membros));
      return mockQuery(membro ? { ...equipe, membros: [...equipe.membros] } : null);
    }),
    // Sem operadores, o Mongoose trata o objeto como $set dos campos enviados.
    findByIdAndUpdate: jest.fn((id, update) => {
      const equipe = byId(id);
      if (equipe) Object.assign(equipe, update);
      return mockQuery(equipe);
    }),
    // Como o MongoDB com { membros: [lista] }: casa so se o array for exatamente igual, na mesma ordem.
    findOneAndUpdate: jest.fn((filter, update) => {
      const equipe = byId(filter._id);
      const mesmaLista = equipe && equipe.membros.length === filter.membros.length &&
        equipe.membros.every((id, index) => mockSame(id, filter.membros[index]));
      if (!mesmaLista) return mockQuery(null);
      Object.assign(equipe, update);
      return mockQuery(equipe);
    }),
    exists: jest.fn(async (filter) => {
      const equipe = byId(filter._id);
      return equipe && equipe.membros.some((id) => mockSame(id, filter.membros)) ? { _id: equipe._id } : null;
    }),
  };
});

const User = require('../models/User');
const Equipe = require('../models/Equipe');
const { issueAuthToken } = require('../utils/faceAuth');
const app = require('../app');

const INVALID_IDS = { erro: 'Existem membros com identificadores inválidos' };

describe('D64: editar equipe sem a lista de membros nao apaga a equipe', () => {
  let criador;
  let outroAdmin;
  let a;
  let b;
  let semEquipe;
  let equipe;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const id = () => new mongoose.Types.ObjectId();
    criador = { _id: id(), nome: 'Criador', tipo: 'admin' };
    outroAdmin = { _id: id(), nome: 'Outro admin', tipo: 'admin' };
    a = { _id: id(), nome: 'A', tipo: 'user' };
    b = { _id: id(), nome: 'B', tipo: 'user' };
    semEquipe = { _id: id(), nome: 'Sem equipe', tipo: 'user' };
    mockState.users = [criador, outroAdmin, a, b, semEquipe];
    equipe = { _id: id(), nome: 'Equipe Original', createdBy: criador._id, membros: [criador._id, a._id, b._id] };
    mockState.equipes = [equipe];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const edit = (body, { token = criador, url = `/api/equipes/${equipe._id}` } = {}) => {
    const req = request(app).put(url);
    if (token) req.set('Authorization', `Bearer ${issueAuthToken(token)}`);
    return body === undefined ? req : req.send(body);
  };
  const ids = (list) => list.map(String);
  const membros = () => ids(equipe.membros);
  const original = () => ids([criador._id, a._id, b._id]);

  // Nenhum dos dois caminhos de gravacao (so nome / lista de membros condicionada) foi usado.
  const expectNoWrite = () => {
    expect(Equipe.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Equipe.findOneAndUpdate).not.toHaveBeenCalled();
  };

  const expectUntouched = () => {
    expect(Equipe.updateMany).not.toHaveBeenCalled();
    expectNoWrite();
    expect(User.find).not.toHaveBeenCalled();
    expect(equipe.nome).toBe('Equipe Original');
    expect(membros()).toEqual(original());
  };

  describe('A: membros ausente preserva a lista atual', () => {
    test('so o nome muda', async () => {
      const res = await edit({ nome: 'novo nome' });

      expect(res.status).toBe(200);
      expect(equipe.nome).toBe('Novo Nome');
      expect(membros()).toEqual(original());
    });

    test('o update nao leva o campo membros', async () => {
      await edit({ nome: 'novo nome' });

      const [, update] = Equipe.findByIdAndUpdate.mock.calls[0];
      expect(update).toEqual({ nome: 'Novo Nome' });
      expect(User.find).not.toHaveBeenCalled();
    });

    test('equipe legada sem o criador na lista: o criador continua sendo garantido', async () => {
      equipe.membros = [a._id, b._id];

      const res = await edit({ nome: 'Nova' });

      expect(res.status).toBe(200);
      expect(membros()).toEqual(expect.arrayContaining(original()));
      expect(membros()).toHaveLength(3);
    });
  });

  describe('B: lista vazia explicita remove os membros opcionais', () => {
    test('fica so o criador', async () => {
      const res = await edit({ nome: 'Novo Nome', membros: [] });

      expect(res.status).toBe(200);
      expect(membros()).toEqual(ids([criador._id]));
    });

    test('lista so com o criador tambem deixa so o criador', async () => {
      await edit({ nome: 'Novo Nome', membros: [String(criador._id)] });

      expect(membros()).toEqual(ids([criador._id]));
    });
  });

  describe('C: membros que nao e lista e recusado', () => {
    test.each([
      ['objeto vazio', {}],
      ['objeto com indice', { 0: 'x' }],
      ['texto', 'abc'],
      ['id em texto', 'aaaaaaaaaaaaaaaaaaaaaaaa'],
      ['numero', 123],
      ['booleano', true],
      ['nulo', null],
    ])('%s: 400 sem alterar nada', async (_label, value) => {
      const res = await edit({ nome: 'Novo Nome', membros: value });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(INVALID_IDS);
      expectUntouched();
    });
  });

  describe('D: item invalido na lista e recusado', () => {
    test.each([
      ['objeto', {}],
      ['nulo', null],
      ['lista vazia', []],
      ['lista com id', 'NESTED'],
      ['booleano', true],
      ['numero', 123],
      ['texto vazio', ''],
      ['so espacos', '   '],
      ['texto que nao e id', 'nao-e-id'],
    ])('%s: 400 sem alterar nada', async (_label, item) => {
      const value = item === 'NESTED' ? [String(a._id)] : item;

      const res = await edit({ nome: 'Novo Nome', membros: [String(a._id), value] });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(INVALID_IDS);
      expectUntouched();
    });
  });

  describe('regras que continuam valendo', () => {
    test('edicao normal atualiza nome e membros, mantendo o criador', async () => {
      const res = await edit({ nome: 'equipe nova', membros: [String(a._id), String(semEquipe._id)] });

      expect(res.status).toBe(200);
      expect(equipe.nome).toBe('Equipe Nova');
      expect(membros().sort()).toEqual(ids([a._id, semEquipe._id, criador._id]).sort());
    });

    test('duplicados e espacos continuam sendo normalizados', async () => {
      const res = await edit({ nome: 'Nova', membros: [String(a._id), String(a._id), ` ${b._id} `, String(b._id)] });

      expect(res.status).toBe(200);
      expect(membros().sort()).toEqual(ids([a._id, b._id, criador._id]).sort());
    });

    test('o criador nao sai mesmo quando nao esta na lista', async () => {
      await edit({ nome: 'Nova', membros: [String(a._id)] });

      expect(membros()).toContain(String(criador._id));
      expect(membros()).not.toContain(String(b._id));
    });

    test('membro que nao e usuario comum continua 400, sem mudar a equipe', async () => {
      const res = await edit({ nome: 'Nova', membros: [String(a._id), String(outroAdmin._id)] });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Alguns membros não são usuarios válidos' });
      expectNoWrite();
      expect(membros()).toEqual(original());
    });

    test('id valido de usuario inexistente continua 400', async () => {
      const res = await edit({ nome: 'Nova', membros: [String(new mongoose.Types.ObjectId())] });

      expect(res.status).toBe(400);
      expectNoWrite();
    });

    test('nome continua obrigatorio (D62)', async () => {
      const res = await edit({ membros: [String(a._id)] });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'O nome da equipe é obrigatório' });
      expectUntouched();
    });

    test.each([
      ['com membros', { nome: 'Nova', membros: [] }],
      ['sem membros', { nome: 'Nova' }],
    ])('equipe inexistente continua 404, %s', async (_label, body) => {
      const res = await edit(body, { url: `/api/equipes/${new mongoose.Types.ObjectId()}` });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ erro: 'Equipe não encontrada' });
      expectNoWrite();
    });

    test('admin que nao e membro continua 404', async () => {
      const res = await edit({ nome: 'Nova' }, { token: outroAdmin });

      expect(res.status).toBe(404);
      expect(membros()).toEqual(original());
    });

    // O usuario e lido na execucao: na definicao do teste ele ainda nao existe.
    test.each([
      ['sem JWT', () => null, 401],
      ['colaborador', () => a, 403],
    ])('%s continua barrado, com ou sem membros', async (_label, who, status) => {
      const token = who();

      expect((await edit({ nome: 'Nova' }, { token })).status).toBe(status);
      expect((await edit({ nome: 'Nova', membros: [] }, { token })).status).toBe(status);
      expect(equipe.nome).toBe('Equipe Original');
      expect(membros()).toEqual(original());
    });
  });

  // Integrante que ja era membro e foi promovido a admin (services/adminRoleService.js) continua vinculado.
  describe('membro promovido a admin depois de entrar na equipe', () => {
    beforeEach(() => {
      a.tipo = 'admin';
    });

    test('editar o nome mantendo a lista atual nao rejeita o membro promovido', async () => {
      const res = await edit({ nome: 'renomeada', membros: [String(a._id), String(b._id)] });

      expect(res.status).toBe(200);
      expect(equipe.nome).toBe('Renomeada');
      expect(membros().sort()).toEqual(original().sort());
    });

    test('adicionar um usuario comum novo continua funcionando ao lado do membro promovido', async () => {
      const res = await edit({ nome: 'Nova', membros: [String(a._id), String(b._id), String(semEquipe._id)] });

      expect(res.status).toBe(200);
      expect(membros().sort()).toEqual(ids([criador._id, a._id, b._id, semEquipe._id]).sort());
    });

    test('adicionar um admin que nao era membro continua 400, sem mudar a equipe', async () => {
      const res = await edit({ nome: 'Nova', membros: [String(a._id), String(b._id), String(outroAdmin._id)] });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Alguns membros não são usuarios válidos' });
      expectNoWrite();
      expect(membros()).toEqual(original());
      expect(equipe.nome).toBe('Equipe Original');
    });

    test('o criador pode retirar o membro promovido normalmente', async () => {
      const res = await edit({ nome: 'Nova', membros: [String(b._id)] });

      expect(res.status).toBe(200);
      expect(membros().sort()).toEqual(ids([criador._id, b._id]).sort());
    });

    test('retirado, o membro promovido nao volta por esta rota (seria um admin novo)', async () => {
      await edit({ nome: 'Nova', membros: [String(b._id)] });
      Equipe.findByIdAndUpdate.mockClear();
      Equipe.findOneAndUpdate.mockClear();

      const res = await edit({ nome: 'Nova', membros: [String(a._id), String(b._id)] });

      expect(res.status).toBe(400);
      expectNoWrite();
      expect(membros()).not.toContain(String(a._id));
    });

    test('membro antigo cuja conta nao existe mais continua 400 (regra anterior preservada)', async () => {
      mockState.users = mockState.users.filter((user) => !mockSame(user._id, b._id));

      const res = await edit({ nome: 'Nova', membros: [String(a._id), String(b._id)] });

      expect(res.status).toBe(400);
      expectNoWrite();
    });

    test('a validacao consulta novos so como user e os mantidos como user ou admin', async () => {
      await edit({ nome: 'Nova', membros: [String(a._id), String(semEquipe._id)] });

      const filtros = User.find.mock.calls.map(([filtro]) => filtro);
      expect(filtros).toEqual(expect.arrayContaining([
        { _id: { $in: [String(semEquipe._id)] }, tipo: 'user' },
        { _id: { $in: [String(a._id)] }, tipo: { $in: ['user', 'admin'] } },
      ]));
    });

    test('sem a lista de membros, so o nome muda e o vinculo continua', async () => {
      const res = await edit({ nome: 'So o nome' });

      expect(res.status).toBe(200);
      expect(User.find).not.toHaveBeenCalled();
      expect(membros()).toEqual(original());
    });
  });

  // Protecao otimista: a lista so e gravada se ainda for exatamente a que foi lida e validada.
  describe('edicoes concorrentes da lista de membros', () => {
    const CONFLITO = { erro: 'A lista de membros foi alterada por outra edição. Recarregue a equipe e tente novamente.' };

    // As duas edicoes leem a lista antes de qualquer gravacao (o pior caso), de forma deterministica.
    const sincronizarLeituras = (leituras) => {
      let liberar;
      const ambasLeram = new Promise((resolve) => { liberar = resolve; });
      const lerOriginal = Equipe.findOne.getMockImplementation();
      Equipe.findOne.mockImplementation((filter) => {
        const resultado = lerOriginal(filter);
        leituras.count += 1;
        if (leituras.count === 2) liberar();
        return resultado;
      });
      const gravarOriginal = Equipe.findOneAndUpdate.getMockImplementation();
      Equipe.findOneAndUpdate.mockImplementation((filter, update) => {
        const query = ambasLeram.then(() => gravarOriginal(filter, update));
        query.populate = () => query;
        return query;
      });
      return () => {
        Equipe.findOne.mockImplementation(lerOriginal);
        Equipe.findOneAndUpdate.mockImplementation(gravarOriginal);
      };
    };

    test('duas edicoes simultaneas da lista: uma grava, a outra recebe 409 e nao sobrescreve', async () => {
      const restaurar = sincronizarLeituras({ count: 0 });
      try {
        const [semA, semB] = await Promise.all([
          edit({ nome: 'Nova', membros: [String(b._id)] }),
          edit({ nome: 'Nova', membros: [String(a._id)] }),
        ]);

        expect([semA.status, semB.status].sort()).toEqual([200, 409]);
        const perdedora = semA.status === 409 ? semA : semB;
        expect(perdedora.body).toEqual(CONFLITO);
        const esperado = semA.status === 200 ? [criador._id, b._id] : [criador._id, a._id];
        expect(membros().sort()).toEqual(ids(esperado).sort());
      } finally {
        restaurar();
      }
    });

    test('lista desatualizada nao reintroduz o admin retirado por outra edicao', async () => {
      a.tipo = 'admin';
      const restaurar = sincronizarLeituras({ count: 0 });
      try {
        const [retirada, desatualizada] = await Promise.all([
          edit({ nome: 'Nova', membros: [String(b._id)] }),
          edit({ nome: 'Nova', membros: [String(a._id), String(b._id), String(semEquipe._id)] }),
        ]);

        const statuses = [retirada.status, desatualizada.status];
        expect(statuses.sort()).toEqual([200, 409]);
        if (retirada.status === 200) {
          expect(membros()).not.toContain(String(a._id));
          expect(desatualizada.body).toEqual(CONFLITO);
        }
      } finally {
        restaurar();
      }
    });

    test('depois do 409, a mesma edicao com a lista atual grava normalmente', async () => {
      equipe.membros = [criador._id, b._id];
      Equipe.findOne.mockImplementationOnce(() => mockQuery({ ...equipe, membros: [criador._id, a._id, b._id] }));

      const conflito = await edit({ nome: 'Nova', membros: [String(a._id), String(b._id)] });

      expect(conflito.status).toBe(409);
      expect(conflito.body).toEqual(CONFLITO);
      expect(membros()).toEqual(ids([criador._id, b._id]));
      expect(equipe.nome).toBe('Equipe Original');

      const repeticao = await edit({ nome: 'Nova', membros: [String(b._id), String(semEquipe._id)] });
      expect(repeticao.status).toBe(200);
      expect(membros().sort()).toEqual(ids([criador._id, b._id, semEquipe._id]).sort());
    });

    test('a gravacao da lista e condicionada a lista lida, na mesma ordem', async () => {
      await edit({ nome: 'Nova', membros: [String(a._id)] });

      const [filtro] = Equipe.findOneAndUpdate.mock.calls[0];
      expect(ids(filtro.membros)).toEqual(original());
      expect(Equipe.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    test('edicao so do nome continua sem condicao e convive com a edicao da lista', async () => {
      const [nome, lista] = await Promise.all([
        edit({ nome: 'so o nome' }),
        edit({ nome: 'Lista', membros: [String(a._id)] }),
      ]);

      expect([nome.status, lista.status]).toEqual([200, 200]);
      expect(membros().sort()).toEqual(ids([criador._id, a._id]).sort());
    });

    test('equipe apagada entre a leitura e a gravacao continua 404, nao 409', async () => {
      Equipe.findOneAndUpdate.mockImplementationOnce(() => {
        mockState.equipes = [];
        return mockQuery(null);
      });

      const res = await edit({ nome: 'Nova', membros: [String(a._id)] });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ erro: 'Equipe não encontrada' });
    });
  });
});
