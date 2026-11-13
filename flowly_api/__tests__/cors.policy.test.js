const { parseAllowedOrigins, isCorsOriginExplicit, isOriginAllowed } = require('../utils/corsPolicy');

const OFFICIAL = 'https://green-cliff-033f5810f.3.azurestaticapps.net';
const SECOND = 'https://flowly.example';
const EVIL = 'https://evil.example';

describe('D04: politica compartilhada de origem', () => {
  describe('leitura de CORS_ORIGIN', () => {
    test.each([
      ['uma origem', OFFICIAL, [OFFICIAL]],
      ['multiplas origens', `${OFFICIAL},${SECOND}`, [OFFICIAL, SECOND]],
      ['espacos em volta', `  ${OFFICIAL} ,  ${SECOND}  `, [OFFICIAL, SECOND]],
      ['itens vazios', `${OFFICIAL},, ,${SECOND},`, [OFFICIAL, SECOND]],
      ['curinga', '*', ['*']],
      ['vazio', '', []],
      ['ausente', undefined, []],
    ])('%s', (_label, corsOrigin, expected) => {
      expect(parseAllowedOrigins(corsOrigin)).toEqual(expected);
    });
  });

  describe.each(['production', 'development', 'test', undefined])('ambiente %s', (nodeEnv) => {
    test.each([undefined, null, ''])('sem Origin (%p) e permitido', (origin) => {
      expect(isOriginAllowed(origin, OFFICIAL, nodeEnv)).toBe(true);
    });

    test('origem da lista e permitida', () => {
      expect(isOriginAllowed(OFFICIAL, OFFICIAL, nodeEnv)).toBe(true);
    });

    test('origem fora da lista e recusada', () => {
      expect(isOriginAllowed(EVIL, OFFICIAL, nodeEnv)).toBe(false);
    });

    test('todas as origens de uma lista com espacos sao permitidas', () => {
      const corsOrigin = ` ${OFFICIAL} , ${SECOND} `;

      expect(isOriginAllowed(OFFICIAL, corsOrigin, nodeEnv)).toBe(true);
      expect(isOriginAllowed(SECOND, corsOrigin, nodeEnv)).toBe(true);
      expect(isOriginAllowed(EVIL, corsOrigin, nodeEnv)).toBe(false);
    });

    test.each([
      ['sufixo extra', `${OFFICIAL}.evil.example`],
      ['outro esquema', OFFICIAL.replace('https://', 'http://')],
      ['barra final', `${OFFICIAL}/`],
      ['porta extra', `${OFFICIAL}:8443`],
      ['maiusculas', OFFICIAL.toUpperCase()],
      ['Origin null', 'null'],
      ['lista inteira como origem', `${OFFICIAL},${SECOND}`],
    ])('origem parecida e recusada: %s', (_label, origin) => {
      expect(isOriginAllowed(origin, `${OFFICIAL},${SECOND}`, nodeEnv)).toBe(false);
    });

    test('lista vazia recusa qualquer origem informada', () => {
      expect(isOriginAllowed(EVIL, '', nodeEnv)).toBe(false);
      expect(isOriginAllowed(EVIL, ' , ', nodeEnv)).toBe(false);
    });
  });

  describe('curinga', () => {
    test.each(['development', 'test', undefined])('fora de producao (%s) libera qualquer origem', (nodeEnv) => {
      expect(isOriginAllowed(EVIL, '*', nodeEnv)).toBe(true);
      expect(isOriginAllowed(EVIL, ` ${OFFICIAL} , * `, nodeEnv)).toBe(true);
    });

    test('em producao nao libera origem alguma', () => {
      expect(isOriginAllowed(EVIL, '*', 'production')).toBe(false);
      expect(isOriginAllowed(OFFICIAL, '*', 'production')).toBe(false);
      expect(isOriginAllowed('*', '*', 'production')).toBe(false);
    });

    test('em producao a origem explicita ao lado do curinga continua valendo', () => {
      expect(isOriginAllowed(OFFICIAL, `${OFFICIAL},*`, 'production')).toBe(true);
      expect(isOriginAllowed(EVIL, `${OFFICIAL},*`, 'production')).toBe(false);
    });

    test('sem Origin continua permitido em producao', () => {
      expect(isOriginAllowed(undefined, '*', 'production')).toBe(true);
    });
  });

  describe('configuracao explicita', () => {
    test.each([
      [OFFICIAL, true],
      [` ${OFFICIAL} , ${SECOND} `, true],
      ['*', false],
      [' * ', false],
      [`${OFFICIAL},*`, false],
      ['', false],
      [' , ', false],
      [undefined, false],
    ])('%p -> %p', (corsOrigin, expected) => {
      expect(isCorsOriginExplicit(corsOrigin)).toBe(expected);
    });
  });
});
