import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import apiClient from "../../config/apiClient";
import { Link } from "react-router-dom";
import { FaFileDownload, FaBell } from 'react-icons/fa';
import { API_ENDPOINTS } from "../../config/config";
import { formatarStatus } from "../../config/statusUtils";
import "../../styles/pages/user/DashboardUser.css";
import "../../styles/pages/admin/DashboardAdmin.css";
import Sidebar from "../../components/layout/Sidebar";
import TarefaModal from "../../components/tarefas/TarefaModal";
import { chaveDiaLocal, formatarDataEntrega, formatarDia } from "../dashboard/painelGeralUtils";
import {
  JANELA_PROXIMAS_DIAS,
  acumuladoEmSegundos,
  ancoraDaSessao,
  avisarCronometroAtualizado,
  manterAncoras,
  medirInicio,
  removerAncora,
  salvarAncora,
  formatarDuracao,
  organizarMeuDia,
  segundosDoCronometro,
} from "./meuDiaUtils";
import jsPDF from 'jspdf';

const URGENCIA = { alta: 'Alta', media: 'Média', baixa: 'Baixa' };

// Secoes de pendencias, na ordem de prioridade (concluidas ficam a parte).
const SECOES = [
  { chave: 'atrasadas', titulo: 'Atrasadas', selo: 'Atrasada', variante: 'is-atrasada' },
  { chave: 'hoje', titulo: 'Para hoje', selo: 'Hoje', variante: 'is-hoje' },
  { chave: 'proximas', titulo: `Próximos ${JANELA_PROXIMAS_DIAS} dias`, selo: null, variante: '' },
  { chave: 'maisAdiante', titulo: 'Mais adiante', selo: null, variante: '' },
  { chave: 'semPrazo', titulo: 'Sem prazo definido', selo: null, variante: '' },
];

const formatarTempo = formatarDuracao;

// Campos do cronometro confirmados pela resposta da API; o resto da tarefa (equipe populada etc.) fica como estava.
const CAMPOS_CRONOMETRO = ['cronometroAtivo', 'tempoGasto', 'tempoGastoSegundos', 'ultimaAtualizacaoCronometro', 'tempoExcedido'];
const mesclarCronometro = (tarefa, confirmada) => {
  const proxima = { ...tarefa };
  CAMPOS_CRONOMETRO.forEach((campo) => {
    if (confirmada && Object.prototype.hasOwnProperty.call(confirmada, campo)) proxima[campo] = confirmada[campo];
  });
  return proxima;
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
  const linhaAtual = yInicial + espacoEntreLinhas * (tarefa.detalhes ? 2 : 1);
  doc.text(`Data de Entrega: ${formatarDataEntrega(tarefa.dataEntrega, 'Não definida')}`, 20, linhaAtual);
  doc.text(`Equipe: ${tarefa.equipe?.nome || 'Não informada'}`, 20, linhaAtual + espacoEntreLinhas);
  doc.text(`Status: ${formatarStatus(tarefa.status)}`, 20, linhaAtual + (espacoEntreLinhas * 2));
  if (tarefa.tempoEstimado) {
    doc.text(`Tempo Estimado: ${formatarTempo(tarefa.tempoEstimado * 60)}`, 20, linhaAtual + (espacoEntreLinhas * 3));
  }
  if (acumuladoEmSegundos(tarefa) > 0) {
    doc.text(`Tempo Gasto: ${formatarTempo(acumuladoEmSegundos(tarefa))}`, 20, linhaAtual + (espacoEntreLinhas * 4));
  }
  doc.setFontSize(10);
  doc.text(`PDF gerado em: ${new Date().toLocaleString()}`, 20, 280);
  doc.save(`tarefa_${tarefa._id}.pdf`);
};

// Mesmos status do dashboard anterior (PUT /tarefas/:id/status com { status }); a API decide a permissao.
const STATUS_OPCOES = [
  { valor: 'pendente', rotulo: 'Pendente' },
  { valor: 'em_andamento', rotulo: 'Em andamento' },
  { valor: 'concluido', rotulo: 'Concluído' },
];

