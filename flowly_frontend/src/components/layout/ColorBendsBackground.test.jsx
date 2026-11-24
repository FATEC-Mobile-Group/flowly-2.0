import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import ColorBendsBackground from './ColorBendsBackground';
import FaceCapture from '../face/FaceCapture';

// Pausa do fundo durante a captura facial. So estrutura e CSS: o ganho de fluidez e validado no navegador.

const css = readFileSync(join(import.meta.dirname, '../../styles/components/ColorBendsBackground.css'), 'utf8')
  .replace(/\r\n/g, '\n');

const REGRA = `body:has(.face-capture-video) .color-bends-container :is(
  .xmb-wave,
  .xmb-lightbeam,
  .xmb-particles,
  .xmb-glow
) {
  animation-play-state: paused;
}`;
const SELETOR = REGRA.split('{')[0].replace(/\s+/g, ' ').trim();

// Classes que declaram `animation:` no CSS do fundo (as 10 camadas animadas).
const classesAnimadas = [...css.matchAll(/^\.([\w-]+) \{[^}]*\n {2}animation: /gm)].map(([, classe]) => classe);

afterEach(() => {
  delete navigator.mediaDevices;
});

const REDUZIDO = `@media (prefers-reduced-motion: reduce) {
  .color-bends-container :is(.xmb-wave, .xmb-lightbeam, .xmb-particles, .xmb-glow) {
    animation-play-state: paused;
  }
}`;
// Declaracoes de um seletor de topo, sem os comentarios do CSS.
const bloco = (seletor) => css.replace(/\/\*[\s\S]*?\*\//g, '').match(new RegExp(`^${seletor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1] || '';

test('a regra existe, so muda animation-play-state e nao mexe nos 10 keyframes', () => {
  expect(css).toContain(REGRA);
  // Duas pausas, ambas condicionais: a da captura facial e a de prefers-reduced-motion. Nenhuma pausa geral.
  expect(css.match(/animation-play-state/g)).toHaveLength(2);
  expect(css).toContain(REDUZIDO);
  expect(css.match(/@keyframes xmb\w+/g)).toEqual([
    '@keyframes xmbFlowA', '@keyframes xmbFlowB', '@keyframes xmbFlowC', '@keyframes xmbFlowD',
    '@keyframes xmbBeamA', '@keyframes xmbBeamB', '@keyframes xmbBeamC',
    '@keyframes xmbParticlesA', '@keyframes xmbParticlesB', '@keyframes xmbGlow',
  ]);
});

test('com o FaceCapture montado o seletor pega as 10 camadas animadas, e so elas; sem ele, nenhuma', () => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(() => new Promise(() => {})) },
  });
  render(<ColorBendsBackground />);
  expect(classesAnimadas).toHaveLength(10);
  const camadasAnimadas = classesAnimadas.map((classe) => document.querySelector(`.color-bends-container .${classe}`));
  expect(camadasAnimadas.every(Boolean)).toBe(true);

  // Pagina sem captura (Painel, Tarefas...): nada e pausado.
  expect(document.querySelectorAll(SELETOR)).toHaveLength(0);

  const captura = render(<FaceCapture onCapture={() => {}} captureMode="dual" />);
  const alvos = [...document.querySelectorAll(SELETOR)];
  expect(alvos).toHaveLength(10);
  expect(alvos).toEqual(expect.arrayContaining(camadasAnimadas));
  // O proprio video, a moldura e os botoes da captura ficam fora da regra.
  expect(alvos.some((el) => el.closest('.face-capture'))).toBe(false);

  captura.unmount();
  expect(document.querySelector('.face-capture-video')).toBeNull();
  expect(document.querySelectorAll(SELETOR)).toHaveLength(0);
});

describe('desempenho do fundo (estrutura e CSS; o ganho real so se mede no Chrome grafico)', () => {
  test('o fundo continua com as 10 camadas animadas por padrao, dentro do recorte', () => {
    render(<ColorBendsBackground />);
    const recorte = document.querySelector('.color-bends-container > .xmb-field-clip');
    expect(recorte).not.toBeNull();
    expect(recorte.getAttribute('aria-hidden')).toBe('true');
    expect(recorte.querySelector(':scope > .xmb-field')).not.toBeNull();
    expect(classesAnimadas).toHaveLength(10);
    classesAnimadas.forEach((classe) => {
      expect(recorte.querySelector(`.xmb-field > .${classe}`)).not.toBeNull();
      expect(bloco(`.${classe}`)).toMatch(/animation: \w+ \d+s /);
    });
    expect(document.querySelector('.color-bends-container > .noise-overlay')).not.toBeNull();
    // Fora das duas condicoes nada fica pausado.
    expect(css.replace(REGRA, '').replace(REDUZIDO, '')).not.toContain('animation-play-state');
  });

  test('um so desfoque refeito por quadro: no recorte (3.4px), nao no campo nem como backdrop-filter do ruido', () => {
    expect(bloco('.xmb-field-clip')).toMatch(/overflow: hidden;/);
    expect(bloco('.xmb-field-clip')).toMatch(/filter: blur\(3\.4px\);/);
    expect(bloco('.xmb-field')).not.toMatch(/filter/);
    expect(bloco('.noise-overlay')).not.toMatch(/backdrop-filter/);
    // 3.4px equivale aos dois desfoques de antes (2.75px no campo + 2px do ruido).
    expect(Math.hypot(2.75, 2)).toBeCloseTo(3.4, 1);
    // Os desfoques proprios das camadas continuam.
    expect(bloco('.xmb-wave')).toMatch(/filter: blur\(0\.65px\);/);
    expect(bloco('.xmb-lightbeam')).toMatch(/filter: blur\(0\.25px\);/);
    expect(bloco('.xmb-glow')).toMatch(/filter: blur\(12px\);/);
  });

  test('a geometria do campo e a mesma de antes: o inset compensa a margem do recorte', () => {
    expect(bloco('.xmb-field-clip')).toMatch(/inset: -12px;/);
    expect(bloco('.xmb-field')).toMatch(/inset: calc\(-18vh \+ 12px\) calc\(-12vw \+ 12px\);/);
    expect(css).toMatch(/@media \(max-width: 768px\) \{\n {2}\.xmb-field \{\n {4}inset: calc\(-12vh \+ 12px\) calc\(-42vw \+ 12px\);/);
  });
});
