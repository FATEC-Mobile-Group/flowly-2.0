// Linha de comando de gestao de perfis: sem banco real; servico e conexao sao injetados.
// O comportamento com MongoDB real (dry-run sem gravar, --apply, list) esta em adminRole.replicaSet.test.js.
const { USAGE, describeError, parseArgs, run } = require('../scripts/adminRole');
const { AdminRoleError } = require('../services/adminRoleService');

const USER_ID = 'a'.repeat(24);
const OTHER_ID = 'b'.repeat(24);
const REASON = 'Justificativa da mudanca de perfil.';
const BASE = ['--email', 'conta@teste.invalid', '--operator', 'op@teste.invalid', '--reason', REASON];

const makeDeps = (overrides = {}) => {
  const output = { log: [], error: [] };
  const deps = {
    service: {
      resolveUserId: jest.fn(async ({ userId, email }) => (userId || (email === 'destino@teste.invalid' ? OTHER_ID : USER_ID))),
      previewRoleChange: jest.fn(async (action) => ({ action, userId: USER_ID, fromRole: 'user', toRole: 'admin', faceProfileEnrolled: true })),
      bootstrapFirstAdmin: jest.fn(async () => ({ userId: USER_ID, role: 'admin' })),
      promoteToAdmin: jest.fn(async () => ({ userId: USER_ID, role: 'admin' })),
      demoteToUser: jest.fn(async () => ({ userId: USER_ID, role: 'user', transferredTeamIds: [] })),
      listAdministrativeSummary: jest.fn(async () => ({ adminCount: 1, admins: [], recentChanges: [] })),
    },
    // URI com credenciais de mentira: nunca pode aparecer na saida.
    configuredUri: () => 'mongodb://usuario:SenhaSecreta@servidor-teste:27017/flowly_teste',
    connect: jest.fn(async () => {}),
    disconnect: jest.fn(async () => {}),
    databaseName: () => 'flowly_teste',
    log: (line) => output.log.push(line),
    error: (line) => output.error.push(line),
    ...overrides,
  };
  return { deps, output };
};
const writeCalls = (deps) => ['bootstrapFirstAdmin', 'promoteToAdmin', 'demoteToUser']
  .reduce((total, name) => total + deps.service[name].mock.calls.length, 0);

