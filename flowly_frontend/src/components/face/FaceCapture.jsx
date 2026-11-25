import { useCallback, useEffect, useRef, useState } from 'react';
import FaceLoadingSpinner from './FaceLoadingSpinner';
import '../../styles/components/FaceCapture.css';

const DUAL_STEPS = [
  {
    key: 'front',
    buttonLabel: 'Capturar foto de frente',
    tip: 'Olhe de frente para a câmera, com o rosto centralizado na moldura.',
  },
  {
    key: 'side',
    buttonLabel: 'Capturar foto levemente de lado',
    tip: 'Gire levemente a cabeça (~15°) mantendo o rosto visível.',
  },
];

const CAPTURE_TIP = 'Posicione o rosto inteiro na moldura, olhe para a câmera e prefira uma iluminação frontal.';

// Espera curta depois do primeiro quadro de um stream novo, para dar tempo aos ajustes automaticos da camera
// (exposicao, foco). Valor experimental: nao garante estabilidade, so evita capturar os primeiros quadros.
// Vale uma vez por stream: outra foto e a segunda foto do cadastro, com o mesmo stream, nao esperam de novo.
export const CAMERA_SETTLE_MS = 500;

// HTMLMediaElement.HAVE_CURRENT_DATA: o video tem um quadro atual para desenhar.
const HAVE_CURRENT_DATA = 2;

const temQuadro = (video) => Boolean(video)
  && video.readyState >= HAVE_CURRENT_DATA
  && video.videoWidth > 0
  && video.videoHeight > 0;

// Pronto para liberar a captura: quadro real e reproducao em andamento (nao um quadro congelado).
const reproduzindo = (video) => temQuadro(video) && !video.paused && !video.ended;

const ERRO_CAMERA = 'Não foi possível acessar a câmera. Verifique as permissões do navegador.';

// Para as tracks e solta o aviso de fim: um stream encerrado ou substituido nao mexe mais no estado.
const pararStream = (stream) => {
  stream.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
};

const streamVivo = (stream) => Boolean(stream)
  && stream.getVideoTracks().some((track) => track.readyState === 'live');

