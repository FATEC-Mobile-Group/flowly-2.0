import React, { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import apiClient from "../../config/apiClient";
import { API_ENDPOINTS } from "../../config/config";
import { authUtils } from "../../config/authUtils";
import "../../styles/pages/auth/Login.css";
import {
  FaEnvelope, FaPaperPlane, FaKey, FaCheck
} from "react-icons/fa";

function useQuery() {
  return new URLSearchParams(useLocation().search);
}

function Verify() {
  const query = useQuery();
  const tokenFromUrl = query.get("token");
  const emailFromUrl = query.get("email") || "";

  const [email, setEmail] = useState(emailFromUrl);
  const [userId, setUserId] = useState("");
  const [codigo, setCodigo] = useState("");
  const [status, setStatus] = useState({ type: "", message: "" });
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState(tokenFromUrl ? "token-verify" : (emailFromUrl ? "enter-code" : "request"));

  const redirectAfterVerification = async (res) => {
    const jwt = res.data.token;
    let user = res.data.user;

    localStorage.setItem('token', jwt);

    if (!user) {
      try {
        const userRes = await apiClient.get(API_ENDPOINTS.USER_ME);
        user = userRes.data;
      } catch (err) {
        console.warn('Nao foi possivel obter user/me apos validacao de email.');
      }
    }

    if (user) {
      authUtils.saveAuthData(jwt, user);
    }

    const redirect = res.data.redirect || (user?.tipo === "admin" ? "/admin" : "/dashboard");
    window.location.href = redirect;
  };

  useEffect(() => {
    if (emailFromUrl) {
      setEmail(emailFromUrl);
      if (!tokenFromUrl) {
        setStep("enter-code");
        setStatus({ type: "success", message: "Código de verificação já foi enviado para o seu email." });
      }
    }
  }, [emailFromUrl, tokenFromUrl]);

  useEffect(() => {
    if (tokenFromUrl) {
      // Validar token vindo por link
      (async () => {
        setLoading(true);
        setStatus({ type: "", message: "" });
        try {
          const res = await apiClient.get(`${API_ENDPOINTS.VALIDATE_2FA_TOKEN}?token=${encodeURIComponent(tokenFromUrl)}`);
          await redirectAfterVerification(res);
          if (res.data.user) {
            return;
          }
          const jwt = res.data.token;
          // armazenar token temporariamente e buscar dados do usuário
          localStorage.setItem('token', jwt);
          try {
            const userRes = await apiClient.get(API_ENDPOINTS.USER_ME);
            authUtils.saveAuthData(jwt, userRes.data);
          } catch (err) {
            // Se não conseguir buscar user/me, apenas salvar token
            console.warn('Não foi possível obter user/me após validação de token.');
          }

          const redirect = res.data.redirect || '/dashboard';
          window.location.href = redirect;
        } catch (err) {
          setStatus({ type: "error", message: err.response?.data?.message || 'Token inválido ou expirado.' });
          setStep('request');
        } finally {
          setLoading(false);
        }
      })();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenFromUrl]);

  const handleSendCode = async (e) => {
    e.preventDefault();
    await handleSendCodeFromEmail(email);
  };

  const handleSendCodeFromEmail = async (emailToSend) => {
    setLoading(true);
    setStatus({ type: "", message: "" });

    try {
      const res = await apiClient.post(API_ENDPOINTS.SEND_2FA, { email: emailToSend });
      setUserId(res.data.userId || res.data.user_id || "");
      setStatus({ type: "success", message: 'Código enviado. Verifique seu email.' });
      setStep('enter-code');
    } catch (err) {
      setStatus({ type: "error", message: err.response?.data?.message || 'Erro ao enviar código.' });
    } finally {
      setLoading(false);
    }
  };

  const handleValidateCode = async (e) => {
    e.preventDefault();
    setLoading(true);
    setStatus({ type: "", message: "" });

    try {
      const res = await apiClient.post(API_ENDPOINTS.VALIDATE_2FA_CODE, { userId, email, codigo });
      if (res.data.user) {
        setStatus({ type: "success", message: 'VerificaÃ§Ã£o bem-sucedida! Redirecionando...' });
        setTimeout(() => {
          redirectAfterVerification(res);
        }, 900);
        return;
      }
      const jwt = res.data.token;
      localStorage.setItem('token', jwt);
      try {
        const userRes = await apiClient.get(API_ENDPOINTS.USER_ME);
        authUtils.saveAuthData(jwt, userRes.data);
      } catch (err) {
        console.warn('Não foi possível obter user/me após validação do código.');
      }

      setStatus({ type: "success", message: 'Verificação bem-sucedida! Redirecionando...' });
      setTimeout(() => {
        const redirect = res.data.redirect || "/dashboard";
        window.location.href = redirect;
      }, 900);
    } catch (err) {
      setStatus({ type: "error", message: err.response?.data?.message || 'Código inválido ou expirado.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!status.message || status.type === "") {
      return undefined;
    }

    const timeout = setTimeout(() => {
      setStatus((current) => (current.message === status.message ? { type: "", message: "" } : current));
    }, 4500);

    return () => clearTimeout(timeout);
  }, [status.message, status.type]);

  return (
    <div className="auth-container">
      <div className="auth-card glass-panel">
        <div className="auth-header">
          <h2>Verificação de Email</h2>
          <p>Digite o código recebido no email para ativar sua conta</p>
        </div>

        {status.message && (
          <div
            className="erro-container"
            style={{
              background: status.type === "success" ? 'rgba(34, 197, 94, 0.12)' : 'rgba(244, 63, 94, 0.12)',
              borderLeft: `4px solid ${status.type === "success" ? '#22c55e' : '#f43f5e'}`,
              color: status.type === "success" ? '#bbf7d0' : '#fecdd3'
            }}
          >
            {status.message}
          </div>
        )}

        {step === 'request' && (
          <form className="auth-form" onSubmit={handleSendCode}>
            <div className="input-group">
              <div className="input-icon"><FaEnvelope /></div>
              <input
                type="email"
                placeholder="Seu email para receber o código"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={loading}
              />
            </div>

            <input type="hidden" value={email} readOnly />

            <button type="submit" className="glass-btn primary" disabled={loading}>
              <FaPaperPlane /> {loading ? 'Enviando...' : 'Enviar código'}
            </button>
          </form>
        )}

        {step === 'enter-code' && (
          <form className="auth-form" onSubmit={handleValidateCode}>
            <div className="input-group">
              <div className="input-icon"><FaKey /></div>
              <input
                type="text"
                placeholder="Código de verificação"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                required
                disabled={loading}
              />
            </div>

            <button type="submit" className="glass-btn primary" disabled={loading}>
              <FaCheck /> {loading ? 'Verificando...' : 'Verificar código'}
            </button>

            <button
              type="button"
              className="glass-btn"
              onClick={() => handleSendCodeFromEmail(email)}
              disabled={loading}
              style={{ marginTop: '12px' }}
            >
              <FaPaperPlane /> Reenviar código
            </button>
          </form>
        )}

      </div>
    </div>
  );
}

export default Verify;
