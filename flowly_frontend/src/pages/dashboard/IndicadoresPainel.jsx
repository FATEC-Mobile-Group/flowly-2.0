import React from 'react';
import { Link } from 'react-router-dom';
import {
  FaCheckCircle,
  FaClipboardList,
  FaClock,
  FaExclamationTriangle,
  FaHourglassHalf,
  FaInbox,
  FaPlayCircle,
  FaUserFriends,
  FaUserSlash,
  FaUsers,
} from 'react-icons/fa';
import { DESTINOS, linkTarefas } from './painelIndicadores';

const quantidade = (numero, singular, plural) => `${numero} ${numero === 1 ? singular : plural}`;

// tom: so o icone, o valor e pequenos destaques recebem a cor semantica; o fundo segue o tema.
// destino: filtros do PR #62 para /admin/tarefas (a equipe selecionada vai junto); sem destino = cartao sem link.
const CARTOES = [
  {
    chave: 'equipes',
    titulo: 'Equipes vinculadas',
    tom: 'neutro',
    Icone: FaUsers,
    valor: (ind) => ind.equipes,
    detalhe: (ind, { filtrando, totalEquipes }) => {
      if (filtrando) return `de ${totalEquipes} vinculadas`;
      const semTarefas = ind.equipesSemTarefas > 0 ? ` · ${ind.equipesSemTarefas} sem tarefas` : '';
      return `${ind.equipesComTarefas} com tarefas${semTarefas}`;
    },
    // Destino e sempre a relacao completa de equipes: o rotulo deixa isso explicito.
    link: () => '/admin',
    rotuloLink: () => 'Ver todas as equipes',
  },
  {
    chave: 'tarefas',
    titulo: 'Total de tarefas',
    tom: 'neutro',
    Icone: FaClipboardList,
    valor: (ind) => ind.totalTarefas,
    detalhe: (ind) => `${ind.emAberto} em aberto`,
    destino: DESTINOS.todas,
  },
  {
    chave: 'concluidas',
    titulo: 'Concluídas',
    tom: 'sucesso',
    Icone: FaCheckCircle,
    valor: (ind) => ind.concluidas,
    detalhe: (ind) => `${ind.percentualConcluido}% do total`,
    destino: DESTINOS.concluidas,
  },
  {
    chave: 'emAndamento',
    titulo: 'Em andamento',
    tom: 'info',
    Icone: FaPlayCircle,
    valor: (ind) => ind.emAndamento,
    detalhe: () => 'status em andamento',
    destino: DESTINOS.emAndamento,
  },
  {
    chave: 'pendentes',
    titulo: 'Pendentes',
    tom: 'alerta',
    Icone: FaHourglassHalf,
    valor: (ind) => ind.pendentes,
    detalhe: () => 'ainda não iniciadas',
    destino: DESTINOS.pendentes,
  },
  {
    chave: 'atrasadas',
    titulo: 'Atrasadas',
    tom: 'perigo',
    Icone: FaExclamationTriangle,
    valor: (ind) => ind.atrasadas,
    detalhe: () => 'não concluídas, prazo vencido',
    destino: DESTINOS.atrasadas,
  },
  {
    chave: 'semResponsavel',
    titulo: 'Sem responsável',
    tom: 'alerta',
    Icone: FaUserSlash,
    valor: (ind) => ind.semResponsavel,
    detalhe: () => 'qualquer status',
    destino: DESTINOS.semResponsavel,
  },
  {
    chave: 'backlog',
    titulo: 'Backlog disponível',
    tom: 'info',
    Icone: FaInbox,
    valor: (ind) => ind.backlog,
    detalhe: () => 'pendentes e sem responsável',
    destino: DESTINOS.backlog,
  },
  {
    chave: 'participantes',
    titulo: (ind) => (ind?.participantes.modo === 'colaboradores' ? 'Colaboradores únicos' : 'Participantes únicos'),
    tom: 'neutro',
    Icone: FaUserFriends,
    valor: (ind) => ind.participantes.total,
    detalhe: (ind) => (ind.participantes.modo === 'colaboradores'
      ? `sem repetir entre equipes; ${quantidade(ind.participantes.participantes - ind.participantes.total, 'administrador', 'administradores')} fora da conta`
      : 'sem repetir; pode incluir administradores'),
  },
  {
    chave: 'tempo',
    titulo: 'Tempo registrado',
    tom: 'neutro',
    Icone: FaClock,
    valor: (ind) => ind.tempoFormatado,
    detalhe: () => 'acumulado nas tarefas',
  },
];

const tituloDe = (cartao, indicadores) => (typeof cartao.titulo === 'function' ? cartao.titulo(indicadores) : cartao.titulo);

// Sem indicadores (carregando) os cartoes mostram "—": nunca um zero que pareca resultado real, e sem links.
function IndicadoresPainel({ indicadores, filtrando, totalEquipes, equipeId }) {
  const carregando = !indicadores;

  return (
    <section className="cards-container" aria-label="Indicadores" aria-busy={carregando}>
      {CARTOES.map((cartao) => {
        const { Icone } = cartao;
        const titulo = carregando && typeof cartao.titulo === 'function' ? 'Participantes únicos' : tituloDe(cartao, indicadores);
        const destino = !carregando && (cartao.link ? cartao.link() : cartao.destino && linkTarefas(equipeId, cartao.destino));
        const conteudo = (
          <>
            <span className={`kpi-icone kpi-tom-${cartao.tom}`} aria-hidden="true"><Icone /></span>
            <div className="kpi-texto">
              <h3>{titulo}</h3>
              <p className={`kpi-valor kpi-tom-${cartao.tom}`}>{carregando ? '—' : cartao.valor(indicadores)}</p>
              <span className="kpi-detalhe">
                {carregando ? 'Carregando…' : cartao.detalhe(indicadores, { filtrando, totalEquipes })}
              </span>
              {destino && cartao.rotuloLink && <span className="kpi-acao">{cartao.rotuloLink()}</span>}
            </div>
          </>
        );
        return destino ? (
          <Link
            key={cartao.chave}
            to={destino}
            className="summary-card kpi-card kpi-link"
            data-indicador={cartao.chave}
            title={cartao.rotuloLink ? cartao.rotuloLink() : `Ver na lista de tarefas: ${titulo}`}
          >
            {conteudo}
          </Link>
        ) : (
          <div key={cartao.chave} className="summary-card kpi-card" data-indicador={cartao.chave}>
            {conteudo}
          </div>
        );
      })}
    </section>
  );
}

export default IndicadoresPainel;
