import React from 'react';
import EvolucaoInsights from './EvolucaoInsights';
import { descreverPeriodo, formatarDataHora, formatarQuantidade } from './insightsUtils';

// Bloqueios da moderacao do chat (PR #61), pelas categorias gravadas. O texto bloqueado nunca chega aqui.
// "Sem categoria registrada": bloqueios anteriores a classificacao por categoria ou motivos sem categoria (como
// mensagem vazia ou longa demais). Indicios de spam sao outra coisa: palavras-chave em mensagens aprovadas.
const percentual = (parte, total) => (total > 0 ? Math.round((parte / total) * 100) : 0);

function Categorias({ porCategoria, total }) {
  if (porCategoria === null || total === null) return <p className="painel-vazio">A distribuição por categoria não está disponível.</p>;
  if (!total) return <p className="painel-vazio">Nenhum bloqueio no período.</p>;
  return (
    <ul className="insights-barras">
      {porCategoria.map((item) => (
        <li key={item.codigo || item.rotulo} data-categoria={item.codigo}>
          <div className="insights-barra-rotulo">
            <span>{item.rotulo}</span>
            <strong>{`${item.total} (${percentual(item.total, total)}%)`}</strong>
          </div>
          <span className={`insights-barra insights-barra--${item.codigo}`} aria-hidden="true">
            <span style={{ width: `${percentual(item.total, total)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function ModeracaoInsights({ dados, cores }) {
  const { moderacao, evolucao, periodo } = dados;
  if (moderacao === null) {
    return <p className="painel-status" role="status">Os dados de moderação não estão disponíveis nesta resposta da API.</p>;
  }
  const rotulosCategoria = Object.fromEntries((moderacao.porCategoria || []).map((item) => [item.codigo, item.rotulo]));
  const equipesComBloqueios = (dados.porEquipe || []).filter((item) => item.bloqueadas > 0);

  return (
    <div className="insights-aba-conteudo">
      <div className="cards-container insights-indicadores insights-indicadores--moderacao">
        <div className="kpi-card" data-indicador="bloqueios">
          <span className="kpi-texto">
            <h3>Mensagens bloqueadas</h3>
            <span className="kpi-valor kpi-tom-perigo">{formatarQuantidade(moderacao.total)}</span>
            <span className="kpi-detalhe">{descreverPeriodo(periodo)}</span>
          </span>
        </div>
        <div className="kpi-card" data-indicador="indiciosSpam">
          <span className="kpi-texto">
            <h3>Indícios de spam</h3>
            <span className="kpi-valor kpi-tom-alerta">{formatarQuantidade(moderacao.indiciosSpam)}</span>
            <span className="kpi-detalhe">Palavras-chave em mensagens aprovadas. Não são bloqueios nem spam confirmado.</span>
          </span>
        </div>
      </div>

      <div className="dashboard-grid insights-grade">
        <section className="glass-card" aria-labelledby="insights-categorias-titulo">
          <div className="painel-cabecalho">
            <h3 id="insights-categorias-titulo">Bloqueios por categoria</h3>
            <p className="painel-subtitulo">Categorias registradas pela moderação do chat</p>
          </div>
          <Categorias porCategoria={moderacao.porCategoria} total={moderacao.total} />
          <p className="insights-nota">
            “Sem categoria registrada” reúne bloqueios anteriores à classificação por categoria e motivos sem
            categoria, como mensagem vazia ou longa demais. Eles não são contados como spam.
          </p>
        </section>

        <EvolucaoInsights
          evolucao={evolucao}
          series={['bloqueadas']}
          titulo="Bloqueios por dia"
          subtitulo={descreverPeriodo(periodo)}
          cores={cores}
        />
      </div>

      <div className="dashboard-grid insights-grade">
        <section className="glass-card" aria-labelledby="insights-moderacao-equipes-titulo">
          <div className="painel-cabecalho">
            <h3 id="insights-moderacao-equipes-titulo">Bloqueios por equipe</h3>
          </div>
          {dados.porEquipe === null || moderacao.total === null ? (
            <p className="painel-vazio">A distribuição por equipe não está disponível.</p>
          ) : equipesComBloqueios.length === 0 ? (
            <p className="painel-vazio">Nenhuma equipe com bloqueios no período.</p>
          ) : (
            <ul className="insights-lista-simples">
              {equipesComBloqueios.map((item) => (
                <li key={item.equipe.id}>
                  <div className="insights-lista-linha">
                    <span className="insights-nome" title={item.equipe.nome}>{item.equipe.nome}</span>
                    <strong>{item.bloqueadas}</strong>
                  </div>
                  <span className="insights-lista-detalhe">
                    {Object.entries(item.moderacao)
                      .filter(([, total]) => total > 0)
                      .map(([codigo, total]) => `${rotulosCategoria[codigo] || codigo}: ${total}`)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="glass-card" aria-labelledby="insights-moderacao-recentes-titulo">
          <div className="painel-cabecalho">
            <h3 id="insights-moderacao-recentes-titulo">Ocorrências recentes</h3>
            <p className="painel-subtitulo">As mais recentes do período, sem o conteúdo bloqueado</p>
          </div>
          {moderacao.recentes === null ? (
            <p className="painel-vazio">As ocorrências recentes não estão disponíveis.</p>
          ) : moderacao.recentes.length === 0 ? (
            <p className="painel-vazio">Nenhuma ocorrência no período.</p>
          ) : (
            <ul className="insights-lista-simples">
              {moderacao.recentes.map((item, indice) => (
                <li key={item.id || indice} className={item.grave ? 'is-grave' : undefined}>
                  <div className="insights-lista-linha">
                    <span className="insights-nome">{item.categoria.rotulo}</span>
                    <span className="insights-gravidade" data-gravidade={item.gravidade.codigo || 'nenhuma'}>
                      {`Gravidade: ${item.gravidade.rotulo}`}
                    </span>
                  </div>
                  <span className="insights-lista-detalhe">
                    {`${item.equipe?.nome || 'Equipe indisponível'} · ${formatarDataHora(item.data)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
