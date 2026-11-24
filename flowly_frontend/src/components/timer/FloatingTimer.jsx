import React, { useState, useEffect, useCallback } from 'react';
import apiClient from '../../config/apiClient';
import { authUtils } from '../../config/authUtils';
import { EVENTO_CRONOMETRO, ancoraDaSessao, segundosDoCronometro } from '../../pages/user/meuDiaUtils';
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

// Minutos inteiros do mesmo calculo do Meu Dia: acumulado preciso + sessao medida pela mesma ancora (a salva nesta
// aba ou uma a partir da consulta, corrigida pela diferenca de relogio medida).
const minutosDaSessao = (tarefa, agora, carregadoEm) =>
  Math.floor(segundosDoCronometro(tarefa, agora, ancoraDaSessao(tarefa, carregadoEm)) / 60);

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

    // Polling do backend para garantir consistencia com o server
    const intervalPoll = setInterval(fetchAtivas, 60000 * 2);

    // Cronometro iniciado/pausado em outra tela: consulta na hora (sem esperar o polling).
    window.addEventListener(EVENTO_CRONOMETRO, fetchAtivas);

    return () => {
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

  // Atualizacao local (sem API): confere a cada 1 s e so re-renderiza quando algum minuto exibido muda, entao o
  // cartao acompanha o Meu Dia (11 min ate 11:59, 12 min a partir de 12:00). So existe com cartao visivel.
  const assinaturaVisiveis = visiveis.map(chaveDaSessao).join(',');
  useEffect(() => {
    if (!assinaturaVisiveis) return undefined;
    const minutos = (agora) => visiveis.map((t) => minutosDaSessao(t, agora, carregadoEm)).join('|');
    let ultimo = minutos(Date.now());
    const intervalo = setInterval(() => {
      const agora = Date.now();
      const atual = minutos(agora);
      if (atual !== ultimo) {
        ultimo = atual;
        setNow(agora);
      }
    }, 1000);
    return () => clearInterval(intervalo);
    // visiveis muda junto com a assinatura e carregadoEm; recriar a cada render nao e necessario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assinaturaVisiveis, carregadoEm]);

  if (visiveis.length === 0) return null;

  return (
    <div className="floating-timer-container">
      {visiveis.map(t => {
        // Acumulado preciso (segundos) + sessao em andamento, exibido em minutos inteiros.
        const totalMins = minutosDaSessao(t, now, carregadoEm);
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
