// Handler send_message isolado: ACK opcional, ordem gravar -> ACK -> difundir -> notificar, sem rede e sem banco.
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
jest.mock('dotenv', () => ({ config: jest.fn() }));

const mockSaved = [];
const mockSaveImpl = { fn: async () => {} };
jest.mock('../models/Message', () => {
  const MessageMock = jest.fn(function MessageMock(data) {
    Object.assign(this, data, { _id: '64b000000000000000000001' });
    this.save = jest.fn(async () => {
      await mockSaveImpl.fn();
      mockSaved.push(this);
      return this;
    });
    this.toObject = () => ({ _id: this._id, texto: this.texto, user: this.user, equipe: this.equipe });
  });
  MessageMock.findById = jest.fn(() => ({
    populate: async () => ({
      toObject: () => ({ _id: '64b000000000000000000001', texto: mockSaved[0]?.texto, user: { _id: 'u1', nome: 'Ana', fotoPerfil: null } }),
    }),
  }));
  return MessageMock;
});
const mockEquipeFindOne = jest.fn();
jest.mock('../models/Equipe', () => ({ findOne: (...args) => mockEquipeFindOne(...args) }));
const mockUserFindById = jest.fn();
jest.mock('../models/User', () => ({ findById: (...args) => mockUserFindById(...args) }));
const mockNotifyUsers = jest.fn(async () => []);
jest.mock('../utils/notificationService', () => ({ notifyUsers: (...args) => mockNotifyUsers(...args) }));
jest.mock('../services/storage', () => ({ getSignedUrl: jest.fn(async () => null) }));
const mockSaveChatInsight = jest.fn(async () => {});
const mockSaveBlockedChatInsight = jest.fn(async () => {});
jest.mock('../services/assistantInsightService', () => ({
  saveChatInsight: (...args) => mockSaveChatInsight(...args),
  saveBlockedChatInsight: (...args) => mockSaveBlockedChatInsight(...args),
}));

const Message = require('../models/Message');
const { handleSendMessage } = require('../socket_handler');

const USER_ID = '507f1f77bcf86cd799439011';
const OTHER_ID = '507f1f77bcf86cd799439012';
const TEAM_ID = '507f1f77bcf86cd799439099';

const team = { _id: TEAM_ID, nome: 'Equipe Teste', membros: [{ _id: USER_ID }, { _id: OTHER_ID }], createdBy: USER_ID };

const makeIo = (events) => ({
  to: jest.fn((room) => ({ emit: jest.fn((event, payload) => events.push({ kind: 'broadcast', room, event, payload })) })),
});
const makeSocket = (events) => ({
  user: { id: USER_ID },
  emit: jest.fn((event, payload) => events.push({ kind: 'socket', event, payload })),
});

const run = async (data, { withAck = true } = {}) => {
  const events = [];
  const io = makeIo(events);
  const socket = makeSocket(events);
  const ack = withAck ? jest.fn((response) => events.push({ kind: 'ack', response })) : undefined;
  await handleSendMessage({ io, socket, data, ack });
  return { events, io, socket, ack };
};

