import React, { useEffect, useState } from "react";
import axios from "axios";
import { Link } from 'react-router-dom';
import { FaBell } from 'react-icons/fa';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement
} from 'chart.js';
import Sidebar from "../../components/layout/Sidebar";
import { formatarStatus } from "../../config/statusUtils";
import { API_ENDPOINTS } from "../../config/config";
import "../../styles/pages/dashboard/DashboardGeral.css";
import "../../styles/pages/admin/DashboardAdmin.css";

ChartJS.register(
  ArcElement,
  BarElement,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale
);

function DashboardGeral() {
  const [equipes, setEquipes] = useState([]);
  const [tarefas, setTarefas] = useState([]);
  const [dadosGraficos, setDadosGraficos] = useState([]);
  const [notificationCount, setNotificationCount] = useState(0);

  const adminName = localStorage.getItem('nome') || 'Admin Flowly';

  useEffect(() => {
    buscarEquipes();
    buscarTarefas();
    buscarNotificationCount();
  }, []);

  useEffect(() => {
    if (equipes.length > 0 && tarefas.length > 0) {
      processarDadosGraficos();
    }
  }, [equipes, tarefas]);


  const processarDadosGraficos = () => {
    const dadosPorEquipe = equipes.map(equipe => {
      const tarefasEquipe = tarefas.filter(tarefa => tarefa.equipe?._id === equipe._id);
      
      const pendentes = tarefasEquipe.filter(t => t.status === 'pendente').length;
      const emAndamento = tarefasEquipe.filter(t => t.status === 'em_andamento').length;
      const concluidas = tarefasEquipe.filter(t => t.status === 'concluido').length;

      return {
        equipe: equipe.nome,
        dados: {
          labels: [formatarStatus('pendente'), formatarStatus('em_andamento'), formatarStatus('concluido')],
          datasets: [{
            data: [pendentes, emAndamento, concluidas],
            backgroundColor: ['#f44336', '#ff9800', '#4caf50'],
            borderWidth: 1
          }]
        }
      };
    });

    setDadosGraficos(dadosPorEquipe);
  };

  const buscarEquipes = async () => {
    try {
      const res = await axios.get("http://localhost:5000/api/equipes", {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
      });
      setEquipes(res.data);
    } catch (err) {
      console.error("Erro ao buscar equipes:", err);
    }
  };

  const buscarTarefas = async () => {
    try {
      const res = await axios.get("http://localhost:5000/api/tarefas", {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
      });
      setTarefas(res.data);
    } catch (err) {
      console.error("Erro ao buscar tarefas:", err);
    }
  };

  const buscarNotificationCount = async () => {
    try {
      const res = await axios.get(API_ENDPOINTS.NOTIFICATIONS_COUNT, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
      });
      setNotificationCount(res.data?.count || 0);
    } catch (err) {
      console.error('Erro ao buscar notificações:', err);
    }
  };

  const totalTarefas = tarefas.length;
  const tarefasConcluidas = tarefas.filter(t => t.status === 'concluido').length;
  const totalTempoGasto = tarefas.reduce((acc, t) => acc + (t.tempoGasto || 0), 0);
  
  // Calculate Ranking
  const equipesRanking = equipes.map(eq => {
    const tarefasEq = tarefas.filter(t => t.equipe?._id === eq._id);
    const concluidasEq = tarefasEq.filter(t => t.status === 'concluido').length;
    return { nome: eq.nome, concluidas: concluidasEq, total: tarefasEq.length };
  }).sort((a, b) => b.concluidas - a.concluidas);

  const dadosGeraisBar = {
    labels: ['Pendente', 'Em Andamento', 'Concluído'],
    datasets: [{
      label: 'Quantidade de Tarefas',
      data: [
        tarefas.filter(t => t.status === 'pendente').length,
        tarefas.filter(t => t.status === 'em_andamento').length,
        tarefas.filter(t => t.status === 'concluido').length
      ],
      backgroundColor: ['rgba(255, 51, 102, 0.8)', 'rgba(251, 192, 45, 0.8)', 'rgba(0, 212, 141, 0.8)'],
      borderRadius: 6
    }]
  };

  return (
  <div className="admin-page">
    <Sidebar />

    <main className="dashboard-geral">
      <header className="dashboard-header">
        <div className="header-search">
          <input type="text" placeholder="Pesquisar painéis..." />
        </div>
        <div className="header-profile">
          <Link to="/notificacoes" className="notification-bell" aria-label="Ver notificações" style={{ position: 'relative', fontSize: '1.8em', color: '#333', textDecoration: 'none', display: 'flex', alignItems: 'center' }}>
            <FaBell />
            {notificationCount > 0 && <span style={{ position: 'absolute', top: '-8px', right: '-8px', backgroundColor: '#ff4444', color: 'white', borderRadius: '50%', width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75em', fontWeight: 'bold' }}>{notificationCount}</span>}
          </Link>
          <div className="profile-info">
            <div className="avatar">{adminName.charAt(0).toUpperCase()}</div>
            <span>{adminName}</span>
          </div>
        </div>
      </header>

      <div className="cards-container">
        <div className="card cyan summary-card">
          <h3>Equipes Operando</h3>
          <p>{equipes.length}</p>
        </div>
        <div className="card purple summary-card">
          <h3>Total de Tarefas</h3>
          <p>{totalTarefas}</p>
        </div>
        <div className="card green summary-card">
          <h3>Tarefas Concluídas</h3>
          <p>{tarefasConcluidas}</p>
        </div>
        <div className="card orange summary-card">
          <h3>Minutos Investidos</h3>
          <p>{totalTempoGasto}m</p>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="glass-card big-chart">
          <h3 style={{ marginBottom: '20px' }}>Visão Geral de Produtividade</h3>
          <Bar 
            data={dadosGeraisBar}
            options={{
              responsive: true,
              plugins: {
                legend: { position: 'top', labels: { color: '#fff' } },
                title: { display: false }
              },
              scales: {
                x: { ticks: { color: '#fff' } },
                y: { beginAtZero: true, title: { display: true, text: 'Volume', color: '#fff' }, ticks: { color: '#fff', stepSize: 1 } }
              }
            }}
          />
        </div>

        <div className="glass-card ranking-panel">
          <h3>Ranking de Equipes</h3>
          <ul className="ranking-list">
            {equipesRanking.map((eq, idx) => (
              <li key={idx} className="ranking-item">
                <div className="ranking-medal">{idx + 1}</div>
                <div className="ranking-info">
                  <span className="ranking-nome">{eq.nome}</span>
                  <span className="ranking-stats">{eq.concluidas} concluídas de {eq.total}</span>
                </div>
              </li>
            ))}
            {equipesRanking.length === 0 && <p style={{color: '#aaa', marginTop: '10px'}}>Nenhuma equipe cadastrada.</p>}
          </ul>
        </div>
      </div>
    </main>
  </div>
);

}

export default DashboardGeral;
