import { useState } from 'react';
import apiClient, { FACE_API_TIMEOUT_MS } from '../../config/apiClient';
import { API_ENDPOINTS } from '../../config/config';
import FaceCapture from './FaceCapture';
import FaceLoadingSpinner from './FaceLoadingSpinner';
import '../../styles/components/FaceAuthStep.css';

// Recadastro facial excepcional: so funciona depois que o suporte autoriza a conta.
// Nao entra na conta: depois do recadastro o titular faz o login normal com o rosto novo.
function FaceRecovery({ initialEmail = '', onDone, onCancel }) {
  const [email, setEmail] = useState(initialEmail);
  const [codeRequested, setCodeRequested] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [senha, setSenha] = useState('');
  const [fotos, setFotos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [concluido, setConcluido] = useState(false);

  const canSubmit = Boolean(email.trim() && codigo.trim() && senha) && Array.isArray(fotos) && fotos.length === 2;

  const requestCode = async () => {
    setLoading(true);
    setErro('');
    try {
      const res = await apiClient.post(
        API_ENDPOINTS.FACE_RECOVERY_SEND_CODE,
        { email: email.trim() },
        { skipAuthToken: true }
      );
      setAviso(res.data.msg);
      setCodeRequested(true);
    } catch (err) {
      setErro(err.response?.data?.erro || 'Não foi possível pedir o código.');
    } finally {
      setLoading(false);
    }
  };

  const submit = async () => {
    if (!canSubmit) {
      return;
    }
    setLoading(true);
    setErro('');
    try {
      const res = await apiClient.post(
        API_ENDPOINTS.FACE_RECOVERY_REENROLL,
        { email: email.trim(), codigo: codigo.trim(), senha, imagesBase64: fotos },
        { skipAuthToken: true, timeout: FACE_API_TIMEOUT_MS }
      );
      setSenha('');
      setCodigo('');
      setFotos([]);
      setAviso(res.data.msg);
      setConcluido(true);
    } catch (err) {
      setErro(err.response?.data?.erro || 'Não foi possível recadastrar o rosto.');
    } finally {
      setLoading(false);
    }
  };

  if (concluido) {
    return (
      <div className="face-auth-step">
        <div className="face-auth-header">
          <h2>Rosto recadastrado</h2>
          <p>{aviso}</p>
        </div>
        <div className="face-auth-buttons">
          <button type="button" className="glass-btn primary" onClick={onDone}>
            Ir para o login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="face-auth-step">
      <div className="face-auth-header">
        <h2>Recuperar verificação facial</h2>
        <p>Disponível somente depois que o suporte do Flowly autorizar a recuperação desta conta.</p>
      </div>

      {erro && <div className="erro-container">{erro}</div>}
      {aviso && <p className="face-auth-info">{aviso}</p>}

      <label className="face-auth-field">
        E-mail
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading || codeRequested} />
      </label>

      {!codeRequested ? (
        <div className="face-auth-buttons">
          <button type="button" className="glass-btn primary" onClick={requestCode} disabled={loading || !email.trim()}>
            Enviar código
          </button>
        </div>
      ) : (
        <>
          <label className="face-auth-field">
            Código recebido por e-mail
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              disabled={loading}
            />
          </label>
          <label className="face-auth-field">
            Senha atual
            <input
              type="password"
              autoComplete="current-password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              disabled={loading}
            />
          </label>

          <FaceCapture
            captureMode="dual"
            onCapture={(payload) => setFotos(Array.isArray(payload) ? payload : [])}
            disabled={loading}
            processing={loading}
            processingLabel="Recadastrando..."
          />

          <div className="face-auth-buttons">
            <button type="button" className="glass-btn primary" onClick={submit} disabled={loading || !canSubmit}>
              {loading ? <FaceLoadingSpinner label="Recadastrando..." /> : 'Recadastrar rosto'}
            </button>
          </div>
        </>
      )}

      <div className="face-auth-buttons">
        <button type="button" className="auth-switch-btn" onClick={onCancel} disabled={loading}>
          Voltar ao login
        </button>
      </div>
    </div>
  );
}

export default FaceRecovery;
