import { useEffect, useState, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import apiClient from "../../config/apiClient";
import { API_ENDPOINTS } from "../../config/config";
import { authUtils } from "../../config/authUtils";
import {
  FaEnvelope, FaLock, FaSignInAlt, FaEye, FaEyeSlash,
  FaUser, FaUserGraduate, FaUserPlus, FaKey
} from "react-icons/fa";
import LightRays from "../../components/backgrounds/LightRays";
import CurvedLoop from "../../components/text/CurvedLoop";
import FaceAuthStep from "../../components/face/FaceAuthStep";
import "../../styles/pages/auth/Auth.css";

const TERMS_VERSION = "2026-06-08";

function AuthPage() {
  // Water ripple effect handler
  const handleRipple = useCallback((e) => {
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const size = Math.max(rect.width, rect.height) * 0.5;

    // Create main ripple
    const ripple = document.createElement("span");
    ripple.className = "ripple";
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x - size / 2}px`;
    ripple.style.top = `${y - size / 2}px`;

    // Create first ring
    const ring = document.createElement("span");
    ring.className = "ripple-ring";
    ring.style.width = ring.style.height = `${size}px`;
    ring.style.left = `${x - size / 2}px`;
    ring.style.top = `${y - size / 2}px`;

    // Create outer ring
    const ringOuter = document.createElement("span");
    ringOuter.className = "ripple-ring-outer";
    ringOuter.style.width = ringOuter.style.height = `${size}px`;
    ringOuter.style.left = `${x - size / 2}px`;
    ringOuter.style.top = `${y - size / 2}px`;

    btn.appendChild(ripple);
    btn.appendChild(ring);
    btn.appendChild(ringOuter);

    // Add wobble class for surface distortion
    btn.classList.add("rippling");

    // Cleanup after animations finish
    setTimeout(() => {
      ripple.remove();
      ring.remove();
      ringOuter.remove();
      btn.classList.remove("rippling");
    }, 1200);
  }, []);
  // Carousel state
  const [isRegistering, setIsRegistering] = useState(false);
  const [slideDirection, setSlideDirection] = useState("");

  // Login state
  const [loginEmail, setLoginEmail] = useState("");
  const [loginSenha, setLoginSenha] = useState("");
  const [loginErro, setLoginErro] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [mostrarSenhaLogin, setMostrarSenhaLogin] = useState(false);
  const [recoveringPassword, setRecoveringPassword] = useState(false);
  const [recoveryStep, setRecoveryStep] = useState("request");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryConfirmPassword, setRecoveryConfirmPassword] = useState("");
  const [recoveryStatus, setRecoveryStatus] = useState({ type: "", message: "" });
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [mostrarSenhaRecovery, setMostrarSenhaRecovery] = useState(false);

  // Register state
  const [regNome, setRegNome] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regSenha, setRegSenha] = useState("");
  const [regTipo, setRegTipo] = useState("user");
  const [regErro, setRegErro] = useState("");
  const [regLoading, setRegLoading] = useState(false);
  const [mostrarSenhaReg, setMostrarSenhaReg] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);

  // Face auth state
  const [faceStep, setFaceStep] = useState(null);
  const [faceSessionToken, setFaceSessionToken] = useState("");
  const [pendingUser, setPendingUser] = useState(null);

  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const fromRegister = query.get("fromRegister");
    const email = query.get("email");

    if (fromRegister === "1" && email) {
      setIsRegistering(false);
      setLoginEmail(email);
      navigate(`/verificar-2fa?email=${encodeURIComponent(email)}`, { replace: true });
    }
  }, [location.search, navigate]);

  // Switch to Register
  const goToRegister = () => {
    setRecoveringPassword(false);
    setSlideDirection("slide-left");
    setTimeout(() => {
      setIsRegistering(true);
      setSlideDirection("enter-right");
    }, 350);
  };

  // Switch to Login
  const goToLogin = () => {
    setSlideDirection("slide-right");
    setTimeout(() => {
      setIsRegistering(false);
      setRecoveringPassword(false);
      setSlideDirection("enter-left");
    }, 350);
  };

  const goToPasswordRecovery = () => {
    setRecoveryEmail(loginEmail);
    setRecoveryStep("request");
    setRecoveryStatus({ type: "", message: "" });
    setRecoveringPassword(true);
  };

  const redirectAfterLogin = (user) => {
    if (user.tipo === "admin") {
      window.location.href = "/admin";
    } else {
      window.location.href = "/dashboard";
    }
  };

  const resetFaceStep = () => {
    setFaceStep(null);
    setFaceSessionToken("");
    setPendingUser(null);
  };

  // Login handler
  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginErro("");

    try {
      const res = await apiClient.post(API_ENDPOINTS.LOGIN, {
        email: loginEmail,
        senha: loginSenha,
      });

      if (res.data.requiresFaceVerification) {
        setFaceStep("verify");
        setFaceSessionToken(res.data.faceSessionToken);
        setPendingUser(res.data.user);
        return;
      }

      if (res.data.requiresFaceEnrollmentOffer) {
        setFaceStep("enroll");
        setFaceSessionToken(res.data.faceSessionToken);
        setPendingUser(res.data.user);
        return;
      }

      authUtils.saveAuthData(res.data.token, res.data.user);
      redirectAfterLogin(res.data.user);
    } catch (err) {
      const errorMessage =
        err.response?.data?.error || err.response?.data?.erro || "Erro ao fazer login";
      const redirectTo = err.response?.data?.redirectTo;

      if (redirectTo) {
        navigate(redirectTo, { replace: true });
        return;
      }

      if (
        errorMessage.toLowerCase().includes("usuário não verificado") ||
        errorMessage.toLowerCase().includes("usuario nao verificado")
      ) {
        navigate(`/verificar-2fa?email=${encodeURIComponent(loginEmail)}`, { replace: true });
        return;
      }

      setLoginErro(errorMessage);
    } finally {
      setLoginLoading(false);
    }
  };

  // Register handler
  const handleRegister = async (e) => {
    e.preventDefault();
    setRegLoading(true);
    setRegErro("");

    if (!termsAccepted) {
      setRegErro("Leia e aceite os Termos de Uso e Privacidade para finalizar o cadastro.");
      setRegLoading(false);
      return;
    }

    try {
      await apiClient.post(API_ENDPOINTS.REGISTER, {
        nome: regNome,
        email: regEmail,
        senha: regSenha,
        tipo: regTipo,
        termsAccepted,
        termsVersion: TERMS_VERSION,
      });

      navigate(`/?fromRegister=1&email=${encodeURIComponent(regEmail)}`, { replace: true });
    } catch (err) {
      setRegErro(
        err.response?.data?.error || err.response?.data?.erro || "Erro ao cadastrar"
      );
    } finally {
      setRegLoading(false);
    }
  };

  const handleSendRecoveryCode = async (e) => {
    e.preventDefault();
    setRecoveryLoading(true);
    setRecoveryStatus({ type: "", message: "" });

    try {
      await apiClient.post(API_ENDPOINTS.SEND_PASSWORD_RESET, { email: recoveryEmail });
      setRecoveryStep("validate");
      setRecoveryStatus({
        type: "success",
        message: "Codigo enviado. Verifique seu email para continuar.",
      });
    } catch (err) {
      setRecoveryStatus({
        type: "error",
        message: err.response?.data?.message || err.response?.data?.erro || "Erro ao enviar codigo.",
      });
    } finally {
      setRecoveryLoading(false);
    }
  };

  const handleValidateRecoveryCode = async (e) => {
    e.preventDefault();
    setRecoveryLoading(true);
    setRecoveryStatus({ type: "", message: "" });

    try {
      const res = await apiClient.post(API_ENDPOINTS.VALIDATE_PASSWORD_RESET_CODE, {
        email: recoveryEmail,
        codigo: recoveryCode,
      });

      setRecoveryStep("reset");
      setRecoveryStatus({
        type: "success",
        message: res.data?.message || "Codigo validado. Informe sua nova senha.",
      });
    } catch (err) {
      setRecoveryStatus({
        type: "error",
        message: err.response?.data?.message || err.response?.data?.erro || "Erro ao validar codigo.",
      });
    } finally {
      setRecoveryLoading(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setRecoveryLoading(true);
    setRecoveryStatus({ type: "", message: "" });

    if (recoveryPassword !== recoveryConfirmPassword) {
      setRecoveryStatus({ type: "error", message: "A confirmacao da senha nao confere." });
      setRecoveryLoading(false);
      return;
    }

    try {
      await apiClient.post(API_ENDPOINTS.RESET_PASSWORD, {
        email: recoveryEmail,
        codigo: recoveryCode,
        novaSenha: recoveryPassword,
      });

      setLoginEmail(recoveryEmail);
      setLoginSenha("");
      setRecoveryCode("");
      setRecoveryPassword("");
      setRecoveryConfirmPassword("");
      setRecoveryStep("request");
      setRecoveringPassword(false);
      setLoginErro("");
    } catch (err) {
      setRecoveryStatus({
        type: "error",
        message: err.response?.data?.message || err.response?.data?.erro || "Erro ao redefinir senha.",
      });
    } finally {
      setRecoveryLoading(false);
    }
  };

  return (
    <div className="auth-fullscreen" data-theme="dark">
      {/* ========== FULLSCREEN BACKGROUND — LightRays ========== */}
      <div className="auth-bg-layer">
        <LightRays
          raysOrigin="top-center"
          raysColor="#b734e9"
          raysSpeed={1}
          lightSpread={1.5}
          rayLength={5}
          followMouse={true}
          mouseInfluence={0.1}
          noiseAmount={0}
          distortion={0}
          pulsating={false}
          fadeDistance={1}
          saturation={1}
        />
      </div>

      {/* ========== BRAND — Above card ========== */}
      <div className="auth-brand-above">
        <span className="brand-name">Flowly</span>
      </div>

      {/* ========== CENTERED CARD ========== */}
      <div className="auth-center-card">

        {/* ========== FORM CAROUSEL ========== */}
        <div className={`auth-carousel-wrapper ${slideDirection}`}>
          {faceStep ? (
            <div className="auth-form-container">
              <FaceAuthStep
                mode={faceStep}
                faceSessionToken={faceSessionToken}
                user={pendingUser}
                onComplete={redirectAfterLogin}
                onCancel={resetFaceStep}
              />
            </div>
          ) : recoveringPassword ? (
            <div className="auth-form-container">
              <div className="auth-header">
                <h2>Recuperar senha</h2>
                <p>
                  {recoveryStep === "request"
                    ? "Informe seu email para receber um codigo"
                    : recoveryStep === "validate"
                      ? "Digite o codigo recebido no email"
                      : "Codigo validado. Escolha uma nova senha"}
                </p>
              </div>

              {recoveryStep === "request" ? (
                <form className="auth-form" onSubmit={handleSendRecoveryCode}>
                  {recoveryStatus.message && (
                    <div className={recoveryStatus.type === "success" ? "sucesso-container" : "erro-container"}>
                      {recoveryStatus.message}
                    </div>
                  )}

                  <div className="input-group">
                    <div className="input-icon"><FaEnvelope /></div>
                    <input
                      type="email"
                      placeholder="Seu email"
                      value={recoveryEmail}
                      onChange={(e) => setRecoveryEmail(e.target.value)}
                      required
                      disabled={recoveryLoading}
                    />
                  </div>

                  <button type="submit" className="glass-btn primary" disabled={recoveryLoading} onMouseDown={handleRipple}>
                    <FaKey /> {recoveryLoading ? "Enviando..." : "Enviar codigo"}
                  </button>

                  <div className="auth-footer">
                    <p>
                      Lembrou a senha?{" "}
                      <button type="button" className="auth-switch-btn" onClick={goToLogin}>
                        Voltar ao login
                      </button>
                    </p>
                  </div>
                </form>
              ) : recoveryStep === "validate" ? (
                <form className="auth-form" onSubmit={handleValidateRecoveryCode}>
                  {recoveryStatus.message && (
                    <div className={recoveryStatus.type === "success" ? "sucesso-container" : "erro-container"}>
                      {recoveryStatus.message}
                    </div>
                  )}

                  <div className="input-group">
                    <div className="input-icon"><FaKey /></div>
                    <input
                      type="text"
                      placeholder="Codigo de 6 digitos"
                      value={recoveryCode}
                      onChange={(e) => setRecoveryCode(e.target.value)}
                      required
                      disabled={recoveryLoading}
                      maxLength={6}
                    />
                  </div>

                  <button type="submit" className="glass-btn primary" disabled={recoveryLoading} onMouseDown={handleRipple}>
                    <FaKey /> {recoveryLoading ? "Validando..." : "Validar codigo"}
                  </button>

                  <div className="auth-footer">
                    <p>
                      <button type="button" className="auth-switch-btn" onClick={goToLogin}>
                        Voltar ao login
                      </button>
                    </p>
                  </div>
                </form>
              ) : (
                <form className="auth-form" onSubmit={handleResetPassword}>
                  {recoveryStatus.message && (
                    <div className={recoveryStatus.type === "success" ? "sucesso-container" : "erro-container"}>
                      {recoveryStatus.message}
                    </div>
                  )}

                  <div className="input-group">
                    <div className="input-icon"><FaLock /></div>
                    <input
                      type={mostrarSenhaRecovery ? "text" : "password"}
                      placeholder="Nova senha"
                      value={recoveryPassword}
                      onChange={(e) => setRecoveryPassword(e.target.value)}
                      required
                      disabled={recoveryLoading}
                    />
                    <button
                      type="button"
                      className="toggle-password"
                      onClick={() => setMostrarSenhaRecovery(!mostrarSenhaRecovery)}
                      tabIndex={-1}
                    >
                      {mostrarSenhaRecovery ? <FaEyeSlash /> : <FaEye />}
                    </button>
                  </div>

                  <div className="input-group">
                    <div className="input-icon"><FaLock /></div>
                    <input
                      type={mostrarSenhaRecovery ? "text" : "password"}
                      placeholder="Confirmar nova senha"
                      value={recoveryConfirmPassword}
                      onChange={(e) => setRecoveryConfirmPassword(e.target.value)}
                      required
                      disabled={recoveryLoading}
                    />
                  </div>

                  <button type="submit" className="glass-btn primary" disabled={recoveryLoading} onMouseDown={handleRipple}>
                    <FaKey /> {recoveryLoading ? "Redefinindo..." : "Redefinir senha"}
                  </button>

                  <div className="auth-footer">
                    <p>
                      Nao recebeu?{" "}
                      <button type="button" className="auth-switch-btn" onClick={handleSendRecoveryCode} disabled={recoveryLoading}>
                        Reenviar codigo
                      </button>
                    </p>
                    <p>
                      <button type="button" className="auth-switch-btn" onClick={goToLogin}>
                        Voltar ao login
                      </button>
                    </p>
                  </div>
                </form>
              )}
            </div>
          ) : !isRegistering ? (
            /* ========== LOGIN FORM ========== */
            <div className="auth-form-container">
              <div className="auth-header">
                <h2>Bem-vindo(a) de volta!</h2>
                <p>Faça login na plataforma Flowly</p>
              </div>

              <form className="auth-form" onSubmit={handleLogin}>
                {loginErro && <div className="erro-container">{loginErro}</div>}

                <div className="input-group">
                  <div className="input-icon"><FaEnvelope /></div>
                  <input
                    type="email"
                    placeholder="Seu email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    required
                    disabled={loginLoading}
                  />
                </div>

                <div className="input-group">
                  <div className="input-icon"><FaLock /></div>
                  <input
                    type={mostrarSenhaLogin ? "text" : "password"}
                    placeholder="Sua senha"
                    value={loginSenha}
                    onChange={(e) => setLoginSenha(e.target.value)}
                    required
                    disabled={loginLoading}
                  />
                  <button
                    type="button"
                    className="toggle-password"
                    onClick={() => setMostrarSenhaLogin(!mostrarSenhaLogin)}
                    tabIndex={-1}
                  >
                    {mostrarSenhaLogin ? <FaEyeSlash /> : <FaEye />}
                  </button>
                </div>

                <button type="submit" className="glass-btn primary" disabled={loginLoading} onMouseDown={handleRipple}>
                  <FaSignInAlt /> {loginLoading ? "Entrando..." : "Entrar"}
                </button>

                <div className="auth-footer">
                  <p>
                    <button type="button" className="auth-switch-btn" onClick={goToPasswordRecovery}>
                      Esqueci minha senha
                    </button>
                  </p>
                  <p>
                    Não tem uma conta?{" "}
                    <button type="button" className="auth-switch-btn" onClick={goToRegister}>
                      Cadastre-se
                    </button>
                  </p>
                </div>
              </form>
            </div>
          ) : (
            /* ========== REGISTER FORM ========== */
            <div className="auth-form-container">
              <div className="auth-header">
                <h2>Criar nova conta</h2>
                <p>Preencha os dados para se cadastrar</p>
              </div>

              <form className="auth-form" onSubmit={handleRegister}>
                {regErro && <div className="erro-container">{regErro}</div>}

                <div className="input-group">
                  <div className="input-icon"><FaUser /></div>
                  <input
                    type="text"
                    placeholder="Seu nome completo"
                    value={regNome}
                    onChange={(e) => setRegNome(e.target.value)}
                    required
                    disabled={regLoading}
                  />
                </div>

                <div className="input-group">
                  <div className="input-icon"><FaEnvelope /></div>
                  <input
                    type="email"
                    placeholder="Seu melhor email"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    required
                    disabled={regLoading}
                  />
                </div>

                <div className="input-group">
                  <div className="input-icon"><FaLock /></div>
                  <input
                    type={mostrarSenhaReg ? "text" : "password"}
                    placeholder="Escolha uma senha segura"
                    value={regSenha}
                    onChange={(e) => setRegSenha(e.target.value)}
                    required
                    disabled={regLoading}
                  />
                  <button
                    type="button"
                    className="toggle-password"
                    onClick={() => setMostrarSenhaReg(!mostrarSenhaReg)}
                    tabIndex={-1}
                  >
                    {mostrarSenhaReg ? <FaEyeSlash /> : <FaEye />}
                  </button>
                </div>

                <div className="input-group">
                  <div className="input-icon"><FaUserGraduate /></div>
                  <select
                    value={regTipo}
                    onChange={(e) => setRegTipo(e.target.value)}
                    className="select-tipo"
                    disabled={regLoading}
                  >
                    <option value="user">Colaborador</option>
                    <option value="admin">Administrador</option>
                  </select>
                </div>

                <label className="terms-check">
                  <input
                    type="checkbox"
                    checked={termsAccepted}
                    onChange={(e) => setTermsAccepted(e.target.checked)}
                    disabled={regLoading}
                    required
                  />
                  <span>
                    Li e aceito os{" "}
                    <button
                      type="button"
                      className="terms-link"
                      onClick={() => setTermsOpen(true)}
                    >
                      Termos de Uso
                    </button>
                  </span>
                </label>

                <button type="submit" className="glass-btn primary" disabled={regLoading || !termsAccepted}>
                  <FaUserPlus /> {regLoading ? "Criando conta..." : "Criar conta"}
                </button>

                <div className="auth-footer">
                  <p>
                    Já tem uma conta?{" "}
                    <button type="button" className="auth-switch-btn" onClick={goToLogin}>
                      Faça login
                    </button>
                  </p>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>

      {/* ========== CURVED LOOP FOOTER ========== */}
      <div className="auth-curved-footer">
        <CurvedLoop
          marqueeText="Crie  ✦  Defina  ✦  Gerencie  ✦  Entregue  ✦  "
          speed={1}
          curveAmount={0}
          direction="left"
        />
      </div>
      {termsOpen && (
        <div
          className="terms-modal-backdrop"
          role="presentation"
          onMouseDown={() => setTermsOpen(false)}
        >
          <div
            className="terms-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="terms-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="terms-modal-header">
              <div>
                <h3 id="terms-title">Termos de Uso e Privacidade</h3>
                <p>Versao {TERMS_VERSION}</p>
              </div>
              <button
                type="button"
                className="terms-close"
                onClick={() => setTermsOpen(false)}
                aria-label="Fechar termos"
              >
                x
              </button>
            </div>

            <div className="terms-content">
              <p>
                Ao criar uma conta no Flowly, voce concorda com o uso dos dados
                necessarios para operar a plataforma de tarefas, equipes, mensagens,
                notificacoes, assistente digital e recursos de seguranca.
              </p>
              <h4>Dados pessoais tratados</h4>
              <p>
                Podemos tratar nome, e-mail, senha protegida por hash, tipo de usuario,
                foto de perfil, tarefas, comentarios, equipes, mensagens, anexos,
                registros de uso, tokens, IP, datas e horarios de acesso.
              </p>
              <h4>Biometria facial</h4>
              <p>
                Quando o reconhecimento facial for usado, imagens da camera podem ser
                processadas para gerar embeddings faciais usados apenas para verificacao
                de identidade, seguranca da conta e prevencao de fraude. Esse dado e
                sensivel pela LGPD.
              </p>
              <h4>Assistente e voz</h4>
              <p>
                O assistente pode processar comandos, texto, contexto de tarefas,
                equipes e, quando usado recurso de voz, fala convertida em texto para
                executar solicitacoes.
              </p>
              <h4>Finalidade e bases legais</h4>
              <p>
                O tratamento ocorre para execucao do servico, seguranca, prevencao de
                fraude, cumprimento de obrigacoes legais, legitimo interesse quando
                aplicavel e consentimento para funcionalidades opcionais ou dados
                sensiveis.
              </p>
              <h4>Responsabilidades do usuario</h4>
              <p>
                Voce deve fornecer informacoes verdadeiras, proteger sua senha, respeitar
                outros usuarios e nao enviar conteudo ilegal, ofensivo, confidencial de
                terceiros sem autorizacao ou arquivos maliciosos.
              </p>
              <h4>Direitos LGPD</h4>
              <p>
                Voce pode solicitar confirmacao de tratamento, acesso, correcao,
                portabilidade, informacoes sobre compartilhamento, eliminacao quando
                aplicavel e revogacao de consentimento.
              </p>
            </div>

            <div className="terms-modal-actions">
              <button
                type="button"
                onClick={() => {
                  setTermsAccepted(true);
                  setTermsOpen(false);
                }}
              >
                Li e aceito
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AuthPage;
