const request = require('supertest');
const mongoose = require('mongoose');
const { Readable: MockReadable } = require('stream');

// Anexos no chat da equipe: upload (acesso antes do Multer, legenda moderada, moderacao do arquivo, Storage,
// MongoDB e so entao Socket.IO), idempotencia por clientMessageId, limpeza de objetos, download privado e historico.
// Nada sai da maquina: Cloud Storage, Google Auth/Vision, banco, socket e notificacoes sao simulados.

const mockState = { users: [], equipes: [], messages: [], objetos: new Map() };
const mockStorage = { falharSave: false, falharDelete: 0, falharConsulta: false, barreira: null };
const mockSaves = [];
const mockDeletes = [];
const mockEmits = [];
const mockNotify = jest.fn(async () => []);
const mockIo = { ativo: true, falhar: false };
const mockSame = (a, b) => a != null && b != null && String(a) === String(b);

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({
      name: 'bucket-de-teste',
      file: (caminho) => ({
        save: async (buffer) => {
          mockSaves.push(caminho);
          if (mockStorage.barreira) await mockStorage.barreira(caminho);
          if (mockStorage.falharSave) throw new Error('GCS 503 projeto-secreto');
          mockState.objetos.set(caminho, Buffer.from(buffer));
        },
        delete: async () => {
          mockDeletes.push(caminho);
          if (mockStorage.falharDelete > 0) {
            mockStorage.falharDelete -= 1;
            throw new Error('GCS delete falhou');
          }
          mockState.objetos.delete(caminho);
        },
        exists: async () => {
          if (mockStorage.falharConsulta) throw new Error('GCS 503 projeto-secreto');
          return [mockState.objetos.has(caminho)];
        },
        getMetadata: async () => [{ size: mockState.objetos.get(caminho)?.length }],
        createReadStream: () => MockReadable.from([mockState.objetos.get(caminho)]),
      }),
    }),
  })),
}));

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: async () => ({ getAccessToken: async () => ({ token: 'token-de-teste' }) }),
  })),
}));

jest.mock('../utils/socketInstance', () => ({
  setIo: jest.fn(),
  getIo: () => (mockIo.ativo ? {
    to: (room) => ({
      emit: (event, payload) => {
        if (mockIo.falhar) throw new Error('socket caiu');
        // Registra se a mensagem ja estava gravada no instante da emissao.
        const gravada = mockState.messages.some((m) => mockSame(m._id, payload._id));
        mockEmits.push({ room, event, payload, gravada });
      },
    }),
  } : null),
}));

jest.mock('../utils/notificationService', () => ({ notifyUsers: (...args) => mockNotify(...args) }));

const mockQuery = (produce) => {
  const state = { populate: false, sort: null, limit: null };
  const query = {
    select: () => query,
    lean: () => query,
    populate: () => { state.populate = true; return query; },
    sort: (spec) => { state.sort = spec; return query; },
    limit: (n) => { state.limit = n; return query; },
    then: (resolve, reject) => Promise.resolve().then(() => produce(state)).then(resolve, reject),
    catch: (reject) => Promise.resolve().then(() => produce(state)).catch(reject),
  };
  return query;
};

jest.mock('../models/User', () => ({
  findById: jest.fn((id) => mockQuery(() => mockState.users.find((user) => mockSame(user._id, id)) || null)),
}));

jest.mock('../models/Equipe', () => ({
  findOne: jest.fn((filter) => mockQuery(() => mockState.equipes.find((equipe) => {
    if (!mockSame(equipe._id, filter._id)) return false;
    if (filter.$or) {
      return filter.$or.some((cond) => (cond.membros
        ? equipe.membros.some((m) => mockSame(m, cond.membros))
        : mockSame(equipe.createdBy, cond.createdBy)));
    }
    return !filter.membros || equipe.membros.some((m) => mockSame(m, filter.membros));
  }) || null)),
  updateMany: jest.fn(async () => ({})),
}));

