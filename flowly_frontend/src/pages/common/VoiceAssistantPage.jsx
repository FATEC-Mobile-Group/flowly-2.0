import React, { useEffect, useRef, useState } from 'react';
import Sidebar from '../../components/layout/Sidebar';
import { authUtils } from '../../config/authUtils';
import apiClient from '../../config/apiClient';
import '../../styles/pages/common/VoiceAssistantPage.css';

const VoiceAssistantPage = () => {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [commandHistory, setCommandHistory] = useState([]);

  const recognitionRef = useRef(null);
  const abortControllerRef = useRef(null);
  const finalTranscriptRef = useRef('');

  const token = authUtils.getToken();
  const ASSISTANT_API_URL = process.env.REACT_APP_ASSISTANT_URL || 'http://localhost:8080';

  // Configurar Speech Recognition (Web Speech API)
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError('Seu navegador não suporta reconhecimento de voz. Use Chrome, Edge ou Safari.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => {
      setIsListening(true);
      setError('');
      setTranscript('');
      setResponse('');
      finalTranscriptRef.current = '';
    };

    recognition.onresult = (event) => {
      let interimTranscript = '';
      
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        
        if (event.results[i].isFinal) {
          finalTranscriptRef.current += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      // Atualizar display com final + interim
      setTranscript(finalTranscriptRef.current + interimTranscript);
    };

    recognition.onerror = (event) => {
      setIsListening(false);
      let errorMsg = 'Erro ao reconhecer voz.';
      
      switch (event.error) {
        case 'no-speech':
          errorMsg = 'Nenhuma fala foi detectada. Tente novamente.';
          break;
        case 'audio-capture':
          errorMsg = 'Nenhum microfone foi encontrado.';
          break;
        case 'network':
          errorMsg = 'Erro de conexão ao processar voz.';
          break;
        default:
          errorMsg = `Erro: ${event.error}`;
      }
      setError(errorMsg);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
  }, []);

  // Função para falar o texto usando Web Speech API
  const speak = (text) => {
    const synth = window.speechSynthesis;
    
    if (!synth) {
      console.error('[TTS] speechSynthesis não disponível no navegador');
      return;
    }

    // Cancelar fala anterior
    synth.cancel();

    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'pt-BR';
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.volume = 1;

      utterance.onstart = () => {
        console.log('[TTS] Iniciou reprodução');
      };

      utterance.onend = () => {
        console.log('[TTS] Finalizou reprodução');
      };

      utterance.onerror = (event) => {
        console.error('[TTS] Erro ao reproduzir:', event.error);
      };

      console.log('[TTS] Falando:', text);
      synth.speak(utterance);
    } catch (err) {
      console.error('[TTS] Erro ao criar utterance:', err);
    }
  };

  // Função para enviar comando ao assistente
  const sendCommandToAssistant = async (commandText) => {
    if (!commandText.trim()) {
      setError('Por favor, diga um comando.');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      console.log('[ASSISTANT] Enviando comando:', commandText);
      console.log('[ASSISTANT] URL:', ASSISTANT_API_URL);
      console.log('[ASSISTANT] Token:', token ? 'presente' : 'ausente');

      abortControllerRef.current = new AbortController();

      const payload = {
        utterance: commandText.trim(),
      };

      const response = await fetch(`${ASSISTANT_API_URL}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: abortControllerRef.current.signal,
      });

      console.log('[ASSISTANT] Status HTTP:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[ASSISTANT] Erro HTTP:', response.status, errorText);
        
        // Se for erro de CORS, mencioná-lo explicitamente
        if (response.status === 0 || response.type === 'opaque') {
          throw new Error('Erro de CORS: Assistente não está acessível. Verifique a URL.');
        }
        
        throw new Error(`Erro HTTP: ${response.status}`);
      }

      const data = await response.json();
      console.log('[ASSISTANT] Resposta completa:', data);

      if (data.ok) {
        const replyText = data.reply_text || 'Comando executado com sucesso.';
        const commandTitle = data.command?.title || 'Comando executado';
        
        console.log('[ASSISTANT] ✅ Sucesso');
        console.log('[ASSISTANT] Comando:', commandTitle);
        console.log('[ASSISTANT] Resposta:', replyText);
        
        setResponse({
          command: commandTitle,
          reply: replyText,
          result: data.result,
        });

        // Falar a resposta
        console.log('[TTS] Iniciando síntese de voz...');
        speak(replyText);

        // Adicionar ao histórico
        setCommandHistory(prev => [...prev, {
          timestamp: new Date(),
          command: commandText,
          response: replyText,
          status: 'success',
        }]);
      } else {
        const errorMsg = data.reply_text || 'Erro ao processar comando.';
        console.warn('[ASSISTANT] ❌ Erro:', data.error);
        console.warn('[ASSISTANT] Mensagem:', errorMsg);
        
        setError(errorMsg);
        speak(errorMsg);

        setCommandHistory(prev => [...prev, {
          timestamp: new Date(),
          command: commandText,
          response: errorMsg,
          status: 'error',
        }]);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log('[ASSISTANT] Requisição abortada pelo usuário');
        return;
      }
      
      const errorMsg = err.message || 'Erro desconhecido ao conectar com o assistente.';
      console.error('[ASSISTANT] ❌ Erro:', err);
      
      // Mensagens de erro mais específicas
      let userMessage = errorMsg;
      if (errorMsg.includes('CORS')) {
        userMessage = 'Erro de configuração: Assistente não está acessível. Contate o administrador.';
      } else if (errorMsg.includes('Failed to fetch')) {
        userMessage = 'Erro de conexão: Assistente indisponível. Verifique a URL.';
      } else if (errorMsg.includes('401')) {
        userMessage = 'Erro de autenticação: Faça login novamente.';
      }
      
      setError(userMessage);
      speak('Erro ao conectar com o assistente.');
    } finally {
      setIsLoading(false);
    }
  };

  // Iniciar reconhecimento de voz
  const handleStartListening = () => {
    if (recognitionRef.current && !isListening && !isLoading) {
      setTranscript('');
      setResponse('');
      finalTranscriptRef.current = '';
      recognitionRef.current.start();
    }
  };

  // Parar reconhecimento de voz e enviar
  const handleStopListening = () => {
    if (recognitionRef.current && isListening) {
      recognitionRef.current.stop();
      // Enviar após um pequeno delay para garantir que o transcript foi processado
      setTimeout(() => {
        setTranscript(prev => {
          if (prev.trim()) {
            sendCommandToAssistant(prev.trim());
          }
          return prev;
        });
      }, 100);
    }
  };

  // Parar fala
  const handleStopSpeaking = () => {
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
      console.log('[TTS] Áudio cancelado');
    }
  };

  // Limpar histórico
  const handleClearHistory = () => {
    setCommandHistory([]);
    setTranscript('');
    setResponse('');
    setError('');
  };

  return (
    <div className="voice-assistant-page">
      <Sidebar />

      <main className="voice-assistant-content">
        <div className="voice-assistant-header">
          <h2>Assistente de Voz</h2>
          <p>Clique no botão e fale seus comandos. O assistente responderá em voz.</p>
        </div>

        {error && (
          <div className="voice-assistant-error">
            <p>{error}</p>
          </div>
        )}

        <div className="voice-assistant-main">
          {/* Botão Animado */}
          <div className="voice-button-container">
            <button
              className={`voice-button ${isListening ? 'listening' : ''} ${isLoading ? 'loading' : ''}`}
              onClick={isListening ? handleStopListening : handleStartListening}
              disabled={isLoading}
              aria-label={isListening ? 'Parar de ouvir' : 'Iniciar assistente'}
            >
              <div className="voice-button-icon">
                {isLoading ? (
                  <span className="loading-spinner">⏳</span>
                ) : isListening ? (
                  <span className="listening-icon">🎤</span>
                ) : (
                  <span className="default-icon">🎤</span>
                )}
              </div>
            </button>

            {/* Círculos de ondas animadas */}
            {isListening && (
              <>
                <div className="wave-circle wave-1"></div>
                <div className="wave-circle wave-2"></div>
                <div className="wave-circle wave-3"></div>
              </>
            )}
          </div>

          {/* Transcript */}
          {transcript && (
            <div className="voice-transcript">
              <h3>Você disse:</h3>
              <p>{transcript}</p>
            </div>
          )}

          {/* Response */}
          {response && (
            <div className="voice-response">
              <h3>{response.command}</h3>
              <p className="response-text">{response.reply}</p>
              {response.result && (
                <div className="response-result">
                  <details>
                    <summary>Ver detalhes</summary>
                    <pre>{JSON.stringify(response.result, null, 2)}</pre>
                  </details>
                </div>
              )}
              <button 
                className="voice-button-secondary" 
                onClick={handleStopSpeaking}
              >
                Parar áudio
              </button>
            </div>
          )}

          {/* Status */}
          {isLoading && (
            <div className="voice-status">
              <p>Processando comando...</p>
            </div>
          )}

          {!isListening && !isLoading && !response && !transcript && (
            <div className="voice-hint">
              <p>Clique no botão do microfone e diga um comando.</p>
              <p className="hint-small">Ex: "minhas tarefas", "criar equipe", "meu perfil"</p>
            </div>
          )}
        </div>

        {/* Histórico de comandos */}
        {commandHistory.length > 0 && (
          <div className="voice-history">
            <div className="history-header">
              <h3>Histórico de Comandos ({commandHistory.length})</h3>
              <button 
                className="history-clear-btn" 
                onClick={handleClearHistory}
              >
                Limpar
              </button>
            </div>
            <div className="history-list">
              {commandHistory.map((item, index) => (
                <div key={index} className={`history-item ${item.status}`}>
                  <div className="history-time">
                    {item.timestamp.toLocaleTimeString('pt-BR')}
                  </div>
                  <div className="history-command">
                    <strong>Comando:</strong> {item.command}
                  </div>
                  <div className="history-response">
                    <strong>Resposta:</strong> {item.response}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default VoiceAssistantPage;
