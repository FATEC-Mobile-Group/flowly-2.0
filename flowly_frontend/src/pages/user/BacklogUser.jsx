import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FaBell, FaCalendarAlt, FaSyncAlt, FaUserCheck, FaUsers } from 'react-icons/fa';
import apiClient from '../../config/apiClient';
import Sidebar from '../../components/layout/Sidebar';
import { useFotoPerfil } from '../../components/layout/useFotoPerfil';
import { useNaoLidas } from '../../components/notifications/notificationStore';
import { CampoBusca, CampoSelect, plural } from '../admin/FiltrosAdmin';
import { formatarDataCriacao, instanteValido, rotuloUrgencia } from '../admin/adminFiltrosUtils';
import { chaveDiaLocal } from '../dashboard/painelGeralUtils';
import {
  FILTROS_BACKLOG_PADRAO,
  ORDENS_BACKLOG,
  URGENCIAS_BACKLOG,
  backlogComFiltroAtivo,
  equipesDoBacklog,
  filtrarBacklog,
  prazoDoBacklog,
  tarefasDisponiveis,
} from './backlogUtils';
import '../../styles/pages/dashboard/DashboardGeral.css';
import '../../styles/pages/admin/DashboardAdmin.css';
import '../../styles/pages/user/BacklogUser.css';

const URL_BACKLOG = '/tarefas/backlog';

const mensagemDaApi = (erro) => erro?.response?.data?.erro || erro?.response?.data?.error || '';

function PrazoDoCartao({ prazo }) {
  if (prazo.situacao === 'sem') return <span className="backlog-prazo-texto">Sem prazo</span>;
  return (
    <span className="backlog-prazo">
      <time dateTime={prazo.dia} className="backlog-prazo-texto">{prazo.texto}</time>
      {prazo.situacao === 'atrasada' && <span className="prazo-tag prazo-atrasada">{prazo.detalhe}</span>}
      {prazo.situacao === 'hoje' && <span className="prazo-tag prazo-hoje">{prazo.detalhe}</span>}
      {prazo.situacao === 'futura' && <span className="backlog-prazo-detalhe">{prazo.detalhe}</span>}
    </span>
  );
}

function CartaoBacklog({ tarefa, hoje, atribuindoId, onAtribuir }) {
  const titulo = tarefa.descricao || 'Sem título';
  const urgencia = URGENCIAS_BACKLOG.some((opcao) => opcao.valor === tarefa.urgencia) ? tarefa.urgencia : 'indefinida';
  const prazo = prazoDoBacklog(tarefa, hoje);
  const esta = atribuindoId === String(tarefa._id);
  return (
    <li className={`backlog-card backlog-card--${urgencia}`} aria-label={`Tarefa ${titulo}`}>
      <div className="backlog-card-topo">
        <span className="backlog-card-equipe" title={tarefa.equipe?.nome || undefined}>
          <FaUsers aria-hidden="true" />
          <span>{tarefa.equipe?.nome || 'Equipe não informada'}</span>
        </span>
        <span className={`urgencia-badge urgencia-${urgencia}`}>{`Urgência: ${rotuloUrgencia(tarefa.urgencia)}`}</span>
      </div>

      <h3>{titulo}</h3>
      {tarefa.detalhes ? (
        <p className="backlog-card-descricao">{tarefa.detalhes}</p>
      ) : (
        <p className="backlog-card-descricao backlog-card-descricao--vazia">Sem descrição detalhada.</p>
      )}

      <dl className="backlog-card-dados">
        <div>
          <dt><FaCalendarAlt aria-hidden="true" /> Prazo</dt>
          <dd><PrazoDoCartao prazo={prazo} /></dd>
        </div>
        {instanteValido(tarefa.createdAt) !== null && (
          <div>
            <dt>Criada em</dt>
            <dd>{formatarDataCriacao(tarefa.createdAt)}</dd>
          </div>
        )}
      </dl>

      <div className="backlog-card-acoes">
        <Link to={`/backlog/${encodeURIComponent(tarefa._id)}`} className="backlog-botao-secundario" aria-label={`Ver detalhes da tarefa ${titulo}`}>
          Ver detalhes
        </Link>
        <button
          type="button"
          className="backlog-botao-atribuir"
          onClick={() => onAtribuir(tarefa)}
          disabled={atribuindoId !== null}
          aria-busy={esta || undefined}
          aria-label={`Atribuir para mim a tarefa ${titulo}`}
        >
          <FaUserCheck aria-hidden="true" />
          <span>{esta ? 'Atribuindo…' : 'Atribuir para mim'}</span>
        </button>
      </div>
    </li>
  );
}