// Alterar status no proprio item: escolher e confirmar; abrir o seletor nao envia nada.
function AlterarStatus({ tarefa, onAlterarStatus }) {
  const [aberto, setAberto] = useState(false);
  const [novoStatus, setNovoStatus] = useState(tarefa.status || 'pendente');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  // Trava sincrona: um segundo clique antes do re-render nao envia de novo nem mostra erro falso.
  const salvandoRef = useRef(false);
  const seletorId = `status-${tarefa._id}`;

  const abrir = () => {
    setNovoStatus(tarefa.status || 'pendente');
    setErro('');
    setAberto(true);
  };

  const salvar = async (event) => {
    event.preventDefault();
    if (salvandoRef.current || novoStatus === tarefa.status) return;
    salvandoRef.current = true;
    setSalvando(true);
    setErro('');
    const resultado = await onAlterarStatus(tarefa, novoStatus);
    salvandoRef.current = false;
    setSalvando(false);
    if (resultado?.emAndamento) return; // outro envio desta tarefa ja esta em curso: sem erro falso
    if (resultado?.ok) setAberto(false);
    else setErro(resultado?.mensagem || 'Não foi possível alterar o status.');
  };

  if (!aberto) {
    return (
      <button type="button" className="meu-dia-status-btn" onClick={abrir} aria-label={`Alterar status de ${tarefa.descricao}`}>
        Alterar status
      </button>
    );
  }

  return (
    <form className="meu-dia-status-form" onSubmit={salvar}>
      <label htmlFor={seletorId} className="meu-dia-status-rotulo">Novo status</label>
      <select id={seletorId} value={novoStatus} onChange={(event) => setNovoStatus(event.target.value)} disabled={salvando}>
        {STATUS_OPCOES.map(({ valor, rotulo }) => <option key={valor} value={valor}>{rotulo}</option>)}
      </select>
      <button type="submit" disabled={salvando || novoStatus === tarefa.status}>
        {salvando ? 'Salvando...' : 'Salvar'}
      </button>
      <button type="button" className="meu-dia-status-cancelar" onClick={() => setAberto(false)} disabled={salvando}>
        Cancelar
      </button>
      {erro && <span className="meu-dia-status-erro" role="alert">{erro}</span>}
    </form>
  );
}

function ItemTarefa({
  entrada, selo, variante, segundosAtivos, onAbrir, onCronometro, onAlterarStatus, cronometroPendente = false,
  mostrarRelativo = true,
}) {
  const { tarefa } = entrada;
  const urgencia = URGENCIA[String(tarefa.urgencia || '').toLowerCase()];
  return (
    <li className={`meu-dia-item ${variante}`}>
      <div className="meu-dia-item-info">
        <span className="meu-dia-item-titulo">{tarefa.descricao || 'Tarefa sem descrição'}</span>
        <span className="meu-dia-item-meta">
          <span>{tarefa.equipe?.nome || 'Equipe não informada'}</span>
          <span>{formatarStatus(tarefa.status) || 'Pendente'}</span>
          {urgencia && (
            <span className={`meu-dia-urgencia meu-dia-urgencia-${String(tarefa.urgencia).toLowerCase()}`}>
              <span className="meu-dia-urgencia-ponto" aria-hidden="true" />
              <span className="meu-dia-sr">Urgência </span>{urgencia}
            </span>
          )}
          {tarefa.cronometroAtivo && <span>Tempo gasto: {formatarTempo(segundosAtivos ?? acumuladoEmSegundos(tarefa))}</span>}
        </span>
      </div>
      <div className="meu-dia-item-prazo">
        {selo && <span className="meu-dia-selo">{selo}</span>}
        {entrada.data && <time dateTime={entrada.dia}>{entrada.data}</time>}
        {(mostrarRelativo || !entrada.data) && <span className="meu-dia-relativo">{entrada.prazo}</span>}
      </div>
      <div className="meu-dia-item-acoes">
        <button type="button" className="meu-dia-abrir" onClick={() => onAbrir(entrada)} aria-label={`Ver detalhes de ${tarefa.descricao}`}>
          Ver detalhes
        </button>
        {tarefa.tempoEstimado && onCronometro && (
          <button
            type="button"
            className={tarefa.cronometroAtivo ? 'pause-btn' : 'start-btn'}
            onClick={() => onCronometro(tarefa._id, tarefa.cronometroAtivo ? 'pausar' : 'iniciar')}
            disabled={cronometroPendente}
          >
            {tarefa.cronometroAtivo ? 'Pausar' : 'Iniciar'} cronômetro
          </button>
        )}
        <button type="button" className="meu-dia-pdf" onClick={() => gerarPDF(tarefa)} aria-label={`Baixar PDF de ${tarefa.descricao}`}>
          <FaFileDownload aria-hidden="true" /> PDF
        </button>
        {onAlterarStatus && entrada.id && <AlterarStatus tarefa={tarefa} onAlterarStatus={onAlterarStatus} />}
      </div>
    </li>
  );
}