function FaceCapture({
  onCapture,
  disabled = false,
  buttonLabel = 'Capturar rosto',
  captureMode = 'single',
  processing = false,
  processingLabel = 'Processando...',
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  // getUserMedia e assincrono: cada pedido guarda este numero e so o mais recente pode usar o stream.
  // stopCamera (desmontagem ou novo pedido) avanca o numero e invalida o que ainda estiver pendente.
  const pedidoRef = useRef(0);
  // Cancela a espera pelo quadro em andamento (listeners do video e temporizador da estabilizacao).
  const esperaRef = useRef(null);
  // Stream que ja passou pela estabilizacao: com ele, uma nova captura nao espera de novo.
  const estabilizadoRef = useRef(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [preview, setPreview] = useState('');
  const [captureStep, setCaptureStep] = useState(0);
  const [dualCaptures, setDualCaptures] = useState([]);

  const isDual = captureMode === 'dual';
  const currentDualStep = DUAL_STEPS[captureStep] || DUAL_STEPS[0];

  const cancelarEspera = useCallback(() => {
    if (esperaRef.current) {
      const cancelar = esperaRef.current;
      esperaRef.current = null;
      cancelar();
    }
  }, []);

  const stopCamera = useCallback(() => {
    pedidoRef.current += 1;
    cancelarEspera();
    estabilizadoRef.current = null;
    if (streamRef.current) {
      pararStream(streamRef.current);
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraReady(false);
  }, [cancelarEspera]);

  const isStreamAlive = useCallback(() => streamVivo(streamRef.current), []);

  // Libera a captura so quando o video tem um quadro real (eventos nativos + readyState + dimensoes), nunca so
  // porque o getUserMedia devolveu um stream. Evento, temporizador ou stream antigo nao liberam nada.
  const aguardarQuadro = useCallback((stream) => {
    cancelarEspera();
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const pedido = pedidoRef.current;
    const eventos = ['loadeddata', 'playing'];
    let temporizador = null;

    const atual = () => pedido === pedidoRef.current && streamRef.current === stream && streamVivo(stream);

    function limpar() {
      eventos.forEach((nome) => video.removeEventListener(nome, verificar));
      if (temporizador !== null) {
        clearTimeout(temporizador);
        temporizador = null;
      }
    }

    function liberar() {
      temporizador = null;
      if (!atual()) {
        limpar();
        return;
      }
      if (!reproduzindo(video)) {
        return; // continua ouvindo: o proximo loadeddata/playing tenta de novo
      }
      limpar();
      if (esperaRef.current === limpar) {
        esperaRef.current = null;
      }
      estabilizadoRef.current = stream;
      setCameraReady(true);
    }

    function verificar() {
      if (!atual()) {
        limpar();
        return;
      }
      if (temporizador !== null || !reproduzindo(video)) {
        return;
      }
      if (estabilizadoRef.current === stream) {
        liberar();
        return;
      }
      temporizador = setTimeout(liberar, CAMERA_SETTLE_MS);
    }

    eventos.forEach((nome) => video.addEventListener(nome, verificar));
    esperaRef.current = limpar;
    // O video pode ja estar pronto (evento disparado antes do registro dos listeners).
    verificar();
  }, [cancelarEspera]);

  const reproduzir = useCallback((stream) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const pedido = pedidoRef.current;
    Promise.resolve(video.play()).catch((error) => {
      // AbortError: a reproducao foi interrompida por uma troca de fonte, nao e falha da camera.
      if (error?.name === 'AbortError' || pedido !== pedidoRef.current || streamRef.current !== stream) {
        return;
      }
      if (reproduzindo(video)) {
        return;
      }
      cancelarEspera();
      setCameraReady(false);
      setCameraError(ERRO_CAMERA);
    });
  }, [cancelarEspera]);

  const attachStream = useCallback((stream) => {
    streamRef.current = stream;

    stream.getVideoTracks().forEach((track) => {
      track.onended = () => {
        if (streamRef.current === stream) {
          cancelarEspera();
        }
        setCameraReady(false);
      };
    });

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      reproduzir(stream);
    }

    setCameraReady(false);
    setCameraError('');
    aguardarQuadro(stream);
  }, [aguardarQuadro, cancelarEspera, reproduzir]);

  const startCamera = useCallback(async () => {
    if (isStreamAlive()) {
      const stream = streamRef.current;
      if (videoRef.current && videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream;
        reproduzir(stream);
      }
      setCameraReady(false);
      setCameraError('');
      // Stream ja estabilizado fica pronto assim que houver quadro, sem nova espera.
      aguardarQuadro(stream);
      return;
    }

    stopCamera();
    const pedido = pedidoRef.current;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });

      if (pedido !== pedidoRef.current) {
        // Chegou tarde (componente desmontado ou pedido mais novo, como na montagem dupla do StrictMode).
        pararStream(stream);
        return;
      }

      attachStream(stream);
    } catch (error) {
      if (pedido !== pedidoRef.current) {
        return;
      }
      setCameraError(ERRO_CAMERA);
      setCameraReady(false);
    }
  }, [aguardarQuadro, attachStream, isStreamAlive, reproduzir, stopCamera]);

  useEffect(() => {
    // Na desmontagem o React ja soltou videoRef quando esta limpeza roda; guarda o elemento para liberar o srcObject.
    const video = videoRef.current;
    startCamera();
    return () => {
      stopCamera();
      if (video) {
        video.srcObject = null;
      }
    };
  }, [startCamera, stopCamera]);

  const resetCapture = useCallback(() => {
    setPreview('');
    setCaptureStep(0);
    setDualCaptures([]);
    onCapture(isDual ? [] : '');
  }, [isDual, onCapture]);

  const handleCapture = () => {
    const video = videoRef.current;
    // Sem quadro real nao ha foto: nada de dimensoes artificiais gerando uma imagem vazia.
    if (!video || !cameraReady || processing || !isStreamAlive() || !temQuadro(video)) {
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageBase64 = canvas.toDataURL('image/jpeg', 0.92);
    setPreview(imageBase64);

    if (!isDual) {
      onCapture(imageBase64);
      return;
    }

    const nextCaptures = [...dualCaptures, imageBase64];
    setDualCaptures(nextCaptures);

    if (nextCaptures.length < DUAL_STEPS.length) {
      setCaptureStep(nextCaptures.length);
      setPreview('');
      return;
    }

    onCapture(nextCaptures);
  };

  const handleRetake = async () => {
    resetCapture();

    if (!isStreamAlive()) {
      await startCamera();
    }
  };

  const activeButtonLabel = isDual ? currentDualStep.buttonLabel : buttonLabel;
  const showPreview = Boolean(preview);
  const dualProgress = isDual ? `${Math.min(dualCaptures.length + (preview ? 1 : 0), 2)}/2` : null;

  return (
    <div className="face-capture">
      {cameraError && <div className="face-capture-error">{cameraError}</div>}

      <p className="face-capture-tip">{CAPTURE_TIP}</p>

      {isDual && (
        <p className="face-capture-tip">
          Foto {dualProgress}: {currentDualStep.tip}
        </p>
      )}

      <div className="face-capture-video-wrap">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="face-capture-video"
        />
        {!showPreview && !processing && <div className="face-capture-oval" aria-hidden="true" />}
        {showPreview && (
          <img
            src={preview}
            alt="Prévia do rosto capturado"
            className="face-capture-preview-overlay"
          />
        )}
        {processing && (
          <div className="face-capture-processing-overlay">
            <FaceLoadingSpinner label={processingLabel} />
          </div>
        )}
        {!cameraReady && !cameraError && !showPreview && !processing && (
          <p className="face-capture-loading">Iniciando câmera...</p>
        )}
      </div>

      <div className="face-capture-actions">
        <button
          type="button"
          className="glass-btn primary"
          onClick={handleCapture}
          disabled={disabled || processing || !cameraReady || (showPreview && !isDual)}
        >
          {activeButtonLabel}
        </button>
        {(showPreview || dualCaptures.length > 0) && (
          <button
            type="button"
            className="glass-btn secondary"
            onClick={handleRetake}
            disabled={disabled || processing}
          >
            Tirar outra foto
          </button>
        )}
      </div>
    </div>
  );
}

export default FaceCapture;
