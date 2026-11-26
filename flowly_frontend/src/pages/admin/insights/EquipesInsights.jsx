import React, { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { correspondeBusca } from '../adminFiltrosUtils';
import { formatarQuantidade, linkInsights } from './insightsUtils';

// Comunicacao registrada por equipe, toda vinda da mesma consulta (nenhuma requisicao por equipe). Ordem
// alfabetica: os numeros descrevem registros, nao classificam equipes.
const CONTAGENS = [
  { chave: 'registros', rotulo: 'Registros' },
  { chave: 'chat', rotulo: 'Chat analisado' },
  { chave: 'ajuda', rotulo: 'Sinais de ajuda' },
  { chave: 'bloqueadas', rotulo: 'Bloqueadas' },
  { chave: 'assistente', rotulo: 'Assistente' },
];

function CartaoEquipe({ item, filtros, filtrando }) {
  const { equipe } = item;
  const semRegistros = item.registros === 0;
  return (
    <li className="insights-equipe" aria-label={`Equipe ${equipe.nome}`}>
      <div className="insights-equipe-topo">
        <h4 title={equipe.nome}>{equipe.nome}</h4>
        {item.alertas.total > 0 && (
          <span className="insights-selo insights-selo--alerta">
            {`${item.alertas.total} ${item.alertas.total === 1 ? 'alerta' : 'alertas'}`}
          </span>
        )}
      </div>

      {semRegistros ? (
        <p className="insights-equipe-vazia">
          Nenhum registro de comunicação no período. Pouca conversa registrada não indica, por si só, baixa atividade
          nem ausência de dificuldades.
        </p>
      ) : (
        <>
          <dl className="insights-equipe-numeros">
            {CONTAGENS.map(({ chave, rotulo }) => (
              <div key={chave}>
                <dt>{rotulo}</dt>
                <dd>{formatarQuantidade(item[chave])}</dd>
              </div>
            ))}
          </dl>
          <p className="insights-equipe-alertas">
            <span>Alertas:</span>
            <span>{`${formatarQuantidade(item.alertas.individuais)} individuais`}</span>
            <span>{`${formatarQuantidade(item.alertas.coletivos)} coletivos`}</span>
            {item.alertas.historicos > 0 && <span>{`${item.alertas.historicos} históricos sem escopo`}</span>}
            {item.alertas.semVinculo > 0 && <span>{`${item.alertas.semVinculo} sem vínculo confirmado`}</span>}
          </p>
          <div className="insights-assuntos">
            <span className="insights-assuntos-rotulo">Assuntos identificados:</span>
            {item.assuntos === null ? (
              <span className="insights-assuntos-vazio">indisponíveis nesta consulta</span>
            ) : item.assuntos.length === 0 ? (
              <span className="insights-assuntos-vazio">nenhum reconhecido</span>
            ) : (
              <ul>
                {item.assuntos.map((assunto) => (
                  <li key={assunto.codigo || assunto.rotulo}>{`${assunto.rotulo} · ${assunto.total}`}</li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <div className="insights-equipe-acoes">
        {!filtrando && (
          <Link to={linkInsights({ periodo: filtros.periodo, equipe: equipe.id, aba: 'geral' })} className="insights-link" aria-label={`Ver insights da equipe ${equipe.nome}`}>
            Ver insights da equipe
          </Link>
        )}
        <Link to={`/admin/tarefas?equipe=${encodeURIComponent(equipe.id)}`} className="insights-link" aria-label={`Ver tarefas da equipe ${equipe.nome}`}>
          Ver tarefas
        </Link>
        {equipe.participa && (
          <Link to="/admin/chats" state={{ equipeId: equipe.id }} className="insights-link" aria-label={`Abrir chat da equipe ${equipe.nome}`}>
            Abrir chat
          </Link>
        )}
      </div>
    </li>
  );
}

export default function EquipesInsights({ dados, filtros }) {
  const [busca, setBusca] = useState('');
  const [somenteComRegistros, setSomenteComRegistros] = useState(false);
  const idBusca = useId();
  const idSomente = useId();
  const equipes = dados.porEquipe;
  const filtrando = Boolean(dados.filtroEquipe);

  const visiveis = useMemo(() => (equipes || [])
    .filter((item) => correspondeBusca([item.equipe.nome], busca))
    .filter((item) => !somenteComRegistros || item.registros > 0), [equipes, busca, somenteComRegistros]);

  if (equipes === null) {
    return <p className="painel-status" role="status">Os dados por equipe não estão disponíveis nesta resposta da API.</p>;
  }
  if (equipes.length === 0) {
    return <p className="painel-status" role="status">Nenhuma equipe sob sua gestão.</p>;
  }

  return (
    <div className="insights-aba-conteudo">
      {!filtrando && (
        <div className="insights-filtros-locais">
          <div className="insights-campo">
            <label htmlFor={idBusca}>Pesquisar equipe</label>
            <input id={idBusca} type="search" value={busca} maxLength={200} autoComplete="off" onChange={(evento) => setBusca(evento.target.value)} />
          </div>
          <label className="insights-opcao" htmlFor={idSomente}>
            <input id={idSomente} type="checkbox" checked={somenteComRegistros} onChange={(evento) => setSomenteComRegistros(evento.target.checked)} />
            Somente equipes com registros no período
          </label>
          <p className="admin-contagem" aria-live="polite">{`Exibindo ${visiveis.length} de ${equipes.length} ${equipes.length === 1 ? 'equipe' : 'equipes'}`}</p>
        </div>
      )}

      <p className="insights-nota">
        “Sinais de ajuda” são mensagens com palavras associadas à necessidade de ajuda, identificadas por análise
        textual automática: não confirmam que houve dificuldade real.
      </p>

      <p className="insights-nota">
        Uma mensagem pode tratar de mais de um assunto: os totais de assuntos podem se sobrepor. O assunto genérico
        “chat”, usado quando nenhum assunto é reconhecido, não é exibido.
      </p>

      {visiveis.length === 0 ? (
        <p className="painel-status">Nenhuma equipe corresponde à pesquisa.</p>
      ) : (
        <ul className="insights-equipes">
          {visiveis.map((item) => <CartaoEquipe key={item.equipe.id} item={item} filtros={filtros} filtrando={filtrando} />)}
        </ul>
      )}
    </div>
  );
}
