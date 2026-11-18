import React from 'react';

const CARTOES = [
  {
    chave: 'equipes',
    titulo: 'Equipes Vinculadas',
    cor: 'cyan',
    valor: (ind) => ind.equipes,
    detalhe: (ind, { filtrando, totalEquipes }) => (filtrando
      ? `de ${totalEquipes} vinculadas`
      : `${ind.equipesComTarefas} com tarefas`),
  },
  {
    chave: 'tarefas',
    titulo: 'Total de Tarefas',
    cor: 'purple',
    valor: (ind) => ind.totalTarefas,
    detalhe: (ind) => `${ind.emAberto} em aberto`,
  },
  {
    chave: 'concluidas',
    titulo: 'Tarefas Concluídas',
    cor: 'green',
    valor: (ind) => ind.concluidas,
    detalhe: (ind) => `${ind.percentualConcluido}% do total`,
  },
  {
    chave: 'atrasadas',
    titulo: 'Tarefas Atrasadas',
    cor: 'red',
    valor: (ind) => ind.atrasadas,
    detalhe: () => 'prazo vencido',
  },
  {
    chave: 'tempo',
    titulo: 'Tempo Investido',
    cor: 'orange',
    valor: (ind) => ind.tempoFormatado,
    detalhe: (ind) => `${Math.round(ind.tempoMinutos)} min registrados`,
  },
];

// Sem indicadores (carregando) os cartoes mostram "—": nunca um zero que pareca resultado real.
function IndicadoresPainel({ indicadores, filtrando, totalEquipes }) {
  const carregando = !indicadores;

  return (
    <section className="cards-container" aria-label="Indicadores" aria-busy={carregando}>
      {CARTOES.map((cartao) => (
        <div key={cartao.chave} className={`card ${cartao.cor} summary-card`} data-indicador={cartao.chave}>
          <h3>{cartao.titulo}</h3>
          <p className="kpi-valor">{carregando ? '—' : cartao.valor(indicadores)}</p>
          <span className="kpi-detalhe">
            {carregando ? 'Carregando…' : cartao.detalhe(indicadores, { filtrando, totalEquipes })}
          </span>
        </div>
      ))}
    </section>
  );
}

export default IndicadoresPainel;
