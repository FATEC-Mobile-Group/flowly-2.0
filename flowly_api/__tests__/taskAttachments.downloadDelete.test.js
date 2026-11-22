const request = require('supertest');
const mongoose = require('mongoose');
const { Readable: MockReadable } = require('stream');

// Anexos de tarefa: download autorizado com o nome original e exclusao so pelo autor.
// Nada sai da maquina: Cloud Storage, Google Auth, fetch e banco sao simulados; arquivos sao sinteticos.

const mockState = { equipes: [], tarefas: [], users: [], objetos: new Map() };
const mockStorage = { falharConsulta: false, falharLeitura: false, falharRemocao: false };
const mockDelete = jest.fn();
const mockSame = (a, b) => a != null && b != null && String(a) === String(b);

const mockQuery = (produce) => {
  const query = Promise.resolve().then(produce);
  query.select = () => query;
  query.lean = () => query;
  query.populate = () => query;
  return query;
};

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({
      name: 'bucket-de-teste',
      file: (caminho) => ({
        exists: async () => {
          if (mockStorage.falharConsulta) throw new Error('GCS 503 projeto-secreto');
          return [mockState.objetos.has(caminho)];
        },
        getMetadata: async () => [{ contentType: 'application/octet-stream', size: mockState.objetos.get(caminho)?.length }],
        createReadStream: () => {
          if (mockStorage.falharLeitura) {
            const stream = new MockReadable({ read() {} });
            process.nextTick(() => stream.emit('error', new Error('GCS leitura falhou')));
            return stream;
          }
          return MockReadable.from([mockState.objetos.get(caminho)]);
        },
        delete: async (opcoes) => {
          mockDelete(caminho, opcoes);
          if (mockStorage.falharRemocao) throw new Error('GCS 503 projeto-secreto');
          mockState.objetos.delete(caminho);
        },
        save: async (buffer) => {
          mockState.objetos.set(caminho, buffer);
        },
      }),
    }),
  })),
}));

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: async () => ({ getAccessToken: async () => ({ token: 'token-de-teste' }) }),
  })),
}));

jest.mock('../utils/activityLogger', () => jest.fn(async () => {}));

jest.mock('../models/Equipe', () => {
  const matches = (filter) => (equipe) => {
    if (filter.$or) return filter.$or.some((parte) => matches(parte)(equipe));
    return Object.entries(filter).every(([campo, valor]) =>
      campo === 'membros' ? equipe.membros.some((membro) => mockSame(membro, valor)) : mockSame(equipe[campo], valor)
    );
  };
  return {
    find: jest.fn((filter) => mockQuery(() => mockState.equipes.filter(matches(filter)).map(({ _id }) => ({ _id })))),
  };
});

jest.mock('../models/Tarefa', () => {
  const acessivel = (tarefa, filter) =>
    mockSame(tarefa._id, filter._id) && filter.equipe.$in.some((id) => mockSame(id, tarefa.equipe));
  return {
    findOne: jest.fn((filter) => mockQuery(() => mockState.tarefas.find((tarefa) => acessivel(tarefa, filter)) || null)),
    find: jest.fn((filter) => mockQuery(() => mockState.tarefas
      .filter((tarefa) => tarefa.anexos.some((anexo) => anexo.url === filter['anexos.url']))
      .map((tarefa) => ({ _id: tarefa._id, anexos: tarefa.anexos.map(({ _id, url }) => ({ _id, url })) })))),
    // $pull condicional: so retira se o anexo ainda existe e o autor confere.
    updateOne: jest.fn(async (filter, update) => {
      const alvo = filter.anexos.$elemMatch;
      const tarefa = mockState.tarefas.find((item) => acessivel(item, filter));
      const indice = tarefa ? tarefa.anexos.findIndex((anexo) =>
        mockSame(anexo._id, alvo._id) && mockSame(anexo.uploadedBy, alvo.uploadedBy)) : -1;
      if (indice < 0 || !update.$pull) return { matchedCount: 0, modifiedCount: 0 };
      tarefa.anexos.splice(indice, 1);
      return { matchedCount: 1, modifiedCount: 1 };
    }),
  };
});

jest.mock('../models/User', () => ({
  findById: jest.fn((id) => mockQuery(() => mockState.users.find((user) => mockSame(user._id, id)) || null)),
}));

const Tarefa = require('../models/Tarefa');
const logActivity = require('../utils/activityLogger');
const { issueAuthToken } = require('../utils/faceAuth');
const app = require('../app');

