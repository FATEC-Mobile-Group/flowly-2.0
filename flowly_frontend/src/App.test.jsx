import { render, screen } from '@testing-library/react';
import App from './App';

vi.mock('./components/backgrounds/LightRays', () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock('./components/text/CurvedLoop', () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock('jspdf', () => ({
  __esModule: true,
  default: vi.fn(),
}));

test('renderiza a tela pública de login para visitante não autenticado', () => {
  localStorage.clear();
  window.history.pushState({}, '', '/');

  render(<App />);

  expect(
    screen.getByRole('heading', { name: 'Bem-vindo(a) de volta!' })
  ).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Seu email')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Sua senha')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Entrar' })).toBeInTheDocument();
});
