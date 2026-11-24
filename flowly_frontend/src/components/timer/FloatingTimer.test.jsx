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

test('acumulado preciso: 503 s confirmados + 37 s de sessao = 9 min (o legado mostraria 8)', async () => {
  lista = [{ ...ativa('2026-11-25T14:59:23.000Z'), tempoGasto: 8, tempoGastoSegundos: 503 }];
  await montar();
  expect(screen.getByText('9 min')).toBeInTheDocument();
});

test('tarefa antiga sem o campo novo continua usando tempoGasto', async () => {
  lista = [{ ...ativa('2026-11-25T14:59:00.000Z'), tempoGasto: 8 }];
  await montar();
  expect(screen.getByText('9 min')).toBeInTheDocument();
});

test('servidor adiantado: o cartao nao fica parado no acumulado e avanca pelo relogio local', async () => {
  // Inicio 90 s "no futuro" para o navegador; acumulado 503 s (8 min).
  lista = [{ ...ativa('2026-11-25T15:01:30.000Z'), tempoGasto: 8, tempoGastoSegundos: 503 }];
  await montar();
  expect(screen.getByText('8 min')).toBeInTheDocument();
  await act(async () => { vi.advanceTimersByTime(60000); }); // tique de 1 min (antes ficava em 8 min)
  expect(screen.getByText('9 min')).toBeInTheDocument();
});

describe('mesma base do Meu Dia', () => {
  const ID = 'a'.repeat(24);
  const salvarAncoraDoMeuDia = (inicioServidor, inicioLocal) => {
    sessionStorage.setItem('flowly:cronometro-ancoras', JSON.stringify({
      [ID]: { inicioServidor: Date.parse(inicioServidor), inicioLocal: Date.parse(inicioLocal) },
    }));
  };

  test('11 min 59 s mostra 11 min e 12 min 00 s mostra 12 min no segundo seguinte, sem HTTP extra', async () => {
    // Ancora salva pelo Meu Dia nesta aba: sessao local de 119 s sobre 600 s acumulados = 11 min 59 s.
    const inicio = '2026-11-25T15:00:20.000Z'; // servidor 20 s adiantado
    salvarAncoraDoMeuDia(inicio, '2026-11-25T14:58:01.000Z');
    lista = [{ ...ativa(inicio), tempoGasto: 10, tempoGastoSegundos: 600 }];
    const { unmount } = await montar();
    expect(screen.getByText('11 min')).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText('12 min')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledTimes(1); // so a consulta inicial (o polling e de 2 min)
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('depois do F5 (remontado) continua coerente com a mesma ancora', async () => {
    const inicio = '2026-11-25T15:00:20.000Z';
    salvarAncoraDoMeuDia(inicio, '2026-11-25T14:57:00.000Z');
    lista = [{ ...ativa(inicio), tempoGasto: 0, tempoGastoSegundos: 0 }];
    const primeira = await montar();
    expect(screen.getByText('3 min')).toBeInTheDocument();
    primeira.unmount();
    await montar();
    expect(screen.getByText('3 min')).toBeInTheDocument();
  });
});
