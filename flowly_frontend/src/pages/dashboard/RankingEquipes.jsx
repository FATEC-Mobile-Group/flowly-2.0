import React, { useId, useState } from 'react';
import { LIMITE_RANKING, montarRankingEquipes, percentualConcluido } from './rankingEquipesUtils';

const quantidade = (numero, singular, plural) => `${numero} ${numero === 1 ? singular : plural}`;

const inicial = (nome) => (Array.from(nome.trim())[0] || '?').toUpperCase();

function ItemRanking({ equipe, posicao }) {
  const percentual = percentualConcluido(equipe);

  return (
    <li className="ranking-item" data-equipe-id={equipe.id}>
      <span className="ranking-medal" aria-hidden="true">{posicao}</span>
      <div className="ranking-info">
        <span className="ranking-nome" title={equipe.nome}>{equipe.nome}</span>
        <span className="ranking-stats">
          {quantidade(equipe.concluidas, 'concluída', 'concluídas')} de {equipe.total}
        </span>
        <span className="ranking-progresso" aria-hidden="true">
          <span style={{ width: `${percentual}%` }} />
        </span>
      </div>
      <span className="ranking-percentual">{percentual}%</span>
    </li>
  );
}

function ItemAtividade({ equipe }) {
  return (
    <li className="ranking-item" data-equipe-id={equipe.id}>
      <span className="ranking-medal ranking-medal--neutro" aria-hidden="true">{inicial(equipe.nome)}</span>
      <div className="ranking-info">
        <span className="ranking-nome" title={equipe.nome}>{equipe.nome}</span>
        <span className="ranking-stats">
          <span>{quantidade(equipe.total, 'tarefa', 'tarefas')}</span>
          {' · '}
          <span>{equipe.emAndamento} em andamento</span>
          {' · '}
          <span>{quantidade(equipe.pendentes, 'pendente', 'pendentes')}</span>
        </span>
      </div>
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
  // (equipes alem das 5 primeiras do ranking ou varias equipes sem tarefas).
  const unicaEquipeSemTarefas = totalEquipes === 1 && comTarefas.length === 0;
  const umaSemTarefas = semTarefas.length === 1;
  const podeExpandir = comTarefas.length > LIMITE_RANKING || semTarefas.length > 1;
  const mostrarSemTarefas = !unicaEquipeSemTarefas && semTarefas.length > 0 && (expandido || umaSemTarefas);
  const Lista = haConcluidas ? 'ol' : 'ul';

  let subtitulo = null;
  if (comTarefas.length > 0) {
    subtitulo = haConcluidas
      ? 'Ordenado por tarefas concluídas'
      : 'Nenhuma tarefa concluída ainda. Equipes ordenadas pelo volume de tarefas.';
  }

  return (
    <section className="glass-card ranking-panel" aria-labelledby={idTitulo}>
      <header className="painel-cabecalho">
        <h3 id={idTitulo}>{haConcluidas ? 'Ranking de Equipes' : 'Atividade das Equipes'}</h3>
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
                  ? <><strong>{semTarefas[0].nome}</strong> ainda não tem tarefas.</>
                  : 'Nenhuma equipe tem tarefas ainda.'}
              </p>
            )}

            {visiveis.length > 0 && (
              <Lista className="ranking-list">
                {visiveis.map((equipe, indice) => (haConcluidas
                  ? <ItemRanking key={equipe.id} equipe={equipe} posicao={indice + 1} />
                  : <ItemAtividade key={equipe.id} equipe={equipe} />))}
              </Lista>
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

          {podeExpandir && (
            <div className="ranking-rodape">
              {!expandido && semTarefas.length > 1 && (
                <p className="ranking-resumo">
                  {quantidade(semTarefas.length, 'equipe sem tarefas', 'equipes sem tarefas')}
                </p>
              )}
              <button
                type="button"
                className="ranking-toggle"
                aria-expanded={expandido}
                aria-controls={idConteudo}
                onClick={() => setExpandido((atual) => !atual)}
              >
                {expandido ? 'Mostrar menos' : `Ver todas (${totalEquipes})`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default RankingEquipes;
