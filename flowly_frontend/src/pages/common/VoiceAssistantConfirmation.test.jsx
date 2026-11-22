// Etapa 6B: confirmacoes de escrita ligadas a operacao mostrada (operationId), por voz, texto e botoes.
// SpeechRecognition, speechSynthesis e fetch simulados; rede real bloqueada. Quem valida e executa e o backend:
// aqui se confere o que a tela envia, o que mostra e o que nunca faz.
import fs from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { API_ENDPOINTS } from '../../config/config';

vi.mock('../../components/layout/Sidebar', () => ({
  __esModule: true,
  default: () => null,
}));

vi.setConfig({ testTimeout: 20000, hookTimeout: 30000 });

class FakeRecognition {
  static instances = [];

  constructor() {
    this.start = vi.fn();
    this.stop = vi.fn();
    this.abort = vi.fn();
    this.onaudiostart = null;
    FakeRecognition.instances.push(this);
  }
}

const COMMAND_URL = API_ENDPOINTS.ASSISTANT_COMMAND;
const STANDBY_URL = API_ENDPOINTS.ASSISTANT_STANDBY;
let requests = [];
let replyFor = () => null;
let pendingReplies = [];

const jsonResponse = (payload) => ({ json: () => Promise.resolve(payload) });
const commands = () => requests.filter((r) => r.url === COMMAND_URL).map((r) => r.body);
const standbyCalls = () => requests.filter((r) => r.url === STANDBY_URL);

let VoiceAssistantPage;

beforeAll(async () => {
  window.SpeechRecognition = FakeRecognition;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  global.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  VoiceAssistantPage = (await import('./VoiceAssistantPage')).default;
});

beforeEach(() => {
  FakeRecognition.instances = [];
  requests = [];
  pendingReplies = [];
  replyFor = () => null;
  window.speechSynthesis = { speak: vi.fn(), cancel: vi.fn() };
  global.fetch = vi.fn((url, init) => {
    if (url !== COMMAND_URL && url !== STANDBY_URL) {
      return Promise.reject(new Error(`rede real bloqueada: ${url}`));
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    requests.push({ url, body, headers: { ...(init?.headers || {}) } });
    if (url === STANDBY_URL) return Promise.resolve(jsonResponse({ ok: true, status: 'standby' }));
    const payload = replyFor(body);
    if (payload instanceof Error) return Promise.reject(payload);
    if (payload) return Promise.resolve(jsonResponse(payload));
    return new Promise((resolve) => {
      pendingReplies.push((reply) => resolve(jsonResponse(reply)));
    });
  });
});

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
const wait = (ms) => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, ms));
});

const input = () => screen.getByRole('textbox');
const sendTyped = (text) => {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.click(screen.getByTitle('Enviar comando'));
};
const card = () => document.querySelector('.voice-confirmation');
const cardButton = (name) => screen.queryByRole('button', { name });
const speakFinal = (text) => {
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar escuta' }));
  const session = FakeRecognition.instances.at(-1);
  act(() => session.onstart?.());
  act(() => session.onaudiostart?.());
  act(() => session.onresult?.({ results: [Object.assign([{ transcript: text }], { isFinal: true })] }));
  act(() => session.onend?.());
};

const SUMMARY = 'mudar o status da tarefa "Relatório final" para concluída';
const awaiting = (operationId = 'op-1', summary = SUMMARY, extra = {}) => ({
  ok: true,
  reply_text: `Confirme a operação: ${summary}. Nada foi alterado ainda. Para executar, diga "confirmar".`,
  conversation: { status: 'awaiting_confirmation', operation_id: operationId, summary, expires_in: 120, ...extra },
});
const terminal = (status, text, operationId = 'op-1') => ({
  ok: status === 'completed' || status === 'cancelled',
  reply_text: text,
  action_executed: status === 'completed',
  conversation: { status, operation_id: operationId },
});
// Backend simulado so o bastante para o fluxo: pedido -> resumo; confirmar/cancelar -> resultado.
const flowReplies = ({ onConfirm = () => terminal('completed', 'Confirmado. Operação concluída.') } = {}) => (body) => {
  if (body.content.startsWith('mudar status')) return awaiting();
  if (/confirm/i.test(body.content)) return onConfirm(body);
  if (/cancel/i.test(body.content)) return terminal('cancelled', 'Tudo bem, cancelei. Nada foi alterado.');
  return { ok: true, reply_text: 'Ok.', conversation: { status: 'browsing_tasks' } };
};