// Message com o schema real (validacao do contrato) e um "banco" em memoria com indice unico de _id.
jest.mock('../models/Message', () => {
  const RealMessage = jest.requireActual('../models/Message');
  const { Types } = jest.requireActual('mongoose');
  // Copia profunda que preserva ObjectId, Date e Buffer (structuredClone os transformaria em objetos comuns).
  const clone = (value) => {
    if (value instanceof Types.ObjectId || value instanceof Date || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
    return value;
  };
  const toDoc = (raw, populate) => {
    if (!raw) return null;
    const copy = clone(raw);
    if (populate) {
      const user = mockState.users.find((u) => mockSame(u._id, copy.user));
      copy.user = user ? { _id: user._id, nome: user.nome, fotoPerfil: user.fotoPerfil } : copy.user;
    }
    return { ...copy, toObject: () => clone(copy) };
  };
  const hydrate = (raw) => new RealMessage(raw).toObject();
  const matches = (msg, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === 'createdAt') {
      return (!value.$lt || msg.createdAt < value.$lt) && (!value.$gt || msg.createdAt > value.$gt);
    }
    return mockSame(msg[key], value);
  });
  return {
    create: jest.fn(async (docs) => docs.map((doc) => {
      const instance = new RealMessage(doc);
      const invalid = instance.validateSync();
      if (invalid) throw invalid;
      if (mockState.messages.some((m) => mockSame(m._id, instance._id))) {
        throw Object.assign(new Error('E11000 duplicate key error collection: messages index: _id_'), { code: 11000 });
      }
      const raw = { ...instance.toObject(), createdAt: new Date(), updatedAt: new Date() };
      mockState.messages.push(raw);
      return toDoc(raw);
    })),
    findById: jest.fn((id) => mockQuery((state) => toDoc(mockState.messages.find((m) => mockSame(m._id, id)), state.populate))),
    findOne: jest.fn((filter) => mockQuery((state) => toDoc(mockState.messages.find((m) => matches(m, filter)), state.populate))),
    find: jest.fn((filter) => mockQuery((state) => {
      let list = mockState.messages.filter((m) => matches(m, filter)).map(hydrate)
        .map((m, i) => ({ ...m, createdAt: mockState.messages.filter((x) => matches(x, filter))[i].createdAt }));
      const dir = state.sort?.createdAt || 1;
      list.sort((a, b) => (a.createdAt - b.createdAt) * dir);
      if (state.limit) list = list.slice(0, state.limit);
      return list.map((m) => toDoc(m, state.populate));
    })),
  };
});

const Message = require('../models/Message');
const { issueAuthToken } = require('../utils/faceAuth');
const chat = require('../services/chatAttachmentService');
const app = require('../app');

const VISION = 'https://vision.googleapis.com/v1/images:annotate';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 3)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 4)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF');
const SEGURO = { adult: 'VERY_UNLIKELY', racy: 'UNLIKELY', violence: 'VERY_UNLIKELY' };

const id = () => new mongoose.Types.ObjectId();
const uuid = () => require('crypto').randomUUID();
const fetchOriginal = global.fetch;
const mockFetch = jest.fn();
let vision;

