# 🔬 Data Mining Module - README

## Visão Geral

O **Data Mining Module** é um conjunto de componentes Python modulares e production-ready para análise avançada de mensagens em sistemas de assistentes de IA.

### 🎯 Capacidades Principais

1. **Detecção de Mensagens Ofensivas** 🚨
   - Detecta conteúdo tóxico, abusivo e discriminatório
   - Classifica por severidade e categoria
   - Score de confiança automático
   - Suporte a múltiplos idiomas

2. **Análise de Perguntas Recorrentes** 🔄
   - Agrupa perguntas similares semanticamente
   - Identifica tópicos principais
   - Extrai palavras-chave automaticamente
   - Ranking por frequência

3. **Análise de Discussões em Tarefas** 📋
   - Detecta bloqueios e dependências
   - Identifica tarefas em risco
   - Encontra perguntas não resolvidas
   - Analisa volume de atividade

---

## 📦 Instalação Rápida

### 1. Clone/Baixe o Módulo
```bash
# O módulo está em: flowly_assistente/data_mining/
cd flowly_assistente
```

### 2. Instale Dependências
```bash
pip install -r data_mining_requirements.txt
```

### 3. Teste a Instalação
```bash
python -c "from data_mining import OffensiveMessageDetector; print('✓ Instalado!')"
```

---

## 🚀 Uso Rápido

### Detecção de Mensagens Ofensivas

```python
from data_mining import OffensiveMessageDetector

# Inicializar
detector = OffensiveMessageDetector(language="pt")

# Analisar uma mensagem
result = detector.analyze("Você é um idiota!")

# Acessar resultados
print(f"Ofensivo: {result.is_offensive}")
print(f"Score: {result.toxicity_score:.2%}")
print(f"Severidade: {result.severity.value}")
print(f"Termos: {result.offensive_terms}")

# Analisar múltiplas mensagens
messages = ["Olá!", "Você é tóxico!", "Tudo bem?"]
results = detector.batch_analyze(messages)

# Obter estatísticas
stats = detector.get_statistics(results)
print(f"Mensagens ofensivas: {stats['offensive_messages']}")
```

### Análise de Perguntas Recorrentes

```python
from data_mining import RecurringQuestionAnalyzer

# Inicializar
analyzer = RecurringQuestionAnalyzer(language="pt")

# Analisar
messages = [
    "Como faço para criar um usuário?",
    "Como posso adicionar um usuário?",
    "Qual é o processo para criar usuário?",
]

result = analyzer.analyze(messages)

# Acessar resultados
print(f"Perguntas recorrentes: {len(result.recurring_questions)}")

for q in result.recurring_questions:
    print(f"- {q.question} (frequência: {q.frequency})")
    print(f"  Palavras-chave: {', '.join(q.keywords)}")

# Encontrar similares
query = "Como registro um novo usuário?"
similar = analyzer.find_similar_questions(query, messages, top_k=3)
for msg, score in similar:
    print(f"{score:.2%} - {msg}")
```

### Análise de Discussões em Tarefas

```python
from data_mining import TaskDiscussionAnalyzer

# Inicializar
analyzer = TaskDiscussionAnalyzer(language="pt")

# Preparar dados
tasks = [
    {
        "task_id": "TASK-001",
        "title": "Implementar autenticação",
        "messages": [
            "Começamos?",
            "Sim, mas estou bloqueado esperando as chaves API",
            "Isso é crítico!",
        ],
        "users": ["alice", "bob"],
    }
]

# Analisar
result = analyzer.analyze(tasks)

# Acessar resultados
print(f"Bloqueios identificados: {len(result.identified_blockers)}")

for blocker in result.identified_blockers:
    print(f"- {blocker.task_id}: {blocker.blocker_type}")
    print(f"  Descrição: {blocker.description}")
    print(f"  Confiança: {blocker.confidence:.2%}")

# Tarefas em risco
for task in result.risk_tasks:
    print(f"- {task['task_id']}: Risk Score = {task['risk_score']:.2%}")
```

---

## 📊 Estrutura de Arquivos

```
flowly_assistente/
├── data_mining/
│   ├── __init__.py                 # Imports principais
│   ├── models.py                   # Dataclasses (500 linhas)
│   ├── offensive_detector.py       # Detector (450 linhas)
│   ├── recurring_questions.py      # Analisador (400 linhas)
│   ├── task_analysis.py            # Análise de tarefas (380 linhas)
│   └── utils.py                    # Utilitários (300 linhas)
├── examples/
│   └── mining_examples.py          # Exemplos completos (400 linhas)
├── data_mining_requirements.txt    # Dependências
└── README.md                       # Este arquivo
```

