import React, { useState, useEffect, useCallback } from 'react';
import { FaDownload, FaFileAlt, FaFileImage, FaFilePdf, FaTrashAlt } from 'react-icons/fa';
import apiClient, { getFullApiUrl } from '../../config/apiClient';
import { authUtils } from '../../config/authUtils';
import { formatarStatus } from '../../config/statusUtils';
import { formatarDataEntrega } from '../../pages/dashboard/painelGeralUtils';
import { UPLOAD_ACCEPT, describeUploadError, validateUploadFile } from '../../utils/uploadErrors';
import '../../styles/components/TarefaModal.css';

const formatarTamanho = (bytes) => {
  const valor = Number(bytes) || 0;
  if (valor < 1024) return `${valor} B`;
  if (valor < 1024 * 1024) return `${Math.round(valor / 1024)} KB`;
  return `${(valor / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
};

const formatarDataAnexo = (data) => {
  const date = data ? new Date(data) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
};

// uploadedBy chega populado ({ _id, nome }) nos detalhes da tarefa; em outras respostas, so o id.
const idDoAutor = (anexo) => {
  const autor = anexo?.uploadedBy;
  if (!autor) return '';
  return String(typeof autor === 'object' ? autor._id || '' : autor);
};

const IconeAnexo = ({ mimetype }) => {
  if (mimetype === 'application/pdf') return <FaFilePdf aria-hidden="true" />;
  if (String(mimetype || '').startsWith('image/')) return <FaFileImage aria-hidden="true" />;
  return <FaFileAlt aria-hidden="true" />;
};

// O erro do download chega como Blob (responseType blob): a mensagem sai do status.
const avisoDeDownload = (err) => {
  if (!err?.response) {
    return { kind: 'unavailable', title: 'Falha de conexão', message: 'Não foi possível baixar o arquivo. Verifique sua conexão e tente novamente.' };
  }
  if (err.response.status === 404) {
    return { kind: 'error', title: 'Arquivo não encontrado', message: 'O anexo não está mais disponível. Atualize a tarefa.' };
  }
  if (err.response.status === 503) {
    return { kind: 'unavailable', title: 'Armazenamento indisponível', message: 'Não foi possível acessar o arquivo agora. Tente novamente em instantes.' };
  }
  return { kind: 'error', title: 'Falha no download', message: 'Não foi possível baixar o arquivo.' };
};

const avisoDeRemocao = (err) => {
  const response = err?.response;
  if (!response) {
    return { kind: 'unavailable', title: 'Falha de conexão', message: 'Não foi possível remover o anexo. Verifique sua conexão e tente novamente.' };
  }
  const mensagem = typeof response.data?.erro === 'string' ? response.data.erro : '';
  if (response.status === 503) {
    return { kind: 'unavailable', title: 'Armazenamento indisponível', message: mensagem || 'O anexo foi mantido; tente novamente.' };
  }
  if (response.status === 403) {
    return { kind: 'error', title: 'Remoção não permitida', message: mensagem || 'Somente quem enviou o anexo pode removê-lo.' };
  }
  if (response.status === 404) {
    return { kind: 'error', title: 'Anexo não encontrado', message: 'O anexo já tinha sido removido.' };
  }
  return { kind: 'error', title: 'Falha ao remover', message: mensagem || 'Não foi possível remover o anexo.' };
};

const TarefaModal = ({ tarefaId, onClose }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('detalhes'); // detalhes, subtarefas, anexos, comentarios, logs
  const [novoComentario, setNovoComentario] = useState('');
  const [novaSubtarefa, setNovaSubtarefa] = useState('');
  const [arquivo, setArquivo] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [baixandoId, setBaixandoId] = useState(null);
  const [confirmandoId, setConfirmandoId] = useState(null);
  const [removendoId, setRemovendoId] = useState(null);
  const userId = String(authUtils.getUserId() || '');

  const carregarDetalhes = useCallback(async () => {
    try {
      const res = await apiClient.get(`/tarefas/${tarefaId}/detalhes`);
      setData(res.data);
      setLoading(false);
    } catch (err) {
      console.error(err);
      setLoading(false);
    }
  }, [tarefaId]);

  useEffect(() => {
    carregarDetalhes();
  }, [carregarDetalhes, tarefaId]);

  const toggleSub = async (subId) => {
    try {
      await apiClient.put(`/tarefas/${tarefaId}/subtarefas/${subId}`, {});
      carregarDetalhes(); // Recarrega
    } catch (err) {
      console.error(err);
    }
  };

  const addSubtarefa = async () => {
    if(!novaSubtarefa.trim()) return;
    try {
      await apiClient.post(`/tarefas/${tarefaId}/subtarefas`, { descricao: novaSubtarefa });
      setNovaSubtarefa('');
      carregarDetalhes();
    } catch (err) {
      console.error(err);
    }
  };

  const addComentario = async () => {
    if(!novoComentario.trim()) return;
    try {
      await apiClient.post(`/tarefas/${tarefaId}/comentarios`, { texto: novoComentario });
      setNovoComentario('');
      carregarDetalhes();
    } catch (err) {
      console.error(err);
    }
  };

  const selecionarArquivo = (file) => {
    const problema = validateUploadFile(file);
    setUploadNotice(problema);
    setArquivo(problema ? null : file || null);
  };

  // Recusa ou indisponibilidade mantem o arquivo escolhido: a pessoa decide trocar ou tentar de novo.
  const fazerUpload = async () => {
    if (!arquivo || uploading) return;
    setUploading(true);
    setUploadNotice(null);
    try {
      const formData = new FormData();
      formData.append('file', arquivo);

      await apiClient.post(`/tarefas/${tarefaId}/anexos`, formData);
      setArquivo(null);
      setFileInputKey((key) => key + 1);
      setUploadNotice({ kind: 'success', title: 'Anexo enviado', message: 'O arquivo foi adicionado à tarefa.' });
      carregarDetalhes();
    } catch (err) {
      setUploadNotice(describeUploadError(err, 'Não foi possível enviar o anexo.'));
    } finally {
      setUploading(false);
    }
  };

  const baixarAnexo = async (anexo) => {
    if (baixandoId) return;
    setBaixandoId(anexo._id);
    try {
      const res = await apiClient.get(`/tarefas/${tarefaId}/anexos/${anexo._id}/download`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const link = document.createElement('a');
      link.href = url;
      link.download = anexo.nomeOriginal || 'arquivo';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setUploadNotice(avisoDeDownload(err));
    } finally {
      setBaixandoId(null);
    }
  };

  // A interface so oferece a remocao ao autor; a API confere de novo sessao, acesso e autoria.
  const removerAnexo = async (anexo) => {
    if (removendoId) return;
    setRemovendoId(anexo._id);
    setUploadNotice(null);
    try {
      await apiClient.delete(`/tarefas/${tarefaId}/anexos/${anexo._id}`);
      setUploadNotice({ kind: 'success', title: 'Anexo removido', message: `"${anexo.nomeOriginal || 'Arquivo'}" foi removido da tarefa.` });
      await carregarDetalhes();
    } catch (err) {
      setUploadNotice(avisoDeRemocao(err));
      if (err?.response?.status === 404) await carregarDetalhes();
    } finally {
      setRemovendoId(null);
      setConfirmandoId(null);
    }
  };

  if (loading) return <div className="modal-overlay"><div className="modal-content">Carregando detalhes...</div></div>;
  if (!data || !data.tarefa) return null;

  const { tarefa, comentarios, logs } = data;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{tarefa.descricao}</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-tabs">
          <button className={activeTab === 'detalhes' ? 'active' : ''} onClick={() => setActiveTab('detalhes')}>Resumo</button>
          <button className={activeTab === 'subtarefas' ? 'active' : ''} onClick={() => setActiveTab('subtarefas')}>Subtarefas ({tarefa.subtarefas?.length || 0})</button>
          <button className={activeTab === 'anexos' ? 'active' : ''} onClick={() => setActiveTab('anexos')}>Anexos ({tarefa.anexos?.length || 0})</button>
          <button className={activeTab === 'comentarios' ? 'active' : ''} onClick={() => setActiveTab('comentarios')}>Comentários ({comentarios.length})</button>
          <button className={activeTab === 'logs' ? 'active' : ''} onClick={() => setActiveTab('logs')}>Histórico</button>
        </div>

        <div className="modal-body">
          {activeTab === 'detalhes' && (
            <div className="tab-detalhes">
              <p><strong>Detalhes:</strong> {tarefa.detalhes || 'Sem detalhes'}</p>
              <p><strong>Status:</strong> {formatarStatus(tarefa.status)}</p>
              <p><strong>Urgência:</strong> {tarefa.urgencia}</p>
              <p><strong>Prazo:</strong> {formatarDataEntrega(tarefa.dataEntrega, 'Não definido')}</p>
              <p><strong>Tempo Gasto:</strong> {tarefa.tempoGasto || 0} min {tarefa.cronometroAtivo ? '(Ativo)' : ''}</p>
              {tarefa.tags && tarefa.tags.length > 0 && (
                <div className="tags-list">
                  {tarefa.tags.map((tag, i) => <span key={i} className="tag-badge">#{tag}</span>)}
                </div>
              )}
            </div>
          )}

          {activeTab === 'subtarefas' && (
            <div className="tab-subtarefas">
              <div className="subtarefas-list">
                {tarefa.subtarefas?.map(sub => (
                  <label key={sub._id} className="subtarefa-item">
                    <input 
                      type="checkbox" 
                      checked={sub.concluida} 
                      onChange={() => toggleSub(sub._id)} 
                    />
                    <span className={sub.concluida ? 'concluida' : ''}>{sub.descricao}</span>
                  </label>
                ))}
                {(!tarefa.subtarefas || tarefa.subtarefas.length === 0) && <p>Nenhuma subtarefa.</p>}
              </div>
              <div className="add-form">
                <input 
                  type="text" 
                  placeholder="Nova checklist..." 
                  value={novaSubtarefa}
                  onChange={e => setNovaSubtarefa(e.target.value)} 
                />
                <button onClick={addSubtarefa}>Add</button>
              </div>
            </div>
          )}

          {activeTab === 'comentarios' && (
            <div className="tab-comentarios">
              <div className="comentarios-list">
                {comentarios.map(c => (
                  <div key={c._id} className="comentario-item">
                    <div className="comentario-header">
                      <strong>{c.user?.nome}</strong>
                      <span>{new Date(c.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="comentario-body">{c.texto}</div>
                  </div>
                ))}
                {comentarios.length === 0 && <p>Nenhum comentário na tarefa.</p>}
              </div>
              <div className="add-form">
                <textarea 
                  placeholder="Seu comentário..." 
                  value={novoComentario}
                  onChange={e => setNovoComentario(e.target.value)}
                />
                <button onClick={addComentario}>Comentar</button>
              </div>
            </div>
          )}

          {activeTab === 'anexos' && (
            <div className="tab-anexos">
              {tarefa.anexos?.length > 0 ? (
                <ul className="anexos-list">
                  {tarefa.anexos.map((anexo, i) => {
                    const nome = anexo.nomeOriginal || anexo.nome || 'Arquivo';
                    const autorId = idDoAutor(anexo);
                    const autorNome = typeof anexo.uploadedBy === 'object' ? anexo.uploadedBy?.nome : '';
                    const souAutor = Boolean(autorId) && autorId === userId;
                    const data = formatarDataAnexo(anexo.uploadedAt);
                    const confirmando = confirmandoId === anexo._id;
                    const removendo = removendoId === anexo._id;

                    return (
                      <li key={anexo._id || i} className={`anexo-item${confirmando ? ' confirmando' : ''}`}>
                        <span className="anexo-icone"><IconeAnexo mimetype={anexo.mimetype} /></span>
                        <div className="anexo-info">
                          <a className="anexo-nome" href={getFullApiUrl(anexo.url)} target="_blank" rel="noreferrer" title={nome}>{nome}</a>
                          <span className="anexo-meta">
                            {formatarTamanho(anexo.size || anexo.tamanho)}
                            {autorId
                              ? <> · {souAutor ? 'Você' : (autorNome || 'Membro da equipe')}{data && <> · {data}</>}</>
                              : <> · Autor não registrado</>}
                          </span>
                        </div>
                        {confirmando ? (
                          <div className="anexo-confirmacao" role="group" aria-label={`Confirmar remoção de ${nome}`}>
                            <span>Remover este anexo?</span>
                            <button type="button" className="anexo-btn perigo" onClick={() => removerAnexo(anexo)} disabled={removendo}>
                              {removendo ? 'Removendo...' : 'Remover'}
                            </button>
                            <button type="button" className="anexo-btn" onClick={() => setConfirmandoId(null)} disabled={removendo}>
                              Cancelar
                            </button>
                          </div>
                        ) : (
                          <div className="anexo-acoes">
                            <button
                              type="button"
                              className="anexo-btn"
                              onClick={() => baixarAnexo(anexo)}
                              disabled={Boolean(baixandoId)}
                              aria-label={`Baixar ${nome}`}
                              title="Baixar"
                            >
                              <FaDownload aria-hidden="true" />
                              <span className="anexo-btn-texto">{baixandoId === anexo._id ? 'Baixando...' : 'Baixar'}</span>
                            </button>
                            {souAutor && (
                              <button
                                type="button"
                                className="anexo-btn perigo"
                                onClick={() => setConfirmandoId(anexo._id)}
                                disabled={Boolean(removendoId)}
                                aria-label={`Remover ${nome}`}
                                title="Remover"
                              >
                                <FaTrashAlt aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="anexos-vazio">Nenhum anexo na tarefa.</p>
              )}
              <div className="upload-form">
                <input 
                  key={fileInputKey}
                  type="file" 
                  accept={UPLOAD_ACCEPT}
                  aria-label="Arquivo do anexo"
                  onChange={e => selecionarArquivo(e.target.files?.[0])}
                  disabled={uploading}
                />
                <button 
                  onClick={fazerUpload} 
                  disabled={!arquivo || uploading}
                >
                  {uploading ? 'Enviando...' : 'Fazer Upload'}
                </button>
              </div>
              <p className="upload-hint">PNG, JPG ou PDF, até 10 MB. Os arquivos passam por verificação de segurança.</p>
              {uploadNotice && (
                <div
                  className={`upload-notice ${uploadNotice.kind}`}
                  role={uploadNotice.kind === 'success' ? 'status' : 'alert'}
                >
                  <strong>{uploadNotice.title}</strong>
                  <span>{uploadNotice.message}</span>
                  <button type="button" onClick={() => setUploadNotice(null)} aria-label="Fechar aviso">×</button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="tab-logs">
              <ul className="logs-list">
                {logs.map(log => (
                  <li key={log._id}>
                    <span className="log-time">{new Date(log.createdAt).toLocaleString()}</span>
                    <span className="log-user">{log.user?.nome}</span>
                    <span className="log-action">[{log.tipoAcao}]</span>
                    <span className="log-detail">{log.detalhes}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TarefaModal;
