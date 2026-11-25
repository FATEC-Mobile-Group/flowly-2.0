import { useEffect, useRef, useState } from 'react';
import apiClient, { FACE_API_TIMEOUT_MS } from '../../config/apiClient';
import { API_ENDPOINTS } from '../../config/config';
import { authUtils } from '../../config/authUtils';
import FaceCapture from './FaceCapture';
import FaceLoadingSpinner from './FaceLoadingSpinner';
import { getFaceErrorMessage } from '../../utils/faceErrorMessages';
import '../../styles/components/FaceAuthStep.css';

// Aviso de espera longa: so uma possibilidade (o frontend nao sabe se o servico esta inicializando).
export const FACE_LONG_WAIT_MS = 8000;
const LONG_WAIT_MESSAGE =
  'A primeira verificação pode demorar um pouco mais. Aguarde enquanto o serviço é inicializado ou conclui o processamento.';

function FaceAuthStep({
  mode,
  faceSessionToken,
  user,
  onComplete,
  onCancel,
  onRecover,
}) {
  const [capturePayload, setCapturePayload] = useState(mode === 'verify' ? '' : []);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [esperaLonga, setEsperaLonga] = useState(false);
  // Um temporizador por envio; o numero da tentativa impede que um envio antigo mexa no aviso de um novo.
  const esperaRef = useRef(null);
  const tentativaRef = useRef(0);
  const isVerify = mode === 'verify';

  const encerrarEspera = () => {
    if (esperaRef.current) {
      clearTimeout(esperaRef.current);
      esperaRef.current = null;
    }
    setEsperaLonga(false);
  };

  useEffect(() => () => {
    tentativaRef.current += 1;
    if (esperaRef.current) {
      clearTimeout(esperaRef.current);
      esperaRef.current = null;
    }
  }, []);

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
    tentativaRef.current += 1;
    const tentativa = tentativaRef.current;
    encerrarEspera();
    esperaRef.current = setTimeout(() => {
      esperaRef.current = null;
      if (tentativa === tentativaRef.current) {
        setEsperaLonga(true);
      }
    }, FACE_LONG_WAIT_MS);

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
      if (tentativa === tentativaRef.current) {
        encerrarEspera();
      }
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

      {loading && esperaLonga && (
        <p className="face-capture-tip" role="status">{LONG_WAIT_MESSAGE}</p>
      )}

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

        {isVerify && onRecover && (
          <button
            type="button"
            className="auth-switch-btn"
            onClick={onRecover}
            disabled={loading}
          >
            Não consigo verificar meu rosto
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
