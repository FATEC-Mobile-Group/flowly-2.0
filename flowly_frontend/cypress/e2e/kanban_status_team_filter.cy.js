const mockUser = {
  _id: 'user-kanban-1',
  id: 'user-kanban-1',
  nome: 'Usuario Kanban',
  email: 'usuario.kanban@flowly.local',
  tipo: 'user',
  fotoPerfil: '',
};

const teamDefault = {
  _id: 'team-alpha',
  nome: 'Equipe Alpha',
  membros: [mockUser],
};

const teamOther = {
  _id: 'team-beta',
  nome: 'Equipe Beta',
  membros: [mockUser],
};

const taskDefaultTeam = {
  _id: 'task-alpha',
  descricao: 'Tarefa da equipe padrao',
  detalhes: 'Deve aparecer ao abrir o Kanban.',
  dataEntrega: '2026-06-15T12:00:00.000Z',
  status: 'pendente',
  urgencia: 'media',
  tempoEstimado: 30,
  tempoGasto: 0,
  cronometroAtivo: false,
  equipe: teamDefault,
  user: mockUser,
};

const taskOtherTeam = {
  _id: 'task-beta',
  descricao: 'Tarefa da equipe selecionada',
  detalhes: 'Deve aparecer apenas ao selecionar a segunda equipe.',
  dataEntrega: '2026-06-16T12:00:00.000Z',
  status: 'pendente',
  urgencia: 'alta',
  tempoEstimado: 45,
  tempoGasto: 0,
  cronometroAtivo: false,
  equipe: teamOther,
  user: mockUser,
};

const seedUserAuth = (win) => {
  win.localStorage.setItem('token', 'fake-jwt-token-kanban');
  win.localStorage.setItem('tipo', 'user');
  win.localStorage.setItem('nome', mockUser.nome);
  win.localStorage.setItem('id', mockUser._id);
  win.localStorage.setItem('fotoPerfil', '');
};

describe('Kanban do usuario - filtro por equipe e atualizacao de status', () => {
  it('atualiza o status de uma tarefa apos selecionar uma equipe diferente da padrao', () => {
    let betaStatus = 'pendente';

    cy.intercept('http://localhost:5000/socket.io/**', { statusCode: 200, body: '' });

    cy.intercept('GET', 'http://localhost:5000/api/equipes/minhas', {
      statusCode: 200,
      body: [teamDefault, teamOther],
    }).as('getTeams');

    cy.intercept('GET', 'http://localhost:5000/api/tarefas/minhas', (req) => {
      req.reply({
        statusCode: 200,
        body: [
          taskDefaultTeam,
          {
            ...taskOtherTeam,
            status: betaStatus,
          },
        ],
      });
    }).as('getTasks');

    cy.intercept('PUT', 'http://localhost:5000/api/tarefas/task-beta/status', (req) => {
      expect(req.body).to.deep.equal({ status: 'em_andamento' });
      betaStatus = 'em_andamento';
      req.reply({
        statusCode: 200,
        body: {
          msg: 'Status atualizado com sucesso',
          tarefa: {
            ...taskOtherTeam,
            status: betaStatus,
          },
        },
      });
    }).as('updateBetaStatus');

    cy.visit('/minhas-tarefas', {
      onBeforeLoad: seedUserAuth,
    });

    cy.wait('@getTeams');
    cy.wait('@getTasks');

    cy.get('#kanban-equipe-select').should('have.value', teamDefault._id);
    cy.contains('.kanban-team-summary', '1 tarefa em Equipe Alpha').should('be.visible');
    cy.contains('Tarefa da equipe padrao').should('be.visible');
    cy.contains('Tarefa da equipe selecionada').should('not.exist');

    cy.get('#kanban-equipe-select').select(teamOther._id);
    cy.contains('.kanban-team-summary', '1 tarefa em Equipe Beta').should('be.visible');
    cy.contains('Tarefa da equipe padrao').should('not.exist');
    cy.contains('.tarefa-item', 'Tarefa da equipe selecionada')
      .should('be.visible')
      .within(() => {
        cy.contains('button', 'Iniciar').click();
      });

    cy.wait('@updateBetaStatus');
    cy.wait('@getTasks');

    cy.contains('.kanban-column', 'Em Andamento')
      .contains('Tarefa da equipe selecionada')
      .should('be.visible');
  });
});
