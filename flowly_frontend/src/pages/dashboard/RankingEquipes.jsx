import React, { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { LIMITE_RANKING, montarRankingEquipes, percentualConcluido } from './rankingEquipesUtils';
import { linkTarefas } from './painelIndicadores';
import { validObjectId } from '../../utils/navigationRequests';

const quantidade = (numero, singular, plural) => `${numero} ${numero === 1 ? singular : plural}`;

const inicial = (nome) => (Array.from(nome.trim())[0] || '?').toUpperCase();

// Progresso de cada equipe (concluidas / total). A ordem so organiza a lista; nao e avaliacao de desempenho.
function ItemProgresso({ equipe }) {
  const percentual = percentualConcluido(equipe);
  const abrivel = Boolean(validObjectId(equipe.id));

  return (
    <li className="ranking-item" data-equipe-id={equipe.id}>
      <span className="ranking-medal ranking-medal--neutro" aria-hidden="true">{inicial(equipe.nome)}</span>
      <div className="ranking-info">
        <span className="ranking-nome" title={equipe.nome}>{equipe.nome}</span>
        <span className="ranking-stats">
          <span>{quantidade(equipe.concluidas, 'concluída', 'concluídas')} de {equipe.total}</span>
          {' · '}
          <span>{equipe.emAndamento} em andamento</span>
          {' · '}
          <span>{quantidade(equipe.pendentes, 'pendente', 'pendentes')}</span>
        </span>
        <span
          className="ranking-progresso"
          role="progressbar"
          aria-label={`Progresso da equipe ${equipe.nome}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentual}
        >
          <span style={{ width: `${percentual}%` }} />
        </span>
      </div>
      <span className="ranking-percentual">{percentual}%</span>
      {abrivel && (
        <Link className="ranking-link" to={linkTarefas(equipe.id)} aria-label={`Ver tarefas da equipe ${equipe.nome}`}>
          Ver tarefas
        </Link>
      )}
    </li>
  );
}

function RankingEquipes({ equipes, tarefas }) {
  const [expandido, setExpandido] = useState(false);
  const idTitulo = useId();
  const idConteudo = useId();
  const { comTarefas, semTarefas, totalEquipes, haConcluidas } = montarRankingEquipes(equipes, tarefas);

  const visiveis = expandido ? comTarefas : comTarefas.slice(0, LIMITE_RANKING);
  // Uma equipe sem tarefas sozinha aparece direto: o botao so existe quando revela mais de um nome
  // (equipes alem das 5 primeiras ou varias equipes sem tarefas).
  const unicaEquipeSemTarefas = totalEquipes === 1 && comTarefas.length === 0;
  const umaSemTarefas = semTarefas.length === 1;
  const podeExpandir = comTarefas.length > LIMITE_RANKING || semTarefas.length > 1;
  const mostrarSemTarefas = !unicaEquipeSemTarefas && semTarefas.length > 0 && (expandido || umaSemTarefas);

  let subtitulo = null;
  if (comTarefas.length > 0) {
    subtitulo = haConcluidas
      ? 'Ordem: mais tarefas concluídas; empate por percentual, volume e nome'
      : 'Nenhuma tarefa concluída ainda. Ordem pelo volume de tarefas.';
  }

  return (
    <section className="glass-card ranking-panel" aria-labelledby={idTitulo}>
      <header className="painel-cabecalho">
        <h3 id={idTitulo}>Progresso das equipes</h3>
        {subtitulo && <p className="painel-subtitulo">{subtitulo}</p>}
      </header>

      {totalEquipes === 0 ? (
        <p className="ranking-vazio">Nenhuma equipe cadastrada.</p>
      ) : (
        <>
          <div id={idConteudo} className={`ranking-conteudo${expandido ? ' is-expanded' : ''}`}>
            {comTarefas.length === 0 && (
              <p className="ranking-vazio">
                {unicaEquipeSemTarefas
                  ? <><strong>{semTarefas[0].nome}</strong>: sem tarefas.</>
                  : 'Nenhuma equipe tem tarefas ainda.'}
              </p>
            )}

            {visiveis.length > 0 && (
              <ul className="ranking-list">
                {visiveis.map((equipe) => <ItemProgresso key={equipe.id} equipe={equipe} />)}
              </ul>
            )}

            {mostrarSemTarefas && (
              <div className="ranking-sem-tarefas">
                <h4>Sem tarefas</h4>
                <ul>
                  {semTarefas.map((equipe) => (
                    <li key={equipe.id} data-equipe-id={equipe.id} title={equipe.nome}>{equipe.nome}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="ranking-rodape">
            {!expandido && semTarefas.length > 1 && (
              <p className="ranking-resumo">
                {quantidade(semTarefas.length, 'equipe sem tarefas', 'equipes sem tarefas')}
              </p>
            )}
            <Link className="ranking-todas" to="/admin">Gerenciar todas as equipes</Link>
            {podeExpandir && (
              <button
                type="button"
                className="ranking-toggle"
                aria-expanded={expandido}
                aria-controls={idConteudo}
                onClick={() => setExpandido((atual) => !atual)}
              >
                {expandido ? 'Mostrar menos' : `Ver todas (${totalEquipes})`}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export default RankingEquipes;
