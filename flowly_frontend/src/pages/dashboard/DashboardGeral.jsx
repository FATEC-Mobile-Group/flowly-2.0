import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import apiClient from "../../config/apiClient";
import { Link } from 'react-router-dom';
import { FaBell, FaSyncAlt } from 'react-icons/fa';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
} from 'chart.js';
import Sidebar from "../../components/layout/Sidebar";
import { useFotoPerfil } from "../../components/layout/useFotoPerfil";
import { API_ENDPOINTS } from "../../config/config";
import RankingEquipes from "./RankingEquipes";
import IndicadoresPainel from "./IndicadoresPainel";
import DistribuicaoTarefas from "./DistribuicaoTarefas";
import ListaEntregas from "./ListaEntregas";
import PontosAtencao from "./PontosAtencao";
import { useCoresDoTema } from "./useCoresDoTema";
import {
  chaveDiaLocal,
  filtrarPorEquipe,
  idDaEquipe,
  ordenarEquipesPorNome
} from "./painelGeralUtils";
import {
  DESTINOS,
  calcularPainel,
  listarAtrasadas,
  listarPontosAtencao,
  listarProximosSeteDias,
  periodoProximosSeteDias,
} from "./painelIndicadores";
import "../../styles/pages/dashboard/DashboardGeral.css";
import "../../styles/pages/admin/DashboardAdmin.css";

// Rosca da distribuicao: so o arco e o tooltip (sem Legend: a legenda e a lista acessivel ao lado).
ChartJS.register(ArcElement, Tooltip);

const AVISO_EQUIPE_INDISPONIVEL = 'A equipe selecionada não está mais disponível. Mostrando todas as equipes.';

// GET /tarefas?resumo=1: so os campos dos indicadores, sem URLs assinadas de anexos. Um backend que ainda nao
// conhece o parametro o ignora e devolve a lista completa, que tem os mesmos campos (e mais): o painel funciona igual.
const PARAMETROS_TAREFAS = { resumo: 1 };