function DashboardUser() {
  const [tarefas, setTarefas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [tarefaAberta, setTarefaAberta] = useState(null);
  const [userName, setUserName] = useState("");
  // Relogio da tela (1 s, so com cronometro ativo) e inicio de cada sessao no relogio do navegador.
  const [relogio, setRelogio] = useState(() => Date.now());
  const ancorasCronometro = useRef({});
  const cronometroEmAndamento = useRef(new Set());
  const [cronometrosPendentes, setCronometrosPendentes] = useState({});
  const [avisoErro, setAvisoErro] = useState('');
  const [notificationCount, setNotificationCount] = useState(0);
  // "Hoje" no calendario local de quem olha o painel (mesma regra do Painel Geral).
  const hoje = chaveDiaLocal();

  // silencioso: recarrega depois de fechar o detalhe sem voltar ao estado de carregamento.
  const buscarTarefas = useCallback(async ({ silencioso = false } = {}) => {
    if (!silencioso) {
      setCarregando(true);
      setErro('');
    }
    try {
      const response = await apiClient.get(API_ENDPOINTS.TAREFAS_MINHAS);
      const lista = Array.isArray(response.data) ? response.data : [];
      // Sessoes ativas: a ancora em memoria (mesmo inicio) fica como esta; senao a salva nesta aba (F5, troca de
      // pagina) ou uma nova a partir da carga, corrigida pela diferenca de relogio medida. Assim recarregar a lista
      // nao pula nem zera o contador, e o F5 nao perde os segundos de uma sessao iniciada nesta aba.
      const agoraLocal = Date.now();
      const ancoras = ancorasCronometro.current;
      const ativas = new Set();
      lista.forEach((tarefa) => {
        if (!tarefa?.cronometroAtivo) return;
        const chave = String(tarefa._id);
        const inicioServidor = new Date(tarefa.ultimaAtualizacaoCronometro).getTime();
        if (!Number.isFinite(inicioServidor)) return;
        ativas.add(chave);
        if (ancoras[chave]?.inicioServidor !== inicioServidor) {
          const ancora = ancoraDaSessao(tarefa, agoraLocal);
          if (ancora) ancoras[chave] = ancora;
        }
        salvarAncora(chave, ancoras[chave]);
      });
      Object.keys(ancoras).forEach((chave) => { if (!ativas.has(chave)) delete ancoras[chave]; });
      manterAncoras(ativas);
      setTarefas(lista);
      setRelogio(agoraLocal);
      setErro('');
    } catch (err) {
      if (!silencioso) setErro('Não foi possível carregar suas tarefas agora.');
    } finally {
      if (!silencioso) setCarregando(false);
    }
  }, []);

  const buscarNotificationCount = async () => {
    try {
      const res = await apiClient.get(API_ENDPOINTS.NOTIFICATIONS_COUNT);
      setNotificationCount(res.data?.count || 0);
    } catch (err) {
      console.error('Erro ao buscar notificações:', err);
    }
  };

  useEffect(() => {
    buscarTarefas();
    buscarNotificationCount();
    setUserName(localStorage.getItem('nome') || '');
  }, [buscarTarefas]);

  // Um unico intervalo, so enquanto houver cronometro ativo; para sozinho quando a API confirma a pausa.
  // A duracao vem sempre do tempo decorrido (nunca de +1 por callback). Verifica a cada 250 ms e so atualiza a tela
  // quando algum segundo exibido muda: um intervalo de 1 s fora de fase com o segundo da sessao repetia um valor
  // e pulava dois no tique seguinte.
  const temCronometroAtivo = tarefas.some((tarefa) => tarefa?.cronometroAtivo);
  useEffect(() => {
    if (!temCronometroAtivo) return undefined;
    const segundosExibidos = (agora) => Object.values(ancorasCronometro.current)
      .map((ancora) => Math.floor((agora - ancora.inicioLocal) / 1000)).join('|') || String(Math.floor(agora / 1000));
    let ultimo = segundosExibidos(Date.now());
    setRelogio(Date.now());
    const intervalo = setInterval(() => {
      const agora = Date.now();
      const atual = segundosExibidos(agora);
      if (atual !== ultimo) {
        ultimo = atual;
        setRelogio(agora);
      }
    }, 250);
    return () => clearInterval(intervalo);
  }, [temCronometroAtivo]);

  const controlarCronometro = async (tarefaId, acao) => {
    const chave = String(tarefaId);
    if (cronometroEmAndamento.current.has(chave)) return;
    cronometroEmAndamento.current.add(chave);
    setCronometrosPendentes((atuais) => ({ ...atuais, [chave]: true }));
    setAvisoErro('');
    try {
      const envioLocal = Date.now();
      const res = await apiClient.put(`/tarefas/${tarefaId}/cronometro`, { acao });
      const confirmada = res?.data?.tarefa;
      if (!confirmada || typeof confirmada !== 'object') throw new Error('resposta sem tarefa');
      const agoraLocal = Date.now();
      if (confirmada.cronometroAtivo) {
        const inicioServidor = new Date(confirmada.ultimaAtualizacaoCronometro).getTime();
        if (Number.isFinite(inicioServidor)) {
          // O servidor gravou o inicio entre o envio e a resposta: meio do caminho no relogio local (e mede a
          // diferenca entre os relogios para sessoes que chegarem ativas sem ancora).
          const ancora = medirInicio(inicioServidor, envioLocal, agoraLocal);
          ancorasCronometro.current[chave] = ancora;
          salvarAncora(chave, ancora);
        }
      } else {
        delete ancorasCronometro.current[chave];
        removerAncora(chave);
      }
      setTarefas((atuais) => atuais.map((t) => (String(t._id) === chave ? mesclarCronometro(t, confirmada) : t)));
      setRelogio(agoraLocal);
      avisarCronometroAtualizado();
    } catch (err) {
      setAvisoErro(acao === 'iniciar'
        ? 'Não foi possível iniciar o cronômetro agora. Nada foi alterado.'
        : 'Não foi possível pausar o cronômetro agora. Confira o tempo antes de tentar de novo.');
    } finally {
      cronometroEmAndamento.current.delete(chave);
      setCronometrosPendentes((atuais) => {
        const proximos = { ...atuais };
        delete proximos[chave];
        return proximos;
      });
    }
  };

  // Uma alteracao de status por tarefa por vez (clique duplo nao repete o PUT).
  const statusEmAndamento = useRef(new Set());
  const [avisoStatus, setAvisoStatus] = useState('');

  const alterarStatus = async (tarefa, status) => {
    const tarefaId = String(tarefa._id);
    if (statusEmAndamento.current.has(tarefaId)) return { ok: false, emAndamento: true };
    statusEmAndamento.current.add(tarefaId);
    setAvisoStatus('');
    try {
      const res = await apiClient.put(`/tarefas/${tarefaId}/status`, { status });
      // Status (e cronometro, que a API pausa ao concluir) confirmados pela resposta; o resto da tarefa fica igual.
      const confirmada = res?.data?.tarefa || {};
      const statusConfirmado = confirmada.status || status;
      setTarefas((atuais) => atuais.map((t) => (String(t._id) === tarefaId
        ? {
            ...t,
            status: statusConfirmado,
            ...(confirmada.cronometroAtivo !== undefined ? { cronometroAtivo: confirmada.cronometroAtivo } : {}),
            ...(confirmada.tempoGasto !== undefined ? { tempoGasto: confirmada.tempoGasto } : {}),
            ...(confirmada.tempoGastoSegundos !== undefined ? { tempoGastoSegundos: confirmada.tempoGastoSegundos } : {}),
            ...(confirmada.ultimaAtualizacaoCronometro !== undefined
              ? { ultimaAtualizacaoCronometro: confirmada.ultimaAtualizacaoCronometro } : {}),
          }
        : t)));
      if (confirmada.cronometroAtivo === false) {
        delete ancorasCronometro.current[tarefaId];
        removerAncora(tarefaId);
      }
      avisarCronometroAtualizado();
      const rotulo = STATUS_OPCOES.find((opcao) => opcao.valor === statusConfirmado)?.rotulo || formatarStatus(statusConfirmado);
      setAvisoStatus(`Status de "${tarefa.descricao}" atualizado para ${rotulo}.`);
      buscarTarefas({ silencioso: true });
      return { ok: true };
    } catch (err) {
      const mensagem = err?.response?.data?.erro;
      return { ok: false, mensagem: typeof mensagem === 'string' && mensagem ? mensagem : 'Não foi possível alterar o status agora.' };
    } finally {
      statusEmAndamento.current.delete(tarefaId);
    }
  };

  const meuDia = useMemo(() => organizarMeuDia(tarefas, hoje), [tarefas, hoje]);
  const prontos = !carregando && !erro;

  // Detalhe: o mesmo TarefaModal do Kanban; so abre tarefas da lista vinda da API.
  const abrirDetalhes = (entrada) => {
    if (entrada?.id && tarefas.some((tarefa) => String(tarefa?._id) === entrada.id)) setTarefaAberta(entrada.id);
  };
  const fecharDetalhes = () => {
    setTarefaAberta(null);
    buscarTarefas({ silencioso: true });
  };

  const indicadores = [
    { chave: 'atrasadas', rotulo: 'Atrasadas', ajuda: 'prazo vencido', classe: 'is-atrasada' },
    { chave: 'hoje', rotulo: 'Hoje', ajuda: 'vencem hoje', classe: 'is-hoje' },
    { chave: 'proximas', rotulo: 'Próximas', ajuda: `de amanhã até ${JANELA_PROXIMAS_DIAS} dias`, classe: '' },
  ];

  return (
    <div className="admin-page">
      <Sidebar />
      <div className="dashboard-user meu-dia">
        <header className="meu-dia-header">
          <div>
            {userName && <h3 className="boas-vindas">Bem-vindo(a), {userName}!</h3>}
            <h2>Meu dia</h2>
            <p className="meu-dia-data">{formatarDia(hoje)}</p>
          </div>
          <Link to="/notificacoes" className="meu-dia-sino" aria-label={notificationCount > 0 ? `Ver notificações (${notificationCount} não lidas)` : 'Ver notificações'}>
            <FaBell aria-hidden="true" />
            {notificationCount > 0 && <span className="meu-dia-sino-contador">{notificationCount}</span>}
          </Link>
        </header>

        <section className="meu-dia-indicadores" aria-label="Resumo do dia">
          {indicadores.map(({ chave, rotulo, ajuda, classe }) => (
            <article key={chave} className={`meu-dia-indicador ${prontos && meuDia.indicadores[chave] > 0 ? classe : ''}`}>
              <span className="meu-dia-indicador-rotulo">{rotulo}</span>
              {/* Carregando ou com erro: nunca um zero que pareca resultado. */}
              <strong aria-label={prontos ? undefined : `${rotulo}: indisponível`}>{prontos ? meuDia.indicadores[chave] : '—'}</strong>
              <span className="meu-dia-indicador-ajuda">{ajuda}</span>
            </article>
          ))}
        </section>

        {avisoStatus && <p className="meu-dia-aviso" role="status">{avisoStatus}</p>}
        {avisoErro && <p className="meu-dia-aviso-erro" role="alert">{avisoErro}</p>}

        {carregando && <p className="meu-dia-estado" role="status">Carregando suas tarefas...</p>}

        {!carregando && erro && (
          <div className="meu-dia-erro" role="alert">
            <span>{erro}</span>
            <button type="button" onClick={() => buscarTarefas()}>Tentar novamente</button>
          </div>
        )}

        {prontos && meuDia.total === 0 && (
          <p className="meu-dia-estado">Você ainda não tem tarefas atribuídas.</p>
        )}

        {prontos && meuDia.total > 0 && meuDia.pendentes === 0 && (
          <p className="meu-dia-estado is-ok">Tudo em dia: todas as suas tarefas estão concluídas.</p>
        )}

        {prontos && meuDia.pendentes > 0 && (
          <>
            <p className="meu-dia-resumo">
              {meuDia.indicadores.atrasadas === 0 && 'Nenhuma tarefa atrasada. '}
              {meuDia.indicadores.hoje === 0 && 'Nada vence hoje. '}
              {meuDia.indicadores.proximas === 0 && `Nenhuma entrega nos próximos ${JANELA_PROXIMAS_DIAS} dias.`}
            </p>
            {SECOES.filter(({ chave }) => meuDia[chave].length > 0).map(({ chave, titulo, selo, variante }) => (
              <section key={chave} className="meu-dia-secao" aria-label={`${titulo} (${meuDia[chave].length})`}>
                <h3>{titulo} <span className="meu-dia-contagem">{meuDia[chave].length}</span></h3>
                <ul className="meu-dia-lista">
                  {meuDia[chave].map((entrada) => (
                    <ItemTarefa
                      key={entrada.id || `sem-id-${entrada.indice}`}
                      entrada={entrada}
                      selo={selo}
                      variante={variante}
                      segundosAtivos={segundosDoCronometro(
                        entrada.tarefa, relogio, ancorasCronometro.current[String(entrada.tarefa._id)],
                      )}
                      cronometroPendente={Boolean(cronometrosPendentes[String(entrada.tarefa._id)])}
                      onAbrir={abrirDetalhes}
                      onCronometro={controlarCronometro}
                      onAlterarStatus={alterarStatus}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}

        {prontos && meuDia.concluidas.length > 0 && (
          <details className="meu-dia-concluidas">
            <summary>Concluídas ({meuDia.concluidas.length})</summary>
            <ul className="meu-dia-lista">
              {meuDia.concluidas.map((entrada) => (
                <ItemTarefa
                  key={entrada.id || `sem-id-${entrada.indice}`}
                  entrada={entrada}
                  selo="Concluída"
                  variante="is-concluida"
                  mostrarRelativo={false}
                  onAbrir={abrirDetalhes}
                  onAlterarStatus={alterarStatus}
                />
              ))}
            </ul>
          </details>
        )}
      </div>

      {tarefaAberta && <TarefaModal tarefaId={tarefaAberta} onClose={fecharDetalhes} />}
    </div>
  );
}

export default DashboardUser;
