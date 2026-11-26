// Central de preferencias (PR #68): armazenamento por conta, valores invalidos, sincronia com o seletor rapido de
// aparencia (mesmo ThemeContext), interruptores imediatos, restaurar padroes e a sidebar persistida.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../config/ThemeContext';
import ThemeToggle from '../../components/layout/ThemeToggle';
import PreferenciasPage from './PreferenciasPage';
import { LOCAL_STORAGE_KEYS } from '../../config/config';
import {
  PREFERENCIAS_PADRAO,
  definirPreferencia,
  lerPreferencias,
  normalizarPreferencias,
  redefinirCacheDePreferencias,
  restaurarPreferencias,
} from '../../config/preferencias';
import { redefinirNotificacoes } from '../../components/notifications/notificationStore';

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: vi.fn(async () => ({ data: { count: 0 } })) },
  getFullApiUrl: (p) => p,
}));
vi.mock('../../components/layout/useFotoPerfil', () => ({ useFotoPerfil: () => ({ fotoUrl: '', aoFalharFoto: () => {} }) }));

const entrarComo = (id, tipo = 'user') => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, 'token');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, id);
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_TYPE, tipo);
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_NAME, 'Pessoa');
};

// A central monta a Sidebar real (nao simulada neste arquivo).
const renderCentral = () => render(
  <ThemeProvider>
    <MemoryRouter initialEntries={['/preferencias']}>
      <ThemeToggle />
      <PreferenciasPage />
    </MemoryRouter>
  </ThemeProvider>,
);

const interruptor = (nome) => screen.getByRole('switch', { name: nome });
const salvas = (id) => JSON.parse(localStorage.getItem(`flowly-preferences:${id}`) || 'null');

beforeEach(() => {
  localStorage.clear();
  redefinirCacheDePreferencias();
  redefinirNotificacoes();
  entrarComo('u-1');
});

describe('armazenamento', () => {
  test('padroes, valores invalidos ou corrompidos e isolamento por conta', () => {
    expect(lerPreferencias()).toEqual(PREFERENCIAS_PADRAO);
    expect(normalizarPreferencias({ fundoAnimado: 'nao', sidebarRecolhida: true, extra: 'x' })).toEqual({ ...PREFERENCIAS_PADRAO, sidebarRecolhida: true });
    expect(normalizarPreferencias([true])).toEqual(PREFERENCIAS_PADRAO);

    localStorage.setItem('flowly-preferences:u-2', '{corrompido');
    definirPreferencia('fundoAnimado', false);
    definirPreferencia('naoExiste', true);
    definirPreferencia('enviarComEnter', 'sim');
    expect(salvas('u-1')).toEqual({ ...PREFERENCIAS_PADRAO, fundoAnimado: false });

    entrarComo('u-2');
    expect(lerPreferencias()).toEqual(PREFERENCIAS_PADRAO);
    definirPreferencia('toastsMensagens', false);
    entrarComo('u-1');
    expect(lerPreferencias()).toEqual({ ...PREFERENCIAS_PADRAO, fundoAnimado: false });

    restaurarPreferencias();
    expect(localStorage.getItem('flowly-preferences:u-1')).toBeNull();
    expect(salvas('u-2')).toEqual({ ...PREFERENCIAS_PADRAO, toastsMensagens: false });
    // Nada alem de booleanos de interface vai para a chave.
    expect(Object.keys(salvas('u-2')).sort()).toEqual(Object.keys(PREFERENCIAS_PADRAO).sort());
  });
});

