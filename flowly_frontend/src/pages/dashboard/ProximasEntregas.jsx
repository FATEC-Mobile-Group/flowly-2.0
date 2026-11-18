import React, { useId } from 'react';
import { Link } from 'react-router-dom';

function ProximasEntregas({ itens, total, filtrando }) {
  const idTitulo = useId();

  return (
    <section className="glass-card entregas-panel" aria-labelledby={idTitulo}>
      <header className="painel-cabecalho">
        <h3 id={idTitulo}>Próximas entregas</h3>
        <p className="painel-subtitulo">Tarefas não concluídas, ordenadas pelo prazo</p>
      </header>

      {itens.length === 0 ? (
        <p className="painel-vazio">
          {filtrando ? 'Nenhuma tarefa em aberto nesta equipe.' : 'Nenhuma tarefa em aberto.'}
        </p>
      ) : (
        <ol className="entregas-lista">
          {itens.map((item) => (
            <li
              key={item.id}
              className={`entrega-item${item.atrasada ? ' is-atrasada' : ''}${item.venceHoje ? ' is-hoje' : ''}`}
              data-tarefa-id={item.id}
            >
              <div className="entrega-info">
                <span className="entrega-descricao" title={item.descricao}>{item.descricao}</span>
                <span className="entrega-equipe" title={item.equipe}>{item.equipe}</span>
              </div>
              <div className="entrega-prazo">
                <time dateTime={item.dia}>{item.data}</time>
                <span className="entrega-relativo">{item.prazo}</span>
              </div>
              {item.atrasada && <span className="entrega-selo">Atrasada</span>}
            </li>
          ))}
        </ol>
      )}

      {total > itens.length && (
        <p className="entregas-resumo">
          Mostrando {itens.length} de {total} tarefas não concluídas.{' '}
          <Link to="/admin/tarefas">Ver tarefas</Link>
        </p>
      )}
    </section>
  );
}

export default ProximasEntregas;
