import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { FaBan, FaComments, FaDatabase, FaHandsHelping, FaMicrophone, FaUsers } from 'react-icons/fa';
import EvolucaoInsights from './EvolucaoInsights';
import { descreverPeriodo, formatarQuantidade, linkInsights } from './insightsUtils';

// Indicadores da aba Visao geral. Cada um diz de onde vem; valor ausente na resposta aparece como "—".
const INDICADORES = [
  {
    chave: 'registros', titulo: 'Registros de comunicação', icone: FaDatabase, tom: 'neutro',
    detalhe: 'Eventos analisados de todas as origens',
  },
  {
    chave: 'chat', titulo: 'Mensagens de chat analisadas', icone: FaComments, tom: 'info',
    detalhe: 'Aprovadas pela moderação', aba: 'equipes',
  },
  {
    chave: 'bloqueadas', titulo: 'Mensagens bloqueadas', icone: FaBan, tom: 'perigo',
    detalhe: 'Tentativas recusadas pela moderação', aba: 'moderacao',
  },
  {
    chave: 'ajuda', titulo: 'Sinais de necessidade de ajuda', icone: FaHandsHelping, tom: 'alerta',
    detalhe: 'Análise textual automática das mensagens de chat; não confirma dificuldades', aba: 'equipes',
  },
  {
    chave: 'equipesComAlertas', titulo: 'Equipes com alertas registrados', icone: FaUsers, tom: 'alerta',
    detalhe: 'Alertas emitidos no período', aba: 'alertas',
  },
  {
    chave: 'assistente', titulo: 'Eventos do assistente', icone: FaMicrophone, tom: 'neutro',
    detalhe: 'Separados das mensagens do chat',
  },
];

function Indicador({ indicador, valor, filtros, total }) {
  const Icone = indicador.icone;
  const conteudo = (
    <>
      <span className={`kpi-icone kpi-tom-${indicador.tom}`} aria-hidden="true"><Icone /></span>
      <span className="kpi-texto">
        <h3>{indicador.titulo}</h3>
        <span className={`kpi-valor kpi-tom-${indicador.tom}`}>
          {formatarQuantidade(valor)}
          {indicador.chave === 'equipesComAlertas' && total !== null && valor !== null && <small>{` de ${total}`}</small>}
        </span>
        <span className="kpi-detalhe">{indicador.detalhe}</span>
      </span>
    </>
  );
  return indicador.aba ? (
    <Link
      to={linkInsights({ ...filtros, aba: indicador.aba })}
      className="kpi-card kpi-link"
      data-indicador={indicador.chave}
      aria-label={`${indicador.titulo}: ${formatarQuantidade(valor)}. Abrir a aba correspondente.`}
    >
      {conteudo}
    </Link>
  ) : (
    <div className="kpi-card" data-indicador={indicador.chave}>{conteudo}</div>
  );
}

export function Recomendacoes({ recomendacoes, periodo, filtros, limite }) {
  const [todas, setTodas] = useState(false);
  if (recomendacoes === null) {
    return <p className="painel-vazio" role="status">As recomendações não estão disponíveis nesta resposta da API.</p>;
  }
  const recolhida = Boolean(limite) && !todas && recomendacoes.length > limite;
  const visiveis = recolhida ? recomendacoes.slice(0, limite) : recomendacoes;
  return (
    <>
      <ul className="insights-recomendacoes">
        {visiveis.map((item) => (
          <li key={item.chave} className={`insights-recomendacao insights-recomendacao--${item.tipo}`}>
            <div className="insights-recomendacao-topo">
              <strong>{item.situacao || 'Sinal registrado'}</strong>
              {item.quantidade !== null && item.quantidade > 0 && (
                <span className="insights-contador" aria-label={`${item.quantidade} ocorrências`}>{item.quantidade}</span>
              )}
            </div>
            <p>{item.evidencia}</p>
            <p className="insights-recomendacao-meta">
              {item.equipe ? <span>{`Equipe ${item.equipe.nome}`}</span> : <span>Todas as equipes consultadas</span>}
              <span>{descreverPeriodo(periodo)}</span>
            </p>
            {item.acao && <p className="insights-recomendacao-acao"><span>Ação sugerida:</span> {item.acao}</p>}
            {item.destino && (
              <Link
                className="insights-link"
                to={linkInsights({ ...filtros, equipe: item.destino.equipe || filtros.equipe, aba: item.destino.aba, ocorrencia: '' })}
              >
                {item.destino.aba === 'alertas' ? 'Ver alertas' : item.destino.aba === 'moderacao' ? 'Ver moderação' : 'Ver equipe'}
              </Link>
            )}
          </li>
        ))}
      </ul>
      {Boolean(limite) && recomendacoes.length > limite && (
        <button type="button" className="insights-botao-texto" aria-expanded={!recolhida} onClick={() => setTodas((atual) => !atual)}>
          {recolhida ? `Mostrar todas as ${recomendacoes.length} recomendações` : 'Mostrar só as prioritárias'}
        </button>
      )}
    </>
  );
}

export default function VisaoGeralInsights({ dados, filtros, cores }) {
  const { totais, evolucao, periodo, recomendacoes } = dados;
  const totalEquipes = dados.porEquipe ? dados.porEquipe.length : null;
  const valor = (chave) => (totais ? totais[chave] : null);

  return (
    <div className="insights-aba-conteudo">
      <div className="cards-container insights-indicadores">
        {INDICADORES.map((indicador) => (
          <Indicador key={indicador.chave} indicador={indicador} valor={valor(indicador.chave)} filtros={filtros} total={totalEquipes} />
        ))}
      </div>

      {totais && (
        <p className="insights-origens" aria-label="Origem dos registros de comunicação">
          <span>Origem dos registros:</span>
          <span>{`Chat ${formatarQuantidade(totais.chat)}`}</span>
          <span>{`Moderação ${formatarQuantidade(totais.bloqueadas)}`}</span>
          <span>{`Assistente ${formatarQuantidade(totais.assistente)}`}</span>
          <span>{`Origem desconhecida ou histórica ${formatarQuantidade(totais.origemDesconhecida)}`}</span>
        </p>
      )}
      {totais && (
        <p className="insights-nota">
          A origem segue o campo registrado com cada evento e não é uma prova autenticada de procedência. Valores não
          reconhecidos contam como origem desconhecida.
        </p>
      )}

      <div className="dashboard-grid insights-grade">
        <EvolucaoInsights
          evolucao={evolucao}
          series={['chat', 'bloqueadas', 'ajuda']}
          titulo="Evolução no período"
          subtitulo={`Registros por dia, ${descreverPeriodo(periodo).toLowerCase()}`}
          cores={cores}
          nota="Os sinais de necessidade de ajuda são parte das mensagens de chat e vêm de análise textual automática, não de confirmação: as linhas não se somam."
        />

        <section className="glass-card insights-recomendacoes-painel" aria-labelledby="insights-recomendacoes-titulo">
          <div className="painel-cabecalho">
            <h3 id="insights-recomendacoes-titulo">Recomendações</h3>
            <p className="painel-subtitulo">Sinais automatizados a partir dos registros. Exigem avaliação humana.</p>
          </div>
          <Recomendacoes recomendacoes={recomendacoes} periodo={periodo} filtros={filtros} limite={4} />
        </section>
      </div>
    </div>
  );
}
