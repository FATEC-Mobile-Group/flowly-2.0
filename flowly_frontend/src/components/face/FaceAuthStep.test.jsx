import { fireEvent, render, screen } from '@testing-library/react';
import FaceAuthStep from './FaceAuthStep';

vi.mock('./FaceCapture', () => ({
  __esModule: true,
  default: () => <div>camera</div>,
}));

const RECOVER = 'Não consigo verificar meu rosto';

describe('FaceAuthStep: acesso a recuperacao facial', () => {
  test('na verificacao, o link leva a recuperacao', () => {
    const onRecover = vi.fn();
    render(<FaceAuthStep mode="verify" faceSessionToken="t" user={{ nome: 'Titular' }} onRecover={onRecover} />);

    fireEvent.click(screen.getByRole('button', { name: RECOVER }));

    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  test('no cadastro opcional o link nao aparece', () => {
    render(<FaceAuthStep mode="enroll" faceSessionToken="t" user={{ nome: 'Titular' }} onRecover={vi.fn()} />);

    expect(screen.queryByRole('button', { name: RECOVER })).not.toBeInTheDocument();
  });

  test('sem onRecover o link nao aparece', () => {
    render(<FaceAuthStep mode="verify" faceSessionToken="t" user={{ nome: 'Titular' }} />);

    expect(screen.queryByRole('button', { name: RECOVER })).not.toBeInTheDocument();
  });
});
