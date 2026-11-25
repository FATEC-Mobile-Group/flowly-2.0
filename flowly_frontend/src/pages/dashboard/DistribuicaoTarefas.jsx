import React, { useId } from 'react';
import { Link } from 'react-router-dom';
import { Doughnut } from 'react-chartjs-2';
import { distribuicaoStatus, linkTarefas } from './painelIndicadores';

// Cores semanticas das fatias (o canvas nao le var(--...)): ambar, azul e verde. No tema claro, tons mais
// escuros para manter o contraste com o fundo claro.
export const CORES_STATUS = {
  pendente: '#f2b233',
  em_andamento: '#3d8bfd',
  concluido: '#2fb36d',
};
export const CORES_STATUS_CLARO = {
  pendente: '#c98a0b',
  em_andamento: '#1f66d1',
  concluido: '#1e8a4f',
};

const plural = (n, singular, pluralTexto) => `${n} ${n === 1 ? singular : pluralTexto}`;

// Rosca por status oficial. Atrasadas e backlog sao subconjuntos desses status: nao viram fatias.
// A legenda e a navegacao acessivel (links para a lista filtrada); o canvas fica so como imagem decorativa.
function DistribuicaoTarefas({ indicadores, equipeId, filtrando, cores }) {
  const idTitulo = useId();
  const itens = distribuicaoStatus(indicadores);
  const total = indicadores.totalTarefas;
  const paleta = cores?.claro ? CORES_STATUS_CLARO : CORES_STATUS;

  const dados = {
    labels: itens.map((item) => item.rotulo),
    datasets: [{
      label: 'Tarefas',
      data: itens.map((item) => item.valor),
      backgroundColor: itens.map((item) => paleta[item.chave]),
      borderWidth: 0,
      spacing: 2,
    }],
  };

  return (
    <section className="glass-card distribuicao-panel" aria-labelledby={idTitulo}>
      <header className="painel-cabecalho">
        <h3 id={idTitulo}>Distribuição das tarefas</h3>
        <p className="painel-subtitulo">Quantidade por status{filtrando ? ' nesta equipe' : ''}</p>
      </header>

      {total === 0 ? (
        <p className="painel-vazio chart-vazio">
          {filtrando ? 'Esta equipe ainda não tem tarefas.' : 'Nenhuma tarefa nas suas equipes.'}
        </p>
      ) : (
        <div className="distribuicao-corpo">
          <div className="chart-area distribuicao-grafico" aria-hidden="true">
            <Doughnut
              data={dados}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                cutout: '68%',
                animation: false,
                plugins: {
                  // Outras telas registram o Legend no Chart.js global: aqui a legenda e a lista ao lado.
                  legend: { display: false },
                  title: { display: false },
                  tooltip: { enabled: true },
                },
              }}
            />
            <div className="distribuicao-centro">
              <strong>{total}</strong>
              <span>{total === 1 ? 'tarefa' : 'tarefas'}</span>
            </div>
          </div>

          <ul className="distribuicao-legenda" aria-label="Tarefas por status">
            {itens.map((item) => (
              <li key={item.chave} data-status={item.chave}>
                <Link
                  to={linkTarefas(equipeId, item.destino)}
                  className="distribuicao-item"
                  aria-label={`${item.rotulo}: ${plural(item.valor, 'tarefa', 'tarefas')}, ${item.percentual}% do total. Ver na lista de tarefas`}
                >
                  <span className="distribuicao-cor" style={{ background: paleta[item.chave] }} aria-hidden="true" />
                  <span className="distribuicao-rotulo">{item.rotulo}</span>
                  <span className="distribuicao-valor">{item.valor}</span>
                  <span className="distribuicao-percentual">{item.percentual}%</span>
                </Link>
              </li>
            ))}
          </ul>

          {indicadores.statusDesconhecido > 0 && (
            <p className="distribuicao-nota">
              {`${plural(indicadores.statusDesconhecido, 'tarefa tem', 'tarefas têm')} status fora dos três oficiais: conta${indicadores.statusDesconhecido === 1 ? '' : 'm'} no total, mas não aparece${indicadores.statusDesconhecido === 1 ? '' : 'm'} no gráfico.`}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

export default DistribuicaoTarefas;
