import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FaBell, FaSyncAlt } from 'react-icons/fa';
import { CategoryScale, Chart as ChartJS, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js';
import apiClient from '../../../config/apiClient';
import { API_ENDPOINTS } from '../../../config/config';
import Sidebar from '../../../components/layout/Sidebar';
import { useFotoPerfil } from '../../../components/layout/useFotoPerfil';
import { useCoresDoTema } from '../../dashboard/useCoresDoTema';
import VisaoGeralInsights from './VisaoGeralInsights';
import EquipesInsights from './EquipesInsights';
import ModeracaoInsights from './ModeracaoInsights';
import AlertasInsights from './AlertasInsights';
import InsightsLegado, { AVISO_LEGADO } from './InsightsLegado';
import {
  ABAS,
  PERIODOS,
  chaveDaConsulta,
  descreverPeriodo,
  formatarDataHora,
  interpretarResposta,
  lerFiltrosInsights,
  parametrosDaConsulta,
  serializarFiltrosInsights,
} from './insightsUtils';
import '../../../styles/pages/dashboard/DashboardGeral.css';
import '../../../styles/pages/admin/DashboardAdmin.css';
import '../../../styles/pages/admin/InsightsAdmin.css';

// Grafico diario (linhas): sem Legend do Chart.js, a legenda e uma lista de texto.
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip);

// Estouro de um limite de agregacao (diferente dos limites intencionais das listas): os numeros afetados ficam
// indisponiveis em todas as abas, e a pagina sugere reduzir a consulta.
export const AVISO_LIMITE_REGISTROS = 'O volume de registros passou do limite de agregação. Indicadores de comunicação, gráficos, '
  + 'moderação por categoria e recomendações ficaram indisponíveis para não exibir totais incompletos. Reduza o período ou escolha uma equipe.';
export const AVISO_LIMITE_ALERTAS = 'A quantidade de alertas passou do limite de agregação. Os totais de alertas e as recomendações ficaram '
  + 'indisponíveis; a lista mostra os alertas mais recentes. Reduza o período ou escolha uma equipe.';
export const AVISO_LIMITE_ASSUNTOS = 'Os assuntos identificados ficaram indisponíveis: o volume passou do limite de agregação. Reduza o período ou escolha uma equipe.';

export const AVISO_EQUIPE_INDISPONIVEL = 'A equipe selecionada não está disponível para você. Mostrando todas as suas equipes.';

const ERROS = {
  rede: 'Não foi possível carregar os Insights. Verifique a conexão e tente novamente.',
  sessao: 'Sua sessão expirou ou não é mais válida. Entre novamente para ver os Insights.',
  acesso: 'Você não tem permissão para ver estes Insights.',
  parametros: 'A API não aceitou os filtros informados.',
  resposta: 'A API respondeu em um formato inesperado.',
};

// Estado da consulta. carregando: sem dados (nada de zeros); atualizando: mesmos filtros, dados anteriores na tela;
// pronto; erro. `chave` e a consulta que os dados representam (equipe|periodo|ocorrencia, sem a aba).
const ESTADO_INICIAL = { fase: 'carregando', resposta: null, chave: null, atualizacao: -1, erro: null, falhaAoAtualizar: false, carregadoEm: null };

// Falha temporaria (rede, tempo esgotado, servidor): numa atualizacao, os dados ja exibidos podem continuar.
// 401, 403 e 400 nao: os dados anteriores saem da tela.
const falhaTemporaria = (status) => !status || status >= 500 || status === 408 || status === 429;
const erroDoStatus = (status) => ({ 401: 'sessao', 403: 'acesso', 400: 'parametros' }[status] || 'rede');

// A resposta versao 2 precisa ser da consulta feita: mesmo periodo e mesma equipe. Todas as equipes no lugar da
// equipe pedida so vale com a indicacao explicita do contrato (equipeSolicitada indisponivel).
const respostaDaConsulta = (resposta, pedido) => {
  if (resposta.modo !== 'v2') return true;
  const { dados } = resposta;
  if (dados.periodo.dias !== pedido.periodo) return false;
  if (dados.filtroPeriodo !== null && dados.filtroPeriodo !== pedido.periodo) return false;
  if (dados.filtroEquipe === (pedido.equipe || '')) return !dados.equipeIndisponivel;
  return Boolean(pedido.equipe) && dados.filtroEquipe === '' && dados.equipeIndisponivel;
};