async function prepare() {
  sendTyped('mudar status da tarefa relatório final para concluído');
  await flush();
}

describe('1-4, 16: resumo, confirmar e cancelar por botao, voz e texto', () => {
  test('1. pedido cria a confirmacao e mostra o resumo exato devolvido pela API', async () => {
    replyFor = flowReplies();
    render(<VoiceAssistantPage />);
    await prepare();
    expect(card()).toBeInTheDocument();
    expect(card().dataset.operationId).toBe('op-1');
    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
    expect(screen.getByText(/Nada foi alterado ainda/, { selector: '.voice-confirmation-note' })).toBeInTheDocument();
    expect(cardButton('Confirmar')).toBeEnabled();
    expect(cardButton('Cancelar')).toBeEnabled();
    expect(commands()[0].operationId).toBeUndefined(); // o pedido em si nao leva ID algum
  });

  test('2. botao Confirmar envia "confirmar" com o operationId mostrado e remove a confirmacao no fim', async () => {
    replyFor = flowReplies();
    render(<VoiceAssistantPage />);
    await prepare();
    fireEvent.click(cardButton('Confirmar'));
    await flush();
    expect(commands()[1]).toMatchObject({ content: 'confirmar', operationId: 'op-1' });
    expect(card()).toBeNull();
    expect(screen.getByText('Confirmado. Operação concluída.')).toBeInTheDocument();
  });

  test('3 e 16. confirmacao falada envia o mesmo operationId', async () => {
    replyFor = flowReplies();
    render(<VoiceAssistantPage />);
    await prepare();
    speakFinal('confirmar');
    await flush();
    expect(commands()[1]).toMatchObject({ content: 'confirmar', operationId: 'op-1' });
    expect(card()).toBeNull();
  });

  test.each([
    ['botao', () => fireEvent.click(cardButton('Cancelar'))],
    ['texto', () => sendTyped('cancelar')],
    ['voz', () => speakFinal('cancelar')],
  ])('4. cancelamento por %s referencia a operacao e encerra a confirmacao', async (_via, cancel) => {
    replyFor = flowReplies();
    render(<VoiceAssistantPage />);
    await prepare();
    cancel();
    await flush();
    expect(commands()[1]).toMatchObject({ content: 'cancelar', operationId: 'op-1' });
    expect(card()).toBeNull();
  });
});

