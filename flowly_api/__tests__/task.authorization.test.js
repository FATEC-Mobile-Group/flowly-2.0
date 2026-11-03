jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));
jest.mock('../models/Tarefa', () => ({ find: jest.fn() }));
jest.mock('../models/Equipe', () => ({ find: jest.fn() }));
jest.mock('../models/User', () => ({}));
jest.mock('../models/Comment', () => ({}));
jest.mock('../models/ActivityLog', () => ({}));
jest.mock('../utils/activityLogger', () => jest.fn());
jest.mock('../utils/notificationService', () => ({ notifyUsers: jest.fn() }));

const Tarefa = require('../models/Tarefa');
const Equipe = require('../models/Equipe');
const tarefaController = require('../controllers/tarefaController');

describe('autorizacao de tarefas', () => {
  test('minhas tarefas filtra equipe e responsavel autenticado', async () => {
    Equipe.find.mockReturnValue({
      select: jest.fn().mockResolvedValue([{ _id: 'team-1' }]),
    });

    const query = {
      populate: jest.fn(),
      sort: jest.fn().mockResolvedValue([]),
    };
    query.populate.mockReturnValue(query);
    Tarefa.find.mockReturnValue(query);

    const res = { json: jest.fn(), status: jest.fn() };
    await tarefaController.minhasTarefas(
      { user: { id: 'user-1', tipo: 'user' } },
      res
    );

    expect(Tarefa.find).toHaveBeenCalledWith({
      user: 'user-1',
      equipe: { $in: ['team-1'] },
    });
    expect(res.json).toHaveBeenCalledWith([]);
  });
});
