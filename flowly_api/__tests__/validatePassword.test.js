/**
 * Teste Unitário (Jest) — validatePassword
 * 
 * Testa a função utilitária de validação de senha do Flowly.
 * A senha deve ter:
 *   - Mínimo 8 caracteres
 *   - Letra maiúscula
 *   - Letra minúscula
 *   - Número
 *   - Caractere especial
 */

const validatePassword = require('../utils/validatePassword');

describe('validatePassword — Validação de Senha', () => {

  // ==========================================
  // CENÁRIOS DE SUCESSO
  // ==========================================

  it('deve retornar true para uma senha válida completa', () => {
    const resultado = validatePassword('Flowly@2025');
    expect(resultado).toBe(true);
  });

  it('deve retornar true para senha com exatamente 8 caracteres válidos', () => {
    const resultado = validatePassword('Abc1234!');
    expect(resultado).toBe(true);
  });

  it('deve retornar true para senha longa e complexa', () => {
    const resultado = validatePassword('MinhaSenha#Segura123!@');
    expect(resultado).toBe(true);
  });

  // ==========================================
  // CENÁRIOS DE ERRO — Tamanho
  // ==========================================

  it('deve rejeitar senha com menos de 8 caracteres', () => {
    const resultado = validatePassword('Ab1!');
    expect(resultado).toBe('A senha deve ter pelo menos 8 caracteres.');
  });

  it('deve rejeitar string vazia', () => {
    const resultado = validatePassword('');
    expect(resultado).toBe('A senha deve ter pelo menos 8 caracteres.');
  });

  it('deve rejeitar senha undefined com mensagem controlada', () => {
    const resultado = validatePassword(undefined);
    expect(resultado).toBe('A senha é obrigatória e deve ser informada como texto.');
  });

  it('deve rejeitar senha null com mensagem controlada', () => {
    const resultado = validatePassword(null);
    expect(resultado).toBe('A senha é obrigatória e deve ser informada como texto.');
  });

  it.each([12345678, true, {}])(
    'deve rejeitar valor não textual (%p) com mensagem controlada',
    (password) => {
      const resultado = validatePassword(password);
      expect(resultado).toBe('A senha é obrigatória e deve ser informada como texto.');
    }
  );

  // ==========================================
  // CENÁRIOS DE ERRO — Complexidade
  // ==========================================

  it('deve rejeitar senha sem letra maiúscula', () => {
    const resultado = validatePassword('flowly@2025');
    expect(resultado).toBe(
      'A senha deve incluir letras maiúsculas, minúsculas, números e caracteres especiais.'
    );
  });

  it('deve rejeitar senha sem letra minúscula', () => {
    const resultado = validatePassword('FLOWLY@2025');
    expect(resultado).toBe(
      'A senha deve incluir letras maiúsculas, minúsculas, números e caracteres especiais.'
    );
  });

  it('deve rejeitar senha sem número', () => {
    const resultado = validatePassword('Flowly@abc!');
    expect(resultado).toBe(
      'A senha deve incluir letras maiúsculas, minúsculas, números e caracteres especiais.'
    );
  });

  it('deve rejeitar senha sem caractere especial', () => {
    const resultado = validatePassword('Flowly2025abc');
    expect(resultado).toBe(
      'A senha deve incluir letras maiúsculas, minúsculas, números e caracteres especiais.'
    );
  });

  it('deve rejeitar senha que é só números', () => {
    const resultado = validatePassword('123456789');
    expect(resultado).toBe(
      'A senha deve incluir letras maiúsculas, minúsculas, números e caracteres especiais.'
    );
  });

});
