// Chat: separadores por data, agrupamento de mensagens consecutivas, pesquisa nas mensagens carregadas (com
// destaque) e pesquisa de equipes. So apresentacao, sobre os dados ja carregados; nada aqui consulta a API.
import { correspondeBusca, normalizarBusca } from '../admin/adminFiltrosUtils';
import { chaveDiaLocal, diferencaEmDias, formatarDia } from '../dashboard/painelGeralUtils';

export const LIMITE_PAGINA_MENSAGENS = 50;
// Mensagens do mesmo participante, no mesmo dia e com ate 5 minutos de intervalo formam um bloco visual.
export const INTERVALO_AGRUPAMENTO_MS = 5 * 60 * 1000;

const instante = (valor) => {
  const tempo = new Date(valor ?? '').getTime();
  return Number.isFinite(tempo) ? tempo : null;
};

export const idDoAutor = (mensagem) => {
  const user = mensagem?.user;
  const id = user && typeof user === 'object' ? user._id : user;
  return id == null ? null : String(id);
};

// Equipe da mensagem (payload do socket e do historico trazem `equipe`); null quando o campo nao vem.
export const idDaEquipeDaMensagem = (mensagem) => {
  const equipe = mensagem?.equipe;
  const id = equipe && typeof equipe === 'object' ? equipe._id : equipe;
  return id == null || id === '' ? null : String(id);
};

export function rotuloDoDia(valor, hoje) {
  const tempo = instante(valor);
  if (tempo === null) return 'Data indisponível';
  const dia = chaveDiaLocal(new Date(tempo));
  const diferenca = diferencaEmDias(dia, hoje);
  if (diferenca === 0) return 'Hoje';
  if (diferenca === 1) return 'Ontem';
  return formatarDia(dia);
}

export const formatarHora = (valor) => {
  const tempo = instante(valor);
  return tempo === null ? '' : new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(tempo);
};

export const formatarDataHora = (valor) => {
  const tempo = instante(valor);
  return tempo === null
    ? ''
    : new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(tempo);
};

// Itens da lista: { tipo: 'dia', chave, rotulo } e { tipo: 'mensagem', mensagem, inicioDoBloco, fimDoBloco }.
export function montarLinhaDoTempo(mensagens, hoje) {
  const itens = [];
  let diaAnterior = null;
  mensagens.forEach((mensagem, posicao) => {
    const tempo = instante(mensagem?.createdAt);
    const dia = tempo === null ? 'sem-data' : chaveDiaLocal(new Date(tempo));
    if (dia !== diaAnterior) {
      itens.push({ tipo: 'dia', chave: `dia-${dia}-${posicao}`, rotulo: rotuloDoDia(mensagem?.createdAt, hoje) });
      diaAnterior = dia;
    }
    const anterior = mensagens[posicao - 1];
    const seguinte = mensagens[posicao + 1];
    const mesmoBloco = (a, b) => {
      if (!a || !b) return false;
      const ta = instante(a.createdAt);
      const tb = instante(b.createdAt);
      if (ta === null || tb === null) return false;
      return idDoAutor(a) !== null && idDoAutor(a) === idDoAutor(b)
        && chaveDiaLocal(new Date(ta)) === chaveDiaLocal(new Date(tb))
        && Math.abs(tb - ta) <= INTERVALO_AGRUPAMENTO_MS;
    };
    itens.push({
      tipo: 'mensagem',
      mensagem,
      inicioDoBloco: !mesmoBloco(anterior, mensagem),
      fimDoBloco: !mesmoBloco(mensagem, seguinte),
    });
  });
  return itens;
}

// ------------------------------------------------------------------------------------------------------------
// Pesquisa: sem diferenca de maiusculas e acentos, na mesma regra das paginas administrativas.

export const textoPesquisavel = (mensagem) => [mensagem?.texto, mensagem?.anexo?.nomeOriginal].filter(Boolean).join(' ');

// Ids (ou posicoes) das mensagens carregadas que contem todos os termos, em ordem cronologica.
export function buscarMensagens(mensagens, busca) {
  if (!normalizarBusca(busca)) return [];
  return mensagens
    .map((mensagem, posicao) => ({ mensagem, posicao }))
    .filter(({ mensagem }) => correspondeBusca([textoPesquisavel(mensagem)], busca))
    .map(({ mensagem, posicao }) => chaveDaMensagem(mensagem, posicao));
}

export const chaveDaMensagem = (mensagem, posicao) => (mensagem?._id ? String(mensagem._id) : `posicao-${posicao}`);

// Normaliza caractere a caractere, guardando de qual caractere original veio cada um (para destacar no original).
function normalizarComMapa(texto) {
  let normalizado = '';
  const mapa = [];
  let original = 0;
  Array.from(String(texto ?? '')).forEach((caractere) => {
    const base = caractere.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const parte of base) {
      normalizado += parte;
      mapa.push({ inicio: original, fim: original + caractere.length });
    }
    original += caractere.length;
  });
  return { normalizado, mapa };
}

// Trechos do texto original: [{ texto, destaque }]. Cada termo da busca e destacado onde aparece.
export function trechosDestacados(texto, busca) {
  const original = String(texto ?? '');
  const termos = normalizarBusca(busca).split(' ').filter(Boolean);
  if (!original || termos.length === 0) return [{ texto: original, destaque: false }];
  const { normalizado, mapa } = normalizarComMapa(original);
  const marcado = new Array(original.length).fill(false);
  termos.forEach((termo) => {
    let desde = normalizado.indexOf(termo);
    while (desde !== -1) {
      const inicio = mapa[desde].inicio;
      const fim = mapa[desde + termo.length - 1].fim;
      for (let i = inicio; i < fim; i += 1) marcado[i] = true;
      desde = normalizado.indexOf(termo, desde + termo.length);
    }
  });
  const trechos = [];
  for (let i = 0; i < original.length; i += 1) {
    const ultimo = trechos[trechos.length - 1];
    if (ultimo && ultimo.destaque === marcado[i]) ultimo.texto += original[i];
    else trechos.push({ texto: original[i], destaque: marcado[i] });
  }
  return trechos;
}

// Equipes da lista lateral: pesquisa por nome, na ordem em que a API devolve (a mesma de antes).
export const filtrarEquipesDoChat = (equipes, busca) => (Array.isArray(equipes) ? equipes : [])
  .filter((equipe) => correspondeBusca([equipe?.nome], busca));
