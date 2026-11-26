import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FaArrowLeft, FaUserCheck, FaUsers } from 'react-icons/fa';
import apiClient from '../../config/apiClient';
import Sidebar from '../../components/layout/Sidebar';
import { backlogDisponivel, formatarDataCriacao, instanteValido, rotuloStatus, rotuloUrgencia } from '../admin/adminFiltrosUtils';
import { chaveDiaLocal } from '../dashboard/painelGeralUtils';
import { URGENCIAS_BACKLOG, prazoDoBacklog } from './backlogUtils';
import '../../styles/pages/dashboard/DashboardGeral.css';
import '../../styles/pages/admin/DashboardAdmin.css';
import '../../styles/pages/user/BacklogUser.css';

const ATRASO_REDIRECIONAMENTO_MS = 900;

const mensagemDaApi = (erro) => erro?.response?.data?.erro || erro?.response?.data?.error || '';

const BacklogTaskDetailUser = () => {
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [atribuindo, setAtribuindo] = useState(false);
  const [mensagem, setMensagem] = useState('');
  const [tipoMensagem, setTipoMensagem] = useState('sucesso');
  const [tarefa, setTarefa] = useState(null);
  const [atribuida, setAtribuida] = useState(false);
  // Trava sincrona contra clique duplo antes da nova renderizacao.
  const atribuicaoEmCurso = useRef(false);
  const redirecionamento = useRef(null);

  useEffect(() => () => clearTimeout(redirecionamento.current), []);

  const carregarDetalhes = useCallback(async ({ manterMensagem = false } = {}) => {
    try {
      setLoading(true);
      const response = await apiClient.get(`/tarefas/${id}/detalhes`);
      const tarefaApi = response?.data?.tarefa || null;
      if (!tarefaApi) {
        setTipoMensagem('erro');
        setMensagem('Tarefa não encontrada.');
        setTarefa(null);
        return;
      }
      setTarefa(tarefaApi);
      if (!manterMensagem) setMensagem('');
    } catch (error) {
      setTipoMensagem('erro');
      setMensagem(mensagemDaApi(error) || 'Erro ao carregar detalhes da tarefa');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) {
      carregarDetalhes();
    }
  }, [id, carregarDetalhes]);

  const atribuirParaMim = async () => {
    if (!tarefa?._id || atribuicaoEmCurso.current || atribuida) {
      return;
    }
    atribuicaoEmCurso.current = true;
    try {
      setAtribuindo(true);
      await apiClient.put(`/tarefas/${tarefa._id}/atribuir-para-mim`, {});

      setAtribuida(true);
      setTipoMensagem('sucesso');
      setMensagem('Tarefa atribuída para você com sucesso! Redirecionando para o Kanban...');
      redirecionamento.current = setTimeout(() => {
        navigate('/minhas-tarefas');
      }, ATRASO_REDIRECIONAMENTO_MS);
    } catch (error) {
      setTipoMensagem('erro');
      setMensagem(mensagemDaApi(error) || 'Não foi possível atribuir a tarefa');
      // Conflito: outra pessoa assumiu ou o status mudou. Os dados atuais mostram por que nao esta mais disponivel.
      if (error?.response?.status === 409) carregarDetalhes({ manterMensagem: true });
    } finally {
      atribuicaoEmCurso.current = false;
      setAtribuindo(false);
    }
  };

  const hoje = chaveDiaLocal(new Date());
  const urgencia = URGENCIAS_BACKLOG.some((opcao) => opcao.valor === tarefa?.urgencia) ? tarefa.urgencia : 'indefinida';
  const prazo = tarefa ? prazoDoBacklog(tarefa, hoje) : null;
  const disponivel = Boolean(tarefa) && backlogDisponivel(tarefa);

  const textoBotao = () => {
    if (atribuida) return 'Tarefa atribuída';
    if (atribuindo) return 'Atribuindo...';
    if (tarefa?.user) return 'Tarefa já possui responsável';
    if (!disponivel) return 'Indisponível no backlog';
    return 'Atribuir para mim';
  };

  return (
    <div className="admin-page">
      <Sidebar />

      <main className="dashboard-geral backlog-pagina">
        <header className="dashboard-header">
          <div className="painel-titulo">
            <h2>Detalhes da tarefa</h2>
            <p>Confira as informações antes de assumir a tarefa do backlog.</p>
          </div>
        </header>

        <div className="backlog-detalhe-voltar">
          <Link to="/backlog" className="backlog-botao-secundario">
            <FaArrowLeft aria-hidden="true" />
            <span>Voltar ao backlog</span>
          </Link>
        </div>

        {mensagem && (
          <div className={`backlog-aviso backlog-aviso--${tipoMensagem}`} role={tipoMensagem === 'erro' ? 'alert' : 'status'}>
            <span>{mensagem}</span>
          </div>
        )}

        {loading && !tarefa ? (
          <p className="painel-status" role="status">Carregando tarefa...</p>
        ) : !tarefa ? (
          <p className="painel-status">Não foi possível carregar esta tarefa.</p>
        ) : (
          <section className="glass-card backlog-detalhe" aria-label={`Tarefa ${tarefa.descricao || 'Sem título'}`}>
            <div className="backlog-detalhe-topo">
              <span className="backlog-card-equipe" title={tarefa.equipe?.nome || undefined}>
                <FaUsers aria-hidden="true" />
                <span>{tarefa.equipe?.nome || 'Equipe não informada'}</span>
              </span>
              <span className={`urgencia-badge urgencia-${urgencia}`}>{`Urgência: ${rotuloUrgencia(tarefa.urgencia)}`}</span>
              {prazo.situacao === 'atrasada' && <span className="prazo-tag prazo-atrasada">{prazo.detalhe}</span>}
              {prazo.situacao === 'hoje' && <span className="prazo-tag prazo-hoje">{prazo.detalhe}</span>}
            </div>

            <h3>{tarefa.descricao || 'Sem título'}</h3>

            <dl className="backlog-detalhe-dados">
              <div>
                <dt>Prazo</dt>
                <dd>
                  {prazo.dia ? <time dateTime={prazo.dia}>{prazo.texto}</time> : 'Sem prazo'}
                  {prazo.situacao === 'futura' && <span className="backlog-prazo-detalhe">{` · ${prazo.detalhe}`}</span>}
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{rotuloStatus(tarefa.status)}</dd>
              </div>
              <div>
                <dt>Responsável atual</dt>
                <dd>{tarefa.user?.nome || (tarefa.user ? 'Definido' : 'Sem responsável')}</dd>
              </div>
              {instanteValido(tarefa.createdAt) !== null && (
                <div>
                  <dt>Criada em</dt>
                  <dd>{formatarDataCriacao(tarefa.createdAt)}</dd>
                </div>
              )}
            </dl>

            <article className="backlog-detalhe-descricao">
              <h4>Descrição</h4>
              <p>{tarefa.detalhes || 'Sem descrição detalhada.'}</p>
            </article>

            <div className="backlog-card-acoes">
              <button
                type="button"
                className="backlog-botao-atribuir"
                onClick={atribuirParaMim}
                disabled={atribuindo || atribuida || !disponivel || loading}
                aria-busy={atribuindo || undefined}
              >
                <FaUserCheck aria-hidden="true" />
                <span>{textoBotao()}</span>
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

export default BacklogTaskDetailUser;
