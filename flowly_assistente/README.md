# Flowly Assistente (Python)

Compatível com **Google Cloud Functions** para frontend web/mobile.

Assistente virtual que interpreta comandos em linguagem natural (pt-BR) e consulta o backend Flowly.

## Segurança das alterações (escritas)

- **Desligadas por padrão.** Criar, atribuir, mudar status, cronômetro, comentário e subtarefa pelo assistente só
  funcionam com `FLOWLY_ASSISTANT_WRITES_ENABLED=true`. Ausente, vazia ou com qualquer outro valor, o assistente responde
  que as alterações estão temporariamente indisponíveis e não envia POST, PUT, PATCH ou DELETE à API.
- **Não use `FLOWLY_ASSISTANT_WRITES_ENABLED=true` em produção** enquanto a confirmação não for compartilhada entre
  instâncias e as escritas não forem idempotentes. Hoje o estado da conversa fica em um arquivo local por instância.
- Com a variável ligada, toda escrita mostra um resumo e só executa com "confirmar" em uma mensagem seguinte.
- Exclusão nunca é feita pelo assistente.
- `POST /api/v1/messages` é a rota usada pelo frontend. `POST /assist` e `POST /` (legado) continuam disponíveis só para
  **consultas**: nunca executam escritas, com qualquer valor da variável.
- Nada disso afeta as operações normais feitas pelas telas do Flowly, que usam a API principal diretamente.

## Requisitos

- **Python 3.11+**
- Backend Flowly rodando (ex.: `http://localhost:5000/api`)
- Token JWT válido

## Quick Start (5 minutos)

### 1. Instalar
```bash
cd flowly_assistente
pip install -r requirements.txt
```

### 2. Configurar
```bash
cp .env.example .env
# Editar .env com sua API URL e token
```

### 3. Rodar (escolha um)

**CLI Interativo (local):**
```bash
python main.py --cli
```

**HTTP Server (Google Cloud Functions):**
```bash
pip install functions-framework
functions-framework --target trigger_http --port 8080
```

**Test:**
```bash
curl -X POST http://localhost:8080/assist \
  -H "Content-Type: application/json" \
  -d '{"utterance": "meu perfil", "token": "SEU_TOKEN"}'
```

## 📖 Documentação

| Arquivo | Descrição |
|---------|-----------|
| [API_EXAMPLES.md](API_EXAMPLES.md) | Exemplos de requests/responses |

## Casos de Uso

### Mode CLI (Desktop/Terminal)
```bash
python main.py --cli
> Assistente Flowly iniciado. Diga um comando.
> [ouça comando via microfone]
```

### HTTP API (Web/Mobile Frontend)

O frontend usa `POST /api/v1/messages` (seção "API v1" abaixo). A rota legada `/assist` responde apenas consultas:

```javascript
const response = await fetch('https://seu-cloud-function/assist', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    utterance: 'minhas tarefas',
    token: 'jwt_token'
  })
});
```

No modo REST, o servidor não executa microfone nem `pyttsx3`. O frontend deve tocar a voz usando `reply_text` ou `tts.text`:

```json
{
  "ok": true,
  "reply_text": "Ok. Encontrei 3 itens.",
  "tts": {
    "enabled": true,
    "language": "pt-BR",
    "text": "Ok. Encontrei 3 itens."
  }
}
```

## Arquitetura

```
┌─────────────────┐
│   Frontend      │ (Web/Mobile)
│   (JavaScript)  │
└────────┬────────┘
         │ HTTP POST
         ▼
┌─────────────────────────────┐
│  Google Cloud Functions     │ (executaça rápida)
│  - Parse comando (NLP)      │
│  - Resolve referências      │
│  - Chama API backend        │
└────────┬────────────────────┘
         │ HTTP
         ▼
┌──────────────────┐
│  Flowly Backend  │
│  (Node.js)       │
│  - Tarefas       │
│  - Equipes       │
│  - Usuários      │
└──────────────────┘
```

## Comandos Disponíveis

### Usuário
- "meu perfil" → Mostrar dados
- "buscar usuario" → Buscar por nome
- "listar usuarios" → Listar todos

### Equipes
- "minhas equipes" → Minhas equipes
- "listar equipes" → Todas as equipes
- "membros da equipe" → Listar membros
- "criar equipe" → Criar nova