function DashboardGeral() {
  const [equipes, setEquipes] = useState([]);
  const [tarefas, setTarefas] = useState([]);
  // carregando: ainda sem dados (nada de zeros); pronto: dados reais; erro: equipes ou tarefas falharam.
  const [estado, setEstado] = useState('carregando');
  const [atualizando, setAtualizando] = useState(false);
  const [equipeId, setEquipeId] = useState('');
  const [avisoFiltro, setAvisoFiltro] = useState('');
  const [notificationCount, setNotificationCount] = useState(0);
  const carregamentoAtual = useRef(null);
  const idFiltro = useId();
  const cores = useCoresDoTema();

  const adminName = localStorage.getItem('nome') || 'Admin Flowly';
  const { fotoUrl, aoFalharFoto } = useFotoPerfil();

  // Um carregamento por vez: o novo cancela o anterior, e nada atualiza o estado depois de desmontar.
  const carregarDados = useCallback(async () => {
    carregamentoAtual.current?.abort();
    const controle = new AbortController();
    carregamentoAtual.current = controle;
    setAtualizando(true);

    try {
      const [resEquipes, resTarefas] = await Promise.all([
        apiClient.get(API_ENDPOINTS.EQUIPES, { signal: controle.signal }),
        apiClient.get(API_ENDPOINTS.TAREFAS, { signal: controle.signal, params: PARAMETROS_TAREFAS }),
      ]);
      if (controle.signal.aborted) return;
      if (!Array.isArray(resEquipes?.data) || !Array.isArray(resTarefas?.data)) {
        throw new Error('Resposta inesperada ao carregar equipes ou tarefas.');
      }
      setEquipes(resEquipes.data);
      setTarefas(resTarefas.data);
      setEstado('pronto');
    } catch (err) {
      if (controle.signal.aborted) return;
      console.error('Erro ao carregar o Painel Geral:', err);
      setEstado('erro');
    } finally {
      if (carregamentoAtual.current === controle) carregamentoAtual.current = null;
      if (!controle.signal.aborted) setAtualizando(false);
    }
  }, []);

  useEffect(() => {
    carregarDados();
    return () => carregamentoAtual.current?.abort();
  }, [carregarDados]);

  // O contador do sino e independente: se falhar, o painel segue normalmente.
  useEffect(() => {
    const controle = new AbortController();
    apiClient.get(API_ENDPOINTS.NOTIFICATIONS_COUNT, { signal: controle.signal })
      .then((res) => {
        if (!controle.signal.aborted) setNotificationCount(res.data?.count || 0);
      })
      .catch((err) => {
        if (!controle.signal.aborted) console.error('Erro ao buscar notificações:', err);
      });
    return () => controle.abort();
  }, []);

  const tentarNovamente = () => {
    setEstado('carregando');
    carregarDados();
  };

  const filtro = useMemo(() => filtrarPorEquipe(equipes, tarefas, equipeId), [equipes, tarefas, equipeId]);
  const filtrando = Boolean(filtro.equipeId);
  const selecaoIndisponivel = Boolean(equipeId) && !filtrando;

  // Equipe escolhida que sumiu numa atualizacao: volta para "todas" e avisa (o filtro ja ignora o id invalido).
  useEffect(() => {
    if (estado === 'pronto' && selecaoIndisponivel) {
      setEquipeId('');
      setAvisoFiltro(AVISO_EQUIPE_INDISPONIVEL);
    }
  }, [estado, selecaoIndisponivel]);

  const escolherEquipe = (evento) => {
    setEquipeId(evento.target.value);
    setAvisoFiltro('');
  };

  // Tudo calculado sobre a mesma base carregada; trocar a equipe nao consulta a API.
  const hoje = chaveDiaLocal(new Date());
  const indicadores = useMemo(() => calcularPainel(filtro.equipes, filtro.tarefas, hoje), [filtro, hoje]);
  const atrasadas = useMemo(() => listarAtrasadas(filtro.tarefas, hoje), [filtro, hoje]);
  const proximas = useMemo(() => listarProximosSeteDias(filtro.tarefas, hoje), [filtro, hoje]);
  const pontos = useMemo(() => listarPontosAtencao(indicadores, { filtrando }), [indicadores, filtrando]);
  const periodo = periodoProximosSeteDias(hoje);
  const opcoesEquipes = ordenarEquipesPorNome(equipes).filter((equipe) => idDaEquipe(equipe));
  const equipeSelecionada = filtrando ? filtro.equipes[0]?.nome || 'Equipe sem nome' : null;

  return (
  <div className="admin-page">
    <Sidebar />

    <main className="dashboard-geral">
      <header className="dashboard-header">
        <div className="painel-titulo">
          <h2>Painel Geral</h2>
          <p>Situação das equipes e tarefas sob sua gestão, com atalhos para as listas filtradas.</p>
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

      <div className="painel-filtros">
        <div className="filtro-equipe">
          <label htmlFor={idFiltro}>Equipe</label>
          <select id={idFiltro} value={filtro.equipeId} onChange={escolherEquipe} disabled={estado !== 'pronto'}>
            <option value="">Todas as equipes</option>
            {opcoesEquipes.map((equipe) => (
              <option key={idDaEquipe(equipe)} value={idDaEquipe(equipe)}>
                {equipe.nome || 'Equipe sem nome'}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="botao-atualizar" onClick={carregarDados} disabled={atualizando}>
          <FaSyncAlt aria-hidden="true" className={atualizando ? 'girando' : undefined} />
          <span>{atualizando ? 'Atualizando…' : 'Atualizar'}</span>
        </button>
        {estado === 'pronto' && (
          <p className="painel-escopo">
            {equipeSelecionada ? <>Mostrando a equipe <strong>{equipeSelecionada}</strong></> : 'Mostrando todas as equipes'}
          </p>
        )}
      </div>

      {avisoFiltro && <p className="aviso-filtro" role="status">{avisoFiltro}</p>}

      {estado === 'erro' ? (
        <section className="glass-card painel-erro" role="alert">
          <h3>Não foi possível carregar os dados do painel.</h3>
          <p>Os indicadores não foram exibidos para não mostrar números incorretos.</p>
          <button type="button" className="botao-tentar" onClick={tentarNovamente}>
            Tentar novamente
          </button>
        </section>
      ) : (
        <>
          <IndicadoresPainel
            indicadores={estado === 'pronto' ? indicadores : null}
            filtrando={filtrando}
            totalEquipes={equipes.length}
            equipeId={filtro.equipeId}
          />

          {estado === 'carregando' ? (
            <p className="painel-status" role="status">Carregando dados do painel…</p>
          ) : (
            <>
              <div className="dashboard-grid">
                <DistribuicaoTarefas
                  indicadores={indicadores}
                  equipeId={filtro.equipeId}
                  filtrando={filtrando}
                  cores={cores}
                />
                <RankingEquipes key={filtro.equipeId || 'todas'} equipes={filtro.equipes} tarefas={filtro.tarefas} />
              </div>

              <div className="dashboard-grid dashboard-grid--entregas">
                <ListaEntregas
                  titulo="Entregas atrasadas"
                  subtitulo="Não concluídas com prazo antes de hoje, das mais antigas para as mais recentes"
                  tipo="atrasadas"
                  itens={atrasadas.itens}
                  total={atrasadas.total}
                  equipeId={filtro.equipeId}
                  destino={DESTINOS.atrasadas}
                  vazio={filtrando ? 'Nenhuma tarefa atrasada nesta equipe.' : 'Nenhuma tarefa atrasada.'}
                  rotuloTotal="Ver todas as atrasadas"
                />
                <ListaEntregas
                  titulo="Próximas entregas"
                  subtitulo={`Não concluídas com prazo de hoje (${periodo.inicio}) até ${periodo.fim}`}
                  tipo="proximas"
                  itens={proximas.itens}
                  total={proximas.total}
                  equipeId={filtro.equipeId}
                  destino={DESTINOS.proximos7}
                  vazio={filtrando ? 'Nenhuma entrega nos próximos 7 dias nesta equipe.' : 'Nenhuma entrega nos próximos 7 dias.'}
                  rotuloTotal="Ver entregas dos próximos 7 dias"
                />
              </div>

              <PontosAtencao pontos={pontos} equipeId={filtro.equipeId} />
            </>
          )}
        </>
      )}
    </main>
  </div>
);

}

export default DashboardGeral;
