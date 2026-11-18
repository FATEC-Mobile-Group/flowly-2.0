/**
 * Teste E2E (Cypress) — Fluxo de Login e Cadastro
 * 
 * Testa o fluxo crítico de autenticação do Projeto Integrador Flowly.
 * 
 * URL base: http://localhost:3000 (frontend React)
 * 
 * Funcionalidade testada: Login e Navegação para Cadastro
 * 
 * Passos manuais que o usuário faz:
 *   1. Acessar a página inicial (/)
 *   2. Digitar email no campo "Seu email"
 *   3. Digitar senha no campo "Sua senha"
 *   4. Clicar no botão "Entrar"
 *   5. (Alternativo) Clicar em "Cadastre-se" para ir ao formulário de registro
 */

describe('Teste de Fluxo Crítico - Projeto Integrador Flowly', () => {

  beforeEach(() => {
    // Visita a página inicial onde está o formulário de login
    cy.visit('/');
  });

  // ==========================================
  // TESTES DO FORMULÁRIO DE LOGIN
  // ==========================================

  it('Deve carregar a página de login com todos os elementos visíveis', () => {
    // Verifica o título da página de login
    cy.contains('h2', 'Bem-vindo(a) de volta!').should('be.visible');
    cy.contains('p', 'Faça login na plataforma Flowly').should('be.visible');

    // Verifica que os campos de input estão presentes
    cy.get('input[type="email"]').should('be.visible');
    cy.get('input[placeholder="Sua senha"]').should('be.visible');

    // Verifica que o botão "Entrar" está visível
    cy.contains('button', 'Entrar').should('be.visible');
  });

  it('Deve permitir digitar email e senha nos campos do formulário', () => {
    // Digita email no campo
    cy.get('input[type="email"]')
      .type('usuario@teste.com')
      .should('have.value', 'usuario@teste.com');

    // Digita senha no campo
    cy.get('input[placeholder="Sua senha"]')
      .type('MinhaSenha@123')
      .should('have.value', 'MinhaSenha@123');
  });

  it('Deve exibir mensagem de erro ao tentar login com credenciais inválidas', () => {
    // Preenche o formulário com credenciais que não existem
    cy.get('input[type="email"]').type('naoexiste@flowly.com');
    cy.get('input[placeholder="Sua senha"]').type('SenhaInvalida@123');

    // Clica no botão "Entrar"
    cy.contains('button', 'Entrar').click();

    // Aguarda e verifica que uma mensagem de erro apareceu
    // (o backend retorna "Usuário não encontrado" ou outro erro)
    cy.get('.erro-container', { timeout: 10000 }).should('be.visible');
  });

  it('Deve alternar a visibilidade da senha ao clicar no ícone do olho', () => {
    // Campo começa como type="password"
    cy.get('input[placeholder="Sua senha"]').should('have.attr', 'type', 'password');

    // Clica no botão de toggle de senha
    cy.get('.toggle-password').first().click();

    // Agora o campo deve ser type="text"
    cy.get('input[placeholder="Sua senha"]').should('have.attr', 'type', 'text');

    // Clica novamente para voltar a esconder
    cy.get('.toggle-password').first().click();

    // Volta para type="password"
    cy.get('input[placeholder="Sua senha"]').should('have.attr', 'type', 'password');
  });

  // ==========================================
  // TESTES DE NAVEGAÇÃO PARA CADASTRO
  // ==========================================

  it('Deve navegar para o formulário de cadastro ao clicar em "Cadastre-se"', () => {
    // Clica no botão/link "Cadastre-se"
    cy.contains('Cadastre-se').click();

    // Aguarda a transição do carousel e verifica que o formulário de registro apareceu
    cy.contains('h2', 'Criar nova conta', { timeout: 5000 }).should('be.visible');
    cy.contains('p', 'Preencha os dados para se cadastrar').should('be.visible');
  });

  it('Deve exibir todos os campos do formulário de cadastro', () => {
    // Navega para o cadastro
    cy.contains('Cadastre-se').click();

    // Verifica que os campos do formulário de registro estão presentes
    cy.get('input[placeholder="Seu nome completo"]', { timeout: 5000 }).should('be.visible');
    cy.get('input[placeholder="Seu melhor email"]').should('be.visible');
    cy.get('input[placeholder="Escolha uma senha segura"]').should('be.visible');

    // O cadastro público não escolhe tipo de conta: exige o aceite dos Termos de Uso
    cy.get('.terms-check input[type="checkbox"]').as('termos');
    cy.get('@termos').should('be.visible').and('not.be.checked');
    cy.contains('.terms-check', 'Termos de Uso').should('be.visible');

    // Sem aceitar os termos, o botão "Criar conta" fica desabilitado
    cy.contains('button[type="submit"]', 'Criar conta').as('criarConta');
    cy.get('@criarConta').should('be.visible').and('be.disabled');

    // Aceitar os termos habilita o botão (o formulário não é enviado)
    cy.get('@termos').check();
    cy.get('@termos').should('be.checked');
    cy.get('@criarConta').should('be.enabled');

    // Verifica que é possível voltar para o login
    cy.contains('button', 'Faça login').should('be.visible');
  });

});
