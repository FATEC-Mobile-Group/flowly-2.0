module.exports = function validatePassword(password) {
  const minLength = 8;

  if (typeof password !== 'string') {
    return 'A senha é obrigatória e deve ser informada como texto.';
  }

  const hasUpperCase = /[A-Z]/.test(password);
  const hasLowerCase = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecialChar = /[!@#$%^&*(),.?":{}|<>]/.test(password);

  if (password.length < minLength) {
    return "A senha deve ter pelo menos 8 caracteres.";
  }

  if (!hasUpperCase || !hasLowerCase || !hasNumber || !hasSpecialChar) {
    return "A senha deve incluir letras maiúsculas, minúsculas, números e caracteres especiais.";
  }

  return true;
};
