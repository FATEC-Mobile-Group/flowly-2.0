import React, { useId } from 'react';
import { Link } from 'react-router-dom';
import { linkTarefas } from './painelIndicadores';

// Uma secao de entregas do Painel Geral (atrasadas ou proximos 7 dias). "Ver detalhes" abre a tarefa na gestao
// administrativa pelo contrato state.abrirTarefaId (detalhes abertos automaticamente, PR #62), mantendo a equipe
// selecionada na URL. O total do recorte e o link para a lista filtrada completa ficam no rodape.
function ListaEntregas({
  titulo,
  subtitulo,
  tipo,
  itens,
  total,
  equipeId,
  destino,
  vazio,
  rotuloTotal,
}) {
  const idTitulo = useId();

  return (
    <section className={`glass-card entregas-panel entregas-${tipo}`} aria-labelledby={idTitulo}>
      <header className="painel-cabecalho painel-cabecalho--com-total">
        <div>
          <h3 id={idTitulo}>{titulo}</h3>
          <p className="painel-subtitulo">{subtitulo}</p>
        </div>
        <span className={`entregas-total entregas-total--${tipo}`}>{total}</span>
      </header>

      {itens.length === 0 ? (
        <p className="painel-vazio">{vazio}</p>
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
              {item.venceHoje && <span className="entrega-selo entrega-selo--hoje">Hoje</span>}
              {item.abrivel && (
                <Link
                  className="entrega-abrir"
                  to={linkTarefas(equipeId)}
                  state={{ abrirTarefaId: item.id }}
                  aria-label={`Ver detalhes de ${item.descricao}`}
                >
                  Ver detalhes
                </Link>
              )}
            </li>
          ))}
        </ol>
      )}

      {total > 0 && (
        <p className="entregas-resumo">
          {total > itens.length ? `Mostrando ${itens.length} de ${total}. ` : ''}
          <Link to={linkTarefas(equipeId, destino)}>{rotuloTotal}</Link>
        </p>
      )}
    </section>
  );
}

export default ListaEntregas;
