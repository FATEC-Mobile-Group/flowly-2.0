import React, { useId } from 'react';
import { Link } from 'react-router-dom';
import { linkTarefas } from './painelIndicadores';

// Fatos calculados sobre os dados carregados que pedem uma acao administrativa. Nada inferido sobre pessoas,
// conflitos ou produtividade, e nenhum dado de insights.
function PontosAtencao({ pontos, equipeId }) {
  const idTitulo = useId();

  return (
    <section className="glass-card atencao-panel" aria-labelledby={idTitulo}>
      <header className="painel-cabecalho">
        <h3 id={idTitulo}>Pontos de atenção</h3>
        <p className="painel-subtitulo">Situações que pedem uma ação administrativa</p>
      </header>
      {pontos.length === 0 ? (
        <p className="painel-vazio">Nenhum ponto de atenção no momento.</p>
      ) : (
        <ul className="atencao-lista">
          {pontos.map((ponto) => (
            <li key={ponto.chave} className={`atencao-item atencao-${ponto.tom}`} data-ponto={ponto.chave}>
              <span className="atencao-texto">{ponto.texto}</span>
              {ponto.equipes ? (
                <Link to="/admin" className="atencao-acao">Ver todas as equipes</Link>
              ) : (
                <Link to={linkTarefas(equipeId, ponto.destino)} className="atencao-acao" aria-label={`Ver lista: ${ponto.texto}`}>
                  Ver lista
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default PontosAtencao;
