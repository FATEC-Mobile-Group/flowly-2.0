// Linha de comando do operador: sem banco real; servico e conexao sao injetados.
const { parseArgs, run } = require('../scripts/faceRecovery');

const makeDeps = (overrides = {}) => {
  const output = { log: [], error: [] };
  const deps = {
    service: {
      requestAuthorization: jest.fn(async () => ({ authorizationId: 'a'.repeat(24), ownershipExpiresAt: new Date(0) })),
      confirmAuthorization: jest.fn(async () => ({ authorizationId: 'a'.repeat(24), expiresAt: new Date(0) })),
      revokeAuthorization: jest.fn(async () => ({ authorizationId: 'a'.repeat(24) })),
    },
    connect: jest.fn(async () => {}),
    disconnect: jest.fn(async () => {}),
    readCode: jest.fn(async () => '123456'),
    log: (line) => output.log.push(line),
    error: (line) => output.error.push(line),
    ...overrides,
  };
  return { deps, output };
};

describe('scripts/faceRecovery.js', () => {
  test('le o comando e as opcoes', () => {
    expect(parseArgs(['request', '--email', 'a@b.c', '--operator', 'op', '--reason', 'motivo longo o bastante'])).toEqual({
      command: 'request',
      options: { email: 'a@b.c', operator: 'op', reason: 'motivo longo o bastante' },
    });
  });

  test('opcao sem valor e argumento solto sao recusados', () => {
    expect(() => parseArgs(['request', '--email'])).toThrow('--email');
    expect(() => parseArgs(['request', 'solto'])).toThrow('solto');
  });

  test('comando desconhecido nao conecta ao banco', async () => {
    const { deps, output } = makeDeps();

    expect(await run(['apagar'], deps)).toBe(1);
    expect(deps.connect).not.toHaveBeenCalled();
    expect(output.error.join('\n')).toMatch(/Uso/);
  });

  test('request repassa ao servico e imprime so o id e a expiracao', async () => {
    const { deps, output } = makeDeps();

    const code = await run(['request', '--email', 'a@b.c', '--operator', 'op', '--reason', 'motivo longo o bastante'], deps);

    expect(code).toBe(0);
    expect(deps.service.requestAuthorization).toHaveBeenCalledWith({ email: 'a@b.c', operator: 'op', reason: 'motivo longo o bastante' });
    expect(JSON.parse(output.log[0])).toEqual({ authorizationId: 'a'.repeat(24), ownershipExpiresAt: new Date(0).toISOString() });
    expect(deps.disconnect).toHaveBeenCalled();
  });

  test('confirm sem --code le o codigo da entrada padrao, fora do historico do shell', async () => {
    const { deps } = makeDeps();

    expect(await run(['confirm', '--id', 'a'.repeat(24), '--operator', 'op'], deps)).toBe(0);
    expect(deps.readCode).toHaveBeenCalled();
    expect(deps.service.confirmAuthorization).toHaveBeenCalledWith({ authorizationId: 'a'.repeat(24), operator: 'op', code: '123456' });
  });

  test('erro do servico sai com 1 e fecha a conexao', async () => {
    const { deps, output } = makeDeps();
    deps.service.revokeAuthorization.mockRejectedValueOnce(new Error('Operador nao autorizado para recuperacao facial.'));

    expect(await run(['revoke', '--id', 'a'.repeat(24), '--operator', 'x', '--reason', 'fim'], deps)).toBe(1);
    expect(output.error[0]).toBe('ERRO: Operador nao autorizado para recuperacao facial.');
    expect(deps.disconnect).toHaveBeenCalled();
  });
});
