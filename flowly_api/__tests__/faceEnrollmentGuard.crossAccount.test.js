// Checagem contra outras contas: nunca pulada para o proprio dono, e com o limiar de login como piso.
const mockProfiles = [];
jest.mock('../models/FaceProfile', () => ({
  find: jest.fn((filter) => ({
    select: async () =>
      mockProfiles.filter((profile) => profile.enrolled && String(profile.userId) !== String(filter.userId.$ne)),
  })),
}));
jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: async () => ({ nome: 'Dono', email: 'dono@exemplo.com' }) })),
}));
jest.mock('../utils/sendEmail', () => jest.fn(async () => {}));

const config = require('../config/config');
const sendEmail = require('../utils/sendEmail');
const {
  assertUniqueFaceEnrollment,
  crossAccountThreshold,
  isSamePersonFaceUpdate,
} = require('../utils/faceEnrollmentGuard');

const OWNER_ID = '507f1f77bcf86cd799439011';
const OTHER_ID = '507f1f77bcf86cd799439022';

// Vetor unitario cuja distancia de cosseno ate [1, 0] e exatamente `distance`.
const atDistance = (distance) => {
  const cos = 1 - distance;
  return [cos, Math.sqrt(1 - cos * cos)];
};

const seedOther = (embedding) => {
  mockProfiles.length = 0;
  mockProfiles.push({ userId: OTHER_ID, enrolled: true, embeddings: [embedding] });
};

const expectDuplicate = (promise) =>
  expect(promise).rejects.toMatchObject({ statusCode: 409, code: 'FACE_DUPLICATE' });

describe('assertUniqueFaceEnrollment contra outras contas', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProfiles.length = 0;
  });

  test('os limiares configurados continuam os mesmos', () => {
    expect(config.face.duplicateThreshold).toBe(0.46);
    expect(config.face.verifyThreshold).toBe(0.5);
    expect(crossAccountThreshold()).toBe(0.5);
  });

  test('o piso nunca afrouxa: limiar de duplicidade maior que o de login continua valendo', () => {
    const original = config.face.duplicateThreshold;
    config.face.duplicateThreshold = 0.6;
    try {
      expect(crossAccountThreshold()).toBe(0.6);
    } finally {
      config.face.duplicateThreshold = original;
    }
  });

  test('distancia entre o limite antigo (0,46) e o de login (0,5) agora bloqueia', async () => {
    seedOther(atDistance(0.48));

    await expectDuplicate(assertUniqueFaceEnrollment(OWNER_ID, [[1, 0]]));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  test('distancia acima do limite de login continua liberada', async () => {
    seedOther(atDistance(0.52));

    await expect(assertUniqueFaceEnrollment(OWNER_ID, [[1, 0], [1, 0]])).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('rosto que bate com o proprio perfil nao pula a checagem contra outra conta', async () => {
    const existingProfile = { embeddings: [[1, 0]] };
    seedOther(atDistance(0.3));
    expect(isSamePersonFaceUpdate(existingProfile, [[1, 0]])).toBe(true);

    await expectDuplicate(assertUniqueFaceEnrollment(OWNER_ID, [[1, 0]], { existingProfile }));
  });

  test('o proprio perfil nao conta como duplicidade', async () => {
    mockProfiles.push({ userId: OWNER_ID, enrolled: true, embeddings: [[1, 0]] });

    await expect(assertUniqueFaceEnrollment(OWNER_ID, [[1, 0]])).resolves.toBeUndefined();
  });

  test('perfil inativo de outra conta nao bloqueia', async () => {
    mockProfiles.push({ userId: OTHER_ID, enrolled: false, embeddings: [[1, 0]] });

    await expect(assertUniqueFaceEnrollment(OWNER_ID, [[1, 0]])).resolves.toBeUndefined();
  });
});
