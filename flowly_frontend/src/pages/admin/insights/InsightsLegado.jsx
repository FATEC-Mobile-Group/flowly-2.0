import React from 'react';
import { formatarQuantidade } from './insightsUtils';

// Backend anterior ao contrato versao 2 (ex.: preview apontando para a API de producao ainda antiga). So o que tem
// janela conhecida e exibido, com a janela escrita; filtro de periodo, moderacao e alertas nao sao simulados.
export const AVISO_LEGADO = 'A API em uso ainda não oferece os Insights por período. Exibindo o resumo anterior, sem filtro de período.';

export default function InsightsLegado({ dados, aba, equipeId }) {
  const equipes = (dados.equipes || []).filter((equipe) => !equipeId || equipe.id === equipeId);

  if (aba === 'moderacao' || aba === 'alertas') {
    return (
      <p className="painel-status" role="status">
        {aba === 'moderacao' ? 'A moderação por categoria' : 'A lista de alertas'} ainda não está disponível na API em uso.
        Ela aparecerá aqui quando a versão nova da API for publicada.
      </p>
    );
  }

  const lista = (
    <section className="glass-card" aria-labelledby="insights-legado-equipes">
      <div className="painel-cabecalho">
        <h3 id="insights-legado-equipes">Registros de chat e moderação por equipe</h3>
        <p className="painel-subtitulo">
          {dados.janelaChatDias ? `Últimos ${dados.janelaChatDias} dias, janela fixa da API anterior` : 'Janela informada pela API anterior'}
        </p>
      </div>
      {dados.equipes === null ? (
        <p className="painel-vazio">Os dados por equipe não estão disponíveis.</p>
      ) : equipes.length === 0 ? (
        <p className="painel-vazio">{equipeId ? 'Nenhum registro desta equipe na janela da API anterior.' : 'Nenhuma equipe com registros na janela da API anterior.'}</p>
      ) : (
        <ul className="insights-lista-simples">
          {equipes.map((equipe) => (
            <li key={equipe.id}>
              <div className="insights-lista-linha">
                <span className="insights-nome" title={equipe.nome}>{equipe.nome}</span>
                <strong>{formatarQuantidade(equipe.mensagens)}</strong>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  if (aba === 'equipes') return <div className="insights-aba-conteudo">{lista}</div>;

  return (
    <div className="insights-aba-conteudo">
      <div className="cards-container insights-indicadores insights-indicadores--legado">
        <div className="kpi-card" data-indicador="legado-registros">
          <span className="kpi-texto">
            <h3>Registros de análise</h3>
            <span className="kpi-valor kpi-tom-neutro">{formatarQuantidade(dados.totalRegistros)}</span>
            <span className="kpi-detalhe">
              {equipeId
                ? 'Todo o histórico, todas as origens e todas as suas equipes (não filtrado pela equipe selecionada)'
                : 'Todo o histórico, todas as origens e todas as suas equipes'}
            </span>
          </span>
        </div>
      </div>
      {lista}
    </div>
  );
}