describe('send_message', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSaved.length = 0;
    mockSaveImpl.fn = async () => {};
    mockEquipeFindOne.mockImplementation(() => ({ populate: async () => team }));
    mockUserFindById.mockImplementation(() => ({ select: async () => ({ _id: USER_ID, nome: 'Ana', tipo: 'user' }) }));
    mockNotifyUsers.mockImplementation(async () => []);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  test('mensagem legítima: grava, confirma uma vez, difunde e notifica nessa ordem', async () => {
    const { events, ack } = await run({ equipeId: TEAM_ID, texto: '  Vou matar essa pendência hoje  ' });

    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0].texto).toBe('Vou matar essa pendência hoje');
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true, messageId: '64b000000000000000000001' });
    expect(events.map((event) => event.kind)).toEqual(['ack', 'broadcast']);
    expect(events[1]).toMatchObject({ room: `equipe_${TEAM_ID}`, event: 'receive_message' });
    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
    expect(mockNotifyUsers.mock.calls[0][0]).toMatchObject({ userIds: [OTHER_ID], tipo: 'chat' });
  });

  test('mensagem bloqueada: não grava, não difunde, não notifica e explica no ACK', async () => {
    const { events, ack, socket } = await run({ equipeId: TEAM_ID, texto: 'você é um idiota' });

    expect(Message).not.toHaveBeenCalled();
    expect(mockSaved).toHaveLength(0);
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(mockSaveChatInsight).not.toHaveBeenCalled();
    expect(events.filter((event) => event.kind === 'broadcast')).toHaveLength(0);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0][0]).toEqual({
      ok: false,
      reason: 'unsafe_content',
      blocked: true,
      message: expect.stringContaining('insulto'),
    });
    // O insight de bloqueio recebe so motivo e categoria, nunca o texto.
    expect(mockSaveBlockedChatInsight).toHaveBeenCalledTimes(1);
    const [insight] = mockSaveBlockedChatInsight.mock.calls[0];
    expect(Object.keys(insight).sort()).toEqual(['category', 'equipe', 'reason', 'userId']);
    expect(insight).toMatchObject({ userId: USER_ID, reason: 'unsafe_content', category: 'insult' });
    expect(JSON.stringify(insight)).not.toContain('idiota');
  });

  test('palavrão e ódio da política nova: bloqueados com a mensagem da categoria, sem repetir o texto', async () => {
    const palavrao = await run({ equipeId: TEAM_ID, texto: 'Que merda, o build quebrou de novo' });
    const odio = await run({ equipeId: TEAM_ID, texto: 'Morte aos judeus' });

    expect(mockSaved).toHaveLength(0);
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(palavrao.ack.mock.calls[0][0]).toEqual({
      ok: false, reason: 'unsafe_content', blocked: true, message: expect.stringContaining('palavrões'),
    });
    expect(odio.ack.mock.calls[0][0]).toEqual({
      ok: false, reason: 'unsafe_content', blocked: true, message: expect.stringContaining('discurso de ódio'),
    });
    expect(mockSaveBlockedChatInsight.mock.calls.map(([insight]) => insight.category)).toEqual(['profanity', 'hate']);
    expect(JSON.stringify([palavrao.ack.mock.calls, odio.ack.mock.calls])).not.toMatch(/merda|judeus/i);
  });

  test('depois de uma rejeição, o envio legítimo (tema acadêmico) funciona normalmente', async () => {
    await run({ equipeId: TEAM_ID, texto: 'você é um idiota' });
    const { ack, events } = await run({ equipeId: TEAM_ID, texto: 'Precisamos estudar a ascensão do nazismo' });

    expect(mockSaved).toHaveLength(1);
    expect(ack).toHaveBeenCalledWith({ ok: true, messageId: '64b000000000000000000001' });
    expect(events.filter((event) => event.kind === 'broadcast')).toHaveLength(1);
    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
  });

  test('cliente sem ACK continua recebendo message_blocked e nada é gravado', async () => {
    const { events, socket } = await run({ equipeId: TEAM_ID, texto: 'vou te matar' }, { withAck: false });

    expect(mockSaved).toHaveLength(0);
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(events.filter((event) => event.kind === 'broadcast')).toHaveLength(0);
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('message_blocked', {
      reason: 'unsafe_content',
      score: 0.95,
      message: expect.stringContaining('ameaça'),
    });
  });

  test('cliente sem ACK com mensagem legítima mantém o fluxo antigo', async () => {
    const { events, socket } = await run({ equipeId: TEAM_ID, texto: 'Bom dia, equipe' }, { withAck: false });

    expect(mockSaved).toHaveLength(1);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(events.filter((event) => event.kind === 'broadcast')).toHaveLength(1);
    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
  });

  test('falha ao gravar: ACK de erro controlado, sem detalhes internos, sem difusão nem notificação', async () => {
    mockSaveImpl.fn = async () => {
      throw new Error('MongoServerError: connection 10.0.0.5:27017 refused (secret=abc)');
    };

    const { events, ack } = await run({ equipeId: TEAM_ID, texto: 'Bom dia, equipe' });

    expect(ack).toHaveBeenCalledTimes(1);
    const response = ack.mock.calls[0][0];
    expect(response).toEqual({ ok: false, reason: 'send_failed', blocked: false, message: expect.any(String) });
    expect(JSON.stringify(response)).not.toMatch(/Mongo|27017|secret/);
    expect(events.filter((event) => event.kind === 'broadcast')).toHaveLength(0);
    expect(mockNotifyUsers).not.toHaveBeenCalled();
  });

  test('ACK de sucesso só sai depois que a gravação termina', async () => {
    let finishSave;
    mockSaveImpl.fn = () => new Promise((resolve) => {
      finishSave = resolve;
    });
    const events = [];
    const ack = jest.fn((response) => events.push({ kind: 'ack', response }));

    const pending = handleSendMessage({
      io: makeIo(events),
      socket: makeSocket(events),
      data: { equipeId: TEAM_ID, texto: 'Bom dia' },
      ack,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(finishSave).toEqual(expect.any(Function));
    expect(ack).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(mockNotifyUsers).not.toHaveBeenCalled();

    finishSave();
    await pending;

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true, messageId: '64b000000000000000000001' });
  });

  test.each([
    ['consulta da equipe', () => mockEquipeFindOne.mockImplementation(() => ({
      populate: async () => {
        throw new Error('MongoNetworkError: 10.0.0.5:27017');
      },
    }))],
    ['consulta do remetente', () => mockUserFindById.mockImplementation(() => ({
      select: async () => {
        throw new Error('MongoNetworkError: 10.0.0.5:27017');
      },
    }))],
  ])('exceção antes da gravação (%s): erro controlado, nada gravado nem notificado', async (_label, arrange) => {
    arrange();

    const { events, ack } = await run({ equipeId: TEAM_ID, texto: 'Bom dia' });

    expect(Message).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0][0]).toEqual({ ok: false, reason: 'send_failed', blocked: false, message: expect.any(String) });
    expect(JSON.stringify(ack.mock.calls[0][0])).not.toMatch(/Mongo|27017/);
    expect(events.filter((event) => event.kind === 'broadcast')).toHaveLength(0);
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(mockSaveChatInsight).not.toHaveBeenCalled();
  });

  test('falha na notificação não transforma a mensagem gravada em erro', async () => {
    mockNotifyUsers.mockImplementation(async () => {
      throw new Error('falha simulada');
    });

    const { events, ack } = await run({ equipeId: TEAM_ID, texto: 'Bom dia, equipe' });

    expect(mockSaved).toHaveLength(1);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true, messageId: '64b000000000000000000001' });
    expect(events.filter((event) => event.kind === 'broadcast')).toHaveLength(1);
  });

  test('falha ao montar a mensagem difundida usa os dados já carregados', async () => {
    Message.findById.mockImplementationOnce(() => ({
      populate: async () => {
        throw new Error('falha simulada');
      },
    }));

    const { events, ack } = await run({ equipeId: TEAM_ID, texto: 'Bom dia, equipe' });

    expect(ack).toHaveBeenCalledWith({ ok: true, messageId: '64b000000000000000000001' });
    const broadcasts = events.filter((event) => event.kind === 'broadcast');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].payload).toMatchObject({ texto: 'Bom dia, equipe', user: { _id: USER_ID, nome: 'Ana' } });
  });

  test('equipe sem acesso: ACK informa e nada é gravado', async () => {
    mockEquipeFindOne.mockImplementation(() => ({ populate: async () => null }));

    const { ack } = await run({ equipeId: TEAM_ID, texto: 'Bom dia' });

    expect(mockSaved).toHaveLength(0);
    expect(ack).toHaveBeenCalledWith({ ok: false, reason: 'team_access_denied', blocked: false, message: expect.any(String) });
  });

  test('id de equipe inválido é recusado sem consultar o banco', async () => {
    const { ack } = await run({ equipeId: { $ne: null }, texto: 'Bom dia' });

    expect(mockEquipeFindOne).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, reason: 'team_access_denied' }));
  });

  test.each([
    [{ equipeId: TEAM_ID, texto: '   ' }],
    [{ equipeId: TEAM_ID, texto: 'a'.repeat(4001) }],
    [{ equipeId: TEAM_ID, texto: { $gt: '' } }],
    [null],
  ])('conteúdo inválido é recusado: %p', async (data) => {
    const { ack } = await run(data);

    expect(mockSaved).toHaveLength(0);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, reason: 'invalid_content' }));
  });

  test('ACK que lança erro não interrompe a difusão nem a notificação', async () => {
    const events = [];
    const ack = jest.fn(() => {
      throw new Error('cliente quebrado');
    });

    await handleSendMessage({ io: makeIo(events), socket: makeSocket(events), data: { equipeId: TEAM_ID, texto: 'Bom dia' }, ack });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.kind === 'broadcast')).toHaveLength(1);
    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
  });
});