describe('5-9: vinculos ausentes, antigos, duplicados, atrasados ou ambiguos', () => {
  test('5. resposta sem operation_id nao cria botoes e a confirmacao segue sem ID (o backend recusa)', async () => {
    replyFor = (body) => (body.content === 'confirmar'
      ? { ok: false, error: 'operation_id_required', reply_text: 'Não consegui ligar essa confirmação. Nada foi alterado.',
        conversation: { status: 'awaiting_confirmation', operation_id: 'op-7', summary: SUMMARY, expires_in: 90 } }
      : { ok: true, reply_text: 'Confirme a operação.', conversation: { status: 'awaiting_confirmation' } });
    render(<VoiceAssistantPage />);
    await prepare();
    expect(card()).toBeNull();
    sendTyped('confirmar');
    await flush();
    expect(commands()[1].operationId).toBeUndefined();
    // O backend reapresenta a operacao certa: so agora aparecem os botoes, para a pessoa confirmar de novo.
    expect(card().dataset.operationId).toBe('op-7');
    expect(screen.queryByText('Confirmado. Operação concluída.')).toBeNull();
  });

  test('6. confirmacao antiga nao vale para a nova; divergencia reapresentada troca o vinculo sem executar', async () => {
    let next = 'op-1';
    replyFor = (body) => {
      if (body.content.startsWith('mudar status')) return awaiting(next);
      if (body.content === 'cancelar') return terminal('cancelled', 'Cancelei.', body.operationId);
      return { ok: false, error: 'confirmation_mismatch', reply_text: 'Essa confirmação não corresponde. Nada foi alterado.',
        conversation: { status: 'awaiting_confirmation', operation_id: 'op-3', summary: 'criar a equipe "Vendas"', expires_in: 60 } };
    };
    render(<VoiceAssistantPage />);
    await prepare();
    sendTyped('cancelar');
    await flush();
    next = 'op-2';
    await prepare();
    fireEvent.click(cardButton('Confirmar'));
    await flush();
    expect(commands().map((c) => c.operationId)).toEqual([undefined, 'op-1', undefined, 'op-2']);
    expect(card().dataset.operationId).toBe('op-3');
    expect(screen.getByText('criar a equipe "Vendas"')).toBeInTheDocument(); // o resumo da operacao valida agora
  });

  test('7. duplo clique em Confirmar produz um unico envio', async () => {
    replyFor = (body) => (body.content.startsWith('mudar status') ? awaiting() : null);
    render(<VoiceAssistantPage />);
    await prepare();
    fireEvent.click(cardButton('Confirmar'));
    fireEvent.click(cardButton('Confirmar'));
    sendTyped('confirmar');
    await flush();
    expect(commands().filter((c) => c.content === 'confirmar')).toHaveLength(1);
    expect(cardButton('Confirmar')).toBeDisabled();
    act(() => pendingReplies.shift()(terminal('completed', 'Confirmado.')));
    await flush();
    expect(card()).toBeNull();
  });

  test('8. resposta atrasada (depois do standby) ou de outra conversa nao altera a confirmacao', async () => {
    replyFor = () => null;
    render(<VoiceAssistantPage />);
    sendTyped('mudar status da tarefa relatório final para concluído');
    fireEvent.click(screen.getByTitle('Standby'));
    await flush();
    act(() => pendingReplies.shift()(awaiting('op-tardia')));
    await flush();
    expect(card()).toBeNull();

    replyFor = () => awaiting('op-de-outra-conversa', SUMMARY, { id: 'outra-conversa' });
    sendTyped('mudar status da tarefa relatório final para concluído');
    await flush();
    expect(card()).toBeNull();
  });

  test('9. resposta ambigua nao executa: a confirmacao continua aguardando', async () => {
    replyFor = (body) => (body.content.startsWith('mudar status') ? awaiting() : {
      ok: true, reply_text: 'Não entendi se você quer confirmar. Nada foi alterado.',
      conversation: { status: 'awaiting_confirmation', operation_id: 'op-1', summary: SUMMARY, expires_in: 100 },
    });
    render(<VoiceAssistantPage />);
    await prepare();
    for (const word of ['sim', 'ok']) {
      sendTyped(word);
      await flush();
    }
    expect(commands().slice(1).map((c) => [c.content, c.operationId])).toEqual([['sim', 'op-1'], ['ok', 'op-1']]);
    expect(card().dataset.operationId).toBe('op-1');
    expect(cardButton('Confirmar')).toBeEnabled();
  });
});

