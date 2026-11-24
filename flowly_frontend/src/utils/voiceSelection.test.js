import { normalizeLang, pickPortugueseVoice } from './voiceSelection';
import { VOICE_DEBUG_KEY, createVoiceTrace } from './voiceDiagnostics';

const voice = (name, lang, extra = {}) => ({ name, lang, default: false, localService: true, ...extra });

describe('pickPortugueseVoice', () => {
  test('normaliza pt-BR, pt_BR e caixa', () => {
    expect(['pt-BR', 'pt_BR', 'PT-br', ' pt_br '].map(normalizeLang)).toEqual(['pt-br', 'pt-br', 'pt-br', 'pt-br']);
  });

  test('prefere voz brasileira de melhor qualidade, de forma deterministica (independe da ordem)', () => {
    const list = [
      voice('Microsoft Maria - Portuguese (Brazil)', 'pt-BR'),
      voice('Google português do Brasil', 'pt-BR', { localService: false }),
      voice('Microsoft Francisca Online (Natural) - Portuguese (Brazil)', 'pt-BR', { localService: false }),
      voice('Microsoft Helia - Portuguese (Portugal)', 'pt-PT'),
      voice('Microsoft David - English', 'en-US', { default: true }),
    ];
    const expected = 'Microsoft Francisca Online (Natural) - Portuguese (Brazil)';
    expect(pickPortugueseVoice(list)).toMatchObject({ kind: 'pt-BR', voice: { name: expected } });
    expect(pickPortugueseVoice([...list].reverse()).voice.name).toBe(expected);
    expect(pickPortugueseVoice(list.filter((v) => !v.name.includes('Francisca'))).voice.name).toBe('Google português do Brasil');
  });

  test('nunca escolhe outro idioma; sem pt-BR usa outra variante do portugues; sem portugues, nenhuma', () => {
    expect(pickPortugueseVoice([voice('Helia', 'pt-PT'), voice('David', 'en-US', { default: true })]))
      .toMatchObject({ kind: 'pt', voice: { name: 'Helia' } });
    expect(pickPortugueseVoice([voice('David', 'en-US', { default: true }), voice('Paulina', 'es-MX')]))
      .toEqual({ voice: null, kind: 'none' });
    expect(pickPortugueseVoice([voice('Portugues falso', 'ptx-BR')])).toEqual({ voice: null, kind: 'none' });
    expect(pickPortugueseVoice(undefined)).toEqual({ voice: null, kind: 'none' });
    expect(pickPortugueseVoice([null, 'x'])).toEqual({ voice: null, kind: 'none' });
  });
});

describe('createVoiceTrace', () => {
  afterEach(() => localStorage.removeItem(VOICE_DEBUG_KEY));

  test('desligado por padrao: mede, mas nao registra nada', () => {
    const log = vi.fn();
    const trace = createVoiceTrace(log);
    trace.mark('envio');
    expect(trace.measure('resposta', 'envio')).toBeGreaterThanOrEqual(0);
    expect(log).not.toHaveBeenCalled();
  });

  test('ligado: registra so o nome da etapa e os milissegundos', () => {
    localStorage.setItem(VOICE_DEBUG_KEY, '1');
    const log = vi.fn();
    const trace = createVoiceTrace(log);
    trace.mark('envio');
    trace.measure('resposta', 'envio');
    expect(log).toHaveBeenCalledTimes(1);
    const [prefix, step, ms] = log.mock.calls[0];
    expect([prefix, step]).toEqual(['[flowly:voz]', 'resposta']);
    expect(ms).toMatch(/^\d+ ms$/);
    expect(trace.measure('resposta', 'envio')).toBeNull(); // marca usada uma vez
  });
});
