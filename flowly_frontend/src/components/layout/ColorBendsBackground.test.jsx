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

test('a regra existe, so muda animation-play-state e nao mexe nos 10 keyframes', () => {
  expect(css).toContain(REGRA);
  expect(css.match(/animation-play-state/g)).toHaveLength(1);
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