describe('central', () => {
  test('aparencia: mesma fonte do seletor rapido nos dois sentidos, salva por conta', () => {
    renderCentral();
    const tema = screen.getByRole('radiogroup', { name: 'Tema' });
    const paleta = screen.getByRole('radiogroup', { name: 'Paleta de cores' });
    expect(within(tema).getByRole('radio', { name: /Escuro/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(paleta).getByRole('radio', { name: /Roxo/ })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(within(tema).getByRole('radio', { name: /Claro/ }));
    fireEvent.click(within(paleta).getByRole('radio', { name: /Verde/ }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-palette')).toBe('green');
    expect(JSON.parse(localStorage.getItem('flowly-appearance:u-1'))).toEqual({ theme: 'light', palette: 'green' });

    // O seletor rapido mostra a mesma escolha e, alterado, atualiza a central.
    fireEvent.click(screen.getByTestId('theme-toggle'));
    const menu = document.querySelector('.appearance-menu');
    expect(within(menu).getByRole('button', { name: /Claro/ })).toHaveClass('selected');
    expect(within(menu).getByRole('button', { name: /Verde/ })).toHaveClass('selected');
    fireEvent.click(within(menu).getByRole('button', { name: /Azul/ }));
    fireEvent.click(within(menu).getByRole('button', { name: /Escuro/ }));
    expect(within(paleta).getByRole('radio', { name: /Azul/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(tema).getByRole('radio', { name: /Escuro/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('interruptores aplicam e salvam na hora, sem botao Salvar', () => {
    renderCentral();
    expect(screen.queryByRole('button', { name: /Salvar/ })).toBeNull();
    for (const [nome, chave] of [
      ['Fundo animado', 'fundoAnimado'],
      ['Avisos de novas mensagens', 'toastsMensagens'],
      ['Enviar mensagens com Enter', 'enviarComEnter'],
    ]) {
      expect(interruptor(nome)).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(interruptor(nome));
      expect(interruptor(nome)).toHaveAttribute('aria-checked', 'false');
      expect(salvas('u-1')[chave]).toBe(false);
    }
    expect(interruptor('Barra lateral recolhida')).toHaveAttribute('aria-checked', 'false');
    expect(interruptor('Fundo animado')).toHaveAccessibleDescription(/fundo estático/);
  });

  test('restaurar padroes: pede confirmacao e volta aparencia e interface, so desta conta', () => {
    localStorage.setItem('flowly-preferences:u-2', JSON.stringify({ fundoAnimado: false }));
    localStorage.setItem('flowly-appearance:u-1', JSON.stringify({ theme: 'light', palette: 'cyan' }));
    localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, 'token');
    renderCentral();
    fireEvent.click(interruptor('Fundo animado'));
    fireEvent.click(interruptor('Barra lateral recolhida'));

    fireEvent.click(screen.getByRole('button', { name: 'Restaurar preferências padrão' }));
    const dialogo = screen.getByRole('dialog');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    expect(interruptor('Fundo animado')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Restaurar preferências padrão' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restaurar' }));
    expect(screen.getByRole('status')).toHaveTextContent('Preferências padrão restauradas.');
    expect(interruptor('Fundo animado')).toHaveAttribute('aria-checked', 'true');
    expect(interruptor('Barra lateral recolhida')).toHaveAttribute('aria-checked', 'false');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-palette')).toBe('purple');
    // Sessao e preferencias de outra conta intactas.
    expect(localStorage.getItem(LOCAL_STORAGE_KEYS.TOKEN)).toBe('token');
    expect(salvas('u-2')).toEqual({ fundoAnimado: false });
  });

  test('assistente e conta: so atalhos reais', () => {
    renderCentral();
    expect(screen.getByRole('link', { name: /Abrir o assistente/ })).toHaveAttribute('href', '/assistente');
    expect(screen.getByRole('link', { name: /^Meu perfil/ })).toHaveAttribute('href', '/perfil');
    expect(screen.getByRole('link', { name: /^Segurança/ })).toHaveAttribute('href', '/perfil');
  });
});

describe('sidebar', () => {
  test('botao de recolher e central usam a mesma preferencia, salva por conta e aplicada ao remontar', async () => {
    const { unmount } = renderCentral();
    const aside = () => document.querySelector('aside.sidebar');
    expect(aside()).toHaveClass('expanded');
    expect(screen.getByRole('link', { name: 'Preferências' })).toHaveAttribute('href', '/preferencias');

    fireEvent.click(screen.getByRole('button', { name: 'Recolher menu' }));
    expect(aside()).toHaveClass('collapsed');
    expect(interruptor('Barra lateral recolhida')).toHaveAttribute('aria-checked', 'true');
    expect(salvas('u-1').sidebarRecolhida).toBe(true);

    // Outra pagina (nova montagem): continua recolhida. Outra conta: padrao expandida.
    unmount();
    const segunda = renderCentral();
    expect(aside()).toHaveClass('collapsed');
    segunda.unmount();
    entrarComo('u-2');
    renderCentral();
    expect(aside()).toHaveClass('expanded');
    await act(async () => { fireEvent.click(interruptor('Barra lateral recolhida')); });
    expect(aside()).toHaveClass('collapsed');
  });

  test('menu aberto no celular nao altera a preferencia', () => {
    definirPreferencia('sidebarRecolhida', true);
    renderCentral();
    // O botao do menu so aparece no celular (CSS): procura sem filtrar por visibilidade.
    fireEvent.click(document.querySelector('button.sidebar-hamburger[aria-label="Menu"]'));
    expect(document.querySelector('aside.sidebar')).toHaveClass('mobile-open', 'expanded');
    expect(salvas('u-1').sidebarRecolhida).toBe(true);
  });
});
