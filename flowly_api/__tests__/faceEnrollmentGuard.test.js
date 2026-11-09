const {
  isSamePersonFaceUpdate,
  minDistanceToOwnReferences,
} = require('../utils/faceEnrollmentGuard');

describe('faceEnrollmentGuard', () => {
  const existingProfile = {
    embedding: [1, 0, 0],
    embeddings: [
      [1, 0, 0],
      [0.95, 0.05, 0],
    ],
  };

  it('deve permitir atualização quando todas as fotos novas correspondem ao dono', () => {
    const newPhotos = [
      [0.98, 0.02, 0],
      [0.9, 0.1, 0],
    ];

    expect(isSamePersonFaceUpdate(existingProfile, newPhotos, 0.5)).toBe(true);
  });

  it('não deve permitir captura mista, com uma foto do dono e outra de outra pessoa', () => {
    const newPhotos = [
      [0.98, 0.02, 0],
      [0.2, 0.8, 0],
    ];

    expect(minDistanceToOwnReferences(existingProfile, newPhotos)).toBeLessThan(0.05);
    expect(isSamePersonFaceUpdate(existingProfile, newPhotos, 0.5)).toBe(false);
    expect(isSamePersonFaceUpdate(existingProfile, [...newPhotos].reverse(), 0.5)).toBe(false);
  });

  it('não deve considerar atualização sem nenhuma foto nova', () => {
    expect(isSamePersonFaceUpdate(existingProfile, [], 0.5)).toBe(false);
  });

  it('deve tratar como troca de pessoa quando fotos novas não batem com o cadastro atual', () => {
    const newPhotos = [
      [0, 1, 0],
      [0, 0.95, 0.05],
    ];

    expect(isSamePersonFaceUpdate(existingProfile, newPhotos, 0.5)).toBe(false);
  });

  it('não deve considerar atualização do mesmo dono sem perfil existente', () => {
    expect(isSamePersonFaceUpdate(null, [[1, 0, 0]], 0.5)).toBe(false);
  });
});
