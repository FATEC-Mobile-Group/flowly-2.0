import React, { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FaBell, FaCheck, FaComments, FaDesktop, FaMicrophone, FaMoon, FaPalette, FaShieldAlt, FaStop, FaSun, FaUndo, FaUserCircle,
  FaVolumeUp,
} from 'react-icons/fa';
import Sidebar from '../../components/layout/Sidebar';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import { useFotoPerfil } from '../../components/layout/useFotoPerfil';
import { useNaoLidas } from '../../components/notifications/notificationStore';
import { useTheme } from '../../config/ThemeContext';
import { definirPreferencia, restaurarPreferencias, usePreferencias } from '../../config/preferencias';
import { FRASE_DE_PREVIA, aplicarVoz, encontrarVozTecnologica, escolherVozDoAssistente } from '../../utils/assistantVoice';
import '../../styles/pages/dashboard/DashboardGeral.css';
import '../../styles/pages/common/PreferenciasPage.css';

const TEMAS = [
  { id: 'dark', rotulo: 'Escuro', Icone: FaMoon },
  { id: 'light', rotulo: 'Claro', Icone: FaSun },
];

// Interruptor acessivel: role="switch", nome pelo titulo e descricao pelo texto explicativo.
function Interruptor({ titulo, descricao, ativo, onAlterar }) {
  const id = useId();
  return (
    <div className="preferencia-linha">
      <div className="preferencia-texto">
        <span id={`${id}-titulo`} className="preferencia-titulo">{titulo}</span>
        <span id={`${id}-descricao`} className="preferencia-descricao">{descricao}</span>
      </div>
      <button
        type="button"
        role="switch"
        className={`preferencia-switch ${ativo ? 'is-ativo' : ''}`}
        aria-checked={ativo}
        aria-labelledby={`${id}-titulo`}
        aria-describedby={`${id}-descricao`}
        onClick={() => onAlterar(!ativo)}
      >
        <span className="preferencia-switch-trilho" aria-hidden="true"><span className="preferencia-switch-botao" /></span>
        <span className="preferencia-switch-estado" aria-hidden="true">{ativo ? 'Ativado' : 'Desativado'}</span>
      </button>
    </div>
  );
}

const VOZES = [
  { id: 'tecnologica', rotulo: 'Voz tecnológica', descricao: 'Masculina, grave e um pouco mais rápida (Microsoft Daniel, pt-BR).' },
  { id: 'original', rotulo: 'Voz original', descricao: 'A voz em português do Brasil usada até agora pelo assistente.' },
];

// Vozes do navegador (podem chegar depois: voiceschanged). So para saber se a voz tecnologica existe e para a previa.
function useVozesDoNavegador() {
  const [vozes, setVozes] = useState([]);
  useEffect(() => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    if (!synth || typeof synth.getVoices !== 'function') return undefined;
    const carregar = () => setVozes(synth.getVoices() || []);
    carregar();
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', carregar);
      return () => synth.removeEventListener('voiceschanged', carregar);
    }
    return undefined;
  }, []);
  return vozes;
}

