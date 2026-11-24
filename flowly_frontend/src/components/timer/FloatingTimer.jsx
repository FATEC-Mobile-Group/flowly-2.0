import React, { useState, useEffect, useCallback } from 'react';
import apiClient from '../../config/apiClient';
import { authUtils } from '../../config/authUtils';
import { EVENTO_CRONOMETRO, acumuladoEmSegundos } from '../../pages/user/meuDiaUtils';
import '../../styles/components/FloatingTimer.css';

// Cartoes dos cronometros ATIVOS do usuario (nao e uma notificacao temporaria): vem de /tarefas/minhas, com nova
// consulta a cada 2 min e quando alguma tela avisa que um cronometro mudou (EVENTO_CRONOMETRO). Ocultar um cartao
// (x) nao pausa nada: so esconde aquela sessao (tarefa + inicio) nesta aba; uma nova sessao volta a aparecer.
const CHAVE_OCULTOS = 'flowly:cronometros-ocultos';

const lerOcultos = () => {
  try {
    const valor = JSON.parse(sessionStorage.getItem(CHAVE_OCULTOS) || '[]');
    return Array.isArray(valor) ? valor.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

const gravarOcultos = (lista) => {
  try {
    sessionStorage.setItem(CHAVE_OCULTOS, JSON.stringify(lista));
  } catch {
    // Sem sessionStorage (modo privado): oculta so enquanto o componente estiver montado.
  }
};

const chaveDaSessao = (tarefa) => `${tarefa._id}:${tarefa.ultimaAtualizacaoCronometro || ''}`;

const FloatingTimer = () => {
  const [tarefasAtivas, setTarefasAtivas] = useState([]);
  const [now, setNow] = useState(Date.now());
  // Instante (navegador) da ultima consulta: a sessao parte do que dava para medir nele e avanca pelo relogio
  // local, entao um relogio de servidor adiantado nao deixa o cartao parado.
  const [carregadoEm, setCarregadoEm] = useState(Date.now());
  const [ocultos, setOcultos] = useState(lerOcultos);

  const fetchAtivas = useCallback(async () => {
    try {
      const res = await apiClient.get('/tarefas/minhas');
      const userId = authUtils.getUserId();
      const ativas = (Array.isArray(res.data) ? res.data : []).filter((t) => {
        const responsavelId = typeof t.user === 'object' ? t.user?._id : t.user;
        return t.cronometroAtivo && String(responsavelId) === String(userId);
      });
      const agora = Date.now();
      setTarefasAtivas(ativas);
      setCarregadoEm(agora);
      setNow(agora);
      // Sessoes que ja terminaram nao precisam continuar na lista de ocultas.
      const vivas = new Set(ativas.map(chaveDaSessao));
      setOcultos((atuais) => {
        const filtrados = atuais.filter((chave) => vivas.has(chave));
        if (filtrados.length !== atuais.length) gravarOcultos(filtrados);
        return filtrados.length !== atuais.length ? filtrados : atuais;
      });
    } catch (err) {
      console.error('Erro ao buscar tarefas ativas', err);
    }
  }, []);

  useEffect(() => {
    fetchAtivas();

    // Tick de 1 minuto para atualização da tela local
    const intervalTicker = setInterval(() => {
      setNow(Date.now());
    }, 60000);

    // Polling do backend para garantir consistencia com o server
    const intervalPoll = setInterval(fetchAtivas, 60000 * 2);

    // Cronometro iniciado/pausado em outra tela: consulta na hora (sem esperar o polling).
    window.addEventListener(EVENTO_CRONOMETRO, fetchAtivas);

    return () => {
      clearInterval(intervalTicker);
      clearInterval(intervalPoll);
      window.removeEventListener(EVENTO_CRONOMETRO, fetchAtivas);
    };
  }, [fetchAtivas]);

  const ocultar = (tarefa) => {
    const chave = chaveDaSessao(tarefa);
    setOcultos((atuais) => {
      if (atuais.includes(chave)) return atuais;
      const proximos = [...atuais, chave];
      gravarOcultos(proximos);
      return proximos;
    });
  };

  const visiveis = tarefasAtivas.filter((t) => !ocultos.includes(chaveDaSessao(t)));
  if (visiveis.length === 0) return null;

  return (
    <div className="floating-timer-container">
      {visiveis.map(t => {
        // Acumulado preciso (segundos) + sessao em andamento, exibido em minutos inteiros: os segundos que sobraram
        // de sessoes anteriores entram na conta (antes, minutos legados + minutos da sessao ficavam abaixo do real).
        const startedAt = new Date(t.ultimaAtualizacaoCronometro).getTime();
        const segundosSessao = Number.isFinite(startedAt)
          ? Math.floor((Math.max(0, carregadoEm - startedAt) + Math.max(0, now - carregadoEm)) / 1000)
          : 0;
        const totalMins = Math.floor((acumuladoEmSegundos(t) + segundosSessao) / 60);
        const descricao = String(t.descricao || 'Tarefa');

        return (
          <div key={t._id} className={`floating-timer-chip ${t.tempoExcedido || (t.tempoEstimado && totalMins > t.tempoEstimado) ? 'danger' : ''}`}>
            ⏱️ <strong>{descricao.length > 20 ? descricao.substring(0, 20)+'...' : descricao}</strong>
            <span className="time-badge">{totalMins} min</span>
            <button
              type="button"
              className="floating-timer-close"
              onClick={() => ocultar(t)}
              aria-label={`Ocultar o aviso do cronômetro de ${descricao} (o cronômetro continua contando)`}
              title="Ocultar aviso (o cronômetro continua)"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default FloatingTimer;