const chamadasVision = () => mockFetch.mock.calls.filter(([url]) => String(url).startsWith(VISION)).length;
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('anexos no chat da equipe', () => {
  let ana;
  let bruno;
  let estranho;
  let equipe;
  let outraEquipe;
  let errorSpy;

  const bearer = (user) => `Bearer ${issueAuthToken(user)}`;
  const enviar = (user, {
    equipeId = equipe._id, arquivo = PNG, nome = 'foto.png', tipo = 'image/png', clientMessageId = uuid(), legenda, semArquivo = false,
  } = {}) => {
    const req = request(app).post(`/api/equipes/${equipeId}/mensagens/anexos`);
    if (user) req.set('Authorization', bearer(user));
    if (clientMessageId !== null) req.field('clientMessageId', clientMessageId);
    if (legenda !== undefined) req.field('legenda', legenda);
    return semArquivo ? req : req.attach('file', arquivo, { filename: nome, contentType: tipo });
  };
  const baixar = (user, equipeId, messageId, query = '') => {
    const req = request(app).get(`/api/equipes/${equipeId}/mensagens/${messageId}/anexo${query}`).buffer(true)
      .parse((res, done) => {
        const partes = [];
        res.on('data', (parte) => partes.push(parte));
        res.on('end', () => done(null, Buffer.concat(partes)));
      });
    return user ? req.set('Authorization', bearer(user)) : req;
  };
  const corpoJson = (res) => JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : JSON.stringify(res.body));
  const historico = (user, query = '') => request(app).get(`/api/equipes/${equipe._id}/messages${query}`).set('Authorization', bearer(user));
  const anexosGravados = () => mockState.messages.filter((m) => m.tipo === 'anexo');
  const nadaPublicado = () => {
    expect(anexosGravados()).toHaveLength(0);
    expect(mockState.objetos.size).toBe(0);
    expect(mockEmits).toHaveLength(0);
    expect(mockNotify).not.toHaveBeenCalled();
  };

  beforeAll(() => {
    global.fetch = mockFetch;
  });

  afterAll(() => {
    global.fetch = fetchOriginal;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    ['UPLOAD_MODERATION_URL', 'UPLOAD_MODERATION_REQUIRED', 'UPLOAD_IMAGE_MODERATION_PROVIDER', 'UPLOAD_IMAGE_MODERATION_REQUIRED']
      .forEach((nome) => delete process.env[nome]);
    Object.assign(mockStorage, { falharSave: false, falharDelete: 0, falharConsulta: false, barreira: null });
    Object.assign(mockIo, { ativo: true, falhar: false });
    mockState.objetos = new Map();
    mockState.messages = [];
    mockSaves.length = 0;
    mockDeletes.length = 0;
    mockEmits.length = 0;
    vision = async () => ({ ok: true, status: 200, json: async () => ({ responses: [{ safeSearchAnnotation: SEGURO }] }) });
    mockFetch.mockImplementation(async (url) => {
      if (String(url).startsWith(VISION)) return vision();
      throw new Error(`URL inesperada: ${url}`);
    });
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    ana = { _id: id(), nome: 'Ana', email: 'ana@teste.invalid', tipo: 'user', fotoPerfil: '', authVersion: 0 };
    bruno = { _id: id(), nome: 'Bruno', email: 'bruno@teste.invalid', tipo: 'user', fotoPerfil: '', authVersion: 0 };
    estranho = { _id: id(), nome: 'Estranho', email: 'estranho@teste.invalid', tipo: 'user', fotoPerfil: '', authVersion: 0 };
    const admin = { _id: id(), nome: 'Admin', email: 'admin@teste.invalid', tipo: 'admin', fotoPerfil: '', authVersion: 0 };
    mockState.users = [ana, bruno, estranho, admin];
    equipe = { _id: id(), nome: 'Equipe Alfa', createdBy: admin._id, membros: [admin._id, ana._id, bruno._id] };
    outraEquipe = { _id: id(), nome: 'Outra', createdBy: admin._id, membros: [admin._id, estranho._id] };
    mockState.equipes = [equipe, outraEquipe];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('upload permitido', () => {
    test('PNG: 201, Storage privado, mensagem gravada, um evento depois da gravacao e uma notificacao', async () => {
      const clientMessageId = uuid();

      const res = await enviar(ana, { clientMessageId, legenda: '  print da tela  ' });
      await flush();

      expect(res.status).toBe(201);
      expect(res.body).toEqual(expect.objectContaining({ ok: true, duplicate: false }));
      const msg = res.body.message;
      expect(msg).toEqual(expect.objectContaining({ tipo: 'anexo', texto: 'print da tela', clientMessageId }));
      expect(msg.anexo).toEqual({
        nomeOriginal: 'foto.png',
        mimetype: 'image/png',
        size: PNG.length,
        enviadoEm: expect.any(String),
        downloadUrl: `/api/equipes/${equipe._id}/mensagens/${msg._id}/anexo`,
        previewUrl: `/api/equipes/${equipe._id}/mensagens/${msg._id}/anexo?disposition=inline`,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/objectPath|sha256|chat\/|token=|storage\/files/);
      expect(msg.user).toEqual(expect.objectContaining({ nome: 'Ana' }));

      const [gravada] = anexosGravados();
      expect(String(gravada._id)).toBe(String(chat.deriveMessageId(ana._id, equipe._id, clientMessageId)));
      expect(gravada.anexo.objectPath).toMatch(new RegExp(`^chat/${equipe._id}/[0-9a-f-]{36}\\.png$`));
      expect(Buffer.compare(mockState.objetos.get(gravada.anexo.objectPath), PNG)).toBe(0);

      expect(mockEmits).toHaveLength(1);
      expect(mockEmits[0]).toEqual(expect.objectContaining({ room: `equipe_${equipe._id}`, event: 'receive_message', gravada: true }));
      // Mesmo conteudo do corpo HTTP (o socket serializa Date e ObjectId em JSON, como o HTTP).
      expect(JSON.parse(JSON.stringify(mockEmits[0].payload))).toEqual(msg);
      expect(mockNotify).toHaveBeenCalledTimes(1);
      const aviso = mockNotify.mock.calls[0][0];
      expect(aviso.userIds.sort()).toEqual([String(bruno._id), String(equipe.createdBy)].sort());
      expect(aviso.metadata).toEqual(expect.objectContaining({ attachment: { nomeOriginal: 'foto.png', mimetype: 'image/png' } }));
    });

    test('PDF e JPEG: aceitos; PDF sem pre-visualizacao, legenda ausente vira texto vazio', async () => {
      const pdf = await enviar(bruno, { arquivo: PDF, nome: 'ata.pdf', tipo: 'application/pdf' });
      const jpeg = await enviar(bruno, { arquivo: JPEG, nome: 'foto.jpg', tipo: 'image/jpeg' });

      expect(pdf.status).toBe(201);
      expect(pdf.body.message.texto).toBe('');
      expect(pdf.body.message.anexo.previewUrl).toBeUndefined();
      expect(jpeg.status).toBe(201);
      expect(jpeg.body.message.anexo.previewUrl).toBeDefined();
      expect(chamadasVision()).toBe(1);
    });

    test('nome com caminho e acento (decodificado pelo Multer como latin1) chega sanitizado e em UTF-8', async () => {
      const res = await enviar(ana, { arquivo: PDF, nome: '..\\pasta/relatório final.pdf', tipo: 'application/pdf' });

      expect(res.status).toBe(201);
      expect(res.body.message.anexo.nomeOriginal).toBe('relatório final.pdf');
    });

    test('sanitizacao do nome: controle, caminho, tamanho e nome vazio', () => {
      expect(chat.sanitizeOriginalName(`rel${String.fromCharCode(7)}at${String.fromCharCode(0)}orio.pdf`)).toBe('relatorio.pdf');
      expect(chat.sanitizeOriginalName('C:\\Users\\x\\segredo.png')).toBe('segredo.png');
      expect(chat.sanitizeOriginalName('/etc/../passwd.pdf')).toBe('passwd.pdf');
      expect(chat.sanitizeOriginalName('.pdf')).toBe('arquivo.pdf');
      expect(chat.sanitizeOriginalName('')).toBe('arquivo');
      const longo = chat.sanitizeOriginalName(`${'a'.repeat(400)}.pdf`);
      expect(longo).toHaveLength(255);
      expect(longo.endsWith('.pdf')).toBe(true);
      expect(chat.sanitizeOriginalName(Buffer.from('relatório.pdf', 'utf8').toString('latin1'))).toBe('relatório.pdf');
    });

    test('o criador da equipe que nao esta na lista de membros tambem envia (mesma regra do chat de texto)', async () => {
      const criador = mockState.users.find((u) => mockSame(u._id, equipe.createdBy));
      equipe.membros = equipe.membros.filter((m) => !mockSame(m, criador._id));

      expect((await enviar(criador)).status).toBe(201);
    });
  });

  describe('recusas antes de qualquer gravacao', () => {
    test.each([
      ['sem JWT', () => null, 401],
      ['JWT invalido', () => 'invalido', 401],
      ['usuario de outra equipe', () => estranho, 404],
    ])('%s: %s sem Storage, Vision ou mensagem', async (_caso, quem, status) => {
      const user = quem();
      const req = user === 'invalido'
        ? request(app).post(`/api/equipes/${equipe._id}/mensagens/anexos`).set('Authorization', 'Bearer invalido')
          .field('clientMessageId', uuid()).attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' })
        : enviar(user);

      const res = await req;

      expect(res.status).toBe(status);
      expect(chamadasVision()).toBe(0);
      expect(mockSaves).toHaveLength(0);
      nadaPublicado();
    });

    test('sessao revogada (authVersion mudou): 401', async () => {
      const token = bearer(ana);
      ana.authVersion = 1;

      const res = await request(app).post(`/api/equipes/${equipe._id}/mensagens/anexos`).set('Authorization', token)
        .field('clientMessageId', uuid()).attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' });

      expect(res.status).toBe(401);
      nadaPublicado();
    });

    test('id de equipe malformado: 404', async () => {
      expect((await enviar(ana, { equipeId: 'nao-e-id' })).status).toBe(404);
    });

    test('arquivo ausente: 400', async () => {
      const res = await enviar(ana, { semArquivo: true });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Nenhum arquivo enviado.' });
      nadaPublicado();
    });

    test.each([
      ['ausente', null],
      ['malformado', 'nao-e-uuid'],
    ])('clientMessageId %s: 400', async (_caso, clientMessageId) => {
      const res = await enviar(ana, { clientMessageId });

      expect(res.status).toBe(400);
      expect(res.body.codigo).toBe('invalid_client_message_id');
      expect(chamadasVision()).toBe(0);
      nadaPublicado();
    });

    test('acima de 10 MB: 413 do Multer', async () => {
      const grande = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024, 1)]);

      expect((await enviar(ana, { arquivo: grande })).status).toBe(413);
      nadaPublicado();
    });

    test.each([
      ['extensao incompatível com o MIME', { nome: 'foto.pdf', tipo: 'image/png' }],
      ['tipo nao permitido', { arquivo: Buffer.from('GIF89a'), nome: 'anim.gif', tipo: 'image/gif' }],
      ['documento Word (formato nao suportado)', { arquivo: Buffer.from('PK'), nome: 'doc.docx', tipo: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }],
    ])('%s: 400 antes da moderacao', async (_caso, opcoes) => {
      const res = await enviar(ana, opcoes);

      expect(res.status).toBe(400);
      expect(chamadasVision()).toBe(0);
      nadaPublicado();
    });

    test('assinatura falsa (PNG declarado com bytes de PDF): 422 invalid_file', async () => {
      const res = await enviar(ana, { arquivo: PDF, nome: 'foto.png', tipo: 'image/png' });

      expect(res.status).toBe(422);
      expect(res.body.codigo).toBe('invalid_file');
      nadaPublicado();
    });

    test('moderacao bloqueia o conteudo: 422 upload_blocked', async () => {
      vision = async () => ({ ok: true, status: 200, json: async () => ({ responses: [{ safeSearchAnnotation: { ...SEGURO, adult: 'VERY_LIKELY' } }] }) });

      const res = await enviar(ana);

      expect(res.status).toBe(422);
      expect(res.body.codigo).toBe('upload_blocked');
      nadaPublicado();
    });

    test('moderacao indisponivel: 503 moderation_unavailable', async () => {
      vision = async () => ({ ok: false, status: 503, text: async () => 'fora' });

      const res = await enviar(ana);

      expect(res.status).toBe(503);
      expect(res.body.codigo).toBe('moderation_unavailable');
      nadaPublicado();
    });

    test('legenda rejeitada: 422 caption_blocked, antes da moderacao visual', async () => {
      const res = await enviar(ana, { legenda: 'você é um idiota' });

      expect(res.status).toBe(422);
      expect(res.body).toEqual({ erro: expect.stringContaining('insulto'), codigo: 'caption_blocked' });
      expect(chamadasVision()).toBe(0);
      nadaPublicado();
    });

    test('legenda segue a mesma politica do texto: palavrao e odio dao 422, sem repetir o texto', async () => {
      const palavrao = await enviar(ana, { legenda: 'Que merda, o print saiu cortado' });
      expect(palavrao.status).toBe(422);
      expect(palavrao.body).toEqual({ erro: expect.stringContaining('palavrões'), codigo: 'caption_blocked' });

      const odio = await enviar(ana, { legenda: 'Morte aos judeus' });
      expect(odio.status).toBe(422);
      expect(odio.body).toEqual({ erro: expect.stringContaining('ódio'), codigo: 'caption_blocked' });
      expect(JSON.stringify([palavrao.body, odio.body])).not.toMatch(/merda|judeus/i);
      expect(chamadasVision()).toBe(0);
      nadaPublicado();
    });

    test('legenda longa demais: 400', async () => {
      expect((await enviar(ana, { legenda: 'a'.repeat(4001) })).status).toBe(400);
      nadaPublicado();
    });
  });

  describe('falhas depois da validacao', () => {
    test('falha no Storage: 503, nenhuma mensagem, nenhum evento', async () => {
      mockStorage.falharSave = true;

      const res = await enviar(ana);

      expect(res.status).toBe(503);
      expect(res.body.codigo).toBe('storage_unavailable');
      expect(JSON.stringify(res.body)).not.toMatch(/GCS|projeto-secreto/);
      nadaPublicado();
    });

    test('falha no MongoDB: 503 e o objeto desta tentativa e removido', async () => {
      Message.create.mockImplementationOnce(async () => { throw new Error('MongoNetworkError'); });

      const res = await enviar(ana);

      expect(res.status).toBe(503);
      expect(res.body.codigo).toBe('persistence_failed');
      expect(mockSaves).toHaveLength(1);
      expect(mockDeletes).toEqual([mockSaves[0]]);
      nadaPublicado();
    });

    test('limpeza falhou duas vezes: 503 e o caminho fica registrado no log para a limpeza posterior', async () => {
      Message.create.mockImplementationOnce(async () => { throw new Error('MongoNetworkError'); });
      mockStorage.falharDelete = 2;

      const res = await enviar(ana);

      expect(res.status).toBe(503);
      expect(mockDeletes).toEqual([mockSaves[0], mockSaves[0]]);
      expect(mockState.objetos.has(mockSaves[0])).toBe(true);
      expect(errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(`objeto orfao para limpeza posterior: ${mockSaves[0]}`);
      expect(anexosGravados()).toHaveLength(0);
      expect(mockEmits).toHaveLength(0);
    });

    test('limpeza falhou uma vez e funcionou na segunda tentativa', async () => {
      Message.create.mockImplementationOnce(async () => { throw new Error('MongoNetworkError'); });
      mockStorage.falharDelete = 1;

      await enviar(ana);

      expect(mockDeletes).toHaveLength(2);
      expect(mockState.objetos.size).toBe(0);
    });

    test('falha na emissao do Socket.IO nao apaga a mensagem; o historico a recupera', async () => {
      mockIo.falhar = true;
      const antes = new Date(Date.now() - 1000).toISOString();

      const res = await enviar(ana);
      const recuperada = await historico(bruno, `?after=${antes}`);

      expect(res.status).toBe(201);
      expect(anexosGravados()).toHaveLength(1);
      expect(recuperada.status).toBe(200);
      expect(recuperada.body.map((m) => m._id)).toContain(res.body.message._id);
    });

    test('sem servidor de socket: grava e responde normalmente', async () => {
      mockIo.ativo = false;

      expect((await enviar(ana)).status).toBe(201);
      expect(anexosGravados()).toHaveLength(1);
    });
  });

  describe('idempotencia por clientMessageId', () => {
    test('repetir o mesmo envio devolve a mesma mensagem: um arquivo, um evento, uma notificacao', async () => {
      const clientMessageId = uuid();

      const primeiro = await enviar(ana, { clientMessageId });
      const repeticao = await enviar(ana, { clientMessageId });
      await flush();

      expect(primeiro.status).toBe(201);
      expect(repeticao.status).toBe(200);
      expect(repeticao.body).toEqual(expect.objectContaining({ ok: true, duplicate: true }));
      expect(repeticao.body.message._id).toBe(primeiro.body.message._id);
      expect(anexosGravados()).toHaveLength(1);
      expect(mockState.objetos.size).toBe(1);
      expect(mockSaves).toHaveLength(1);
      expect(mockEmits).toHaveLength(1);
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(chamadasVision()).toBe(1);
    });

    test('mesmo clientMessageId com outro arquivo: 409, nada novo', async () => {
      const clientMessageId = uuid();
      await enviar(ana, { clientMessageId });

      const res = await enviar(ana, { clientMessageId, arquivo: JPEG, nome: 'outra.jpg', tipo: 'image/jpeg' });

      expect(res.status).toBe(409);
      expect(res.body.codigo).toBe('client_message_id_conflict');
      expect(anexosGravados()).toHaveLength(1);
      expect(mockState.objetos.size).toBe(1);
    });

    test('duas tentativas simultaneas do mesmo envio: uma grava, a outra recebe a mesma mensagem e seu objeto sai', async () => {
      const clientMessageId = uuid();
      let liberar;
      const ambasSalvando = new Promise((resolve) => { liberar = resolve; });
      mockStorage.barreira = async () => {
        if (mockSaves.length >= 2) liberar();
        await ambasSalvando;
      };

      const [a, b] = await Promise.all([enviar(ana, { clientMessageId }), enviar(ana, { clientMessageId })]);
      await flush();

      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.message._id).toBe(b.body.message._id);
      expect(mockSaves).toHaveLength(2);
      expect(anexosGravados()).toHaveLength(1);
      expect(mockState.objetos.size).toBe(1);
      expect([...mockState.objetos.keys()]).toEqual([anexosGravados()[0].anexo.objectPath]);
      expect(mockEmits).toHaveLength(1);
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    test('o mesmo clientMessageId de outro usuario ou outra equipe e outro envio', async () => {
      const clientMessageId = uuid();

      const daAna = await enviar(ana, { clientMessageId });
      const doBruno = await enviar(bruno, { clientMessageId });

      expect([daAna.status, doBruno.status]).toEqual([201, 201]);
      expect(daAna.body.message._id).not.toBe(doBruno.body.message._id);
    });
  });

  describe('download privado', () => {
    const enviarPdf = async () => (await enviar(ana, { arquivo: PDF, nome: 'relatório.pdf', tipo: 'application/pdf' })).body.message;

    test('membro baixa com nome original, nosniff e sem cache', async () => {
      const msg = await enviarPdf();

      const res = await baixar(bruno, equipe._id, msg._id);

      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body, PDF)).toBe(0);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(`attachment; filename="relat_rio.pdf"; filename*=UTF-8''relat%C3%B3rio.pdf`);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    test('pre-visualizacao inline so para imagem; PDF continua attachment', async () => {
      const imagem = (await enviar(ana)).body.message;
      const pdf = await enviarPdf();

      const img = await baixar(bruno, equipe._id, imagem._id, '?disposition=inline');
      const doc = await baixar(bruno, equipe._id, pdf._id, '?disposition=inline');

      expect(img.headers['content-disposition']).toMatch(/^inline; filename="foto\.png"/);
      expect(doc.headers['content-disposition']).toMatch(/^attachment;/);
    });

    test('nao membro: 404, mesmo conhecendo os ids', async () => {
      const msg = await enviarPdf();

      const res = await baixar(estranho, equipe._id, msg._id);

      expect(res.status).toBe(404);
      expect(corpoJson(res)).toEqual({ erro: 'Equipe não encontrada' });
    });

    test('mensagem de outra equipe pelo caminho de uma equipe acessivel: 404', async () => {
      const daOutra = (await enviar(estranho, { equipeId: outraEquipe._id })).body.message;
      const admin = mockState.users.find((u) => u.tipo === 'admin');

      const res = await baixar(admin, equipe._id, daOutra._id);

      expect(res.status).toBe(404);
      expect(corpoJson(res)).toEqual({ erro: 'Anexo não encontrado' });
    });

    test.each([
      ['mensagem de texto', 'texto'],
      ['id inexistente', 'inexistente'],
      ['id malformado', 'malformado'],
      ['objeto fora da pasta da equipe', 'fora'],
    ])('%s: 404', async (_caso, tipo) => {
      let messageId = String(id());
      if (tipo === 'texto') {
        const [texto] = await Message.create([{ texto: 'oi', user: ana._id, equipe: equipe._id }]);
        messageId = String(texto._id);
      }
      if (tipo === 'malformado') messageId = 'nao-e-id';
      if (tipo === 'fora') {
        // O objeto existe, mas na pasta de outra equipe: o vinculo nao confere e nada e servido.
        const msg = await enviarPdf();
        const alheio = `chat/${outraEquipe._id}/x.pdf`;
        mockState.objetos.set(alheio, Buffer.from('%PDF alheio'));
        anexosGravados()[0].anexo.objectPath = alheio;
        messageId = msg._id;
      }

      const res = await baixar(ana, equipe._id, messageId);
      expect(res.status).toBe(404);
      if (tipo !== 'malformado') expect(corpoJson(res)).toEqual({ erro: 'Anexo não encontrado' });
    });

    test('falha no Storage: 503 sem detalhe interno; objeto ausente: 404', async () => {
      const msg = await enviarPdf();
      mockStorage.falharConsulta = true;
      const falha = await baixar(ana, equipe._id, msg._id);
      mockStorage.falharConsulta = false;
      mockState.objetos.clear();
      const ausente = await baixar(ana, equipe._id, msg._id);

      expect(falha.status).toBe(503);
      expect(JSON.stringify(corpoJson(falha))).not.toMatch(/GCS|projeto-secreto/);
      expect(ausente.status).toBe(404);
    });

    test('sem JWT: 401', async () => {
      const msg = await enviarPdf();

      expect((await baixar(null, equipe._id, msg._id)).status).toBe(401);
    });
  });

  describe('historico', () => {
    const textoAntigo = (texto, minutos) => {
      // Mensagem antiga: gravada antes do campo tipo existir.
      mockState.messages.push({
        _id: id(), texto, user: ana._id, equipe: equipe._id, createdAt: new Date(Date.now() - minutos * 60000), updatedAt: new Date(),
      });
    };

    test('mensagens antigas de texto continuam iguais; anexos aparecem com a visao publica', async () => {
      textoAntigo('bom dia', 10);
      textoAntigo('reuniao as 14h', 5);
      const anexo = (await enviar(bruno, { legenda: 'segue o print' })).body.message;

      const res = await historico(ana);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
      expect(res.body[0]).toEqual(expect.objectContaining({ texto: 'bom dia', tipo: 'texto', user: expect.objectContaining({ nome: 'Ana' }) }));
      expect(res.body[0].anexo).toBeUndefined();
      expect(res.body[1].texto).toBe('reuniao as 14h');
      expect(res.body[2]).toEqual(expect.objectContaining({ _id: anexo._id, tipo: 'anexo', texto: 'segue o print' }));
      expect(res.body[2].anexo).toEqual(anexo.anexo);
      expect(JSON.stringify(res.body)).not.toMatch(/objectPath|sha256|chat\//);
    });

    test('paginacao opcional: limit traz as mais recentes em ordem cronologica; after recupera depois de reconectar', async () => {
      textoAntigo('m1', 30);
      textoAntigo('m2', 20);
      textoAntigo('m3', 10);
      const corte = new Date(Date.now() - 15 * 60000).toISOString();

      const ultimas = await historico(ana, '?limit=2');
      const depois = await historico(ana, `?after=${corte}`);
      const antes = await historico(ana, `?before=${corte}`);

      expect(ultimas.body.map((m) => m.texto)).toEqual(['m2', 'm3']);
      expect(depois.body.map((m) => m.texto)).toEqual(['m3']);
      expect(antes.body.map((m) => m.texto)).toEqual(['m1', 'm2']);
    });

    test.each([['?limit=0'], ['?limit=201'], ['?limit=abc'], ['?after=ontem'], ['?before=2026-11-23']])('parametro invalido %s: 400', async (query) => {
      expect((await historico(ana, query)).status).toBe(400);
    });

    test('nao membro nao le o historico: 404', async () => {
      expect((await historico(estranho)).status).toBe(404);
    });
  });

  describe('revisao final: multipart malformado, legenda na repeticao e consistencia', () => {
    const PRIVADO = /objectPath|sha256|chat\/|token=|storage\/files|bucket/;
    const BOUNDARY = '----flowlyTesteBoundary';
    const enviarCru = (corpo) => request(app)
      .post(`/api/equipes/${equipe._id}/mensagens/anexos`)
      .set('Authorization', bearer(ana))
      .set('Content-Type', `multipart/form-data; boundary=${BOUNDARY}`)
      .send(corpo);
    const parte = (cabecalhos, conteudo) => Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\n${cabecalhos}\r\n\r\n`, 'latin1'), conteudo, Buffer.from('\r\n', 'latin1'),
    ]);

    test('caractere de controle no nome do arquivo: 400 generico, sem mensagem interna e sem gravar', async () => {
      const res = await enviar(ana, { nome: `foto${String.fromCharCode(7)}.png` });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        erro: 'Não foi possível ler o arquivo enviado. Selecione o arquivo novamente e tente outra vez.',
        codigo: 'invalid_multipart',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/Malformed|busboy|multer|header/i);
      expect(chamadasVision()).toBe(0);
      nadaPublicado();
    });

    test('corpo multipart truncado (sem o fim): 400 generico', async () => {
      const corpo = Buffer.concat([
        parte('Content-Disposition: form-data; name="clientMessageId"', Buffer.from(uuid())),
        Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="foto.png"\r\nContent-Type: image/png\r\n\r\n`, 'latin1'),
        PNG.subarray(0, 20),
      ]);

      const res = await enviarCru(corpo);

      expect(res.status).toBe(400);
      expect(res.body.codigo).toBe('invalid_multipart');
      nadaPublicado();
    });

    test('cabecalho de parte malformado montado a mao: 400 generico', async () => {
      const corpo = Buffer.concat([
        Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a\u0001b.png"\r\nContent-Type: image/png\r\n\r\n`, 'latin1'),
        PNG,
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'latin1'),
      ]);

      const res = await enviarCru(corpo);

      expect(res.status).toBe(400);
      expect(res.body.codigo).toBe('invalid_multipart');
    });

    test('depois de um envio malformado, um envio valido continua funcionando', async () => {
      await enviar(ana, { nome: `foto${String.fromCharCode(7)}.png` });

      const valido = await enviar(ana);

      expect(valido.status).toBe(201);
      expect(anexosGravados()).toHaveLength(1);
    });

    test('erro interno do Multer/Storage nao vira 400: segue para o tratador de erros', () => {
      let controller;
      jest.isolateModules(() => {
        jest.doMock('../middlewares/upload', () => ({
          single: () => (_req, _res, cb) => cb(new Error('ENOSPC: sem espaco no disco temporario')),
        }));
        controller = require('../controllers/chatAttachmentController');
      });
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      controller.receberArquivo({}, res, next);

      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'ENOSPC: sem espaco no disco temporario' }));
      jest.dontMock('../middlewares/upload');
    });

    test('MulterError (ex.: limite de tamanho) continua com o tratamento atual (413)', async () => {
      const grande = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024, 1)]);

      const res = await enviar(ana, { arquivo: grande });

      expect(res.status).toBe(413);
      expect(res.body.codigo).toBeUndefined();
    });

    test('mesmo clientMessageId e arquivo com legenda diferente: 409, nada novo', async () => {
      const clientMessageId = uuid();
      const primeiro = await enviar(ana, { clientMessageId, legenda: 'versao 1' });

      const outraLegenda = await enviar(ana, { clientMessageId, legenda: 'versao 2' });
      const semLegenda = await enviar(ana, { clientMessageId });
      const mesmaLegenda = await enviar(ana, { clientMessageId, legenda: '  versao 1  ' });

      expect(primeiro.status).toBe(201);
      expect(outraLegenda.status).toBe(409);
      expect(outraLegenda.body.codigo).toBe('client_message_id_conflict');
      expect(semLegenda.status).toBe(409);
      expect(mesmaLegenda.status).toBe(200);
      expect(mesmaLegenda.body.duplicate).toBe(true);
      expect(anexosGravados()).toHaveLength(1);
      expect(anexosGravados()[0].texto).toBe('versao 1');
      expect(mockState.objetos.size).toBe(1);
      expect(mockEmits).toHaveLength(1);
    });

    test('tentativas simultaneas com legendas diferentes: uma grava, a outra 409, e so o objeto da vencedora fica', async () => {
      const clientMessageId = uuid();
      let liberar;
      const ambasSalvando = new Promise((resolve) => { liberar = resolve; });
      mockStorage.barreira = async () => {
        if (mockSaves.length >= 2) liberar();
        await ambasSalvando;
      };

      const [a, b] = await Promise.all([
        enviar(ana, { clientMessageId, legenda: 'legenda A' }),
        enviar(ana, { clientMessageId, legenda: 'legenda B' }),
      ]);

      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(anexosGravados()).toHaveLength(1);
      expect([...mockState.objetos.keys()]).toEqual([anexosGravados()[0].anexo.objectPath]);
      expect(mockDeletes).toHaveLength(1);
      expect(mockDeletes[0]).not.toBe(anexosGravados()[0].anexo.objectPath);
    });

    test('tentativa perdedora nunca remove o objeto da mensagem vencedora (mesmo envio)', async () => {
      const clientMessageId = uuid();
      let liberar;
      const ambasSalvando = new Promise((resolve) => { liberar = resolve; });
      mockStorage.barreira = async () => {
        if (mockSaves.length >= 2) liberar();
        await ambasSalvando;
      };

      await Promise.all([enviar(ana, { clientMessageId }), enviar(ana, { clientMessageId })]);

      const vencedora = anexosGravados()[0].anexo.objectPath;
      expect(mockDeletes).toHaveLength(1);
      expect(mockDeletes[0]).not.toBe(vencedora);
      expect(mockState.objetos.has(vencedora)).toBe(true);
      expect((await baixar(bruno, equipe._id, anexosGravados()[0]._id)).status).toBe(200);
    });

    test('falha na notificacao depois de gravar: resposta 201 consistente e mensagem preservada', async () => {
      mockNotify.mockImplementationOnce(async () => { throw new Error('Notification insert falhou'); });

      const res = await enviar(ana);
      await flush();

      expect(res.status).toBe(201);
      expect(res.body.duplicate).toBe(false);
      expect(anexosGravados()).toHaveLength(1);
      expect(mockEmits).toHaveLength(1);
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    test('falha no socket e na notificacao juntas: 201 e o historico continua trazendo a mensagem', async () => {
      mockIo.falhar = true;
      mockNotify.mockImplementationOnce(async () => { throw new Error('Notification insert falhou'); });

      const res = await enviar(ana);
      await flush();
      const lista = await historico(bruno);

      expect(res.status).toBe(201);
      expect(lista.body.map((m) => m._id)).toContain(res.body.message._id);
    });

    test('nenhum caminho privado no corpo HTTP, na repeticao, no socket ou no historico', async () => {
      const clientMessageId = uuid();
      const primeiro = await enviar(ana, { clientMessageId, legenda: 'oi' });
      const repeticao = await enviar(ana, { clientMessageId, legenda: 'oi' });
      const lista = await historico(bruno);

      for (const conteudo of [primeiro.body, repeticao.body, mockEmits.map((e) => e.payload), lista.body]) {
        expect(JSON.stringify(conteudo)).not.toMatch(PRIVADO);
      }
    });

    test('falha de limpeza registra so o caminho do objeto, sem nome do arquivo, legenda ou e-mail', async () => {
      Message.create.mockImplementationOnce(async () => { throw new Error('MongoNetworkError'); });
      mockStorage.falharDelete = 2;

      await enviar(ana, { nome: 'contrato-confidencial.pdf', arquivo: PDF, tipo: 'application/pdf', legenda: 'segredo da reuniao' });

      const logs = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logs).toMatch(/objeto orfao para limpeza posterior: chat\/[a-f0-9]{24}\/[0-9a-f-]{36}\.pdf/);
      expect(logs).not.toMatch(/contrato-confidencial|segredo da reuniao|ana@teste\.invalid|MongoNetworkError/);
    });
  });
});
