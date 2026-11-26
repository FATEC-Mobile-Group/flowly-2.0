import React, { useId } from 'react';
import { Line } from 'react-chartjs-2';
import { formatarDia, formatarQuantidade } from './insightsUtils';

// Series diarias do periodo (dias civis de Sao Paulo, calculados no backend). Zero e um dia consultado sem
// registros; serie ausente ou malformada nao e desenhada (vira aviso). Cada serie tem cor, traco e marcador
// proprios, e a legenda e uma lista de texto com os totais (nao depende so da cor).
export const SERIES = {
  chat: { rotulo: 'Mensagens de chat analisadas', cor: '#5aa2ff', corClara: '#1f66d1', traco: [], ponto: 'circle' },
  bloqueadas: { rotulo: 'Mensagens bloqueadas', cor: '#ff6b8b', corClara: '#c62828', traco: [6, 4], ponto: 'rectRot' },
  ajuda: { rotulo: 'Sinais de necessidade de ajuda', cor: '#f4b740', corClara: '#b45309', traco: [2, 3], ponto: 'triangle' },
  assistente: { rotulo: 'Eventos do assistente', cor: '#a78bfa', corClara: '#6d28d9', traco: [10, 3, 2, 3], ponto: 'rect' },
};

const soma = (lista) => lista.reduce((total, n) => total + n, 0);

export default function EvolucaoInsights({ evolucao, series, titulo, subtitulo, cores, nota }) {
  const idTitulo = useId();
  const disponiveis = evolucao ? series.filter((nome) => Array.isArray(evolucao.series?.[nome])) : [];
  const faltando = evolucao ? series.filter((nome) => !Array.isArray(evolucao.series?.[nome])) : series;
  const semRegistros = disponiveis.length > 0 && disponiveis.every((nome) => soma(evolucao.series[nome]) === 0);

  const data = evolucao && {
    labels: evolucao.dias.map(formatarDia),
    datasets: disponiveis.map((nome) => {
      const serie = SERIES[nome];
      const cor = cores?.claro ? serie.corClara : serie.cor;
      return {
        label: serie.rotulo,
        data: evolucao.series[nome],
        borderColor: cor,
        backgroundColor: cor,
        borderDash: serie.traco,
        pointStyle: serie.ponto,
        pointRadius: 3,
        pointHoverRadius: 5,
        borderWidth: 2,
        tension: 0.25,
      };
    }),
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { enabled: true } },
    scales: {
      x: { ticks: { color: cores?.texto, autoSkip: true, maxRotation: 0 }, grid: { display: false } },
      y: { beginAtZero: true, ticks: { color: cores?.texto, precision: 0 }, grid: { color: cores?.grade } },
    },
  };

  return (
    <section className="glass-card insights-evolucao" aria-labelledby={idTitulo}>
      <div className="painel-cabecalho">
        <h3 id={idTitulo}>{titulo}</h3>
        {subtitulo && <p className="painel-subtitulo">{subtitulo}</p>}
      </div>

      {!evolucao || disponiveis.length === 0 ? (
        <p className="chart-vazio painel-vazio" role="status">A evolução diária não está disponível nesta resposta da API.</p>
      ) : (
        <>
          {semRegistros ? (
            <p className="chart-vazio painel-vazio">Nenhum registro destas categorias no período.</p>
          ) : (
            <div className="insights-grafico" role="img" aria-label={`${titulo}: gráfico diário. Os valores estão na legenda e na tabela abaixo.`}>
              <Line data={data} options={options} />
            </div>
          )}
          <ul className="insights-legenda">
            {disponiveis.map((nome) => (
              <li key={nome} data-serie={nome}>
                <span className={`insights-legenda-marca insights-legenda-marca--${nome}`} aria-hidden="true" />
                <span>{SERIES[nome].rotulo}</span>
                <strong>{formatarQuantidade(soma(evolucao.series[nome]))}</strong>
              </li>
            ))}
          </ul>
          {nota && <p className="insights-nota">{nota}</p>}
          {faltando.length > 0 && (
            <p className="insights-nota">{`Sem dados nesta resposta: ${faltando.map((nome) => SERIES[nome].rotulo.toLowerCase()).join(', ')}.`}</p>
          )}
          <details className="insights-tabela-detalhes">
            <summary>Ver valores por dia</summary>
            <div className="insights-tabela-rolagem">
              <table className="insights-tabela">
                <caption className="sr-only">{`${titulo} por dia`}</caption>
                <thead>
                  <tr>
                    <th scope="col">Dia</th>
                    {disponiveis.map((nome) => <th key={nome} scope="col">{SERIES[nome].rotulo}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {evolucao.dias.map((dia, indice) => (
                    <tr key={dia}>
                      <th scope="row">{formatarDia(dia)}</th>
                      {disponiveis.map((nome) => <td key={nome}>{evolucao.series[nome][indice]}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