describe('10-12: prazo, concluida, incerta, unknown e erros', () => {
  test('10. prazo vencido tira os botoes e a proxima mensagem nao leva o ID', async () => {
    replyFor = (body) => (body.content.startsWith('mudar status')
      ? { ...awaiting(), conversation: { ...awaiting().conversation, expires_in: 0.05 } }
      : terminal('expired', 'O pedido de confirmação expirou. Nada foi alterado.'));
    render(<VoiceAssistantPage />);
    await prepare();
    await wait(120);
    expect(screen.getByText('Prazo encerrado')).toBeInTheDocument();
    expect(cardButton('Confirmar')).toBeNull();
    sendTyped('confirmar');
    await flush();
    expect(commands()[1].operationId).toBeUndefined();
    expect(card()).toBeNull();
  });

  test('10. operacao ja concluida: nenhum botao fica ativo', async () => {
    replyFor = flowReplies({ onConfirm: () => terminal('completed', 'Não há nenhuma operação aguardando. Nada foi executado de novo.') });
    render(<VoiceAssistantPage />);
    await prepare();
    fireEvent.click(cardButton('Confirmar'));
    await flush();
    expect(card()).toBeNull();
    expect(cardButton('Confirmar')).toBeNull();
  });

  test('11. resultado incerto: avisa que pode ter sido aplicada e so oferece concluir com seguranca', async () => {
    replyFor = flowReplies({ onConfirm: () => ({
      ok: false, error: 'outcome_uncertain', reply_text: 'Não consegui confirmar se a alteração foi feita.',
      conversation: { status: 'retry_pending', operation_id: 'op-1' } }) });
    render(<VoiceAssistantPage />);
    await prepare();
    fireEvent.click(cardButton('Confirmar'));
    await flush();
    expect(screen.getByText('Resultado não confirmado')).toBeInTheDocument();
    expect(screen.getByText(/pode ter sido aplicada/, { selector: '.voice-confirmation-note' })).toBeInTheDocument();
    expect(cardButton('Cancelar')).toBeNull();
    expect(screen.getByText(SUMMARY)).toBeInTheDocument(); // o resumo da operacao continua visivel
    fireEvent.click(cardButton('Concluir com segurança'));
    await flush();
    expect(commands()[2]).toMatchObject({ content: 'confirmar', operationId: 'op-1' });
  });

  test('11. resposta perdida depois de confirmar vira "incerto", nunca sucesso ou falha', async () => {
    replyFor = flowReplies({ onConfirm: () => new Error('rede caiu') });
    render(<VoiceAssistantPage />);
    await prepare();
    fireEvent.click(cardButton('Confirmar'));
    await flush();
    expect(screen.getByText('Resultado não confirmado')).toBeInTheDocument();
    expect(screen.getByText(/A alteração pode ter sido aplicada; confira antes de repetir/)).toBeInTheDocument();
  });

  test('11. unknown e terminal: nada para reexecutar', async () => {
    replyFor = flowReplies({ onConfirm: () => terminal('unknown', 'Por segurança, não vou repetir. Confira no Flowly.') });
    render(<VoiceAssistantPage />);
    await prepare();
    fireEvent.click(cardButton('Confirmar'));
    await flush();
    expect(card()).toBeNull();
    sendTyped('confirmar');
    await flush();
    expect(commands()[2].operationId).toBeUndefined();
  });

  test.each([
    ['409 conflito de contexto', { ok: false, error: 'conversation_state_conflict', reply_text: 'Recebi outra mensagem ao mesmo tempo.', conversation: { status: 'unverified' } }],
    ['503 contexto indisponivel', { ok: false, error: 'conversation_state_unavailable', reply_text: 'Não consegui recuperar o andamento.', conversation: { status: 'unverified' } }],
    ['401 sessao', { ok: false, error: 'unauthorized', reply_text: 'Autenticação inválida.' }],
  ])('12. %s: nada muda na confirmacao mostrada', async (_label, reply) => {
    replyFor = (body) => (body.content.startsWith('mudar status') ? awaiting() : reply);
    render(<VoiceAssistantPage />);
    await prepare();
    fireEvent.click(cardButton('Confirmar'));
    await flush();
    expect(screen.getByText(reply.reply_text)).toBeInTheDocument();
    expect(card().dataset.operationId).toBe('op-1');
    expect(screen.getByText('Confirme a operação')).toBeInTheDocument();
  });

  test('12. conversa ocupada mostra a operacao que esta valendo; cancelamento nao verificado mantem so Cancelar', async () => {
    replyFor = (body) => (body.content === 'cancelar'
      ? { ok: false, error: 'user_type_unknown', reply_text: 'Não consegui confirmar o cancelamento.',
        conversation: { status: 'cancel_unverified', operation_id: 'op-5' } }
      : { ok: false, error: 'conversation_busy', reply_text: 'Já existe uma confirmação pendente nesta conversa.',
        conversation: { status: 'awaiting_confirmation', operation_id: 'op-5', summary: 'criar a equipe "Vendas"', expires_in: 30 } });
    render(<VoiceAssistantPage />);
    await prepare();
    expect(card().dataset.operationId).toBe('op-5');
    expect(screen.getByText('criar a equipe "Vendas"')).toBeInTheDocument();
    fireEvent.click(cardButton('Cancelar'));
    await flush();
    expect(screen.getByText('Cancelamento não confirmado')).toBeInTheDocument();
    expect(cardButton('Confirmar')).toBeNull();
    expect(cardButton('Cancelar')).toBeEnabled();
  });

  test('12. operacao em andamento: sem botoes', async () => {
    replyFor = () => ({ ok: false, error: 'operation_in_progress', reply_text: 'Essa operação já está sendo executada.',
      conversation: { status: 'operation_in_progress', operation_id: 'op-1' } });
    render(<VoiceAssistantPage />);
    await prepare();
    expect(screen.getByText('Em andamento')).toBeInTheDocument();
    expect(card().querySelectorAll('button')).toHaveLength(0);
  });
});

