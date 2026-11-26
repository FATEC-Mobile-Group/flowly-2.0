import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { FaExclamationCircle, FaExclamationTriangle, FaInfoCircle } from 'react-icons/fa';
import { ESCOPOS_ALERTA, GRAVIDADES, descreverPeriodo, formatarData, formatarDataHora, formatarQuantidade } from './insightsUtils';

// Alertas efetivamente emitidos (notificacoes enviadas aos administradores), cada um contado uma vez. Gravidade
// em texto e icone (nao so cor); nenhum percentual de risco. A pessoa so aparece no alerta individual.
export const ITENS_POR_PAGINA = 10;

const ICONES_GRAVIDADE = { high: FaExclamationCircle, medium: FaExclamationTriangle, low: FaInfoCircle };

function Gravidade({ gravidade }) {
  const Icone = ICONES_GRAVIDADE[gravidade.codigo] || FaInfoCircle;
  return (
    <span className="insights-gravidade" data-gravidade={gravidade.codigo || 'nenhuma'}>
      <Icone aria-hidden="true" />
      {`Gravidade: ${gravidade.rotulo}`}
    </span>
  );
}

function Alerta({ alerta, destacado = false, titulo }) {
  return (
    <article
      className={`insights-alerta insights-alerta--${alerta.escopo}${destacado ? ' is-destacado' : ''}`}
      aria-label={titulo || `Alerta ${ESCOPOS_ALERTA[alerta.escopo].toLowerCase()} de ${formatarDataHora(alerta.data)}`}
      data-alerta={alerta.id || undefined}
    >
      <div className="insights-alerta-topo">
        <span className={`insights-selo insights-selo--${alerta.escopo}`}>{ESCOPOS_ALERTA[alerta.escopo]}</span>
        <Gravidade gravidade={alerta.gravidade} />
        <time dateTime={alerta.data || undefined}>{formatarDataHora(alerta.data)}</time>
      </div>
      <h4>{alerta.categoria.rotulo}</h4>
      <dl className="insights-alerta-dados">
        <div><dt>Equipe</dt><dd title={alerta.equipe?.nome}>{alerta.equipe?.nome || 'Equipe indisponível'}</dd></div>
        {/* "Participante": administradores tambem conversam no chat da equipe e podem estar na ocorrencia. */}
        {alerta.colaborador && <div><dt>Participante</dt><dd>{alerta.colaborador.nome}</dd></div>}
        {alerta.ocorrencias !== null && (alerta.escopo === 'individual' ? (
          // metadata.occurrences do alerta individual: bloqueios da mesma pessoa, na mesma equipe, nas 24 horas
          // ate o alerta, incluindo o bloqueio que o gerou (services/assistantInsightService.js).
          <div>
            <dt>Bloqueios em 24 horas</dt>
            <dd>{`${alerta.ocorrencias} (da mesma pessoa nesta equipe, nas 24 horas até o alerta, incluindo o que o gerou)`}</dd>
          </div>
        ) : (
          <div><dt>Ocorrências registradas</dt><dd>{alerta.ocorrencias}</dd></div>
        ))}
        {alerta.vinculo !== 'confiavel' && (
          <div><dt>Vínculo com a ocorrência</dt><dd>{alerta.vinculo === 'divergente' ? 'Identificadores divergentes' : 'Não registrado'}</dd></div>
        )}
        <div>
          <dt>Motivo registrado</dt>
          <dd>{alerta.motivos.length > 0 ? alerta.motivos.join('; ') : 'Não registrado'}</dd>
        </div>
      </dl>
    </article>
  );
}

function OcorrenciaSolicitada({ ocorrencia, periodo }) {
  if (!ocorrencia) return null;
  if (ocorrencia.status === 'indisponivel' || !ocorrencia.item) {
    return (
      <p className="aviso-filtro insights-ocorrencia-aviso" role="status">
        O alerta indicado na notificação não está disponível para as equipes sob sua gestão neste filtro.
      </p>
    );
  }
  return (
    <section className="insights-ocorrencia" aria-label="Alerta aberto pela notificação">
      <p className="insights-ocorrencia-texto" role="status">
        {ocorrencia.status === 'fora_do_periodo'
          ? `Alerta da notificação, de ${formatarData(ocorrencia.item.data)}: fora do período selecionado (${descreverPeriodo(periodo).toLowerCase()}).`
          : 'Alerta da notificação, destacado na lista abaixo.'}
      </p>
      <Alerta alerta={ocorrencia.item} destacado titulo="Alerta aberto pela notificação" />
    </section>
  );
}