const BacklogUser = () => {
  const [tarefas, setTarefas] = useState([]);
  // carregando: ainda sem lista; pronto: lista real; erro: a primeira carga falhou (nada de "nenhuma tarefa").
  const [estado, setEstado] = useState('carregando');
  const [atualizando, setAtualizando] = useState(false);
  const [falhaAtualizacao, setFalhaAtualizacao] = useState(false);
  const [filtros, setFiltros] = useState(FILTROS_BACKLOG_PADRAO);
  const [atribuindoId, setAtribuindoId] = useState(null);
  const [aviso, setAviso] = useState(null);
  // Contador compartilhado com a sidebar e a central (atualizado tambem pelo Socket.IO).
  const notificationCount = useNaoLidas() ?? 0;
  const carregamento = useRef(null);
  const montado = useRef(true);
  const temLista = useRef(false);
  // Trava sincrona: um segundo clique antes da nova renderizacao nao dispara outra atribuicao.
  const atribuicaoEmCurso = useRef(false);

  const nome = localStorage.getItem('nome') || 'Colaborador';
  const { fotoUrl, aoFalharFoto } = useFotoPerfil();

  // Uma carga por vez: a nova cancela a anterior. Numa atualizacao que falha, a lista atual continua com aviso.
  const carregar = useCallback(async () => {
    carregamento.current?.abort();
    const controle = new AbortController();
    carregamento.current = controle;
    setAtualizando(true);
    try {
      const resposta = await apiClient.get(URL_BACKLOG, { signal: controle.signal });
      if (controle.signal.aborted) return;
      if (!Array.isArray(resposta?.data)) throw new Error('Resposta inesperada ao carregar o backlog.');
      setTarefas(resposta.data);
      temLista.current = true;
      setFalhaAtualizacao(false);
      setEstado('pronto');
    } catch (erro) {
      if (controle.signal.aborted) return;
      console.error('Erro ao carregar backlog:', erro?.message || erro);
      if (temLista.current) setFalhaAtualizacao(true);
      else setEstado('erro');
    } finally {
      if (carregamento.current === controle) carregamento.current = null;
      if (!controle.signal.aborted) setAtualizando(false);
    }
  }, []);

  useEffect(() => {
    montado.current = true;
    carregar();
    return () => {
      montado.current = false;
      carregamento.current?.abort();
    };
  }, [carregar]);

  const tentarNovamente = () => {
    setEstado('carregando');
    carregar();
  };

  // Mesma rota e mesmas regras do detalhe: a API decide (pendente, sem responsavel, membro da equipe) e grava de
  // forma condicional. Depois do sucesso ou de um conflito, a tarefa sai da lista e o backlog e recarregado.
  const atribuir = async (tarefa) => {
    if (atribuicaoEmCurso.current || !tarefa?._id) return;
    atribuicaoEmCurso.current = true;
    const id = String(tarefa._id);
    const titulo = tarefa.descricao || 'Sem título';
    setAtribuindoId(id);
    setAviso(null);
    try {
      await apiClient.put(`/tarefas/${encodeURIComponent(id)}/atribuir-para-mim`, {});
      if (!montado.current) return;
      setTarefas((atuais) => atuais.filter((item) => String(item?._id) !== id));
      setAviso({ tipo: 'sucesso', texto: `A tarefa "${titulo}" agora está com você.`, kanban: true });
      carregar();
    } catch (erro) {
      if (!montado.current) return;
      const status = erro?.response?.status;
      if (status === 409 || status === 404 || status === 403) {
        // Outra pessoa assumiu, o status mudou ou a tarefa deixou de estar acessivel: nao fica oferecida.
        setTarefas((atuais) => atuais.filter((item) => String(item?._id) !== id));
        const motivo = (mensagemDaApi(erro) || 'Esta tarefa não está mais disponível no backlog').replace(/[.\s]+$/, '');
        setAviso({ tipo: 'erro', texto: `${motivo}. A lista foi atualizada.` });
        carregar();
      } else {
        setAviso({ tipo: 'erro', texto: 'Não foi possível atribuir a tarefa agora. Verifique a conexão e tente novamente.' });
      }
    } finally {
      atribuicaoEmCurso.current = false;
      if (montado.current) setAtribuindoId(null);
    }
  };

  const hoje = chaveDiaLocal(new Date());
  const disponiveis = useMemo(() => tarefasDisponiveis(tarefas), [tarefas]);
  const equipes = useMemo(() => equipesDoBacklog(disponiveis), [disponiveis]);
  // Equipe escolhida que saiu da lista (ultima tarefa assumida): volta para todas, sem lista vazia enganosa.
  const equipeValida = equipes.some((equipe) => equipe.id === filtros.equipe) ? filtros.equipe : '';
  const filtrosEfetivos = useMemo(() => ({ ...filtros, equipe: equipeValida }), [filtros, equipeValida]);
  const visiveis = useMemo(() => filtrarBacklog(disponiveis, filtrosEfetivos), [disponiveis, filtrosEfetivos]);
  const filtroAtivo = backlogComFiltroAtivo(filtrosEfetivos);
  const pronto = estado === 'pronto';

  const alterar = (mudancas) => setFiltros((atuais) => ({ ...atuais, ...mudancas }));
  const limpar = () => setFiltros((atuais) => ({ ...FILTROS_BACKLOG_PADRAO, ordem: atuais.ordem }));

  return (
    <div className="admin-page">
      <Sidebar />

      <main className="dashboard-geral backlog-pagina">
        <header className="dashboard-header">
          <div className="painel-titulo">
            <h2>Backlog de tarefas</h2>
            <p>Tarefas pendentes e sem responsável das suas equipes. Escolha uma e assuma com um clique.</p>
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
                  nome.charAt(0).toUpperCase()
                )}
              </div>
              <span>{nome}</span>
            </div>
          </div>
        </header>

        <div className="painel-filtros">
          <p className="backlog-contador" aria-live="polite">
            {pronto ? (
              <>
                <strong>{disponiveis.length}</strong>
                {` ${disponiveis.length === 1 ? 'tarefa disponível' : 'tarefas disponíveis'}`}
              </>
            ) : 'Carregando tarefas disponíveis…'}
          </p>
          <button type="button" className="botao-atualizar" onClick={carregar} disabled={atualizando || atribuindoId !== null}>
            <FaSyncAlt aria-hidden="true" className={atualizando ? 'girando' : undefined} />
            <span>{atualizando ? 'Atualizando…' : 'Atualizar'}</span>
          </button>
        </div>

        {aviso && (
          <div className={`backlog-aviso backlog-aviso--${aviso.tipo}`} role={aviso.tipo === 'erro' ? 'alert' : 'status'}>
            <span>{aviso.texto}</span>
            {aviso.kanban && <Link to="/minhas-tarefas">Ver no Kanban</Link>}
          </div>
        )}
        {pronto && falhaAtualizacao && (
          <p className="aviso-filtro" role="status">
            Não foi possível atualizar o backlog agora. A lista exibida pode estar desatualizada.
          </p>
        )}

        {estado === 'erro' ? (
          <section className="glass-card painel-erro" role="alert">
            <h3>Não foi possível carregar o backlog.</h3>
            <p>Verifique a conexão e tente novamente.</p>
            <button type="button" className="botao-tentar" onClick={tentarNovamente}>Tentar novamente</button>
          </section>
        ) : estado === 'carregando' ? (
          <p className="painel-status" role="status">Carregando backlog…</p>
        ) : disponiveis.length === 0 ? (
          <section className="glass-card backlog-vazio">
            <h3>Nenhuma tarefa disponível no backlog.</h3>
            <p>Quando houver tarefas pendentes e sem responsável nas suas equipes, elas aparecem aqui.</p>
            <Link to="/minhas-tarefas" className="backlog-botao-secundario">Ir para minhas tarefas</Link>
          </section>
        ) : (
          <>
            <section className="admin-filtros backlog-filtros" aria-label="Pesquisa e filtros do backlog">
              <CampoBusca
                id="backlog-busca"
                valor={filtros.busca}
                onChange={(valor) => alterar({ busca: valor })}
                placeholder="Título ou descrição da tarefa"
              />
              <div className="admin-filtros-grade backlog-filtros-grade">
                <CampoSelect
                  id="backlog-equipe"
                  rotulo="Equipe"
                  valor={equipeValida}
                  opcoes={[{ valor: '', rotulo: 'Todas as equipes' }, ...equipes.map((equipe) => ({ valor: equipe.id, rotulo: equipe.nome }))]}
                  onChange={(valor) => alterar({ equipe: valor })}
                />
                <CampoSelect
                  id="backlog-urgencia"
                  rotulo="Urgência"
                  valor={filtros.urgencia}
                  opcoes={[{ valor: '', rotulo: 'Todas' }, ...URGENCIAS_BACKLOG]}
                  onChange={(valor) => alterar({ urgencia: valor })}
                />
                <CampoSelect
                  id="backlog-ordem"
                  rotulo="Ordenar por"
                  valor={filtros.ordem}
                  opcoes={ORDENS_BACKLOG}
                  onChange={(valor) => alterar({ ordem: valor })}
                />
              </div>
              <div className="admin-filtros-rodape">
                <p className="admin-contagem" aria-live="polite">
                  {`Exibindo ${visiveis.length} de ${plural(disponiveis.length, 'tarefa', 'tarefas')}`}
                </p>
                {filtroAtivo && (
                  <button type="button" className="admin-botao-secundario" onClick={limpar}>Limpar filtros</button>
                )}
              </div>
            </section>

            {visiveis.length === 0 ? (
              <div className="teams-feedback admin-vazio">
                <p>Nenhuma tarefa corresponde à pesquisa ou aos filtros aplicados.</p>
                <button type="button" className="admin-botao-secundario" onClick={limpar}>Limpar filtros</button>
              </div>
            ) : (
              <ul className="backlog-grade">
                {visiveis.map((tarefa) => (
                  <CartaoBacklog
                    key={tarefa._id}
                    tarefa={tarefa}
                    hoje={hoje}
                    atribuindoId={atribuindoId}
                    onAtribuir={atribuir}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default BacklogUser;