describe('13-15: troca de conversa, desmontagem, atualizacao e standby', () => {
  test('13 e 14. desmontar avisa o standby; remontar (atualizar a pagina) nao traz nem confirma nada', async () => {
    replyFor = flowReplies();
    const first = render(<VoiceAssistantPage />);
    await prepare();
    const firstConversation = commands()[0].conversationId;
    first.unmount();
    await flush();
    expect(standbyCalls().at(-1).body.conversationId).toBe(firstConversation);

    requests = [];
    render(<VoiceAssistantPage />);
    await wait(5);
    expect(card()).toBeNull();
    expect(commands()).toEqual([]); // nada e confirmado sozinho ao montar
    sendTyped('confirmar');
    await flush();
    expect(commands()[0].operationId).toBeUndefined();
    expect(commands()[0].conversationId).not.toBe(firstConversation);
  });

  test('15. standby tira a confirmacao e a proxima mensagem nao leva o ID', async () => {
    replyFor = flowReplies();
    render(<VoiceAssistantPage />);
    await prepare();
    fireEvent.click(screen.getByTitle('Standby'));
    await flush();
    expect(card()).toBeNull();
    expect(standbyCalls()).toHaveLength(1);
    sendTyped('confirmar');
    await flush();
    expect(commands()[1].operationId).toBeUndefined();
  });
});

describe('17-20: responsividade, credenciais, leituras e kill switch', () => {
  test('17. confirmacao no celular: botoes acessiveis e regras de largura pequena no CSS', async () => {
    window.innerWidth = 375;
    replyFor = flowReplies();
    render(<VoiceAssistantPage />);
    await prepare();
    expect(cardButton('Confirmar')).toBeVisible();
    const css = fs.readFileSync(path.resolve(__dirname, '../../styles/pages/common/VoiceAssistantPage.css'), 'utf8');
    expect(css).toMatch(/@media \(max-width: 768px\) \{\s*\.voice-confirmation-actions button/);
    expect(css).toMatch(/\.voice-confirmation \{[^}]*max-height/);
  });

  test('18. nenhuma credencial interna nas requisicoes nem nas rotas usadas pelo navegador', async () => {
    replyFor = flowReplies();
    render(<VoiceAssistantPage />);
    await prepare();
    fireEvent.click(cardButton('Confirmar'));
    await flush();
    const sent = JSON.stringify(requests);
    for (const forbidden of ['X-Assistant-Operations-Secret', 'ASSISTANT_OPERATIONS_SECRET', 'claimToken', 'idempotencyKey',
      '/assistant/operations', '/assistant/conversations']) {
      expect(sent).not.toContain(forbidden);
    }
    expect(new Set(requests.map((r) => r.url))).toEqual(new Set([COMMAND_URL]));
    // Codigo do frontend: nenhuma referencia as rotas internas ou ao segredo.
    const files = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(jsx?|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(full);
    });
    walk(path.resolve(__dirname, '../..'));
    const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(/assistant\/operations|assistant\/conversations|ASSISTANT_OPERATIONS_SECRET|claimToken|idempotencyKey/);
  });

  test('19. comandos de leitura continuam iguais e nao criam confirmacao', async () => {
    replyFor = () => ({ ok: true, action_executed: true, reply_text: 'Você tem 2 tarefas.', command: { key: 'my_tasks' },
      conversation: { status: 'browsing_tasks', options: ['details', 'assign_to_me', 'cancel'] } });
    render(<VoiceAssistantPage />);
    sendTyped('minhas tarefas');
    await flush();
    expect(screen.getByText('Você tem 2 tarefas.')).toBeInTheDocument();
    expect(card()).toBeNull();
    expect(commands()[0].operationId).toBeUndefined();
  });

  test('20. kill switch: escrita desligada nao mostra botoes de confirmacao', async () => {
    replyFor = () => ({ ok: false, error: 'assistant_writes_disabled', action_executed: false,
      reply_text: 'As alterações pelo assistente estão temporariamente indisponíveis. Nada foi alterado.',
      conversation: { status: 'cancelled' } });
    render(<VoiceAssistantPage />);
    await prepare();
    expect(screen.getByText(/temporariamente indisponíveis/)).toBeInTheDocument();
    expect(card()).toBeNull();
  });
});

describe('Cancelar a escuta junto da estrela nao mexe na confirmacao', () => {
  test('a escuta e descartada; o cartao, o operationId e o backend ficam como estavam', async () => {
    replyFor = flowReplies();
    render(<VoiceAssistantPage />);
    await prepare();
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar escuta' }));
    const session = FakeRecognition.instances.at(-1);
    act(() => session.onstart?.());
    act(() => session.onaudiostart?.());
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar a escuta' }));
    await flush();
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(card().dataset.operationId).toBe('op-1');
    expect(cardButton('Confirmar')).toBeEnabled();
    expect(standbyCalls()).toHaveLength(0);
    expect(commands()).toHaveLength(1); // so o pedido original
  });
});
