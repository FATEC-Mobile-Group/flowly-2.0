import { useState } from 'react';
import apiClient, { FACE_API_TIMEOUT_MS } from '../../config/apiClient';
import { API_ENDPOINTS } from '../../config/config';
import { authUtils } from '../../config/authUtils';
import FaceCapture from './FaceCapture';
import FaceLoadingSpinner from './FaceLoadingSpinner';
import { getFaceErrorMessage } from '../../utils/faceErrorMessages';
import '../../styles/components/FaceAuthStep.css';

function FaceAuthStep({
  mode,
  faceSessionToken,
  user,
  onComplete,
  onCancel,
}) {
  const [capturePayload, setCapturePayload] = useState(mode === 'verify' ? '' : []);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const isVerify = mode === 'verify';

  const hasRequiredCapture = isVerify
    ? Boolean(capturePayload)
    : Array.isArray(capturePayload) && capturePayload.length === 2;

  const finishLogin = (data) => {
    authUtils.saveAuthData(data.token, data.user);
    onComplete(data.user);
  };

  const handleSkip = async () => {
    setLoading(true);
    setErro('');

    try {
      const res = await apiClient.post(API_ENDPOINTS.FACE_SKIP_ENROLLMENT, {
        faceSessionToken,
      }, { skipAuthToken: true });
      finishLogin(res.data);
    } catch (err) {
      setErro(err.response?.data?.erro || 'Erro ao pular cadastro facial.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!hasRequiredCapture) {
      setErro(
        isVerify
          ? 'Capture uma foto do rosto antes de continuar.'
          : 'Capture as duas fotos do rosto antes de continuar.'
      );
      return;
    }

    setLoading(true);
    setErro('');

    try {
      const endpoint =
        mode === 'verify'
          ? API_ENDPOINTS.FACE_VERIFY
          : API_ENDPOINTS.FACE_ENROLL;

      const body = isVerify
        ? { faceSessionToken, imageBase64: capturePayload }
        : { faceSessionToken, imagesBase64: capturePayload };

      const res = await apiClient.post(endpoint, body, {
        timeout: FACE_API_TIMEOUT_MS,
        skipAuthToken: true,
      });

      finishLogin(res.data);
    } catch (err) {
      setErro(getFaceErrorMessage(err, isVerify ? 'verify' : 'enroll'));
    } finally {
      setLoading(false);
    }
  };

  const title = isVerify ? 'Verificação facial' : 'Cadastro facial (opcional)';
  const subtitle = isVerify
    ? `Olá, ${user?.nome || 'usuário'}. Confirme sua identidade para concluir o login.`
    : 'Cadastre duas fotos do rosto para uma camada extra de segurança no login.';

  return (
    <div className="face-auth-step">
      <div className="face-auth-header">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>

      {erro && <div className="erro-container">{erro}</div>}

      <FaceCapture
        captureMode={isVerify ? 'single' : 'dual'}
        onCapture={(payload) => {
          setCapturePayload(payload);
          if (!payload || (Array.isArray(payload) && payload.length === 0)) {
            setErro('');
          }
        }}
        disabled={loading}
        processing={loading}
        processingLabel={isVerify ? 'Verificando...' : 'Cadastrando...'}
        buttonLabel={isVerify ? 'Capturar para verificar' : undefined}
      />

      <div className="face-auth-buttons">
        <button
          type="button"
          className="glass-btn primary"
          onClick={handleSubmit}
          disabled={loading || !hasRequiredCapture}
        >
          {loading ? (
            <FaceLoadingSpinner label={isVerify ? 'Verificando...' : 'Cadastrando...'} />
          ) : (
            isVerify ? 'Verificar e entrar' : 'Cadastrar e entrar'
          )}
        </button>

        {!isVerify && (
          <button
            type="button"
            className="glass-btn secondary"
            onClick={handleSkip}
            disabled={loading}
          >
            Pular por agora
          </button>
        )}

        {onCancel && (
          <button
            type="button"
            className="auth-switch-btn"
            onClick={onCancel}
            disabled={loading}
          >
            Voltar ao login
          </button>
        )}
      </div>
    </div>
  );
}

export default FaceAuthStep;
