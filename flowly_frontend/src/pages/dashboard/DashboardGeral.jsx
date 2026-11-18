import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import apiClient from "../../config/apiClient";
import { Link } from 'react-router-dom';
import { FaBell, FaSyncAlt } from 'react-icons/fa';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  Tooltip,
  CategoryScale,
  LinearScale,
  BarElement
} from 'chart.js';
import Sidebar from "../../components/layout/Sidebar";
import { useFotoPerfil } from "../../components/layout/useFotoPerfil";
import { API_ENDPOINTS } from "../../config/config";
import RankingEquipes from "./RankingEquipes";
import IndicadoresPainel from "./IndicadoresPainel";
import ProximasEntregas from "./ProximasEntregas";
import { useCoresDoTema } from "./useCoresDoTema";
import {
  calcularIndicadores,
  chaveDiaLocal,
  contarPorStatus,
  filtrarPorEquipe,
  idDaEquipe,
  listarProximasEntregas,
  ordenarEquipesPorNome
} from "./painelGeralUtils";
import "../../styles/pages/dashboard/DashboardGeral.css";
import "../../styles/pages/admin/DashboardAdmin.css";

ChartJS.register(
  BarElement,
  Tooltip,
  CategoryScale,
  LinearScale
);

const CORES_STATUS = ['rgba(255, 51, 102, 0.8)', 'rgba(251, 192, 45, 0.8)', 'rgba(0, 212, 141, 0.8)'];
const AVISO_EQUIPE_INDISPONIVEL = 'A equipe selecionada não está mais disponível. Mostrando todas as equipes.';

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
        apiClient.get(API_ENDPOINTS.TAREFAS, { signal: controle.signal }),
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

  const filtro = filtrarPorEquipe(equipes, tarefas, equipeId);
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

  const hoje = chaveDiaLocal(new Date());
  const indicadores = calcularIndicadores(filtro.equipes, filtro.tarefas, hoje);
  const entregas = listarProximasEntregas(filtro.tarefas, hoje);
  const opcoesEquipes = ordenarEquipesPorNome(equipes).filter((equipe) => idDaEquipe(equipe));

  const dadosGeraisBar = {
    labels: ['Pendente', 'Em Andamento', 'Concluído'],
    datasets: [{
      label: 'Quantidade de Tarefas',
      data: contarPorStatus(filtro.tarefas),
      backgroundColor: CORES_STATUS,
      borderRadius: 6
    }]
  };

  return (
  <div className="admin-page">
    <Sidebar />

    <main className="dashboard-geral">
      <header className="dashboard-header">
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
          />

          {estado === 'carregando' ? (
            <p className="painel-status" role="status">Carregando dados do painel…</p>
          ) : (
            <div className="dashboard-grid">
              <div className="glass-card big-chart">
                <header className="painel-cabecalho">
                  <h3>Visão Geral de Produtividade</h3>
                </header>
                {/* Altura fixa no contêiner: o gráfico não acompanha a altura do ranking. */}
                <div className="chart-area">
                  {filtro.tarefas.length === 0 ? (
                    <p className="painel-vazio chart-vazio">
                      {filtrando ? 'Esta equipe ainda não tem tarefas.' : 'Nenhuma tarefa nas suas equipes.'}
                    </p>
                  ) : (
                    <Bar
                      data={dadosGeraisBar}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                          // Outras telas registram o Legend no Chart.js global: aqui ele fica desligado.
                          legend: { display: false },
                          title: { display: false }
                        },
                        scales: {
                          x: { ticks: { color: cores.texto }, grid: { color: cores.grade } },
                          y: {
                            beginAtZero: true,
                            title: { display: true, text: 'Volume', color: cores.texto },
                            ticks: { color: cores.texto, stepSize: 1 },
                            grid: { color: cores.grade }
                          }
                        }
                      }}
                    />
                  )}
                </div>
              </div>

              <RankingEquipes key={filtro.equipeId || 'todas'} equipes={filtro.equipes} tarefas={filtro.tarefas} />

              <ProximasEntregas itens={entregas.itens} total={entregas.total} filtrando={filtrando} />
            </div>
          )}
        </>
      )}
    </main>
  </div>
);

}

export default DashboardGeral;