const id = () => new mongoose.Types.ObjectId();
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
const fetchOriginal = global.fetch;

describe('anexos de tarefa: download e exclusao', () => {
  let ana;
  let bruno;
  let estranho;
  let equipe;
  let tarefa;
  let outraTarefa;
  let anexoDaAna;
  let anexoDoBruno;
  let anexoAntigo;

  const bearer = (user) => `Bearer ${issueAuthToken(user)}`;
  const baixar = (user, tarefaId, anexoId) => {
    const req = request(app).get(`/api/tarefas/${tarefaId}/anexos/${anexoId}/download`).buffer(true)
      .parse((res, done) => {
        const partes = [];
        res.on('data', (parte) => partes.push(parte));
        res.on('end', () => done(null, Buffer.concat(partes)));
      });
    return user ? req.set('Authorization', bearer(user)) : req;
  };
  const remover = (user, tarefaId, anexoId) => {
    const req = request(app).delete(`/api/tarefas/${tarefaId}/anexos/${anexoId}`);
    return user ? req.set('Authorization', bearer(user)) : req;
  };
  const corpoJson = (res) => JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : JSON.stringify(res.body));

  const anexo = ({ dono, tarefaId, nome, conteudo = PNG, url }) => {
    const anexoId = id();
    const caminho = url || `arquivos/${tarefaId}/${anexoId}.png`;
    mockState.objetos.set(caminho, conteudo);
    return {
      _id: anexoId,
      url: caminho,
      nomeOriginal: nome,
      mimetype: 'image/png',
      size: conteudo.length,
      uploadedBy: dono ? dono._id : null,
      uploadedAt: dono ? new Date('2026-11-20T10:00:00Z') : null,
    };
  };

  beforeAll(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ responses: [{ safeSearchAnnotation: { adult: 'VERY_UNLIKELY', racy: 'UNLIKELY', violence: 'VERY_UNLIKELY' } }] }),
    }));
    delete process.env.UPLOAD_MODERATION_URL;
  });

  afterAll(() => {
    global.fetch = fetchOriginal;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(mockStorage, { falharConsulta: false, falharLeitura: false, falharRemocao: false });
    mockState.objetos = new Map();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    ana = { _id: id(), nome: 'Ana', email: 'ana@exemplo.com', tipo: 'user' };
    bruno = { _id: id(), nome: 'Bruno', email: 'bruno@exemplo.com', tipo: 'user' };
    estranho = { _id: id(), nome: 'Estranho', email: 'estranho@exemplo.com', tipo: 'user' };
    mockState.users = [ana, bruno, estranho];

    equipe = { _id: id(), nome: 'Equipe', createdBy: id(), membros: [ana._id, bruno._id] };
    const outraEquipe = { _id: id(), nome: 'Outra', createdBy: id(), membros: [estranho._id] };
    mockState.equipes = [equipe, outraEquipe];

    const tarefaId = id();
    anexoDaAna = anexo({ dono: ana, tarefaId, nome: 'relatório final (v2).png' });
    anexoDoBruno = anexo({ dono: bruno, tarefaId, nome: 'bruno.png' });
    anexoAntigo = anexo({ dono: null, tarefaId, nome: 'antigo.png' });
    tarefa = { _id: tarefaId, equipe: equipe._id, anexos: [anexoDaAna, anexoDoBruno, anexoAntigo] };

    const outraId = id();
    outraTarefa = { _id: outraId, equipe: outraEquipe._id, anexos: [anexo({ dono: estranho, tarefaId: outraId, nome: 'x.png' })] };
    mockState.tarefas = [tarefa, outraTarefa];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('download', () => {
    test('membro da equipe baixa com o nome original e o conteudo do Storage', async () => {
      const res = await baixar(bruno, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body, PNG)).toBe(0);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="relat_rio final (v2).png"; filename*=UTF-8''relat%C3%B3rio%20final%20%28v2%29.png`
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    test('anexo antigo, sem autoria, continua podendo ser baixado', async () => {
      const res = await baixar(ana, tarefa._id, anexoAntigo._id);

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('filename="antigo.png"');
    });

    test('nome com aspas e quebra de linha nao injeta cabecalho', async () => {
      anexoDaAna.nomeOriginal = 'a"b\r\nSet-Cookie: x=1.png';

      const res = await baixar(ana, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="a_b__Set-Cookie: x=1\.png"; filename\*=UTF-8''/);
    });

    test('usuario de outra equipe recebe 404 e o Storage nao e lido', async () => {
      const res = await baixar(estranho, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(404);
      expect(corpoJson(res)).toEqual({ erro: 'Tarefa não encontrada' });
    });

    test('anexo de outra tarefa nao e alcancado pela tarefa acessivel', async () => {
      const res = await baixar(ana, tarefa._id, outraTarefa.anexos[0]._id);

      expect(res.status).toBe(404);
      expect(corpoJson(res)).toEqual({ erro: 'Anexo não encontrado' });
    });

    test('sem sessao: 401', async () => {
      const res = await baixar(null, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(401);
    });

    test.each([
      ['anexo inexistente', () => [tarefa._id, id()], 'Anexo não encontrado'],
      ['id de anexo malformado', () => [tarefa._id, '..%2F..%2Fsegredo'], 'Anexo não encontrado'],
      ['id de tarefa malformado', () => ['nao-e-id', anexoDaAna._id], 'Tarefa não encontrada'],
    ])('%s: 404', async (_caso, ids, erro) => {
      const res = await baixar(ana, ...ids());

      expect(res.status).toBe(404);
      expect(corpoJson(res)).toEqual({ erro });
    });

    test('caminho externo ou local gravado no anexo nao e servido', async () => {
      anexoDaAna.url = 'https://exemplo.com/arquivo.png';
      const externo = await baixar(ana, tarefa._id, anexoDaAna._id);
      anexoDaAna.url = 'uploads/legado.png';
      const local = await baixar(ana, tarefa._id, anexoDaAna._id);

      expect(externo.status).toBe(404);
      expect(local.status).toBe(404);
    });

    test('objeto ausente no Storage: 404 claro', async () => {
      mockState.objetos.delete(anexoDaAna.url);

      const res = await baixar(ana, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(404);
      expect(corpoJson(res).erro).toMatch(/não encontrado no armazenamento/);
    });

    test('falha no Cloud Storage: 503 sem detalhe interno', async () => {
      mockStorage.falharConsulta = true;

      const res = await baixar(ana, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(503);
      expect(JSON.stringify(corpoJson(res))).not.toMatch(/GCS|projeto-secreto/);
    });

    test('falha ao ler o arquivo antes de enviar dados: 503', async () => {
      mockStorage.falharLeitura = true;

      const res = await baixar(ana, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(503);
    });
  });

  describe('exclusao', () => {
    test('autor remove: apaga o objeto da pasta da tarefa, retira o registro e registra o log', async () => {
      const caminho = anexoDaAna.url;

      const res = await remover(ana, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ msg: 'Anexo removido', anexoId: String(anexoDaAna._id), arquivoRemovido: true });
      expect(mockDelete).toHaveBeenCalledWith(caminho, { ignoreNotFound: true });
      expect(mockState.objetos.has(caminho)).toBe(false);
      expect(tarefa.anexos.map((item) => String(item._id))).toEqual([String(anexoDoBruno._id), String(anexoAntigo._id)]);
      expect(logActivity).toHaveBeenCalledWith('anexo_removido', 'Arquivo removido: relatório final (v2).png', String(ana._id), tarefa._id);
    });

    test('outro membro da equipe nao remove anexo alheio: 403 e nada muda', async () => {
      const res = await remover(bruno, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(403);
      expect(res.body.codigo).toBe('anexo_de_outro_usuario');
      expect(mockDelete).not.toHaveBeenCalled();
      expect(Tarefa.updateOne).not.toHaveBeenCalled();
      expect(tarefa.anexos).toHaveLength(3);
    });

    test('anexo antigo sem autoria: 403 conservador, mesmo para quem tem acesso', async () => {
      const res = await remover(ana, tarefa._id, anexoAntigo._id);

      expect(res.status).toBe(403);
      expect(res.body.codigo).toBe('anexo_sem_autoria');
      expect(mockDelete).not.toHaveBeenCalled();
      expect(tarefa.anexos).toHaveLength(3);
    });

    test('usuario de outra equipe: 404, mesmo sendo autor de anexos em outro lugar', async () => {
      const res = await remover(estranho, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(404);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    test('anexo de outra tarefa pelo caminho de uma tarefa acessivel: 404', async () => {
      const res = await remover(ana, tarefa._id, outraTarefa.anexos[0]._id);

      expect(res.status).toBe(404);
      expect(mockDelete).not.toHaveBeenCalled();
      expect(outraTarefa.anexos).toHaveLength(1);
    });

    test('anexo inexistente: 404', async () => {
      const res = await remover(ana, tarefa._id, id());

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ erro: 'Anexo não encontrado' });
    });

    test('id do usuario no corpo ou na query nao muda a autoria', async () => {
      const res = await remover(bruno, tarefa._id, anexoDaAna._id)
        .query({ userId: String(ana._id) })
        .send({ userId: String(ana._id), uploadedBy: String(ana._id) });

      expect(res.status).toBe(403);
      expect(tarefa.anexos).toHaveLength(3);
    });

    test('falha no Cloud Storage: 503, registro mantido e nova tentativa funciona', async () => {
      mockStorage.falharRemocao = true;

      const falha = await remover(ana, tarefa._id, anexoDaAna._id);

      expect(falha.status).toBe(503);
      expect(falha.body.codigo).toBe('storage_indisponivel');
      expect(JSON.stringify(falha.body)).not.toMatch(/GCS|projeto-secreto/);
      expect(tarefa.anexos).toHaveLength(3);
      expect(Tarefa.updateOne).not.toHaveBeenCalled();

      mockStorage.falharRemocao = false;
      const repeticao = await remover(ana, tarefa._id, anexoDaAna._id);

      expect(repeticao.status).toBe(200);
      expect(tarefa.anexos).toHaveLength(2);
    });

    test('objeto ja ausente no Storage nao impede retirar o registro', async () => {
      mockState.objetos.delete(anexoDaAna.url);

      const res = await remover(ana, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(200);
      expect(tarefa.anexos).toHaveLength(2);
    });

    describe('Storage apagou, MongoDB falhou (sem transacao entre os dois)', () => {
      const falharMongoUmaVez = () => {
        Tarefa.updateOne.mockImplementationOnce(async () => {
          throw new Error('MongoNetworkError: connection 10.0.0.5:27017 closed');
        });
      };

      test('nao responde sucesso, explica o estado e mantem o registro para repetir', async () => {
        const caminho = anexoDaAna.url;
        falharMongoUmaVez();

        const res = await remover(ana, tarefa._id, anexoDaAna._id);

        expect(res.status).toBe(500);
        expect(res.body).toEqual({
          erro: 'O arquivo foi apagado do armazenamento, mas o anexo não foi retirado da tarefa. Tente remover novamente.',
          codigo: 'remocao_incompleta',
        });
        expect(JSON.stringify(res.body)).not.toMatch(/Mongo|27017/);
        expect(mockState.objetos.has(caminho)).toBe(false);
        expect(tarefa.anexos.map((item) => String(item._id))).toContain(String(anexoDaAna._id));
        expect(logActivity).not.toHaveBeenCalled();
      });

      test('repetir a remocao conclui: Storage ja vazio nao bloqueia e o registro sai', async () => {
        const caminho = anexoDaAna.url;
        falharMongoUmaVez();
        await remover(ana, tarefa._id, anexoDaAna._id);

        const repeticao = await remover(ana, tarefa._id, anexoDaAna._id);

        expect(repeticao.status).toBe(200);
        expect(repeticao.body).toEqual({ msg: 'Anexo removido', anexoId: String(anexoDaAna._id), arquivoRemovido: true });
        expect(mockDelete).toHaveBeenCalledTimes(2);
        expect(mockDelete).toHaveBeenNthCalledWith(1, caminho, { ignoreNotFound: true });
        expect(mockDelete).toHaveBeenNthCalledWith(2, caminho, { ignoreNotFound: true });
        expect(tarefa.anexos.map((item) => String(item._id))).toEqual([String(anexoDoBruno._id), String(anexoAntigo._id)]);
        expect(logActivity).toHaveBeenCalledTimes(1);
      });

      test('a falha e a repeticao nao tocam nos arquivos dos outros anexos', async () => {
        const outros = [anexoDoBruno.url, anexoAntigo.url, outraTarefa.anexos[0].url];
        falharMongoUmaVez();

        await remover(ana, tarefa._id, anexoDaAna._id);
        await remover(ana, tarefa._id, anexoDaAna._id);

        outros.forEach((caminho) => expect(mockState.objetos.has(caminho)).toBe(true));
        expect(mockDelete.mock.calls.map(([caminho]) => caminho)).toEqual([anexoDaAna.url, anexoDaAna.url]);
      });

      test('durante o intervalo, o download do anexo responde 404 claro (nao serve outro arquivo)', async () => {
        falharMongoUmaVez();
        await remover(ana, tarefa._id, anexoDaAna._id);

        const res = await baixar(bruno, tarefa._id, anexoDaAna._id);

        expect(res.status).toBe(404);
        expect(corpoJson(res).erro).toMatch(/não encontrado no armazenamento/);
      });

      test('outro usuario continua sem poder concluir a remocao pendente', async () => {
        falharMongoUmaVez();
        await remover(ana, tarefa._id, anexoDaAna._id);

        const res = await remover(bruno, tarefa._id, anexoDaAna._id);

        expect(res.status).toBe(403);
        expect(tarefa.anexos.map((item) => String(item._id))).toContain(String(anexoDaAna._id));
      });
    });

    test('remocoes simultaneas de anexos diferentes do mesmo autor apagam so os proprios arquivos', async () => {
      const segundo = anexo({ dono: ana, tarefaId: tarefa._id, nome: 'segundo.png' });
      tarefa.anexos.push(segundo);

      const [a, b] = await Promise.all([
        remover(ana, tarefa._id, anexoDaAna._id),
        remover(ana, tarefa._id, segundo._id),
      ]);

      expect([a.status, b.status]).toEqual([200, 200]);
      expect(mockDelete.mock.calls.map(([caminho]) => caminho).sort()).toEqual([anexoDaAna.url, segundo.url].sort());
      expect(mockState.objetos.has(anexoDoBruno.url)).toBe(true);
      expect(tarefa.anexos.map((item) => String(item._id))).toEqual([String(anexoDoBruno._id), String(anexoAntigo._id)]);
    });

    test('duas remocoes simultaneas: uma remove, a outra recebe 404', async () => {
      const [primeira, segunda] = await Promise.all([
        remover(ana, tarefa._id, anexoDaAna._id),
        remover(ana, tarefa._id, anexoDaAna._id),
      ]);

      expect([primeira.status, segunda.status].sort()).toEqual([200, 404]);
      expect(tarefa.anexos).toHaveLength(2);
      expect(logActivity).toHaveBeenCalledTimes(1);
    });

    test('arquivo compartilhado com outro anexo: retira so o registro e preserva o objeto', async () => {
      const copia = { ...anexoDoBruno, _id: id(), url: anexoDaAna.url };
      tarefa.anexos.push(copia);

      const res = await remover(ana, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(200);
      expect(res.body.arquivoRemovido).toBe(false);
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockState.objetos.has(anexoDaAna.url)).toBe(true);
    });

    test('objeto fora da pasta da tarefa: retira so o registro e preserva o objeto', async () => {
      anexoDaAna.url = `arquivos/${outraTarefa._id}/alheio.png`;
      mockState.objetos.set(anexoDaAna.url, PNG);

      const res = await remover(ana, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(200);
      expect(res.body.arquivoRemovido).toBe(false);
      expect(mockDelete).not.toHaveBeenCalled();
      expect(mockState.objetos.has(anexoDaAna.url)).toBe(true);
    });

    test('sem sessao: 401', async () => {
      const res = await remover(null, tarefa._id, anexoDaAna._id);

      expect(res.status).toBe(401);
      expect(mockDelete).not.toHaveBeenCalled();
    });
  });

  describe('upload registra a autoria a partir da sessao', () => {
    test('uploadedBy vem do JWT, mesmo com outro id no formulario', async () => {
      tarefa.anexos = [];
      tarefa.save = jest.fn(async () => {});

      const res = await request(app)
        .post(`/api/tarefas/${tarefa._id}/anexos`)
        .set('Authorization', bearer(bruno))
        .field('uploadedBy', String(ana._id))
        .attach('file', PNG, { filename: 'novo.png', contentType: 'image/png' });

      expect(res.status).toBe(201);
      expect(tarefa.anexos).toHaveLength(1);
      expect(String(tarefa.anexos[0].uploadedBy)).toBe(String(bruno._id));
      expect(tarefa.anexos[0].uploadedAt).toBeInstanceOf(Date);
      expect(String(res.body.anexo.uploadedBy)).toBe(String(bruno._id));
      expect(logActivity).toHaveBeenCalledWith('anexo_adicionado', 'Arquivo anexado: novo.png', String(bruno._id), tarefa._id);
    });
  });
});
