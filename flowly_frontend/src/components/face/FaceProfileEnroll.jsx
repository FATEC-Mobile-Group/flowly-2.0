import { useState } from 'react';
import apiClient, { FACE_API_TIMEOUT_MS } from '../../config/apiClient';
import { API_ENDPOINTS } from '../../config/config';
import FaceCapture from './FaceCapture';
import FaceLoadingSpinner from './FaceLoadingSpinner';
import { getFaceErrorMessage } from '../../utils/faceErrorMessages';
import '../../styles/components/FaceAuthStep.css';

function FaceProfileEnroll({ enrolled, onEnrolled }) {
  const [capturePayload, setCapturePayload] = useState([]);
  const [senhaAtual, setSenhaAtual] = useState('');
  const [loading, setLoading] = useState(false);
  const [mensagem, setMensagem] = useState('');
  const [erro, setErro] = useState('');

  const hasRequiredCapture = Array.isArray(capturePayload) && capturePayload.length === 2;

  const handleSubmit = async () => {
    if (!hasRequiredCapture) {
      setErro('Capture as duas fotos do rosto antes de salvar.');
      return;
    }

    setLoading(true);
    setErro('');
    setMensagem('');

    try {
      await apiClient.post(
        API_ENDPOINTS.FACE_ENROLL_PROFILE,
        { imagesBase64: capturePayload, senhaAtual },
        { timeout: FACE_API_TIMEOUT_MS }
      );
      setMensagem('Verificação facial cadastrada com sucesso.');
      setCapturePayload([]);
      if (onEnrolled) {
        onEnrolled();
      }
    } catch (err) {
      setErro(getFaceErrorMessage(err, 'profile'));
    } finally {
      setSenhaAtual('');
      setLoading(false);
    }
  };

  return (
    <section className="perfil-card face-profile-section">
      <h3>Verificação facial</h3>
      <p className="face-profile-desc">
        {enrolled
          ? 'Seu rosto já está cadastrado. Recadastre com duas fotos para melhorar o reconhecimento.'
          : 'Cadastre duas fotos do rosto para usar verificação facial no login (opcional).'}
      </p>

      {erro && <p className="perfil-erro">{erro}</p>}
      {mensagem && <p className="perfil-sucesso">{mensagem}</p>}

      <FaceCapture
        captureMode="dual"
        onCapture={(payload) => {
          setCapturePayload(Array.isArray(payload) ? payload : []);
          if (!payload || payload.length === 0) {
            setErro('');
            setMensagem('');
          }
        }}
        disabled={loading}
        processing={loading}
        processingLabel="Salvando rosto..."
      />

      <div className="perfil-form">
        <label htmlFor="face-senha-atual">Senha atual</label>
        <input
          id="face-senha-atual"
          type="password"
          autoComplete="current-password"
          value={senhaAtual}
          onChange={(event) => setSenhaAtual(event.target.value)}
          disabled={loading}
        />
      </div>

      <button type="button" onClick={handleSubmit} disabled={loading || !hasRequiredCapture || !senhaAtual}>
        {loading ? (
          <FaceLoadingSpinner label="Salvando..." />
        ) : (
          enrolled ? 'Atualizar rosto' : 'Cadastrar verificação facial'
        )}
      </button>
    </section>
  );
}

export default FaceProfileEnroll;
