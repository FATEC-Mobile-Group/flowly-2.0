// Cartao dos cronometros ativos: ocultar nao pausa, a sessao oculta nao volta, uma nova sessao volta, e o cartao
// some assim que outra tela avisa a pausa confirmada (sem esperar o polling de 2 min, que continua existindo).
import { act, fireEvent, render, screen } from '@testing-library/react';
import { authUtils } from '../../config/authUtils';
import FloatingTimer from './FloatingTimer';

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
vi.mock('../../config/apiClient', () => ({ __esModule: true, default: { get: apiGet, put: apiPut } }));

const ME = 'd'.repeat(24);
const ativa = (inicio = '2026-11-25T14:58:00.000Z') => ({
  _id: 'a'.repeat(24), descricao: 'Desenvolvimento do Figma', cronometroAtivo: true, tempoGasto: 0,
  ultimaAtualizacaoCronometro: inicio, user: { _id: ME },
});
let lista;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-25T15:00:00.000Z'));
  sessionStorage.clear();
  vi.spyOn(authUtils, 'getUserId').mockReturnValue(ME);
  lista = [ativa()];
  apiGet.mockReset();
  apiPut.mockReset();
  apiGet.mockImplementation(async () => ({ data: lista }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const montar = async () => {
  const view = render(<FloatingTimer />);
  await act(async () => {});
  return view;
};

test('mostra o cronometro ativo com o tempo da sessao', async () => {
  await montar();
  expect(screen.getByText('Desenvolvimento do F...')).toBeInTheDocument();
  expect(screen.getByText('2 min')).toBeInTheDocument();
});

test('ocultar (x, tambem por teclado) esconde sem pausar e a mesma sessao nao reaparece em outra pagina', async () => {
  const { unmount } = await montar();
  const fechar = screen.getByRole('button', { name: /Ocultar o aviso do cronômetro de Desenvolvimento do Figma/ });
  fechar.focus();
  expect(fechar).toHaveFocus();
  fireEvent.click(fechar);
  expect(screen.queryByText('2 min')).toBeNull();
  expect(apiPut).not.toHaveBeenCalled();

  unmount(); // troca de pagina remonta o componente
  await montar();
  expect(screen.queryByText('Desenvolvimento do F...')).toBeNull();
});

test('nova sessao (novo inicio) volta a aparecer depois de ocultar a anterior', async () => {
  await montar();
  fireEvent.click(screen.getByRole('button', { name: /Ocultar o aviso/ }));
  lista = [ativa('2026-11-25T15:00:00.000Z')];
  await act(async () => { window.dispatchEvent(new Event('flowly:cronometro-atualizado')); });
  expect(screen.getByText('Desenvolvimento do F...')).toBeInTheDocument();
});

test('pausa confirmada em outra tela: o cartao some na hora (evento), sem esperar o polling', async () => {
  await montar();
  lista = [{ ...ativa(), cronometroAtivo: false }];
  await act(async () => { window.dispatchEvent(new Event('flowly:cronometro-atualizado')); });
  expect(screen.queryByText('Desenvolvimento do F...')).toBeNull();
});

test('polling de 2 minutos continua atualizando sozinho', async () => {
  await montar();
  lista = [];
  await act(async () => { vi.advanceTimersByTime(120000); });
  expect(apiGet).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Desenvolvimento do F...')).toBeNull();
});
