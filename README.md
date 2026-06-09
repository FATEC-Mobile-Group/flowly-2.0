> ***Projeto Interdisciplinar 1S2026***<br>
> **6º Semestre de DSM**<br>
> **Instituição:** FATEC Jahu / Centro Paula Souza<br>
> **Curso:** Desenvolvimento de Software Multiplataforma<br>
> **Alunos:** Clique em cada nome para acessar o perfil no Github de cada um.<br>
> **[Américo Godoy](https://github.com/AmericoGodoyG)** <br>
> **[Cássia Helena Voltolin](https://github.com/CassiaVoltolin)** <br>
> **[Gabriel Defende](https://github.com/gabrieldefende)** <br>
> **[Pedro Vasconcellos](https://github.com/pedrobvasconcellos)** <br>
> **[Pedro Lucas dos Santos Hernandes](https://github.com/pedro-ls-hernandes)** <br>

# Flowly

---

Sistema web e mobile de gerenciamento de tarefas, equipes e colaboração em tempo real.
O projeto é uma evolução direta de seu modelo anterior, que pode ser encontrado [aqui](https://github.com/FATEC-Mobile-Group/Flowly)

---

## Sobre o Projeto

O **Flowly** é uma plataforma full stack desenvolvida para gerenciamento de tarefas, equipes e produtividade, oferecendo colaboração em tempo real entre administradores e usuários.

A aplicação é composta por:

* Backend em Node.js + Express
* Frontend Web em React
* Aplicativo Mobile em Flutter
* Banco de dados MongoDB
* Comunicação em tempo real com Socket.IO
* Infraestrutura com Docker, Cloud Run, Azure Static Web Apps, Kubernetes e Docker Hub
* Módulo auxiliar em Python para assistente, voz, analytics e comandos
* Microserviço Python para reconhecimento facial

---

# Arquitetura do Projeto

```text
flowly-2.0/
│
├── flowly_api/         # API REST Node.js + Express
├── flowly_frontend/    # Frontend Web React
├── flowly_mobal/       # Aplicativo Flutter
├── flowly_assistente/  # Assistente e mineração de dados em Python
├── flowly_iot_face/    # Microserviço Python de reconhecimento facial
│
├── flowly_api/k8s/     # Manifests Kubernetes da API e MongoDB
└── flowly_frontend/k8s/# Manifest Kubernetes do frontend

```
<img width="1304" height="586" alt="arquitetura" src="https://github.com/user-attachments/assets/af18d19d-bb61-4780-91c2-bbf94df10381" />

---

# Stack Tecnológica

## Backend

<details>
<summary><strong>Backend API - Node.js, dados, autenticacao e tempo real</strong></summary>

| Tecnologia | Uso no projeto | Justificativa |
| ---------- | -------------- | ------------- |
| Node.js | Runtime da `flowly_api` | Mantem a API REST e o Socket.IO em uma pilha JavaScript simples para o time web. |
| Express | Servidor HTTP e roteamento | Framework direto para organizar controllers, middlewares e rotas REST. |
| MongoDB | Banco principal | Modelo documental combina bem com usuarios, equipes, tarefas, mensagens e notificacoes. |
| Mongoose | ODM da API | Define schemas, relacionamentos e validacoes para as colecoes MongoDB. |
| Socket.IO | Chat e atualizacoes em tempo real | Simplifica comunicacao bidirecional para mensagens e eventos de equipe. |
| JSON Web Token | Autenticacao stateless | Permite proteger rotas web/mobile sem sessao server-side centralizada. |
| Argon2 | Hash de senhas | Algoritmo moderno para armazenamento seguro de credenciais. |
| Multer | Upload de arquivos | Middleware usado para receber anexos e fotos antes de validar e persistir. |
| Google Cloud Storage | Armazenamento de uploads | Separa arquivos do container e permite persistencia em ambiente cloud. |
| Google Vision API | Moderacao de imagens | Analisa uploads de imagem antes do armazenamento para reduzir risco de conteudo impróprio. |
| Nodemailer | Envio de e-mails | Suporta verificacao de conta/2FA por codigo enviado ao usuario. |
| CORS/dotenv | Configuracao operacional | Controla origens permitidas e variaveis sensiveis por ambiente. |
| Jest/Supertest | Testes de API | Valida endpoints e regras de autenticacao sem depender de fluxo manual. |

</details>

## Frontend Web

<details>
<summary><strong>Frontend Web - React, experiencia do usuario e dashboards</strong></summary>

| Tecnologia | Uso no projeto | Justificativa |
| ---------- | -------------- | ------------- |
| React | Interface web em `flowly_frontend` | Componentizacao para telas de login, dashboards, tarefas, equipes, chat e perfil. |
| React Scripts | Build e ambiente CRA | Mantem scripts de desenvolvimento, teste e build ja adotados no projeto. |
| React Router DOM | Navegacao | Organiza rotas publicas, protegidas, admin e usuario. |
| Axios | Cliente HTTP | Centraliza chamadas REST para a API Node. |
| Socket.IO Client | Tempo real no navegador | Integra o chat e eventos em tempo real com a API. |
| Chart.js/react-chartjs-2 e Recharts | Graficos e dashboards | Bibliotecas usadas para visualizacao de metricas e produtividade. |
| jsPDF | Geracao de PDF | Exporta informacoes de tarefas/relatorios quando necessario. |
| @hello-pangea/dnd | Drag and drop | Base do Kanban e movimentacao de tarefas. |
| React Icons | Iconografia | Padroniza icones em botoes, menus e telas. |
| React Toastify | Feedback ao usuario | Exibe notificacoes visuais para acoes e erros. |
| Three.js/OGL | Efeitos visuais | Apoia componentes visuais e fundos interativos da interface. |
| Cypress/Testing Library | Testes web | Cobre fluxos E2E e testes de componentes. |

</details>

## Mobile

<details>
<summary><strong>Mobile - Flutter multiplataforma</strong></summary>

| Tecnologia | Uso no projeto | Justificativa |
| ---------- | -------------- | ------------- |
| Flutter | Aplicativo em `flowly_mobal` | Permite entregar app multiplataforma com uma unica base de codigo. |
| Dart | Linguagem do app | Linguagem nativa do Flutter, com tipagem e boa produtividade. |
| go_router | Navegacao | Define rotas e redirecionamentos de forma declarativa. |
| Dio | Cliente HTTP | Consome a API REST com suporte a interceptors e tratamento de erros. |
| flutter_secure_storage | Armazenamento seguro | Guarda tokens e dados sensiveis no dispositivo. |
| socket_io_client | Tempo real mobile | Integra chats e eventos ao mesmo canal da web. |
| google_fonts | Tipografia | Mantem identidade visual consistente. |
| pdf/printing | Geracao e impressao | Suporta exportacao de documentos no mobile. |
| image_picker/file_picker | Imagens e anexos | Permite foto de perfil, captura facial e upload de arquivos. |
| flutter_dotenv | Configuracao | Carrega URLs e variaveis por ambiente. |
| flutter_lints/flutter_test | Qualidade | Apoia padronizacao e testes do app. |

</details>

## Assistente

<details>
<summary><strong>Assistente - Python, voz, analytics e comandos</strong></summary>

| Tecnologia | Uso no projeto | Justificativa |
| ---------- | -------------- | ------------- |
| Python | `flowly_assistente` | Adequado para automacao, NLP leve, voz e workers. |
| requests | Cliente HTTP | Comunica o assistente com a API Node. |
| SpeechRecognition | Speech-to-text | Captura comandos de voz em pt-BR quando o modo de voz e usado. |
| pyttsx3 | Text-to-speech local | Permite resposta falada sem depender de servico externo no modo local. |
| pymongo | Persistencia de analytics | Grava insights/eventos diretamente no MongoDB quando configurado. |
| Functions Framework | Runtime HTTP | Expoe o assistente como endpoint em Google Cloud Functions/Run. |
| Celery/Redis | Fila opcional | Suporta processamento assincromo de analytics quando ha worker separado. |
| python-dotenv | Configuracao local | Carrega variaveis do `.env` durante desenvolvimento. |

</details>

## Reconhecimento Facial

<details>
<summary><strong>IoT Face - reconhecimento facial e biometria</strong></summary>

| Tecnologia | Uso no projeto | Justificativa |
| ---------- | -------------- | ------------- |
| Flask | Microservico `flowly_iot_face` | Expoe endpoints `/health`, `/embed`, `/verify` e `/verify-multi`. |
| Flask-CORS | CORS do servico facial | Facilita testes e integracoes controladas em ambiente HTTP. |
| DeepFace | Extracao e verificacao facial | Biblioteca pronta para embeddings e comparacao facial. |
| TensorFlow/tf-keras | Backend de modelo | Necessario para carregar modelos usados pelo DeepFace. |
| OpenCV headless | Pre-processamento/deteccao | Detecta rosto sem dependencias de interface grafica no container. |
| NumPy | Calculo vetorial | Calcula distancia cosseno entre embeddings. |
| Gunicorn | Servidor de producao | Executa Flask de forma adequada em container/Cloud Run. |

</details>

## Infraestrutura

<details>
<summary><strong>Infraestrutura, deploy e operacao</strong></summary>

| Tecnologia | Uso no projeto | Justificativa |
| ---------- | -------------- | ------------- |
| Docker | Containers da API, frontend e servicos Python | Padroniza ambiente e facilita deploy. |
| Google Cloud Run | Deploy de API, assistente e face | Executa containers HTTP com escala sob demanda. |
| Google Cloud Storage | Uploads | Armazena anexos fora do ciclo de vida dos containers. |
| Azure Static Web Apps | Frontend web publicado | Hospeda build estatico React com HTTPS. |
| Kubernetes | Manifests em `k8s/` | Mantem alternativa/registro de deploy orquestrado para API, frontend e MongoDB. |
| Docker Hub | Publicacao de imagens | Suporta distribuicao das imagens geradas. |
| GitHub Actions | CI/CD documentado | Automatiza builds e publicacao quando configurado no repositorio remoto. |

</details>

---

# Objetivos

## Objetivo Geral

Desenvolver uma solução web e mobile para:

* Gerenciamento de tarefas
* Organização de equipes
* Acompanhamento de produtividade
* Comunicação em tempo real
* Controle de tempo
* Compartilhamento de arquivos
* Geração de métricas e dashboards

## Problemas Resolvidos

* Centralização de tarefas e equipes
* Comunicação integrada
* Controle de produtividade
* Gestão de prazos e prioridades
* Organização de subtarefas e anexos
* Monitoramento em tempo real

---

# Perfis de Usuário

## Administrador

Pode:

* Criar equipes
* Gerenciar tarefas
* Visualizar dashboards
* Acompanhar métricas
* Gerenciar usuários

## Usuário

Pode:

* Visualizar tarefas atribuídas
* Atualizar status
* Registrar tempo gasto
* Participar de chats
* Adicionar comentários
* Manipular subtarefas
* Realizar upload de anexos

---

# Funcionalidades Principais

## Autenticação

* Cadastro de usuários
* Login com JWT
* Verificação de e-mail por código 2FA
* Redirecionamento automático para a dashboard após validação do cadastro
* Recuperação de senha por código enviado por e-mail
* Criptografia de senhas com Argon2
* Controle de acesso por roles
* Logout
* Proteção de rotas

## Equipes

* CRUD de equipes
* Associação de membros
* Visualização de participantes
* Código identificador de equipe
* Popup de confirmação antes de excluir equipes

## Tarefas

* CRUD completo
* Kanban com drag and drop
* Controle de urgência
* Filtros
* PDF de tarefas
* Modal de detalhes
* Popup de confirmação antes de excluir tarefas

## Cronômetro

* Iniciar/Pausar
* Controle de tempo gasto
* Tempo excedido
* Atualização em tempo real
* Pausa automática ao mover tarefa ativa de volta para pendente ou concluir
* Indicador visual de cronômetro ativo removido imediatamente ao pausar

## Subtarefas

* Adição
* Marcação/desmarcação
* Organização por abas

## Comentários

* Registro de comentários
* Histórico por tarefa
* Autor e timestamp

## Uploads

* Upload de anexos
* Limite de 10MB
* Controle de MIME types
* Download de arquivos

## Chat em Tempo Real

* Comunicação por equipe
* Histórico persistente
* Socket.IO
* Controle de acesso
* Popup no canto superior direito para novas mensagens
* Popup de mensagem com remetente, foto de perfil, equipe e conteúdo

## Dashboards

* Métricas gerais
* Ranking de equipes
* Indicadores por status
* Dashboard do usuário
* Painel de insights com abas Resumo, Equipes e Alertas
* Insights restritos às equipes das quais o administrador participa
* Alertas com nome do usuário e motivo traduzido/formatado

---

# API REST

## Principais Rotas

### Autenticação

```http
POST /api/auth/registrar
POST /api/auth/login
GET  /api/auth/users
POST /api/auth/2fa/enviar-codigo
POST /api/auth/2fa/validar-codigo
GET  /api/auth/2fa/validar-token
POST /api/auth/recuperar-senha/enviar-codigo
POST /api/auth/recuperar-senha/validar-codigo
POST /api/auth/recuperar-senha/redefinir
```

### Usuários

```http
GET /api/users
GET /api/users/me
PUT /api/users/me
PUT /api/users/me/password
```

### Equipes

```http
GET    /api/equipes
POST   /api/equipes
GET    /api/equipes/minhas
GET    /api/equipes/:id
PUT    /api/equipes/:id
DELETE /api/equipes/:id
GET    /api/equipes/:id/membros
GET    /api/equipes/:id/messages
```

### Tarefas

```http
GET    /api/tarefas
POST   /api/tarefas
PUT    /api/tarefas/:id
DELETE /api/tarefas/:id
GET    /api/tarefas/minhas
GET    /api/tarefas/backlog
GET    /api/tarefas/:id/detalhes
POST   /api/tarefas/:id/comentarios
POST   /api/tarefas/:id/subtarefas
PUT    /api/tarefas/:id/subtarefas/:subId
POST   /api/tarefas/:id/anexos
PUT    /api/tarefas/:id/status
PUT    /api/tarefas/:id/cronometro
```

### Notificações

```http
GET /api/notificacoes
GET /api/notificacoes/count
PUT /api/notificacoes/mark-all-read
PUT /api/notificacoes/:id/read
```

### Reconhecimento Facial

```http
GET  /api/face/health
POST /api/face/enroll
POST /api/face/verify
POST /api/face/skip-enrollment
GET  /api/face/status
POST /api/face/enroll-profile
```

### Admin e Storage

```http
GET  /api/admin/metricas
POST /api/admin/assistant-insights/ingest
GET  /api/admin/assistant-insights
GET  /api/storage/files/:encodedPath
```

---

# Arquitetura Cloud
```mermaid
flowchart TB
  %% Usuários
  WebUser[Usuário Web / Admin]
  MobileUser[Usuário Mobile Flutter]

  %% CI/CD
  subgraph CICD["CI/CD"]
    GitHub[GitHub Repository]
    GHActions[GitHub Actions]
    DockerHub[Docker Hub]
  end

  %% Azure
  subgraph Azure["Azure"]
    SWA[Azure Static Web Apps<br/>React build estático]
  end

  %% Google Cloud
  subgraph GCP["Google Cloud Platform - southamerica-east1"]
    CloudRunAPI[Cloud Run<br/>flowly-api-backend<br/>Node.js + Express + Socket.IO]
    CloudRunAssistant[Cloud Run / Functions Framework<br/>flowly-assistente-voz<br/>Python Assistant]
    CloudRunFace[Cloud Run<br/>flowly_iot_face<br/>Flask + DeepFace]
    GCS[Google Cloud Storage<br/>Uploads e anexos]
    Vision[Google Vision API<br/>Moderação de imagens]
  end

  %% Banco externo
  subgraph Data["Camada de Dados"]
    MongoAtlas[MongoDB Atlas<br/>Banco Flowly]
  end

  %% Email externo
  SMTP[SMTP Provider<br/>E-mails 2FA / recuperação]

  %% Kubernetes alternativo
  subgraph K8S["Alternativa Kubernetes versionada em /k8s"]
    FrontDeploy[frontend-deployment<br/>1 réplica]
    FrontSvc[frontend-service<br/>NodePort :80]
    ApiDeploy[api-deployment<br/>2 réplicas]
    ApiSvc[api-service<br/>ClusterIP :5000]
    MongoDeploy[mongodb deployment<br/>1 réplica mongo:5]
    MongoSvc[mongodb-service<br/>:27017]
  end

  %% Fluxo de deploy
  GitHub --> GHActions
  GHActions -->|Build React + deploy| SWA
  GHActions -. imagens Docker documentadas .-> DockerHub
  DockerHub -. imagens .-> CloudRunAPI
  DockerHub -. imagens .-> CloudRunAssistant
  DockerHub -. imagens .-> CloudRunFace
  DockerHub -. imagens .-> FrontDeploy
  DockerHub -. imagens .-> ApiDeploy

  %% Acesso dos clientes
  WebUser -->|HTTPS| SWA
  MobileUser -->|HTTPS REST| CloudRunAPI
  MobileUser -->|WebSocket Socket.IO| CloudRunAPI

  %% Frontend
  SWA -->|REST /api| CloudRunAPI
  SWA -->|Socket.IO| CloudRunAPI
  SWA -->|Assistente HTTP| CloudRunAssistant

  %% Backend principal
  CloudRunAPI -->|Mongoose / MONGO_URI| MongoAtlas
  CloudRunAPI -->|Signed URLs / Storage SDK| GCS
  CloudRunAPI -->|Safe Search / labels / OCR| Vision
  CloudRunAPI -->|FACE_SERVICE_URL<br/>/health /embed /verify /verify-multi| CloudRunFace
  CloudRunAPI -->|UPLOAD_MODERATION_URL opcional| CloudRunAssistant
  CloudRunAPI -->|Nodemailer| SMTP

  %% Assistente
  CloudRunAssistant -->|FLOWLY_API_BASE_URL| CloudRunAPI
  CloudRunAssistant -->|Analytics / insights| MongoAtlas

  %% Face
  CloudRunFace -->|Processamento facial<br/>DeepFace + TensorFlow| CloudRunFace

  %% Kubernetes interno
  FrontSvc --> FrontDeploy
  FrontDeploy --> ApiSvc
  ApiSvc --> ApiDeploy
  ApiDeploy --> MongoSvc
  MongoSvc --> MongoDeploy
```


---

# Banco de Dados

## Coleções Principais

| Coleção      | Finalidade               |
| ------------ | ------------------------ |
| User         | Usuários e autenticação  |
| Equipe       | Organização de equipes   |
| Tarefa       | Gerenciamento de tarefas |
| Message      | Chat em tempo real       |
| Comment      | Comentários              |
| Notification | Notificações             |
| ActivityLog  | Histórico de ações       |
| FaceProfile  | Embeddings faciais e status de cadastro biométrico |
| AssistantInsight | Eventos e insights do assistente |

---

# Testes

## Estratégia de Testes

### Testes previstos

* Testes funcionais
* Testes E2E
* Testes de integração
* Testes de API
* Testes de regressão
* Testes de usabilidade

## Ferramentas

* Cypress
* Jest
* React Testing Library
* GitHub Actions

## Fluxos testados

* Login
* Cadastro
* Verificação de e-mail/2FA com entrada direta na dashboard
* Recuperação de senha por e-mail
* Validação de formulários
* Alternância de senha
* Confirmação antes de exclusão de equipes e tarefas
* Atualização de status no Kanban após selecionar uma equipe diferente da padrão
* Pausa/remoção visual do cronômetro ao pausar ou alterar status da tarefa
* Navegação inicial

---

# Requisitos Não Funcionais

## Segurança

* JWT
* Argon2
* Controle de acesso
* Escopo de insights por equipes vinculadas ao administrador
* Códigos temporários para verificação de e-mail e recuperação de senha
* Variáveis de ambiente
* Restrição de uploads
* Configuração CORS

## Usabilidade

* Interface responsiva
* Feedback visual
* Kanban drag and drop
* Modais organizados
* Popups de confirmação para ações destrutivas
* Popups temporários para mensagens recebidas em tempo real

## Performance

* WebSocket
* Atualização otimista
* Polling eficiente

---

# Ética, Privacidade e LGPD

O Flowly trata dados pessoais e, em alguns fluxos, dados pessoais sensíveis. Por isso, o projeto adota os seguintes princípios de ética em desenvolvimento de software:

## Dados pessoais tratados

* Nome, e-mail, senha protegida por hash, tipo de usuário e foto de perfil
* Tarefas, subtarefas, comentários, anexos, equipes, mensagens e notificações
* Registros técnicos como data, horário, IP, tokens e eventos de uso
* Dados de voz convertidos em texto quando o assistente for utilizado
* Embeddings faciais quando o reconhecimento facial for habilitado

## Dados sensíveis e biometria

O reconhecimento facial gera embeddings a partir de imagens capturadas pelo usuário. Esse tipo de informação é sensível pela LGPD e deve ser usado apenas para autenticação, prevenção de fraude e segurança da conta. O frontend e o mobile não chamam o serviço facial diretamente; a API Node centraliza autenticação, autorização e auditoria.

## Consentimento e transparência

* O cadastro exige aceite dos Termos de Uso e Privacidade.
* O aceite é registrado com versão, data e IP no modelo de usuário.
* Funcionalidades de biometria e voz devem explicar a finalidade antes da coleta.
* O usuário deve conseguir entender quais dados são necessários para o funcionamento da plataforma.

## Minimização e finalidade

* Coletar apenas dados necessários para tarefas, equipes, comunicação, autenticação e segurança.
* Evitar armazenar imagem facial bruta quando o embedding for suficiente para verificação.
* Usar Google Vision API e moderação interna para reduzir risco de uploads impróprios ou maliciosos.
* Restringir anexos por tamanho, MIME type e política de segurança.

## Segurança e responsabilidade

* Senhas são armazenadas com Argon2.
* Tokens JWT protegem rotas autenticadas.
* Secrets devem ficar em variáveis de ambiente ou Secret Manager.
* Buckets, MongoDB Atlas e serviços Cloud Run devem ter permissões mínimas necessárias.
* Logs não devem expor senhas, tokens, embeddings faciais ou dados sensíveis.

## Direitos do titular

Em conformidade com a LGPD, o usuário deve poder solicitar confirmação de tratamento, acesso, correção, eliminação quando aplicável, informações sobre compartilhamento e revogação de consentimento para funcionalidades opcionais.

---

# Casos de uso
> O diagrama abaixo resume as interações principais dos perfis Administrador e Usuário com o 
sistema. O Administrador atua sobre equipes, tarefas e dashboards; o Usuário acompanha suas 
tarefas, atualiza status, controla tempo e colabora por chat.
<p align="center">
   <img width="620" height="887" alt="casl" src="https://github.com/user-attachments/assets/70bdbd9a-0cca-479a-b92c-037c41c487a6" />
</p>
---

# Fluxo
> O fluxo da aplicação inicia na autenticação. A partir do tipo de usuário armazenado no 
token/sessão, o sistema direciona o acesso para áreas de administrador ou usuário comum.
<p align="center">
 <img width="683" height="872" alt="fluxo" src="https://github.com/user-attachments/assets/9c8f201d-44dc-4559-9e16-fbf1aad1fe8c" />
</p>
---

# Design
> A interface do Flowly deve priorizar clareza visual, produtividade e organização de tarefas. O 
repositório web utiliza React com componentes para dashboards, tarefas, equipes, chat, 
notificações e perfil. O módulo mobile Flutter documenta uma identidade visual moderna, com 
Google Fonts/Poppins, cartões, botões customizados, telas de autenticação, equipes, tarefas e 
perfil. O design atual é uma evolução do último protótipo, focado apenas em mobile, além de possuir
novidades e melhorias visuais adequadas paras as plataformas que serão usadas pelo app. Você pode encontrar
nosso design Figma e ver a evolução [aqui](https://www.figma.com/design/bAzWl5WbbMZV22b4faw7uH/Flowly?node-id=0-1&t=78oIDFaUWRSZeyul-1).

## Telas do protótipo da aplicação
<table>
  <tr>
    <td align="center">
      <img width="1920" height="956" alt="login" src="https://github.com/user-attachments/assets/47b0d0f2-4427-4899-8922-583be9fa69c9" />
      <strong>Login</strong>
    </td>
    <td align="center">
      <img width="1920" height="961" alt="cadastro" src="https://github.com/user-attachments/assets/17575934-ee96-4ab9-b16c-0fcfda38c1f6" />
      <strong>Cadastro</strong>
    </td>
  </tr>

  <tr>
    <td align="center">
      <img width="1920" height="953" alt="verificacao" src="https://github.com/user-attachments/assets/10a58afc-2cd9-40ce-8b74-8060af72f7dd" />
      <strong>Verificação de Usuário</strong>
    </td>
    <td align="center">
      <img width="1920" height="948" alt="tarefas_user" src="https://github.com/user-attachments/assets/b3661ab2-daec-484e-8a80-9d17760c9fa0" />
      <strong>Tarefas de Usuários</strong>
    </td>
  </tr>

  <tr>
    <td align="center">
      <img width="1920" height="950" alt="kanban_user" src="https://github.com/user-attachments/assets/20a0cc0b-fdef-48b4-94dd-260609cb64ed" />
      <strong>Kanban Usuário</strong>
    </td>
    <td align="center">
      <img width="1920" height="957" alt="backlog_user" src="https://github.com/user-attachments/assets/ed352d25-ec3f-43dc-97df-4b18f04fc101" />
      <strong>Backlog do Usuário</strong>
    </td>
  </tr>

  <tr>
    <td align="center">
      <img width="1920" height="956" alt="chats" src="https://github.com/user-attachments/assets/eaddde9c-71c6-4273-bb8e-4af279a880f5" />
      <strong>Chats</strong>
    </td>
    <td align="center">
      <img width="1920" height="951" alt="notificacoes" src="https://github.com/user-attachments/assets/97ac4086-95cf-4fe8-bfe1-3aeda42dd4a1" />
      <strong>Notificações</strong>
    </td>
  </tr>

  <tr>
    <td align="center">
      <img width="1920" height="959" alt="equipes_user" src="https://github.com/user-attachments/assets/a4e21202-2b16-4ec3-909b-3cb507128d55" />
      <strong>Equipes</strong>
    </td>
    <td align="center">
      <img width="1920" height="953" alt="perfil" src="https://github.com/user-attachments/assets/f5f7e751-124c-436a-96e8-f99ae8209dd6" />
      <strong>Perfil</strong>
    </td>
  </tr>

  <tr>
    <td align="center">
      <img width="1903" height="958" alt="dashboard_adm" src="https://github.com/user-attachments/assets/75daecb4-ce31-4c73-8eda-ea7e122d0d79" />
      <strong>Dashboard ADM</strong>
    </td>
    <td align="center">
      <img width="1920" height="940" alt="crar_equipe" src="https://github.com/user-attachments/assets/3f95afcd-05c4-4aca-9974-943f5375fd5f" />
      <strong>Criar Equipe</strong>
    </td>
  </tr>

  <tr>
    <td align="center">
      <img width="1920" height="949" alt="criar_tarefa" src="https://github.com/user-attachments/assets/60ce2020-a8d7-4de7-b713-57d75d5b3977" />
      <strong>Criar Tarefa</strong>
    </td>
  </tr>
</table>

---

# Infraestrutura

## Docker

* Containerização da API
* Containerização do Frontend
* Publicação no Docker Hub

## Kubernetes

* Deploy da API
* Deploy do Frontend
* Deploy do MongoDB
* Comunicação entre serviços

## CI/CD

* Build automatizado
* Push de imagens
* GitHub Actions

---

# Execução Local

## Pré-requisitos

* Node.js
* MongoDB
* Docker (opcional)
* Flutter SDK
* Python

## Backend

```bash
cd flowly_api
npm install
cp .env.example .env
npm run dev
```

## Frontend

```bash
cd flowly_frontend
npm install
cp .env.example .env
npm start
```

## Mobile

```bash
cd flowly_mobal
flutter pub get
flutter run
```

## Assistente

```bash
cd flowly_assistente
pip install -r requirements.txt
cp .env.example .env
python main.py --cli

```

---

# Variáveis de Ambiente

Os exemplos abaixo representam a configuração recomendada para nuvem. Valores sensíveis devem ser armazenados como secrets do provedor, e não versionados no repositório.

### Backend API (`flowly_api`)

```env
# Runtime
PORT_ENV=8080
NODE_ENV=production
BODY_SIZE_LIMIT=20mb

# Frontend e CORS
CORS_ORIGIN=https://SEU_FRONTEND_AZURE_STATIC_WEB_APPS
FRONTEND_URL=https://SEU_FRONTEND_AZURE_STATIC_WEB_APPS

# MongoDB Atlas
MONGO_URI=mongodb+srv://USER:PASSWORD@CLUSTER/Flowly?retryWrites=true&w=majority

# Autenticação
JWT_SECRET=GERAR_UM_SEGREDO_LONGO_COM_32_BYTES_OU_MAIS
JWT_EXPIRES_IN=7d

# Reconhecimento facial: API Node chama o serviço Python
FACE_SERVICE_URL=https://SEU_FLOWLY_FACE_IOT_CLOUD_RUN
FACE_MATCH_THRESHOLD=0.46
FACE_VERIFY_THRESHOLD=0.50
FACE_DUPLICATE_THRESHOLD=0.46
FACE_SESSION_EXPIRES_IN=5m
FACE_ENROLL_SESSION_EXPIRES_IN=10m

# Google Cloud Storage e Vision API
GCP_PROJECT_ID=SEU_GCP_PROJECT_ID
GCP_BUCKET_NAME=SEU_BUCKET_GCS
UPLOAD_IMAGE_MODERATION_PROVIDER=google_vision
UPLOAD_IMAGE_MODERATION_REQUIRED=true
UPLOAD_MODERATION_MAX_BYTES=10485760

# Moderação complementar por endpoint interno do assistente
UPLOAD_MODERATION_URL=https://SEU_ASSISTENTE_CLOUD_RUN/api/v1/uploads/moderate
UPLOAD_MODERATION_SECRET=GERAR_UM_SEGREDO_LONGO_IGUAL_NO_ASSISTENTE
UPLOAD_MODERATION_REQUIRED=false

# Analytics interno do assistente via HTTP, se usado
ASSISTANT_ANALYTICS_SECRET=GERAR_UM_SEGREDO_LONGO_SE_USAR_INGEST_HTTP

# SMTP
HOST=smtp.example.com
EMAIL_PORT=587
SECURE=false
AUTH_EMAIL=no-reply@example.com
AUTH_PASSWORD=SENHA_DO_SMTP
SERVICE=example
```

> No Cloud Run, a API precisa escutar a porta `8080`. Como o projeto lê `PORT_ENV`, configure `PORT_ENV=8080`.

### Frontend Web (`flowly_frontend`)

```env
# Variáveis de build do React
REACT_APP_API_URL=https://SEU_BACKEND_CLOUD_RUN/api
REACT_APP_API_PUBLIC_URL=https://SEU_BACKEND_CLOUD_RUN
REACT_APP_SOCKET_URL=https://SEU_BACKEND_CLOUD_RUN
REACT_APP_ASSISTANT_URL=https://SEU_ASSISTENTE_CLOUD_RUN
```

> `REACT_APP_*` é embutido no build. Alterar essas variáveis exige novo build/deploy do frontend.

### Assistente (`flowly_assistente`)

```env
# API principal
FLOWLY_API_BASE_URL=https://SEU_BACKEND_CLOUD_RUN/api
FLOWLY_API_TIMEOUT_SEC=20
FLOWLY_MATCH_THRESHOLD=78
FLOWLY_CORS_ORIGIN=https://SEU_FRONTEND_AZURE_STATIC_WEB_APPS

# Em cloud, o token do usuário chega por Authorization: Bearer <token>
FLOWLY_API_TOKEN=
FLOWLY_USER_TYPE=

# Analytics
FLOWLY_ANALYTICS_STORAGE=mongodb
FLOWLY_MONGO_URI=mongodb+srv://USER:PASSWORD@CLUSTER/Flowly?retryWrites=true&w=majority
FLOWLY_MONGO_DB=Flowly
FLOWLY_ANALYTICS_COLLECTION=assistantinsights

# Fila local no próprio container
FLOWLY_ANALYTICS_QUEUE_MODE=local
FLOWLY_LOCAL_WORKER_THREADS=2
FLOWLY_CONVERSATION_STORE=/tmp/flowly_conversation_state.json
FLOWLY_CONVERSATION_TTL_SEC=900

# Contrato de voz/TTS para navegador e modo local
FLOWLY_LANGUAGE=pt-BR
FLOWLY_TTS_ENABLED=true

# Segredo usado pela API Node ao chamar /api/v1/uploads/moderate
UPLOAD_MODERATION_SECRET=GERAR_UM_SEGREDO_LONGO_IGUAL_NA_API

# Debug
FLOWLY_DEBUG=false
```

### IoT Face (`flowly_iot_face`)

```env
FACE_MODEL=VGG-Face
FACE_DETECTOR=opencv
FACE_MATCH_THRESHOLD=0.46
FACE_VERIFY_THRESHOLD=0.50
```

> Em Cloud Run, não configure `HOST` nem `PORT` para o serviço facial. O container já usa a porta injetada pela plataforma.

---

# Funcionalidades Futuras

* Notificações push
* Planos Free/Pro/Enterprise
* Personalização de perfil
* Modo offline
* Analytics avançado
* Busca global
* Internacionalização
* Refresh tokens
* Integrações externas

---

# Analytics, Assistente e Mineração de Dados

O módulo `flowly_assistente` concentra o assistente HTTP/CLI, comandos por texto/voz e geração de insights operacionais:

* Processamento de comandos do assistente
* Consulta à API principal com JWT do usuário
* Coleta de eventos e indicadores do uso do assistente
* Persistência de analytics em MongoDB ou arquivo local
* Fila opcional para processamento assíncrono com Celery/Redis

## Tecnologias utilizadas

* Python
* requests
* SpeechRecognition
* pyttsx3
* pymongo
* Functions Framework
* Celery
* Redis

> Observação: Pandas e Matplotlib foram removidos desta seção porque não aparecem nos `requirements.txt` atuais do projeto.

---

# Qualidade de Software

## Atributos de Qualidade

* Confiabilidade
* Segurança
* Desempenho
* Usabilidade
* Manutenibilidade

## Boas práticas adotadas

* Git Flow simplificado
* Revisão de código
* Commits organizados
* Separação de responsabilidades
* Componentização
* Versionamento com GitHub

---

# Usuários Mockados para teste até 12/06/2026
## [Acesse o Flowly aqui para testes](https://nice-beach-076f39a0f.7.azurestaticapps.net)
### ADM

```env
LOGIN=chucklesadm@bwmyga.com
SENHA=A1234567a.
```

### USER

```env
LOGIN=freddiem@bltiwd.com
SENHA=A1234567a.
```

---

# Instituição

**FATEC Jahu**
Curso de Desenvolvimento de Software Multiplataforma

---

# Referências

<details>
<summary><strong>Backend, banco de dados e seguranca</strong></summary>

- ARGON2. Argon2 Password Hashing Algorithm Documentation. Disponível em: https://argon2-cffi.readthedocs.io/.<br>
- EXPRESS. Express.js Documentation. Disponível em: https://expressjs.com/.<br>
- GOOGLE. Google Cloud Storage Documentation. Disponível em: https://cloud.google.com/storage/docs. <br>
- GOOGLE. Cloud Vision API Documentation. Disponível em: https://cloud.google.com/vision/docs.<br>
- JEST. Jest Documentation. Disponível em: https://jestjs.io/docs/getting-started.<br>
- JSON WEB TOKEN. JWT Introduction and Documentation. Disponível em: https://jwt.io/introduction. <br>
- MONGODB. MongoDB Documentation. Disponível em: https://www.mongodb.com/docs/.<br>
- MONGOOSE. Mongoose ODM Documentation. Disponível em: https://mongoosejs.com/docs/. <br>
- MULTER. Multer Documentation. Disponível em: https://github.com/expressjs/multer. <br>
- NODE.JS. Node.js Documentation. Disponível em: https://nodejs.org/en/docs. <br>
- NODEMAILER. Nodemailer Documentation. Disponível em: https://nodemailer.com/about/.<br>
- SOCKET.IO. Socket.IO Documentation. Disponível em: https://socket.io/docs/v4/. <br>
- SUPERTEST. Supertest Documentation. Disponível em: https://github.com/ladjs/supertest.<br>

</details>

<details>
<summary><strong>Frontend web</strong></summary>

- AXIOS. Axios HTTP Client Documentation. Disponível em: https://axios-http.com/docs/intro.<br>
- CHART.JS. Chart.js Documentation. Disponível em: https://www.chartjs.org/docs/latest/. <br>
- CYPRESS. Cypress Documentation. Disponível em: https://docs.cypress.io/. <br>
- HELLO PANGEA DND. @hello-pangea/dnd Documentation. Disponível em: https://github.com/hello-pangea/dnd.<br>
- JSPDF. jsPDF Documentation. Disponível em: https://github.com/parallax/jsPDF.<br>
- OGL. OGL Documentation. Disponível em: https://github.com/oframe/ogl.<br>
- REACT. React Documentation. Disponível em: https://react.dev/.<br>
- REACT ICONS. React Icons Documentation. Disponível em: https://react-icons.github.io/react-icons/.<br>
- REACT ROUTER. React Router Documentation. Disponível em: https://reactrouter.com/. <br>
- REACT TOASTIFY. React Toastify Documentation. Disponível em: https://fkhadra.github.io/react-toastify/.<br>
- RECHARTS. Recharts Documentation. Disponível em: https://recharts.org/en-US/. <br>
- TESTING LIBRARY. React Testing Library Documentation. Disponível em: https://testing-library.com/docs/react-testing-library/intro/.<br>
- THREE.JS. Three.js Documentation. Disponível em: https://threejs.org/docs/.<br>

</details>

<details>
<summary><strong>Mobile Flutter</strong></summary>

- DART. Dart Language Documentation. Disponível em: https://dart.dev/guides. <br>
- DIO. Dio Package Documentation. Disponível em: https://pub.dev/packages/dio.<br>
- FILE PICKER. file_picker Package Documentation. Disponível em: https://pub.dev/packages/file_picker.<br>
- FLUTTER. Flutter Documentation. Disponível em: https://docs.flutter.dev/. <br>
- FLUTTER DOTENV. flutter_dotenv Package Documentation. Disponível em: https://pub.dev/packages/flutter_dotenv.<br>
- FLUTTER SECURE STORAGE. flutter_secure_storage Package Documentation. Disponível em: https://pub.dev/packages/flutter_secure_storage.<br>
- GO ROUTER. go_router Package Documentation. Disponível em: https://pub.dev/packages/go_router.<br>
- GOOGLE FONTS. Google Fonts Documentation. Disponível em: https://fonts.google.com/. <br>
- IMAGE PICKER. image_picker Package Documentation. Disponível em: https://pub.dev/packages/image_picker.<br>
- PDF. pdf Package Documentation. Disponível em: https://pub.dev/packages/pdf.<br>
- PRINTING. printing Package Documentation. Disponível em: https://pub.dev/packages/printing.<br>
- SOCKET.IO CLIENT DART. socket_io_client Package Documentation. Disponível em: https://pub.dev/packages/socket_io_client.<br>

</details>

<details>
<summary><strong>Python, assistente e reconhecimento facial</strong></summary>

- CELERY. Celery Documentation. Disponível em: https://docs.celeryq.dev/.<br>
- DEEPFACE. DeepFace Documentation. Disponível em: https://github.com/serengil/deepface.<br>
- FLASK. Flask Documentation. Disponível em: https://flask.palletsprojects.com/.<br>
- FUNCTIONS FRAMEWORK. Google Functions Framework for Python. Disponível em: https://github.com/GoogleCloudPlatform/functions-framework-python.<br>
- GUNICORN. Gunicorn Documentation. Disponível em: https://docs.gunicorn.org/.<br>
- NUMPY. NumPy Documentation. Disponível em: https://numpy.org/doc/.<br>
- OPENCV. OpenCV Documentation. Disponível em: https://docs.opencv.org/.<br>
- PYTHON SOFTWARE FOUNDATION. Python Documentation. Disponível em: https://docs.python.org/3/.<br>
- PYTTSX3. pyttsx3 Documentation. Disponível em: https://pyttsx3.readthedocs.io/.<br>
- REDIS. Redis Documentation. Disponível em: https://redis.io/docs/latest/.<br>
- REQUESTS. Requests Documentation. Disponível em: https://requests.readthedocs.io/.<br>
- SPEECHRECOGNITION. SpeechRecognition Documentation. Disponível em: https://pypi.org/project/SpeechRecognition/.<br>
- TENSORFLOW. TensorFlow Documentation. Disponível em: https://www.tensorflow.org/.<br>

</details>

<details>
<summary><strong>Infraestrutura, qualidade e repositorios</strong></summary>

- AZURE. Azure Static Web Apps Documentation. Disponível em: https://learn.microsoft.com/azure/static-web-apps/.<br>
- DOCKER. Docker Documentation. Disponível em: https://docs.docker.com/.<br>
- GITHUB. GitHub Actions Documentation. Disponível em: https://docs.github.com/actions. <br>
- GOOGLE. Cloud Run Documentation. Disponível em: https://cloud.google.com/run/docs.<br>
- ISO25000. ISO/IEC 25010 – Systems and software Quality Requirements and Evaluation (SQuaRE). Disponível em: https://iso25000.com/index.php/en/iso-25000-standards/iso-25010.<br>
- KUBERNETES. Kubernetes Documentation. Disponível em: https://kubernetes.io/docs/home/. <br>
- FATEC-MOBILE-GROUP. flowly-2.0. Repositório GitHub. Disponível em: https://github.com/FATEC-Mobile-Group/flowly-2.0.<br>
- FATEC-MOBILE-GROUP. Flowly. Repositório GitHub. Disponível em: https://github.com/FATEC-Mobile-Group/Flowly.<br>

</details>

---

# 📄 Licença

Este projeto foi desenvolvido para fins acadêmicos no Projeto Integrador da FATEC Jahu.