function InsightsAdmin() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { filtros, invalidos } = useMemo(() => lerFiltrosInsights(searchParams), [searchParams]);
  const chave = chaveDaConsulta(filtros);
  const [atualizacao, setAtualizacao] = useState(0);
  const [estado, setEstado] = useState(ESTADO_INICIAL);
  const [aviso, setAviso] = useState('');
  const [notificationCount, setNotificationCount] = useState(0);
  const cores = useCoresDoTema();
  const ids = { equipe: useId(), periodo: useId(), abas: useId() };
  const abasRef = useRef([]);

  const atual = useRef({ estado, filtros, setSearchParams });
  useLayoutEffect(() => {
    atual.current = { estado, filtros, setSearchParams };
  });

  const adminName = localStorage.getItem('nome') || 'Admin Flowly';
  const { fotoUrl, aoFalharFoto } = useFotoPerfil();

  // Uma consulta por combinacao de equipe, periodo e ocorrencia (ou pelo botao Atualizar). Trocar de aba nao
  // consulta. A consulta nova cancela a anterior, e so a resposta da consulta atual e aplicada.
  useEffect(() => {
    const { estado: anterior, filtros: filtrosAtuais } = atual.current;
    if (anterior.fase === 'pronto' && anterior.chave === chave && anterior.atualizacao === atualizacao) return undefined;
    const controle = new AbortController();
    const mesmaConsulta = Boolean(anterior.resposta) && anterior.chave === chave;
    setEstado((estadoAnterior) => (mesmaConsulta
      ? { ...estadoAnterior, fase: 'atualizando', falhaAoAtualizar: false }
      : { ...ESTADO_INICIAL, chave, atualizacao }));

    apiClient.get(API_ENDPOINTS.ADMIN_ASSISTANT_INSIGHTS, { params: parametrosDaConsulta(filtrosAtuais), signal: controle.signal })
      .then((res) => {
        if (controle.signal.aborted) return;
        const resposta = interpretarResposta(res?.data);
        if (resposta.modo === 'invalida' || !respostaDaConsulta(resposta, filtrosAtuais)) {
          setEstado({ ...ESTADO_INICIAL, fase: 'erro', erro: 'resposta', chave, atualizacao });
          return;
        }
        // Equipe fora do escopo: o backend respondeu por todas as equipes (e nao procurou a ocorrencia dela). A URL
        // passa a dizer isso, sem nova consulta, com a aba que estiver aberta agora (nao a do inicio da consulta).
        const semEquipe = resposta.modo === 'v2' && resposta.dados.equipeIndisponivel;
        const chaveEfetiva = semEquipe ? chaveDaConsulta({ ...filtrosAtuais, equipe: '', ocorrencia: '' }) : chave;
        setEstado({ ...ESTADO_INICIAL, fase: 'pronto', resposta, chave: chaveEfetiva, atualizacao, carregadoEm: new Date().toISOString() });
        if (semEquipe) {
          setAviso(AVISO_EQUIPE_INDISPONIVEL);
          const { filtros: filtrosDeAgora, setSearchParams: gravar } = atual.current;
          gravar(serializarFiltrosInsights({ ...filtrosDeAgora, equipe: '', ocorrencia: '' }), { replace: true, preventScrollReset: true });
        }
      })
      .catch((err) => {
        if (controle.signal.aborted) return;
        const status = err?.response?.status;
        console.error('Erro ao carregar os Insights:', status || err?.message || 'falha de rede');
        if (mesmaConsulta && falhaTemporaria(status)) {
          // Atualizacao que falhou por motivo temporario: os dados ja exibidos continuam, com o aviso e a data.
          setEstado((estadoAnterior) => ({ ...estadoAnterior, fase: 'pronto', atualizacao, falhaAoAtualizar: true }));
          return;
        }
        setEstado({ ...ESTADO_INICIAL, fase: 'erro', erro: erroDoStatus(status), chave, atualizacao });
      });
    return () => controle.abort();
  }, [chave, atualizacao]);

  // O contador do sino e independente: se falhar, a pagina segue normalmente.
  useEffect(() => {
    const controle = new AbortController();
    apiClient.get(API_ENDPOINTS.NOTIFICATIONS_COUNT, { signal: controle.signal })
      .then((res) => {
        if (!controle.signal.aborted) setNotificationCount(res?.data?.count || 0);
      })
      .catch(() => {});
    return () => controle.abort();
  }, []);

  const aplicar = (mudancas, opcoes = {}) => {
    setSearchParams(serializarFiltrosInsights({ ...filtros, ...mudancas }), { preventScrollReset: true, ...opcoes });
  };
  const escolherEquipe = (valor) => {
    setAviso('');
    aplicar({ equipe: valor, ocorrencia: '' });
  };
  const escolherPeriodo = (valor) => {
    setAviso('');
    aplicar({ periodo: Number(valor) });
  };
  const escolherAba = (valor) => aplicar({ aba: valor });
  const atualizar = () => setAtualizacao((n) => n + 1);

  // Teclado nas abas: setas, Home e End movem a selecao (padrao WAI-ARIA de abas com ativacao automatica).
  const aoTeclarNasAbas = (evento) => {
    const indice = ABAS.findIndex((aba) => aba.valor === filtros.aba);
    const destino = {
      ArrowRight: (indice + 1) % ABAS.length,
      ArrowLeft: (indice - 1 + ABAS.length) % ABAS.length,
      Home: 0,
      End: ABAS.length - 1,
    }[evento.key];
    if (destino === undefined) return;
    evento.preventDefault();
    escolherAba(ABAS[destino].valor);
    abasRef.current[destino]?.focus();
  };

  // So vale o estado da consulta atual: logo depois de trocar equipe, periodo ou ocorrencia (antes do efeito
  // iniciar a nova consulta), os dados anteriores nao aparecem com os filtros novos.
  const estadoDaTela = estado.chave === chave ? estado : ESTADO_INICIAL;
  const { fase, resposta } = estadoDaTela;
  const comDados = Boolean(resposta) && (fase === 'pronto' || fase === 'atualizando');
  const v2 = comDados && resposta.modo === 'v2' ? resposta.dados : null;
  const legado = comDados && resposta.modo === 'legado' ? resposta.dados : null;
  const opcoesEquipes = v2?.equipes || legado?.equipes || [];
  const equipeNaLista = !filtros.equipe || opcoesEquipes.some((equipe) => equipe.id === filtros.equipe);
  const nomeEquipe = filtros.equipe ? opcoesEquipes.find((equipe) => equipe.id === filtros.equipe)?.nome : null;
  const filtrosDaTela = v2 ? { ...filtros, equipe: v2.filtroEquipe } : filtros;

  const conteudo = () => {
    if (legado) return <InsightsLegado dados={legado} aba={filtros.aba} equipeId={filtros.equipe} />;
    if (!v2) return null;
    if (filtros.aba === 'equipes') return <EquipesInsights dados={v2} filtros={filtrosDaTela} />;
    if (filtros.aba === 'moderacao') return <ModeracaoInsights dados={v2} cores={cores} />;
    if (filtros.aba === 'alertas') return <AlertasInsights dados={v2} />;
    return <VisaoGeralInsights dados={v2} filtros={filtrosDaTela} cores={cores} />;
  };

  return (
    <div className="admin-page">
      <Sidebar />

      <main className="dashboard-geral insights-page">
        <header className="dashboard-header">
          <div className="painel-titulo">
            <h2>Insights inteligentes</h2>
            <p>Registros de comunicação, moderação e alertas das suas equipes, com recomendações baseadas nos dados.</p>
          </div>
          <div className="header-profile">
            <Link to="/notificacoes" className="notification-bell" aria-label="Ver notificações">
              <FaBell />
              {notificationCount > 0 && <span className="notification-badge">{notificationCount}</span>}
            </Link>
            <div className="profile-info">
              <div className="avatar">
                {fotoUrl ? (
                  <img src={fotoUrl} alt="Foto de perfil" className="avatar-img" onError={aoFalharFoto} />
                ) : (
                  adminName.charAt(0).toUpperCase()
                )}
              </div>
              <span>{adminName}</span>
            </div>
          </div>
        </header>

        <div className="painel-filtros insights-filtros">
          <div className="filtro-equipe">
            <label htmlFor={ids.equipe}>Equipe</label>
            <select id={ids.equipe} value={filtros.equipe} onChange={(evento) => escolherEquipe(evento.target.value)} disabled={!comDados}>
              <option value="">Todas as equipes</option>
              {!equipeNaLista && <option value={filtros.equipe}>Equipe selecionada</option>}
              {opcoesEquipes.map((equipe) => <option key={equipe.id} value={equipe.id}>{equipe.nome}</option>)}
            </select>
          </div>
          <div className="filtro-equipe filtro-periodo">
            <label htmlFor={ids.periodo}>Período</label>
            <select
              id={ids.periodo}
              value={filtros.periodo}
              onChange={(evento) => escolherPeriodo(evento.target.value)}
              disabled={!comDados || Boolean(legado)}
            >
              {PERIODOS.map((periodo) => <option key={periodo.valor} value={periodo.valor}>{periodo.rotulo}</option>)}
            </select>
          </div>
          <button type="button" className="botao-atualizar" onClick={atualizar} disabled={fase === 'carregando' || fase === 'atualizando'}>
            <FaSyncAlt aria-hidden="true" className={fase === 'carregando' || fase === 'atualizando' ? 'girando' : undefined} />
            <span>{fase === 'atualizando' ? 'Atualizando…' : 'Atualizar'}</span>
          </button>
          {v2 && (
            <p className="painel-escopo">
              {v2.filtroEquipe ? <>Equipe <strong>{nomeEquipe || 'selecionada'}</strong></> : 'Todas as suas equipes'}
              {` · ${descreverPeriodo(v2.periodo)}`}
            </p>
          )}
        </div>

        {invalidos.length > 0 && (
          <p className="aviso-filtro" role="status">{`Filtros ignorados por serem inválidos: ${invalidos.join(', ')}.`}</p>
        )}
        {aviso && <p className="aviso-filtro" role="status">{aviso}</p>}
        {legado && <p className="aviso-filtro insights-aviso-legado" role="status">{AVISO_LEGADO}</p>}
        {v2?.limites.registrosParciais && (
          <p className="aviso-filtro insights-aviso-limite" role="status" data-limite="registros">{AVISO_LIMITE_REGISTROS}</p>
        )}
        {v2?.limites.alertasParciais && (
          <p className="aviso-filtro insights-aviso-limite" role="status" data-limite="alertas">{AVISO_LIMITE_ALERTAS}</p>
        )}
        {v2?.limites.assuntosParciais && !v2.limites.registrosParciais && (
          <p className="aviso-filtro insights-aviso-limite" role="status" data-limite="assuntos">{AVISO_LIMITE_ASSUNTOS}</p>
        )}
        {estadoDaTela.falhaAoAtualizar && (
          <p className="aviso-filtro" role="alert">
            {`Não foi possível atualizar. Exibindo os dados carregados em ${formatarDataHora(estadoDaTela.carregadoEm)}.`}
          </p>
        )}

        <div className="insights-abas" role="tablist" aria-label="Seções dos Insights" onKeyDown={aoTeclarNasAbas}>
          {ABAS.map((aba, indice) => {
            const ativa = filtros.aba === aba.valor;
            return (
              <button
                key={aba.valor}
                ref={(elemento) => { abasRef.current[indice] = elemento; }}
                type="button"
                role="tab"
                id={`${ids.abas}-${aba.valor}`}
                aria-selected={ativa}
                aria-controls={`${ids.abas}-painel`}
                tabIndex={ativa ? 0 : -1}
                className={ativa ? 'is-ativa' : undefined}
                onClick={() => escolherAba(aba.valor)}
              >
                {aba.rotulo}
              </button>
            );
          })}
        </div>

        <div className="insights-painel" role="tabpanel" id={`${ids.abas}-painel`} aria-labelledby={`${ids.abas}-${filtros.aba}`} aria-busy={fase === 'carregando' || fase === 'atualizando'}>
          {fase === 'carregando' ? (
            <p className="painel-status" role="status">Carregando Insights…</p>
          ) : fase === 'erro' ? (
            <section className="glass-card painel-erro" role="alert">
              <h3>{ERROS[estadoDaTela.erro] || ERROS.rede}</h3>
              <p>Os indicadores não foram exibidos para não mostrar números incorretos.</p>
              {estadoDaTela.erro === 'parametros' ? (
                <Link className="botao-tentar" to="/admin/insights">Limpar filtros</Link>
              ) : estadoDaTela.erro === 'sessao' ? (
                <Link className="botao-tentar" to="/">Entrar novamente</Link>
              ) : !['acesso', 'sessao'].includes(estadoDaTela.erro) && (
                <button type="button" className="botao-tentar" onClick={atualizar}>Tentar novamente</button>
              )}
            </section>
          ) : (
            conteudo()
          )}
        </div>
      </main>
    </div>
  );
}

export default InsightsAdmin;