---

## 📚 Documentação Completa

Para documentação detalhada, leia:

1. **[DATA_MINING_GUIDE.md](../DATA_MINING_GUIDE.md)** - Guia completo
   - Instalação e configuração
   - Uso de cada componente
   - APIs e estruturas de dados
   - Integração REST
   - Treinamento de modelos

2. **[INDICE_MINERACAO_DADOS.md](../INDICE_MINERACAO_DADOS.md)** - Índice em Português
   - Referência rápida
   - Glossário
   - Troubleshooting
   - Atalhos

3. **[examples/mining_examples.py](examples/mining_examples.py)** - Exemplos Funcionais
   - 5 exemplos completos
   - Execução: `python examples/mining_examples.py`

---

## 🛠️ Utilitários Disponíveis

### TextPreprocessor
```python
from data_mining.utils import TextPreprocessor

normalized = TextPreprocessor.normalize("  OLÁLA  ")      # "olá"
clean = TextPreprocessor.clean("Visite https://...")     # Remove URLs
truncated = TextPreprocessor.truncate(text, 100)         # Limita tamanho
```

### Cache
```python
from data_mining.utils import Cache

cache = Cache(".cache")
cache.set("user:123", {"name": "João"})
user = cache.get("user:123", max_age_hours=24)
cache.clear()
```

### PerformanceMonitor
```python
from data_mining.utils import PerformanceMonitor

monitor = PerformanceMonitor()
monitor.start("operação")
# ... executar ...
elapsed = monitor.end("operação")
monitor.print_report()
```

### DataExporter
```python
from data_mining.utils import DataExporter

DataExporter.to_json(data, "output.json")
DataExporter.to_csv(data, "output.csv")
DataExporter.to_html_report("Título", sections, "report.html")
```

---

## 🎯 Exemplos de Caso de Uso

### Caso 1: Moderar Conteúdo em Tempo Real
```python
from data_mining import OffensiveMessageDetector

detector = OffensiveMessageDetector(language="pt")

def moderar_mensagem(mensagem):
    result = detector.analyze(mensagem)
    
    if result.severity.value == "HIGH":
        # Rejeitar
        return {"status": "rejected", "reason": "Conteúdo inadequado"}
    elif result.severity.value == "MEDIUM":
        # Avisar
        return {"status": "warning", "message": result.explanation}
    else:
        # Permitir
        return {"status": "approved"}
```

### Caso 2: FAQ Automático
```python
from data_mining import RecurringQuestionAnalyzer

analyzer = RecurringQuestionAnalyzer(language="pt")

def gerar_faq(todas_as_mensagens):
    result = analyzer.analyze(todas_as_mensagens)
    
    faq = []
    for question in result.recurring_questions:
        faq.append({
            "pergunta": question.question,
            "frequência": question.frequency,
            "categoria": question.category,
            "exemplos": question.examples,
        })
    
    return faq
```

### Caso 3: Detecção de Problemas em Projetos
```python
from data_mining import TaskDiscussionAnalyzer

analyzer = TaskDiscussionAnalyzer(language="pt")

def diagnosticar_projeto(tasks):
    result = analyzer.analyze(tasks)
    
    # Alertas automáticos
    alerts = []
    
    # Bloqueios críticos
    for blocker in result.identified_blockers:
        if blocker.confidence > 0.8:
            alerts.append({
                "tipo": "bloqueio",
                "tarefa": blocker.task_id,
                "descrição": blocker.description,
            })
    
    # Tarefas em risco
    for task in result.risk_tasks:
        if task["severity"] == "HIGH":
            alerts.append({
                "tipo": "risco",
                "tarefa": task["task_id"],
                "score": task["risk_score"],
            })
    
    return alerts
```

---

## ⚙️ Configuração Avançada

### Usar GPU (CUDA)
```python
detector = OffensiveMessageDetector(language="pt", device="cuda")
analyzer = RecurringQuestionAnalyzer(device="cuda")
```

### Usar Modelo Específico
```python
detector = OffensiveMessageDetector(
    embedding_model="bert-base-portuguese-cased"
)
```

### Ajustar Clustering
```python
analyzer = RecurringQuestionAnalyzer(
    min_cluster_size=5,          # Mínimo de similares
    similarity_threshold=0.80,   # Mais restritivo
)
```