export default function AlertasInsights({ dados }) {
  const { alertas, totais, periodo, ocorrencia } = dados;
  const [escopo, setEscopo] = useState('');
  const [gravidade, setGravidade] = useState('');
  const [categoria, setCategoria] = useState('');
  const [pagina, setPagina] = useState(1);
  const ids = { escopo: useId(), gravidade: useId(), categoria: useId() };
  const listaRef = useRef(null);

  const itens = useMemo(() => alertas?.itens || [], [alertas]);
  const categorias = useMemo(() => {
    const mapa = new Map();
    itens.forEach((item) => { if (item.categoria.codigo) mapa.set(item.categoria.codigo, item.categoria.rotulo); });
    return [...mapa].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  }, [itens]);
  const filtrados = useMemo(() => itens.filter((item) => (!escopo || item.escopo === escopo)
    && (!gravidade || item.gravidade.codigo === gravidade)
    && (!categoria || item.categoria.codigo === categoria)), [itens, escopo, gravidade, categoria]);

  const totalPaginas = Math.max(1, Math.ceil(filtrados.length / ITENS_POR_PAGINA));
  const paginaAtual = Math.min(pagina, totalPaginas);
  const visiveis = filtrados.slice((paginaAtual - 1) * ITENS_POR_PAGINA, paginaAtual * ITENS_POR_PAGINA);
  const destacadoId = ocorrencia?.status === 'no_periodo' ? ocorrencia.id : null;

  // Filtro novo volta para a primeira pagina.
  useEffect(() => { setPagina(1); }, [escopo, gravidade, categoria, alertas]);

  if (alertas === null) {
    return <p className="painel-status" role="status">Os alertas não estão disponíveis nesta resposta da API.</p>;
  }

  const irPara = (nova) => {
    setPagina(nova);
    listaRef.current?.focus();
  };
  const contagem = totais?.alertas;

  return (
    <div className="insights-aba-conteudo">
      <OcorrenciaSolicitada ocorrencia={ocorrencia} periodo={periodo} />

      <div className="insights-resumo-alertas" aria-label="Alertas emitidos no período por escopo">
        <span><strong>{formatarQuantidade(contagem?.individuais ?? null)}</strong> individuais</span>
        <span><strong>{formatarQuantidade(contagem?.coletivos ?? null)}</strong> coletivos</span>
        <span><strong>{formatarQuantidade(contagem?.historicos ?? null)}</strong> históricos sem escopo</span>
        {contagem?.semVinculo > 0 && <span><strong>{contagem.semVinculo}</strong> sem vínculo confirmado com a ocorrência</span>}
        <span className="insights-resumo-sinais">
          <strong>{formatarQuantidade(totais?.sinaisColetivos ?? null)}</strong>
          {' mensagens com sinal coletivo moderado ou alto na análise'}
        </span>
      </div>
      <p className="insights-nota">
        Alertas emitidos são as notificações enviadas aos administradores, com as regras do momento em que foram gerados
        (por exemplo, recorrência em 24 horas e intervalo mínimo entre alertas). Sinais detectados na análise nem sempre
        geram alerta. O período escolhido só define quais alertas são listados. As contagens de alertas diferentes
        podem se sobrepor: um mesmo bloqueio entra na contagem de todos os alertas da mesma pessoa emitidos nas 24
        horas seguintes, e um alerta coletivo pode envolver mensagens que também geraram alertas individuais. Por
        isso, não some as ocorrências entre alertas.
      </p>

      <div className="insights-filtros-locais">
        <div className="insights-campo">
          <label htmlFor={ids.escopo}>Escopo</label>
          <select id={ids.escopo} value={escopo} onChange={(evento) => setEscopo(evento.target.value)}>
            <option value="">Todos</option>
            {Object.entries(ESCOPOS_ALERTA).map(([valor, rotulo]) => <option key={valor} value={valor}>{rotulo}</option>)}
          </select>
        </div>
        <div className="insights-campo">
          <label htmlFor={ids.gravidade}>Gravidade</label>
          <select id={ids.gravidade} value={gravidade} onChange={(evento) => setGravidade(evento.target.value)}>
            <option value="">Todas</option>
            {GRAVIDADES.map(({ valor, rotulo }) => <option key={valor} value={valor}>{rotulo}</option>)}
          </select>
        </div>
        <div className="insights-campo">
          <label htmlFor={ids.categoria}>Categoria</label>
          <select id={ids.categoria} value={categoria} onChange={(evento) => setCategoria(evento.target.value)}>
            <option value="">Todas</option>
            {categorias.map(([valor, rotulo]) => <option key={valor} value={valor}>{rotulo}</option>)}
          </select>
        </div>
        <p className="admin-contagem" aria-live="polite">
          {`${filtrados.length} de ${itens.length} ${itens.length === 1 ? 'alerta carregado' : 'alertas carregados'}`}
        </p>
      </div>

      {alertas.total === null && itens.length > 0 && (
        <p className="insights-nota">{`Total do período indisponível. Exibindo os ${itens.length} alertas mais recentes.`}</p>
      )}
      {alertas.total !== null && alertas.total > itens.length && (
        <p className="insights-nota">{`Foram carregados os ${itens.length} alertas mais recentes de ${alertas.total} no período.`}</p>
      )}

      {itens.length === 0 ? (
        <p className="painel-status">Nenhum alerta emitido no período. A ausência de alertas não garante que não existam dificuldades.</p>
      ) : filtrados.length === 0 ? (
        <p className="painel-status">Nenhum alerta corresponde aos filtros.</p>
      ) : (
        <>
          <div className="insights-alertas" ref={listaRef} tabIndex={-1} aria-label={`Alertas, página ${paginaAtual} de ${totalPaginas}`}>
            {visiveis.map((alerta, indice) => (
              <Alerta key={alerta.id || `${alerta.data}-${indice}`} alerta={alerta} destacado={Boolean(destacadoId) && alerta.id === destacadoId} />
            ))}
          </div>
          {totalPaginas > 1 && (
            <nav className="insights-paginacao" aria-label="Paginação dos alertas">
              <button type="button" className="admin-botao-secundario" disabled={paginaAtual === 1} onClick={() => irPara(paginaAtual - 1)}>
                Anterior
              </button>
              <span>{`Página ${paginaAtual} de ${totalPaginas}`}</span>
              <button type="button" className="admin-botao-secundario" disabled={paginaAtual === totalPaginas} onClick={() => irPara(paginaAtual + 1)}>
                Próxima
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
