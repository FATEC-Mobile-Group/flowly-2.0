import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import apiClient from '../../config/apiClient';
import { API_ENDPOINTS } from '../../config/config';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import Sidebar from '../../components/layout/Sidebar';
import TarefaModal from '../../components/tarefas/TarefaModal';
import '../../styles/pages/user/TarefasUser.css';

const TarefasUser = () => {
  const [tarefas, setTarefas] = useState([]);
  const [equipes, setEquipes] = useState([]);
  const [equipeSelecionada, setEquipeSelecionada] = useState('');
  const [mensagem, setMensagem] = useState('');
  const [tarefaInspecionada, setTarefaInspecionada] = useState(null);

  useEffect(() => {
    carregarTarefas();
    carregarEquipes();
  }, []);

  const carregarTarefas = async () => {
    try {
      const response = await apiClient.get(API_ENDPOINTS.TAREFAS_MINHAS);
      setTarefas(response.data);
    } catch (error) {
      setMensagem('Erro ao carregar tarefas');
    }
  };

  const carregarEquipes = async () => {
    try {
      const response = await apiClient.get(API_ENDPOINTS.MINHAS_EQUIPES);
      const equipesRecebidas = Array.isArray(response.data) ? response.data : [];

      setEquipes(equipesRecebidas);
      setEquipeSelecionada((atual) => atual || equipesRecebidas[0]?._id || '');
    } catch (error) {
      setMensagem('Erro ao carregar equipes');
    }
  };

  const atualizarStatusTarefa = async (id, novoStatus) => {
    try {
      await apiClient.put(API_ENDPOINTS.UPDATE_TAREFA(id) + '/status', { status: novoStatus });
      carregarTarefas();
    } catch (err) {
      setMensagem('Erro ao atualizar status');
    }
  };

  const controlarCronometro = async (id, acao) => {
    try {
      const response = await apiClient.put(API_ENDPOINTS.UPDATE_TAREFA(id) + '/cronometro', { acao });
      setTarefas((atuais) => atuais.map((tarefa) => (
        tarefa._id === id
          ? {
              ...tarefa,
              ...(response.data.tarefa || {}),
              cronometroAtivo: acao === 'iniciar',
            }
          : tarefa
      )));
      carregarTarefas();
      if (response.data.tempoExcedido) {
        setMensagem('Atenção: O tempo estimado para esta tarefa foi excedido!');
      } else {
        setMensagem(`Cronômetro ${acao}do com sucesso`);
      }
    } catch (err) {
      setMensagem(`Erro ao ${acao} cronômetro`);
    }
  };

  /*const baixarPDF = async (tarefa) => {
    // Mantendo estrutura original para PDF caso tenha. Backend precisaria devolver isso.
    alert("Função de gerar PDF em progresso");
  };*/

  const getUrgenciaClass = (urgencia) => {
    if(!urgencia) return '';
    if(urgencia === 'alta') return 'urgencia-alta';
    if(urgencia === 'media') return 'urgencia-media';
    return 'urgencia-baixa';
  };

  const onDragEnd = async (result) => {
    if (!result.destination) return;
    
    const sourceStatus = result.source.droppableId;
    const destStatus = result.destination.droppableId;
    
    if (sourceStatus !== destStatus) {
      const taskId = result.draggableId;
      
      // Atualização otimista da UI
      const updatedTarefas = tarefas.map((t) => (
        t._id === taskId
          ? { ...t, status: destStatus, cronometroAtivo: destStatus === 'em_andamento' ? t.cronometroAtivo : false }
          : t
      ));
      setTarefas(updatedTarefas);
      
      // Persiste no banco
      await atualizarStatusTarefa(taskId, destStatus);
    }
  };

  const colunas = [
    { id: 'pendente', titulo: 'Pendente' },
    { id: 'em_andamento', titulo: 'Em Andamento' },
    { id: 'concluido', titulo: 'Concluído' }
  ];

  const tarefasDaEquipeSelecionada = equipeSelecionada
    ? tarefas.filter((tarefa) => {
        const equipeId = tarefa.equipe?._id || tarefa.equipe;
        return String(equipeId) === String(equipeSelecionada);
      })
    : [];

  const equipeAtual = equipes.find((equipe) => String(equipe._id) === String(equipeSelecionada));

  const getDragStyle = (isDragging, draggableStyle) => ({
    ...draggableStyle,
    ...(isDragging
      ? {
          zIndex: 5000,
          boxShadow: '0 16px 36px rgba(0, 0, 0, 0.55)',
        }
      : {}),
  });

  return (
    <div className="tarefas-page">
      <Sidebar />

      <div className="tarefas-content">
        <div className="tarefas-container">
        <h2>O seu Painel Kanban de Tarefas</h2>
        <div className="kanban-toolbar">
          <div className="kanban-team-field">
            <label htmlFor="kanban-equipe-select">Equipe</label>
            <select
              id="kanban-equipe-select"
              className="kanban-team-select"
              value={equipeSelecionada}
              onChange={(event) => setEquipeSelecionada(event.target.value)}
              disabled={equipes.length === 0}
            >
              {equipes.length === 0 ? (
                <option value="">Nenhuma equipe disponivel</option>
              ) : (
                equipes.map((equipe) => (
                  <option key={equipe._id} value={equipe._id}>
                    {equipe.nome}
                  </option>
                ))
              )}
            </select>
          </div>

          <span className="kanban-team-summary">
            {equipeAtual
              ? `${tarefasDaEquipeSelecionada.length} tarefa${tarefasDaEquipeSelecionada.length === 1 ? '' : 's'} em ${equipeAtual.nome}`
              : 'Entre em uma equipe para visualizar o Kanban'}
          </span>
        </div>
        {mensagem && <div className={`mensagem ${mensagem.includes('sucesso') ? 'sucesso' : mensagem.includes('Atenção') ? 'alerta' : 'erro'}`}>{mensagem}</div>}
        
        <DragDropContext onDragEnd={onDragEnd}>
          <div className="kanban-board">
            {colunas.map((coluna) => {
              const tarefasDaColuna = tarefasDaEquipeSelecionada.filter(t => t.status === coluna.id);

              return (
                <Droppable key={coluna.id} droppableId={coluna.id}>
                  {(provided, snapshot) => (
                    <div
                      className="kanban-column"
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      style={{ backgroundColor: snapshot.isDraggingOver ? 'rgba(255, 255, 255, 0.05)' : '' }}
                    >
                      <h3>{coluna.titulo} <span style={{color: '#b0bec5', fontSize: '0.9rem'}}>({tarefasDaColuna.length})</span></h3>
                      
                      {tarefasDaColuna.map((tarefa, index) => (
                        <Draggable key={tarefa._id} draggableId={tarefa._id} index={index}>
                          {(provided, snapshot) => (
                            (() => {
                              const draggableCard = (
                                <div
                                  className={`tarefa-item ${getUrgenciaClass(tarefa.urgencia)} ${snapshot.isDragging ? 'tarefa-dragging' : ''}`}
                                  ref={provided.innerRef}
                                  {...provided.draggableProps}
                                  {...provided.dragHandleProps}
                                  onClick={() => setTarefaInspecionada(tarefa._id)}
                                  style={getDragStyle(snapshot.isDragging, {
                                    cursor: 'pointer',
                                    ...provided.draggableProps.style,
                                  })}
                                >
                                  <h4>{tarefa.descricao}</h4>
                                  <p><strong>Prazo:</strong> {tarefa.dataEntrega ? new Date(tarefa.dataEntrega).toLocaleDateString() : 'Não definido'}</p>
                                  <p><strong>Urgência:</strong> {tarefa.urgencia ? tarefa.urgencia.toUpperCase() : 'BAIXA'}</p>
                                  
                                  {tarefa.tempoEstimado > 0 && (
                                    <p><strong>Tempo Estimado:</strong> {tarefa.tempoEstimado} min</p>
                                  )}
                                  
                                  {(tarefa.tempoGasto > 0 || tarefa.cronometroAtivo) && (
                                    <p style={{ color: tarefa.tempoExcedido ? '#dc3545' : '#555' }}>
                                      <strong>Tempo Gasto:</strong> {tarefa.tempoGasto || 0} min {tarefa.cronometroAtivo && <span>(⏳ Ativo)</span>}
                                    </p>
                                  )}

                                  <div className="buttons">
                                    {tarefa.status === 'pendente' && (
                                      <button onClick={(e) => { e.stopPropagation(); atualizarStatusTarefa(tarefa._id, 'em_andamento') }} className="iniciar-btn">Iniciar</button>
                                    )}
                                    {tarefa.status === 'em_andamento' && !tarefa.cronometroAtivo && (
                                      <button onClick={(e) => { e.stopPropagation(); controlarCronometro(tarefa._id, 'iniciar'); }} className="iniciar-btn">Play Timer</button>
                                    )}
                                    {tarefa.status === 'em_andamento' && tarefa.cronometroAtivo && (
                                      <button onClick={(e) => { e.stopPropagation(); controlarCronometro(tarefa._id, 'pausar'); }} className="pausar-btn">Pause Timer</button>
                                    )}
                                    {tarefa.status === 'em_andamento' && (
                                      <button onClick={(e) => { e.stopPropagation(); atualizarStatusTarefa(tarefa._id, 'concluido'); }} className="finalizar-btn">Concluir</button>
                                    )}
                                  </div>
                                </div>
                              );

                              return snapshot.isDragging
                                ? createPortal(draggableCard, document.body)
                                : draggableCard;
                            })()
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              );
            })}
          </div>
        </DragDropContext>
        {tarefaInspecionada && (
          <TarefaModal 
            tarefaId={tarefaInspecionada} 
            onClose={() => { setTarefaInspecionada(null); carregarTarefas(); }} 
          />
        )}
        </div>
      </div>
    </div>
  );
};

export default TarefasUser;