---

## 📈 Performance e Escalabilidade

### Otimizações Recomendadas

```python
from data_mining.utils import BatchProcessor, PerformanceMonitor

# Monitorar performance
monitor = PerformanceMonitor()

# Processar em lotes
monitor.start("análise")
results = BatchProcessor.process_with_progress(
    large_message_list,
    lambda batch: detector.batch_analyze(batch),
    batch_size=32,
    show_progress=True,
)
elapsed = monitor.end("análise")
print(f"Tempo total: {elapsed:.2f}s")
```

### Limites Recomendados
- **Batch Size:** 32-64 itens
- **Tamanho de Mensagem:** até 512 tokens
- **Cache Duration:** 24 horas
- **GPU Memory:** 2-4 GB

---

## 🔌 Integração com APIs

### FastAPI
```python
from fastapi import FastAPI
from data_mining import OffensiveMessageDetector

app = FastAPI()
detector = OffensiveMessageDetector(language="pt")

@app.post("/analyze")
async def analyze(message: str):
    result = detector.analyze(message)
    return result.to_dict()
```

### Flask
```python
from flask import Flask, request, jsonify
from data_mining import TaskDiscussionAnalyzer

app = Flask(__name__)
analyzer = TaskDiscussionAnalyzer(language="pt")

@app.route("/analyze-tasks", methods=["POST"])
def analyze_tasks():
    tasks = request.json.get("tasks", [])
    result = analyzer.analyze(tasks)
    return jsonify(result.to_dict())
```

---

## 🐛 Troubleshooting

### Erro: ModuleNotFoundError
```bash
pip install -r data_mining_requirements.txt
```

### Erro: CUDA out of memory
```python
# Use CPU em vez de GPU
detector = OffensiveMessageDetector(device="cpu")
```

### Modelos demorando para carregar
```python
# Use cache para não re-baixar modelos
detector = OffensiveMessageDetector(cache_dir="./models")
```

---

## 📊 Exemplos de Saída

### Detecção de Ofensivas
```json
{
  "is_offensive": true,
  "toxicity_score": 0.85,
  "severity": "HIGH",
  "categories": ["INSULT", "HARASSMENT"],
  "offensive_terms": ["idiota"],
  "confidence": 0.92
}
```

### Perguntas Recorrentes
```json
{
  "total_messages_analyzed": 100,
  "recurring_questions": [
    {
      "question": "Como faço para criar usuário?",
      "frequency": 12,
      "similarity_score": 0.87,
      "keywords": ["criar", "usuário", "conta"]
    }
  ],
  "top_topics": ["autenticação", "usuário"]
}
```

### Análise de Tarefas
```json
{
  "high_activity_tasks": [
    {
      "task_id": "TASK-001",
      "message_count": 25,
      "blocker_indicators": 8
    }
  ],
  "identified_blockers": [
    {
      "task_id": "TASK-001",
      "blocker_type": "dependency",
      "confidence": 0.85
    }
  ]
}
```

---

## 📝 Próximos Passos

1. **Leia a documentação:** [DATA_MINING_GUIDE.md](../DATA_MINING_GUIDE.md)
2. **Execute os exemplos:** `python examples/mining_examples.py`
3. **Experimente:** Crie seu próprio script
4. **Integre:** Adicione à sua aplicação
5. **Otimize:** Ajuste parâmetros para seu caso

---

## 📚 Referências

- [Documentação Completa](../DATA_MINING_GUIDE.md)
- [Índice em Português](../INDICE_MINERACAO_DADOS.md)
- [Exemplos Funcionais](examples/mining_examples.py)
- [Hugging Face Transformers](https://huggingface.co/transformers/)
- [Sentence Transformers](https://www.sbert.net/)

---

## 📄 Licença

MIT License - Veja LICENSE.txt

---

**Versão:** 1.0
**Data:** Junho 2026
**Status:** ✅ Production-Ready

---

## 🤝 Suporte

Para dúvidas ou problemas:
1. Consulte [DATA_MINING_GUIDE.md](../DATA_MINING_GUIDE.md)
2. Verifique [INDICE_MINERACAO_DADOS.md](../INDICE_MINERACAO_DADOS.md)
3. Execute `python examples/mining_examples.py`
4. Revise o código-fonte (está bem documentado)

---

**Obrigado por usar Data Mining Module! 🎉**