function Cartao({ icone: Icone, titulo, descricao, children }) {
  const id = useId();
  return (
    <section className="glass-card preferencias-cartao" aria-labelledby={id}>
      <header className="preferencias-cartao-topo">
        <span className="preferencias-cartao-icone" aria-hidden="true"><Icone /></span>
        <div>
          <h3 id={id}>{titulo}</h3>
          {descricao && <p>{descricao}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

// Central de preferencias (PR #68): mesma aparencia do seletor rapido (ThemeContext) e as preferencias de interface
// da conta (config/preferencias.js). Tudo vale na hora, sem botao Salvar.
export default function PreferenciasPage() {
  const { theme, palette, palettes, setTheme, setPalette, restaurarAparencia } = useTheme();
  const preferencias = usePreferencias();
  const [confirmando, setConfirmando] = useState(false);
  const [aviso, setAviso] = useState('');
  const naoLidas = useNaoLidas() ?? 0;
  const { fotoUrl, aoFalharFoto } = useFotoPerfil();
  const nome = localStorage.getItem('nome') || 'Usuário';
  const idTema = useId();
  const idPaleta = useId();
  const idVoz = useId();
  const vozes = useVozesDoNavegador();
  const [tocandoPrevia, setTocandoPrevia] = useState(false);
  const previaRef = useRef(null);
  const sintetizador = typeof window !== 'undefined' ? window.speechSynthesis : null;
  const podeFalar = Boolean(sintetizador) && typeof SpeechSynthesisUtterance !== 'undefined';
  const tecnologicaDisponivel = Boolean(encontrarVozTecnologica(vozes));

  // Sair da pagina interrompe a previa (so ela: a central nao tem outra fala).
  useEffect(() => () => {
    if (previaRef.current && window.speechSynthesis) window.speechSynthesis.cancel();
  }, []);

  // Previa: frase fixa, com a voz e os ajustes da opcao escolhida. Nao liga o microfone nem consulta o backend.
  const ouvirPrevia = () => {
    if (!podeFalar) return;
    if (tocandoPrevia) {
      previaRef.current = null;
      sintetizador.cancel();
      setTocandoPrevia(false);
      return;
    }
    sintetizador.cancel();
    const fala = new SpeechSynthesisUtterance(FRASE_DE_PREVIA);
    fala.lang = 'pt-BR';
    aplicarVoz(fala, escolherVozDoAssistente(vozes.length ? vozes : (sintetizador.getVoices?.() || []), preferencias.vozAssistente));
    const terminar = () => {
      if (previaRef.current !== fala) return;
      previaRef.current = null;
      setTocandoPrevia(false);
    };
    fala.onend = terminar;
    fala.onerror = terminar;
    previaRef.current = fala;
    setTocandoPrevia(true);
    sintetizador.speak(fala);
  };

  const alterar = (nomePreferencia) => (valor) => {
    definirPreferencia(nomePreferencia, valor);
    setAviso('');
  };

  const restaurar = () => {
    restaurarPreferencias();
    restaurarAparencia();
    setConfirmando(false);
    setAviso('Preferências padrão restauradas.');
  };

  return (
    <div className="admin-page">
      <Sidebar />

      <main className="dashboard-geral preferencias-pagina">
        <header className="dashboard-header">
          <div className="painel-titulo">
            <h2>Preferências</h2>
            <p>Personalize a aparência e o funcionamento do Flowly. As alterações valem na hora e só para a sua conta.</p>
          </div>
          <div className="header-profile">
            <Link to="/notificacoes" className="notification-bell" aria-label="Ver notificações">
              <FaBell />
              {naoLidas > 0 && <span className="notification-badge">{naoLidas}</span>}
            </Link>
            <div className="profile-info">
              <div className="avatar">
                {fotoUrl ? (
                  <img src={fotoUrl} alt="Foto de perfil" className="avatar-img" onError={aoFalharFoto} />
                ) : (
                  nome.charAt(0).toUpperCase()
                )}
              </div>
              <span>{nome}</span>
            </div>
          </div>
        </header>

        {aviso && <p className="aviso-filtro" role="status">{aviso}</p>}

        <div className="preferencias-grade">
          <Cartao icone={FaPalette} titulo="Aparência" descricao="As mesmas opções do botão de aparência no canto da tela.">
            <div className="preferencia-grupo">
              <span id={idTema} className="preferencia-titulo">Tema</span>
              <div className="preferencias-opcoes" role="radiogroup" aria-labelledby={idTema}>
                {TEMAS.map(({ id, rotulo, Icone }) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={theme === id}
                    className={`preferencias-opcao ${theme === id ? 'is-selecionada' : ''}`}
                    onClick={() => setTheme(id)}
                  >
                    <span className={`preferencias-previa preferencias-previa--${id}`} aria-hidden="true">
                      <span className="previa-barra" />
                      <span className="previa-cartao" />
                      <span className="previa-cartao previa-cartao--curto" />
                    </span>
                    <span className="preferencias-opcao-rotulo">
                      <Icone aria-hidden="true" />
                      {rotulo}
                      {theme === id && <FaCheck className="preferencias-check" aria-hidden="true" />}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="preferencia-grupo">
              <span id={idPaleta} className="preferencia-titulo">Paleta de cores</span>
              <div className="preferencias-opcoes preferencias-opcoes--paletas" role="radiogroup" aria-labelledby={idPaleta}>
                {palettes.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={palette === item.id}
                    className={`preferencias-opcao preferencias-paleta ${palette === item.id ? 'is-selecionada' : ''}`}
                    onClick={() => setPalette(item.id)}
                  >
                    <span className="preferencias-amostra" style={{ '--amostra-cor': item.color }} aria-hidden="true" />
                    <span className="preferencias-opcao-rotulo">
                      {item.label}
                      {palette === item.id && <FaCheck className="preferencias-check" aria-hidden="true" />}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </Cartao>

          <Cartao icone={FaDesktop} titulo="Interface e desempenho">
            <Interruptor
              titulo="Fundo animado"
              descricao="Ondas animadas atrás das páginas. Desativado, fica um fundo estático com as cores do tema e o processamento da animação é interrompido."
              ativo={preferencias.fundoAnimado}
              onAlterar={alterar('fundoAnimado')}
            />
            <Interruptor
              titulo="Barra lateral recolhida"
              descricao="Mostra só os ícones na barra lateral em todas as páginas. O botão de recolher da própria barra também altera esta opção."
              ativo={preferencias.sidebarRecolhida}
              onAlterar={alterar('sidebarRecolhida')}
            />
          </Cartao>

          <Cartao icone={FaComments} titulo="Comunicação">
            <Interruptor
              titulo="Avisos de novas mensagens"
              descricao="Aviso flutuante quando chega uma mensagem no chat. Desativado, as notificações, os contadores e a central continuam funcionando."
              ativo={preferencias.toastsMensagens}
              onAlterar={alterar('toastsMensagens')}
            />
            <Interruptor
              titulo="Enviar mensagens com Enter"
              descricao="Ativado: Enter envia e Shift+Enter quebra a linha. Desativado: Enter quebra a linha e o envio é pelo botão Enviar."
              ativo={preferencias.enviarComEnter}
              onAlterar={alterar('enviarComEnter')}
            />
          </Cartao>

          <Cartao icone={FaMicrophone} titulo="Assistente" descricao="Voz usada nas respostas faladas do assistente.">
            <div className="preferencia-grupo">
              <span id={idVoz} className="preferencia-titulo">Voz do assistente</span>
              <div className="preferencias-opcoes" role="radiogroup" aria-labelledby={idVoz}>
                {VOZES.map((voz) => (
                  <button
                    key={voz.id}
                    type="button"
                    role="radio"
                    aria-checked={preferencias.vozAssistente === voz.id}
                    className={`preferencias-opcao preferencias-voz ${preferencias.vozAssistente === voz.id ? 'is-selecionada' : ''}`}
                    onClick={() => alterar('vozAssistente')(voz.id)}
                  >
                    <span className="preferencias-opcao-rotulo">
                      {voz.rotulo}
                      {preferencias.vozAssistente === voz.id && <FaCheck className="preferencias-check" aria-hidden="true" />}
                    </span>
                    <span className="preferencia-descricao">{voz.descricao}</span>
                  </button>
                ))}
              </div>
              {preferencias.vozAssistente === 'tecnologica' && vozes.length > 0 && !tecnologicaDisponivel && (
                <p className="preferencia-descricao preferencias-nota" role="status">
                  A voz tecnológica não está instalada neste navegador. O assistente usa a voz original em português.
                </p>
              )}
            </div>
            <div className="preferencias-acoes-voz">
              <button type="button" className="preferencias-restaurar" onClick={ouvirPrevia} disabled={!podeFalar}>
                {tocandoPrevia ? <FaStop aria-hidden="true" /> : <FaVolumeUp aria-hidden="true" />}
                <span>{tocandoPrevia ? 'Parar prévia' : 'Ouvir prévia'}</span>
              </button>
              <Link to="/assistente" className="preferencias-atalho">
                <FaMicrophone aria-hidden="true" />
                <span>Abrir o assistente</span>
              </Link>
            </div>
          </Cartao>

          <Cartao icone={FaUserCircle} titulo="Conta">
            <div className="preferencias-atalhos">
              <Link to="/perfil" className="preferencias-atalho">
                <FaUserCircle aria-hidden="true" />
                <span>Meu perfil</span>
                <small>Foto e nome</small>
              </Link>
              <Link to="/perfil" className="preferencias-atalho">
                <FaShieldAlt aria-hidden="true" />
                <span>Segurança</span>
                <small>Senha e reconhecimento facial, na página Meu perfil</small>
              </Link>
            </div>
          </Cartao>

          <Cartao icone={FaUndo} titulo="Restaurar padrões">
            <p className="preferencia-descricao">
              Volta ao tema escuro com a paleta roxa, fundo animado, barra lateral expandida, avisos de mensagens, envio com
              Enter e voz tecnológica do assistente. Não altera seus dados, tarefas, notificações nem a segurança da conta.
            </p>
            <button type="button" className="preferencias-restaurar" onClick={() => setConfirmando(true)}>
              <FaUndo aria-hidden="true" />
              <span>Restaurar preferências padrão</span>
            </button>
          </Cartao>
        </div>
      </main>

      <ConfirmDialog
        open={confirmando}
        title="Restaurar preferências padrão?"
        message="Aparência e preferências de interface voltam ao padrão nesta conta. Seus dados não são alterados."
        confirmLabel="Restaurar"
        onConfirm={restaurar}
        onCancel={() => setConfirmando(false)}
      />
    </div>
  );
}
