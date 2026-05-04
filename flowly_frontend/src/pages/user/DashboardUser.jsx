import React, { useEffect, useState } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import { useNavigate } from "react-router-dom";
import { FaTasks, FaFileDownload, FaBell } from 'react-icons/fa';
import { API_ENDPOINTS } from "../../config/config";
import { formatarStatus } from "../../config/statusUtils";
import "../../styles/pages/user/DashboardUser.css";
import "../../styles/pages/admin/DashboardAdmin.css";
import Sidebar from "../../components/layout/Sidebar";
import jsPDF from 'jspdf';

function DashboardUser() {
  const [tarefas, setTarefas] = useState([]);
  const [tarefaSelecionada, setTarefaSelecionada] = useState(null);
  const [statusAtualizado, setStatusAtualizado] = useState("");
  const [userName, setUserName] = useState("");
  const [cronometrosAtivos, setCronometrosAtivos] = useState({});
  const [notificationCount, setNotificationCount] = useState(0);

  useEffect(() => {
    buscarTarefas();
    buscarNotificationCount();
    setUserName(localStorage.getItem('nome') || '');
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const agora = new Date();
      const novosCronometros = { ...cronometrosAtivos };
      let atualizou = false;

      tarefas.forEach(tarefa => {
        if (tarefa.cronometroAtivo) {
          const tempoDecorridoSegundos = Math.floor((agora - new Date(tarefa.ultimaAtualizacaoCronometro)) / 1000);
          novosCronometros[tarefa._id] = (tarefa.tempoGasto ? tarefa.tempoGasto * 60 : 0) + tempoDecorridoSegundos;
          atualizou = true;
        }
      });

      if (atualizou) {
        setCronometrosAtivos(novosCronometros);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [tarefas, cronometrosAtivos]);

  const navigate = useNavigate();

  const logout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("nome");
    navigate("/");
  };

  const buscarTarefas = async () => {
    try {
      const res = await axios.get("http://localhost:5000/api/tarefas/minhas", {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
      });
      setTarefas(res.data);
      
      const cronometros = {};
      res.data.forEach(tarefa => {
        if (tarefa.cronometroAtivo) {
          const tempoDecorridoSegundos = Math.floor((new Date() - new Date(tarefa.ultimaAtualizacaoCronometro)) / 1000);
          cronometros[tarefa._id] = (tarefa.tempoGasto ? tarefa.tempoGasto * 60 : 0) + tempoDecorridoSegundos;
        }
      });
      setCronometrosAtivos(cronometros);
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

  const controlarCronometro = async (tarefaId, acao) => {
    try {
      const res = await axios.put(
        `http://localhost:5000/api/tarefas/${tarefaId}/cronometro`,
        { acao },
        {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("token")}`,
          },
        }
      );

      const tarefasAtualizadas = tarefas.map(t => {
        if (t._id === tarefaId) {
          return res.data.tarefa;
        }
        return t;
      });
      setTarefas(tarefasAtualizadas);

      if (acao === 'iniciar') {
        setCronometrosAtivos(prev => ({
          ...prev,
          [tarefaId]: res.data.tarefa.tempoGasto ? res.data.tarefa.tempoGasto * 60 : 0
        }));
      } else {
        setCronometrosAtivos(prev => {
          const novos = { ...prev };
          delete novos[tarefaId];
          return novos;
        });
      }
    } catch (err) {
      console.error("Erro ao controlar cronômetro:", err);
    }
  };

  const formatarTempo = (segundos) => {
    if (segundos == null) return '0h 0m 0s';
    const horas = Math.floor(segundos / 3600);
    const mins = Math.floor((segundos % 3600) / 60);
    const secs = segundos % 60;
    return `${horas}h ${mins}m ${secs}s`;
  };

  const abrirTarefa = (tarefa) => {
    setTarefaSelecionada(tarefa);
    setStatusAtualizado(tarefa.status);
  };

  const atualizarStatus = async () => {
  try {
    console.log("Atualizando status da tarefa:", tarefaSelecionada._id, "->", statusAtualizado);

    await axios.put(
      `http://localhost:5000/api/tarefas/${tarefaSelecionada._id}/status`,
      { status: statusAtualizado },
      {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
      }
    );
    buscarTarefas();
    setTarefaSelecionada(null);
  } catch (err) {
    console.error("Erro ao atualizar status:", err);
  }
};


  const fecharTarefa = () => {
    setTarefaSelecionada(null);
  };

  const gerarPDF = (tarefa) => {
    const doc = new jsPDF();
    
    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.text("Detalhes da Tarefa", 105, 20, { align: "center" });
    
    doc.setFontSize(12);
    doc.setFont("helvetica", "normal");
    
    const yInicial = 40;
    const espacoEntreLinhas = 10;
    
    doc.text(`Nome da tarefa: ${tarefa.descricao}`, 20, yInicial);
    if (tarefa.detalhes) {
      doc.text(`Descrição: ${tarefa.detalhes}`, 20, yInicial + espacoEntreLinhas);
    }
    let linhaAtual = yInicial + espacoEntreLinhas * (tarefa.detalhes ? 2 : 1);
    doc.text(`Data de Entrega: ${new Date(tarefa.dataEntrega).toLocaleDateString()}`, 20, linhaAtual);
    doc.text(`Equipe: ${tarefa.equipe?.nome}`, 20, linhaAtual + espacoEntreLinhas);
    doc.text(`Status: ${formatarStatus(tarefa.status)}`, 20, linhaAtual + (espacoEntreLinhas * 2));
    
    if (tarefa.tempoEstimado) {
      doc.text(`Tempo Estimado: ${formatarTempo(tarefa.tempoEstimado * 60)}`, 20, linhaAtual + (espacoEntreLinhas * 3));
    }
    
    if (tarefa.tempoGasto > 0) {
      doc.text(`Tempo Gasto: ${formatarTempo(tarefa.tempoGasto * 60)}`, 20, linhaAtual + (espacoEntreLinhas * 4));
    }
    
    const dataAtual = new Date().toLocaleString();
    doc.setFontSize(10);
    doc.text(`PDF gerado em: ${dataAtual}`, 20, 280);
    
    doc.save(`tarefa_${tarefa._id}.pdf`);
  };

  return (
    <div className="admin-page">
      <Sidebar />

      <div className="dashboard-user">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px', paddingBottom: '20px', borderBottom: '1px solid #eee' }}>
          <div>
            {userName && <h3 className="boas-vindas">Bem-vindo(a), {userName}!</h3>}
            <h2 style={{ margin: '0' }}>Minhas Tarefas</h2>
          </div>
          <Link to="/notificacoes" className="notification-bell" aria-label="Ver notificações" style={{ position: 'relative', fontSize: '1.8em', color: '#333', textDecoration: 'none' }}>
            <FaBell />
            {notificationCount > 0 && <span style={{ position: 'absolute', top: '-8px', right: '-8px', backgroundColor: '#ff4444', color: 'white', borderRadius: '50%', width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75em', fontWeight: 'bold' }}>{notificationCount}</span>}
          </Link>
        </div>

        {tarefas.length === 0 ? (
          <p>Nenhuma tarefa atribuída.</p>
        ) : (
          tarefas.map((tarefa) => (
            <div key={tarefa._id} className="tarefa-card">
              <p><strong>Nome da tarefa:</strong> {tarefa.descricao}</p>
              {tarefa.detalhes && <p><strong>Descrição:</strong> {tarefa.detalhes}</p>}
              <p><strong>Data de Entrega:</strong> {new Date(tarefa.dataEntrega).toLocaleDateString()}</p>
              <p><strong>Status:</strong> {formatarStatus(tarefa.status)}</p>
              {tarefa.tempoEstimado && (
                <p><strong>Tempo Estimado:</strong> {formatarTempo(tarefa.tempoEstimado * 60)}</p>
              )}
              {tarefa.cronometroAtivo ? (
                <p><strong>Tempo Gasto:</strong> {formatarTempo(cronometrosAtivos[tarefa._id] || (tarefa.tempoGasto ? tarefa.tempoGasto * 60 : 0))}</p>
              ) : tarefa.tempoGasto > 0 && (
                <p><strong>Tempo Gasto:</strong> {formatarTempo(tarefa.tempoGasto * 60)}</p>
              )}
              <div className="tarefa-actions">
                <button onClick={() => abrirTarefa(tarefa)}>Ver Detalhes</button>
                {tarefa.tempoEstimado && (
                  <button 
                    onClick={() => controlarCronometro(tarefa._id, tarefa.cronometroAtivo ? 'pausar' : 'iniciar')}
                    className={tarefa.cronometroAtivo ? 'pause-btn' : 'start-btn'}
                  >
                    {tarefa.cronometroAtivo ? 'Pausar' : 'Iniciar'} Cronômetro
                  </button>
                )}
              </div>
            </div>
          ))
        )}

        {tarefaSelecionada && (
          <div className="modal-tarefa">
            <div className="modal-content">
              <h3>Detalhes da Tarefa</h3>
              <p><strong>Nome da tarefa:</strong> {tarefaSelecionada.descricao}</p>
              {tarefaSelecionada.detalhes && <p><strong>Descrição:</strong> {tarefaSelecionada.detalhes}</p>}
              <p><strong>Entrega:</strong> {new Date(tarefaSelecionada.dataEntrega).toLocaleDateString()}</p>
              <p><strong>Equipe:</strong> {tarefaSelecionada.equipe?.nome}</p>
              <p><strong>Status Atual:</strong> {formatarStatus(tarefaSelecionada.status)}</p>
              <div className="status-select">
                <label><strong>Alterar Status:</strong></label>{' '}
                <select
                  value={statusAtualizado}
                  onChange={(e) => setStatusAtualizado(e.target.value)}
                >
                  <option value="pendente">Pendente</option>
                  <option value="em_andamento">Em Andamento</option>
                  <option value="concluido">Concluído</option>
                </select>
              </div>

              <button onClick={atualizarStatus} className="atualizar-status-btn">
                Atualizar Status
              </button>

              {tarefaSelecionada.tempoEstimado && (
                <p><strong>Tempo Estimado:</strong> {formatarTempo(tarefaSelecionada.tempoEstimado * 60)}</p>
              )}
              {tarefaSelecionada.cronometroAtivo ? (
                <p><strong>Tempo Gasto:</strong> {formatarTempo(cronometrosAtivos[tarefaSelecionada._id] || (tarefaSelecionada.tempoGasto ? tarefaSelecionada.tempoGasto * 60 : 0))}</p>
              ) : tarefaSelecionada.tempoGasto > 0 && (
                <p><strong>Tempo Gasto:</strong> {formatarTempo(tarefaSelecionada.tempoGasto * 60)}</p>
              )}
              <div className="modal-buttons">
                <button onClick={() => gerarPDF(tarefaSelecionada)} className="download-btn">
                  <FaFileDownload /> Baixar PDF
                </button>
                <button onClick={fecharTarefa}>Fechar</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default DashboardUser;