### Tarefas
- "minhas tarefas" → Minhas tarefas
- "backlog" → Tarefas sem responsável
- "detalhes da tarefa" → Info completa
- "atribuir para mim" → Assumir tarefa
- "mudar status" → Atualizar status
- "criar tarefa" → Nova tarefa
- "adicionar comentario" → Comentário
- "cronometro" → Timer

## Autenticação

### Método 1: No corpo (JSON)
```json
{
  "utterance": "meu perfil",
  "token": "seu_jwt_token"
}
```

### Método 2: Header Bearer
```bash
curl -H "Authorization: Bearer seu_jwt_token" \
  -d '{"utterance": "meu perfil"}'
```

### Método 3: Env Var (CLI)
```bash
export FLOWLY_API_TOKEN="seu_token"
python main.py --cli
```

## CORS & Cloud Deploy

### CORS Automático
Headers adicionados automaticamente:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

Configure via env var:
```env
FLOWLY_CORS_ORIGIN=https://seu-frontend.com
```

### Deploy Google Cloud
```bash
# Via script interativo
bash deploy.sh

# Ou via gcloud CLI
gcloud functions deploy flowly_assistente \
  --runtime python311 \
  --trigger-http \
  --entry-point trigger_http
```

## Testes

```bash
# Suite completa
python test_api.py

# Teste individual
curl -X POST http://localhost:8080/assist \
  -H "Content-Type: application/json" \
  -d '{"utterance": "minhas equipes", "token": "TOKEN"}'
```

## Configuração

### Variáveis Principais

```env
# Backend (obrigatório)
FLOWLY_API_BASE_URL=http://localhost:5000/api
FLOWLY_API_TOKEN=seu_jwt_token

# HTTP Server
FLOWLY_API_TIMEOUT_SEC=20
FLOWLY_MATCH_THRESHOLD=78
FLOWLY_CORS_ORIGIN=*

# Debug
FLOWLY_DEBUG=false

# Escritas pelo assistente: desligadas se ausente. Não usar "true" em produção (ver "Segurança das alterações").
FLOWLY_ASSISTANT_WRITES_ENABLED=false
```

**Ver todas**: `.env.example`

## Estrutura

```
flowly_assistente/
├── flowly_assistant/
│   ├── assistant_core/
│   │   ├── rest_assistant.py # Consultas (/assist legado) e preparo/execução de escritas confirmadas
│   │   └── message_agent.py  # Fluxo REST v1: moderação, comando e fila
│   ├── assistant.py          # CLI local com voz/microfone
│   ├── api_client.py         # Cliente da API Flowly
│   ├── command_parser.py     # NLP / reconhecimento
│   ├── commands.py           # Lista de comandos
│   ├── nlp/                  # Moderação e mineração PLN
│   ├── queues/               # Celery/Redis e publisher de analytics
│   ├── speech_service.py     # Captura de voz local para CLI
│   ├── storage/              # Repositório de insights analytics
│   ├── tts_service.py        # TTS local para CLI
│   ├── workers/              # Worker use cases
│   └── settings.py           # Configurações
├── main.py                 # Entrypoint (Cloud Fn + CLI)
├── function.py             # Adaptador HTTP: /health, /api/v1/messages, /standby e /assist (só consultas)
├── worker.py               # Entrypoint Celery
├── requirements.txt        # Dependências
├── Dockerfile              # Para Google Cloud Run
└── API_EXAMPLES.md         # Documentação API
```

## API v1 orientada a eventos

Além do endpoint legado `/assist` (só consultas), o agente expõe a arquitetura pedida para voz/PLN:

- `POST /api/v1/messages` (rota usada pelo frontend)
  - recebe `channelId` e `content`; a identidade vem do token (`userId` do corpo é ignorado)
  - executa moderação síncrona
  - publica evento de analytics se a mensagem for segura
  - classifica o comando e executa consultas na API backend
  - escritas: desligadas por padrão; com `FLOWLY_ASSISTANT_WRITES_ENABLED=true`, resumo + "confirmar"
    (status `awaiting_confirmation`)

- `GET /api/v1/admin/insights`
  - rota protegida para administradores
  - agrega sentimentos, tópicos e alertas de spam salvos pelo worker

Exemplo:

```bash
curl -X POST http://localhost:8080/api/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TOKEN" \
  -d '{"userId":"123","channelId":"web","content":"minhas tarefas"}'
```

### Worker de analytics

O armazenamento principal dos insights usa diretamente o MongoDB da aplicação:

```env
FLOWLY_ANALYTICS_STORAGE=mongodb
FLOWLY_MONGO_URI=mongodb://localhost:27017/Flowly
FLOWLY_MONGO_DB=Flowly
FLOWLY_ANALYTICS_COLLECTION=assistantinsights
```

O backend `flowly_api` lê a mesma coleção MongoDB pela rota:

```text
GET /api/admin/assistant-insights
```

Desenvolvimento sem Redis:

```env
FLOWLY_ANALYTICS_QUEUE_MODE=local
```

Produção com Celery/Redis:

```env
FLOWLY_ANALYTICS_QUEUE_MODE=celery
FLOWLY_REDIS_URL=redis://localhost:6379/0
```

```bash
celery -A worker.celery_app worker --loglevel=INFO
```

Os modelos reais entram em:

- `flowly_assistant/nlp/moderation.py`
- `flowly_assistant/nlp/mining.py`

Para gravar em JSONL local em vez do banco da aplicação:

```env
FLOWLY_ANALYTICS_STORAGE=jsonl
FLOWLY_ANALYTICS_STORE=data/analytics_events.jsonl
```

As variáveis `FLOWLY_ANALYTICS_INGEST_URL`, `FLOWLY_ANALYTICS_READ_URL` e `FLOWLY_ANALYTICS_SECRET` ficam apenas como opção futura caso você volte a integrar analytics via endpoint HTTP interno.

## Voz (Opcional)

### Google Speech Recognition (padrão)
```bash
pip install pyaudio  # ou sounddevice + numpy
```

### Desabilitar Voz
```env
FLOWLY_TTS_ENABLED=false
FLOWLY_TEXT_ONLY=true
```

## Troubleshooting

| Problema | Solução |
|----------|---------|
| "Erro de rede" | Verifique `FLOWLY_API_BASE_URL` |
| "Timeout" | Aumente `FLOWLY_API_TIMEOUT_SEC` |
| "Você não tem permissão" | Verifique token e role (admin/user) |
| "Não consegui identificar" | Abaixe `FLOWLY_MATCH_THRESHOLD` |
| "API não encontrada" | Verifique se backend está rodando |

## Performance

- **Latência típica**: 200-500ms (HTTP + API backend)
- **Memory**: ~100MB por requisição
- **Concorrência**: Ilimitada (Google Cloud Auto-scaling)

## Segurança

✅ Autenticação via JWT token obrigatória
✅ CORS headers configuráveis
✅ Timeout em requisições
✅ Erros sanitizados (sem stack traces)
✅ Validação de entrada

---

## Diagnóstico de travamentos

Se o assistente parecer “travado”, na prática ele quase sempre está **bloqueado esperando alguma operação síncrona**:

1) **Esperando voz/Google STT** (microfone/Internet)
- Sintoma: ficou parado após "Diga um comando" ou após uma pergunta.
- Contorno: no `.env`, defina `FLOWLY_TEXT_ONLY=True` para usar só input por texto.

2) **TTS travando (pyttsx3)**
- Sintoma: trava exatamente ao "falar" uma pergunta (ex.: confirmação), antes de ouvir resposta.
- Contorno: no `.env`, defina `FLOWLY_TTS_ENABLED=False`.

3) **Backend lento ou travado**
- Sintoma: imprime `[ROTA] ...` e fica aguardando a resposta.
- Contorno: ajuste `FLOWLY_API_TIMEOUT_SEC` (padrão 20s) e verifique logs do backend/DB.

Para enxergar onde ele parou, habilite logs:
- `FLOWLY_DEBUG=True`

## Exemplos de comandos
- "mostrar detalhes da tarefa 6560c4..."
- "adicionar comentário na tarefa 6560c4... dizendo o texto está pronto"
- "listar minhas tarefas"
- "mostrar backlog"
- "atribuir tarefa 6560c4... para mim"
- "mudar status da tarefa 6560c4... para em andamento"
- "iniciar cronômetro da tarefa 6560c4..."
- "meu perfil"
- "buscar usuário joão"

A assistente bloqueia comandos por hierarquia, como na API:
- **admin**: criar/listar/editar/excluir equipes e criar/listar/editar/excluir tarefas
- **user**: rotas de minhas tarefas/backlog/status/cronômetro/atribuir para mim
- **qualquer autenticado**: detalhes de tarefa, comentar, subtarefas, minhas equipes, perfil, listar/buscar users