describe('scripts/adminRole.js: leitura dos argumentos', () => {
  test('opcoes com valor e flags', () => {
    expect(parseArgs(['promote', ...BASE, '--dry-run'])).toEqual({
      command: 'promote',
      options: { email: 'conta@teste.invalid', operator: 'op@teste.invalid', reason: REASON, 'dry-run': true },
    });
  });

  test.each([
    [['promote', '--email'], '--email'],
    [['promote', 'solto'], 'solto'],
    [['promote', '--senha', 'x'], 'desconhecida'],
    [['promote', '--apply', '--apply', '--expect-db', 'flowly_teste'], 'repetida'],
    [['promote', '--email', '--apply', '--expect-db', 'flowly_teste'], '--email'],
  ])('%p e recusado', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe('scripts/adminRole.js: nenhuma alteracao sem pedido explicito', () => {
  test.each([
    ['sem argumentos', []],
    ['comando desconhecido', ['apagar', ...BASE, '--apply', '--expect-db', 'flowly_teste']],
    ['sem --dry-run nem --apply', ['promote', ...BASE]],
    ['--dry-run e --apply juntos', ['promote', ...BASE, '--dry-run', '--apply', '--expect-db', 'flowly_teste']],
    ['sem operador', ['promote', '--email', 'c@teste.invalid', '--reason', REASON, '--apply', '--expect-db', 'flowly_teste']],
    ['sem justificativa', ['promote', '--email', 'c@teste.invalid', '--operator', 'op', '--apply', '--expect-db', 'flowly_teste']],
    ['sem conta', ['promote', '--operator', 'op', '--reason', REASON, '--apply', '--expect-db', 'flowly_teste']],
    ['e-mail e id juntos', ['promote', ...BASE, '--user-id', USER_ID, '--apply', '--expect-db', 'flowly_teste']],
    ['transferencia fora do demote', ['promote', ...BASE, '--transfer-to-id', OTHER_ID, '--apply', '--expect-db', 'flowly_teste']],
    ['dois destinos de transferencia', ['demote', ...BASE, '--transfer-to-id', OTHER_ID, '--transfer-to-email', 'd@teste.invalid', '--apply', '--expect-db', 'flowly_teste']],
    ['list com opcao de escrita', ['list', '--operator', 'op', '--apply', '--expect-db', 'flowly_teste']],
    ['list com --recent invalido', ['list', '--operator', 'op', '--recent', 'muitos']],
  ])('%s: uso (codigo 2), sem conectar ao banco', async (_caso, argv) => {
    const { deps, output } = makeDeps();

    expect(await run(argv, deps)).toBe(2);
    expect(deps.connect).not.toHaveBeenCalled();
    expect(writeCalls(deps)).toBe(0);
    expect(deps.service.previewRoleChange).not.toHaveBeenCalled();
    expect(output.error.at(-1)).toBe(USAGE);
  });
});

describe('scripts/adminRole.js: simulacao e gravacao', () => {
  test('--dry-run chama so a simulacao do servico, nunca uma funcao de gravacao', async () => {
    const { deps, output } = makeDeps();

    expect(await run(['promote', ...BASE, '--dry-run'], deps)).toBe(0);

    expect(deps.service.previewRoleChange).toHaveBeenCalledWith('promote', {
      targetUserId: USER_ID, actor: { kind: 'operator', operator: 'op@teste.invalid' }, reason: REASON,
    });
    expect(writeCalls(deps)).toBe(0);
    expect(output.log[0]).toBe('Banco: flowly_teste');
    expect(JSON.parse(output.log[1])).toEqual(expect.objectContaining({ mode: 'dry-run', nothingWritten: true, action: 'promote' }));
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['bootstrap', 'bootstrapFirstAdmin'],
    ['promote', 'promoteToAdmin'],
    ['demote', 'demoteToUser'],
  ])('--apply em %s chama %s com o autor operador', async (command, fn) => {
    const { deps, output } = makeDeps();

    expect(await run([command, ...BASE, '--apply', '--expect-db', 'flowly_teste'], deps)).toBe(0);

    expect(deps.service[fn]).toHaveBeenCalledTimes(1);
    expect(deps.service[fn].mock.calls[0][0]).toEqual(expect.objectContaining({
      targetUserId: USER_ID, actor: { kind: 'operator', operator: 'op@teste.invalid' }, reason: REASON,
    }));
    expect(writeCalls(deps)).toBe(1);
    expect(deps.service.previewRoleChange).not.toHaveBeenCalled();
    expect(JSON.parse(output.log.at(-1))).toEqual(expect.objectContaining({ mode: 'apply', action: command }));
  });

  test('demote com --transfer-to-email resolve o destino e repassa o id', async () => {
    const { deps } = makeDeps();

    expect(await run(['demote', ...BASE, '--transfer-to-email', 'destino@teste.invalid', '--apply', '--expect-db', 'flowly_teste'], deps)).toBe(0);

    expect(deps.service.demoteToUser).toHaveBeenCalledWith(expect.objectContaining({ targetUserId: USER_ID, transferTeamsTo: OTHER_ID }));
  });

  test('--user-id dispensa a busca por e-mail no servico', async () => {
    const { deps } = makeDeps();

    expect(await run(['promote', '--user-id', USER_ID, '--operator', 'op', '--reason', REASON, '--dry-run'], deps)).toBe(0);

    expect(deps.service.resolveUserId).toHaveBeenCalledWith({ userId: USER_ID, email: undefined });
  });

  test('list repassa o operador e o limite, e so consulta', async () => {
    const { deps } = makeDeps();

    expect(await run(['list', '--operator', 'op', '--recent', '5'], deps)).toBe(0);

    expect(deps.service.listAdministrativeSummary).toHaveBeenCalledWith({ actor: { kind: 'operator', operator: 'op' }, recentChanges: 5 });
    expect(writeCalls(deps)).toBe(0);
  });
});

describe('scripts/adminRole.js: falhas e saida', () => {
  test.each([
    ['operador fora da lista', new AdminRoleError(403, 'invalid_actor', 'Operador nao autorizado para gerenciar perfis.'), 'ERRO [invalid_actor]: Operador nao autorizado para gerenciar perfis.'],
    ['ultimo admin', new AdminRoleError(409, 'last_admin', 'Nao e possivel rebaixar o ultimo administrador.'), 'ERRO [last_admin]: Nao e possivel rebaixar o ultimo administrador.'],
    ['pre-condicao com detalhe', new AdminRoleError(409, 'open_tasks', 'A conta tem tarefas abertas atribuidas.', { openTasks: 2 }), 'ERRO [open_tasks]: A conta tem tarefas abertas atribuidas. (openTasks=2)'],
  ])('erro do servico (%s): codigo 1, mensagem controlada e conexao fechada', async (_caso, err, line) => {
    const { deps, output } = makeDeps();
    deps.service.promoteToAdmin.mockRejectedValueOnce(err);

    expect(await run(['promote', ...BASE, '--apply', '--expect-db', 'flowly_teste'], deps)).toBe(1);
    expect(output.error).toEqual([line]);
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
  });

  test('erro inesperado nao vaza a mensagem (pode conter a URL do banco)', async () => {
    const { deps, output } = makeDeps();
    deps.service.promoteToAdmin.mockRejectedValueOnce(
      Object.assign(new Error('connection to mongodb+srv://admin:SenhaSecreta@cluster0.example.net failed'), { name: 'MongoServerError' })
    );

    expect(await run(['promote', ...BASE, '--apply', '--expect-db', 'flowly_teste'], deps)).toBe(1);
    expect(output.error).toEqual(['ERRO: falha inesperada (MongoServerError). Nada foi confirmado pelo script.']);
    expect(output.error.join(' ')).not.toMatch(/SenhaSecreta|mongodb\+srv|cluster0/);
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
  });

  test('falha ao conectar: codigo 1, sem a URL, e nenhuma chamada ao servico', async () => {
    const { deps, output } = makeDeps({
      connect: jest.fn(async () => { throw new Error('getaddrinfo ENOTFOUND usuario:senha@host'); }),
    });

    expect(await run(['promote', ...BASE, '--apply', '--expect-db', 'flowly_teste'], deps)).toBe(1);
    expect(output.error[0]).toBe('ERRO: falha inesperada (Error). Nada foi confirmado pelo script.');
    expect(writeCalls(deps)).toBe(0);
  });

  test('falha na resolucao da conta: nenhuma gravacao', async () => {
    const { deps, output } = makeDeps();
    deps.service.resolveUserId.mockRejectedValueOnce(new AdminRoleError(404, 'not_found', 'Conta nao encontrada.'));

    expect(await run(['promote', ...BASE, '--apply', '--expect-db', 'flowly_teste'], deps)).toBe(1);
    expect(output.error).toEqual(['ERRO [not_found]: Conta nao encontrada.']);
    expect(writeCalls(deps)).toBe(0);
  });

  test('a saida de sucesso nao repete o e-mail nem a justificativa', async () => {
    const { deps, output } = makeDeps();

    await run(['promote', ...BASE, '--apply', '--expect-db', 'flowly_teste'], deps);

    expect(output.log.join('\n')).not.toMatch(/conta@teste\.invalid|Justificativa/);
  });

  test('describeError trata ausencia de erro sem quebrar', () => {
    expect(describeError(undefined)).toBe('ERRO: falha inesperada (Error). Nada foi confirmado pelo script.');
  });
});

describe('scripts/adminRole.js: conexao explicita e destino confirmado', () => {
  test.each([
    ['--apply', ['promote', ...BASE, '--apply', '--expect-db', 'flowly_teste']],
    ['--dry-run', ['promote', ...BASE, '--dry-run']],
    ['list', ['list', '--operator', 'op']],
  ])('sem MONGO_URI (%s): codigo 2, sem conectar, nada chamado', async (_caso, argv) => {
    const { deps, output } = makeDeps({ configuredUri: () => '' });

    expect(await run(argv, deps)).toBe(2);
    expect(deps.connect).not.toHaveBeenCalled();
    expect(writeCalls(deps)).toBe(0);
    expect(deps.service.previewRoleChange).not.toHaveBeenCalled();
    expect(output.error).toEqual(['Defina MONGO_URI com a conexao pretendida: este script nao usa a conexao padrao.']);
  });

  test('MONGO_URI so com espacos conta como ausente', async () => {
    const { deps } = makeDeps({ configuredUri: () => '' });

    expect(await run(['list', '--operator', 'op'], deps)).toBe(2);
  });

  test('--apply sem --expect-db: codigo 2, sem conectar', async () => {
    const { deps, output } = makeDeps();

    expect(await run(['promote', ...BASE, '--apply'], deps)).toBe(2);
    expect(deps.connect).not.toHaveBeenCalled();
    expect(output.error[0]).toBe('--apply exige --expect-db <banco> para confirmar o destino da gravacao.');
  });

  test.each([
    ['--apply', ['promote', ...BASE, '--apply', '--expect-db', 'Flowly']],
    ['--dry-run', ['promote', ...BASE, '--dry-run', '--expect-db', 'Flowly']],
    ['list', ['list', '--operator', 'op', '--expect-db', 'Flowly']],
  ])('banco conectado diferente do --expect-db (%s): codigo 1, nada chamado e conexao fechada', async (_caso, argv) => {
    const { deps, output } = makeDeps();

    expect(await run(argv, deps)).toBe(1);
    expect(output.error).toEqual([
      'ERRO [unexpected_database]: conectado ao banco "flowly_teste", mas --expect-db pede "Flowly". Nada foi feito.',
    ]);
    expect(deps.service.resolveUserId).not.toHaveBeenCalled();
    expect(deps.service.previewRoleChange).not.toHaveBeenCalled();
    expect(deps.service.listAdministrativeSummary).not.toHaveBeenCalled();
    expect(writeCalls(deps)).toBe(0);
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
  });

  test('--expect-db igual ao banco conectado libera o --apply', async () => {
    const { deps } = makeDeps();

    expect(await run(['promote', ...BASE, '--apply', '--expect-db', 'flowly_teste'], deps)).toBe(0);
    expect(deps.service.promoteToAdmin).toHaveBeenCalledTimes(1);
  });

  test('a URI configurada (com usuario e senha) nunca aparece na saida, nem em erro', async () => {
    const ok = makeDeps();
    await run(['list', '--operator', 'op'], ok.deps);
    const falha = makeDeps({ connect: jest.fn(async () => { throw new Error('falhou mongodb://usuario:SenhaSecreta@servidor-teste'); }) });
    await run(['list', '--operator', 'op'], falha.deps);
    const divergente = makeDeps();
    await run(['list', '--operator', 'op', '--expect-db', 'outro'], divergente.deps);

    const tudo = [ok, falha, divergente].flatMap(({ output }) => [...output.log, ...output.error]).join('\n');
    expect(tudo).not.toMatch(/SenhaSecreta|usuario:|servidor-teste|mongodb:\/\//);
  });

  test('o script nao le config.mongodb.uri (que cai em localhost:27017/Flowly sem a variavel)', () => {
    const fonte = require('fs').readFileSync(require.resolve('../scripts/adminRole'), 'utf8');

    expect(fonte).not.toMatch(/config\.mongodb\.uri/);
    expect(fonte).toMatch(/process\.env\.MONGO_URI/);
  });
});
