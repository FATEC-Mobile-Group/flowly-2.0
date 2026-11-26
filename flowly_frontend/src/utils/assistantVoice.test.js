import { aplicarVoz, encontrarVozTecnologica, escolherVozDoAssistente, vozAindaDisponivel } from './assistantVoice';

const voz = (name, lang, extra = {}) => ({ name, voiceURI: name, lang, localService: true, ...extra });

describe('voz do assistente', () => {
  test('identidade exata e local primeiro; depois exata; depois outra variante pt-BR do Daniel; nunca outra lingua', () => {
    const local = voz('Microsoft Daniel - Portuguese (Brazil)', 'pt-BR');
    const remota = voz('Microsoft Daniel - Portuguese (Brazil)', 'pt-BR', { localService: false });
    const edge = voz('Microsoft Daniel Online (Natural) - Portuguese (Brazil)', 'pt-BR', { localService: false });
    const ingles = voz('Daniel', 'en-GB');
    expect(encontrarVozTecnologica([ingles, edge, remota, local])).toBe(local);
    expect(encontrarVozTecnologica([ingles, edge, remota])).toBe(remota);
    expect(encontrarVozTecnologica([ingles, edge])).toBe(edge);
    expect(encontrarVozTecnologica([ingles, voz('Microsoft Maria - Portuguese (Brazil)', 'pt-BR')])).toBeNull();
    expect(encontrarVozTecnologica(null)).toBeNull();
    // voiceURI tambem identifica (nome exibido diferente).
    const porUri = { name: 'Daniel (pt)', voiceURI: 'Microsoft Daniel - Portuguese (Brazil)', lang: 'pt_BR', localService: true };
    expect(encontrarVozTecnologica([porUri])).toBe(porUri);
  });

  test('escolha e ajustes; fallback para a original e aplicacao na fala', () => {
    const daniel = voz('Microsoft Daniel - Portuguese (Brazil)', 'pt-BR');
    const google = voz('Google português do Brasil', 'pt-BR', { localService: false });
    expect(escolherVozDoAssistente([google, daniel])).toMatchObject({ perfil: 'tecnologica', voice: daniel, pitch: 0.75, rate: 1.05, volume: 1 });
    expect(escolherVozDoAssistente([google])).toMatchObject({ perfil: 'original', voice: google, rate: 1, pitch: null, tecnologicaIndisponivel: true });
    expect(escolherVozDoAssistente([google, daniel], 'original')).toMatchObject({ perfil: 'original', voice: google, tecnologicaIndisponivel: false });
    expect(escolherVozDoAssistente([])).toMatchObject({ voice: null, kind: 'none', rate: 1 });

    const fala = aplicarVoz({}, escolherVozDoAssistente([daniel]));
    expect(fala).toEqual({ voice: daniel, rate: 1.05, pitch: 0.75, volume: 1 });
    expect(aplicarVoz({}, escolherVozDoAssistente([]))).toEqual({ rate: 1 });
    expect(vozAindaDisponivel({ voice: daniel }, [daniel])).toBe(true);
    expect(vozAindaDisponivel({ voice: daniel }, [{ ...daniel }])).toBe(false);
  });
});
