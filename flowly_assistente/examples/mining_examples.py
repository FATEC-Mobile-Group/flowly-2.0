"""
Comprehensive examples for the Data Mining Module.

Demonstrates usage of all three main components with sample data.
"""

import json
from datetime import datetime, timedelta

from data_mining import (
    OffensiveMessageDetector,
    RecurringQuestionAnalyzer,
    TaskDiscussionAnalyzer,
)
from data_mining.utils import (
    TextPreprocessor,
    DataExporter,
    PerformanceMonitor,
    Cache,
)


# ============================================================================
# EXAMPLE 1: Offensive Message Detection
# ============================================================================

def example_offensive_detection():
    """Example: Detect offensive messages in a communication channel."""
    print("\n" + "=" * 70)
    print("EXAMPLE 1: Offensive Message Detection")
    print("=" * 70)
    
    # Initialize detector
    detector = OffensiveMessageDetector(language="pt", device="cpu")
    
    # Sample messages
    messages = [
        "Olá! Como você está?",
        "Você é um idiota e um imbecil!",
        "Qual é o melhor jeito de fazer isso?",
        "Vou te matar, seu desgraçado!",
        "Você é muito chato, por favor vá embora",
        "Qual é a data do prazo?",
        "Pessoas como você não merecem respeito",
        "Tudo bem, vamos continuar com o trabalho",
    ]
    
    print(f"\nAnalisando {len(messages)} mensagens...")
    
    # Analyze each message
    results = []
    for message in messages:
        result = detector.analyze(message)
        results.append(result)
        
        # Print results
        print(f"\n{'─' * 70}")
        print(f"Mensagem: {message}")
        print(f"Ofensivo: {'SIM' if result.is_offensive else 'NÃO'}")
        print(f"Score de Toxicidade: {result.toxicity_score:.2%}")
        print(f"Severidade: {result.severity.value}")
        print(f"Categorias: {', '.join(c.value for c in result.categories)}")
        print(f"Confiança: {result.confidence:.2%}")
        if result.offensive_terms:
            print(f"Termos Detectados: {', '.join(result.offensive_terms)}")
    
    # Get statistics
    stats = detector.get_statistics(results)
    print(f"\n{'─' * 70}")
    print("ESTATÍSTICAS:")
    print(json.dumps(stats, indent=2, ensure_ascii=False))
    
    # Export results
    export_data = [r.to_dict() for r in results]
    DataExporter.to_json(export_data, "offensive_detection_results.json")
    print(f"\nResultados exportados para: offensive_detection_results.json")


# ============================================================================
# EXAMPLE 2: Recurring Question Analysis
# ============================================================================

def example_recurring_questions():
    """Example: Identify recurring questions in task discussions."""
    print("\n" + "=" * 70)
    print("EXAMPLE 2: Recurring Question Analysis")
    print("=" * 70)
    
    # Initialize analyzer
    analyzer = RecurringQuestionAnalyzer(language="pt")
    
    # Sample messages (mix of questions and statements)
    messages = [
        "Como faço para criar um novo usuário?",
        "Como posso adicionar um usuário ao sistema?",
        "Qual é o processo para registrar um novo usuário?",
        "Onde faço login no sistema?",
        "Como faço login?",
        "Qual é a senha padrão?",
        "Qual é o endereço da API?",
        "Onde fico o endpoint de autenticação?",
        "Como autenticar na API?",
        "Temos uma reunião amanhã",
        "A tarefa está pronta",
        "Quando posso iniciar o desenvolvimento?",
        "Como configuro o banco de dados?",
        "Como faço para configurar o banco?",
        "Qual é a string de conexão?",
    ]
    
    print(f"\nAnalisando {len(messages)} mensagens...")
    print("(Filtrando apenas perguntas)")
    
    # Analyze
    monitor = PerformanceMonitor()
    monitor.start("recurring_questions")
    
    result = analyzer.analyze(messages, min_frequency=2, top_n_topics=10)
    
    elapsed = monitor.end("recurring_questions")
    print(f"Análise concluída em {elapsed:.2f}s")
    
    # Print results
    print(f"\n{'─' * 70}")
    print(f"Total de mensagens: {result.total_messages_analyzed}")
    print(f"Total de perguntas: {result.unique_questions}")
    print(f"Perguntas recorrentes encontradas: {len(result.recurring_questions)}")
    
    if result.recurring_questions:
        print(f"\n{'─' * 70}")
        print("PERGUNTAS RECORRENTES:")
        for q in result.recurring_questions:
            print(f"\n[Cluster {q.cluster_id}] Frequência: {q.frequency}")
            print(f"Pergunta: {q.question}")
            print(f"Palavras-chave: {', '.join(q.keywords)}")
            print(f"Similaridade média: {q.similarity_score:.2%}")
            print(f"Exemplos:")
            for ex in q.examples[:3]:
                print(f"  - {ex}")
    
    # Top topics
    if result.top_topics:
        print(f"\n{'─' * 70}")
        print(f"TÓPICOS PRINCIPAIS: {', '.join(result.top_topics)}")
    
    # Statistics
    stats = analyzer.get_statistics(result)
    print(f"\n{'─' * 70}")
    print("ESTATÍSTICAS:")
    print(json.dumps(stats, indent=2, ensure_ascii=False))
    
    # Export
    export_data = result.to_dict()
    DataExporter.to_json(export_data, "recurring_questions_results.json")
    print(f"\nResultados exportados para: recurring_questions_results.json")


# ============================================================================
# EXAMPLE 3: Task Discussion Analysis
# ============================================================================

def example_task_analysis():
    """Example: Analyze discussions in tasks to find blockers and risks."""
    print("\n" + "=" * 70)
    print("EXAMPLE 3: Task Discussion Analysis")
    print("=" * 70)
    
    # Initialize analyzer
    analyzer = TaskDiscussionAnalyzer(language="pt")
    
    # Sample task data
    tasks_data = [
        {
            "task_id": "TASK-001",
            "title": "Implementar autenticação OAuth",
            "messages": [
                "Começamos?",
                "Sim, vamos começar. Qual é o provider OAuth?",
                "Pode ser Google ou GitHub",
                "Temos dependência de outro time para as chaves de API",
                "Como conseguimos essas chaves?",
                "Preciso contatar o time de DevOps",
                "Isso está bloqueando nosso desenvolvimento",
                "Quando vai estar pronto?",
            ],
            "users": ["alice", "bob", "charlie"],
        },
        {
            "task_id": "TASK-002",
            "title": "Otimizar performance do banco de dados",
            "messages": [
                "Temos um problema crítico de performance",
                "As queries estão lentas demais",
                "Qual é a causa do problema?",
                "Pode ser índices faltando ou bad queries",
                "Já analisou os logs?",
                "Sim, há timeout em algumas queries",
                "Isso é crítico! Precisamos urgente",
                "Estou trabalhando nisso agora",
                "Qual é a data limite?",
            ],
            "users": ["alice", "david"],
        },
        {
            "task_id": "TASK-003",
            "title": "Documentar API",
            "messages": [
                "Preciso documentar os endpoints",
                "Como estruturo a documentação?",
                "Use OpenAPI ou Swagger",
                "Entendi, vou fazer",
                "Quantos endpoints temos?",
                "Aproximadamente 50",
                "Que trabalho!",
            ],
            "users": ["emily"],
        },
        {
            "task_id": "TASK-004",
            "title": "Design do novo dashboard",
            "messages": [
                "Dashboard ficou pronto",
                "Qual é o estilo?",
                "Material Design",
                "Ficou legal! Quando deploy?",
                "Próxima semana",
                "Ótimo!",
            ],
            "users": ["frank", "grace"],
        },
    ]
    
    print(f"\nAnalisando {len(tasks_data)} tarefas...")
    
    # Analyze
    monitor = PerformanceMonitor()
    monitor.start("task_analysis")
    
    result = analyzer.analyze(tasks_data, min_discussion_threshold=3)
    
    elapsed = monitor.end("task_analysis")
    print(f"Análise concluída em {elapsed:.2f}s")
    
    # Print results
    print(f"\n{'─' * 70}")
    print(f"Total de tarefas: {result.total_tasks_analyzed}")
    print(f"Total de mensagens: {result.total_messages_analyzed}")
    
    # High activity tasks
    if result.high_activity_tasks:
        print(f"\n{'─' * 70}")
        print("TAREFAS COM MAIOR ATIVIDADE:")
        for task in result.high_activity_tasks[:5]:
            print(f"\n{task['task_id']}: {task['task_title']}")
            print(f"  Mensagens: {task['message_count']}")
            print(f"  Perguntas: {task['question_count']}")
            print(f"  Indicadores de bloqueio: {task['blocker_indicators']}")
    
    # Blockers
    if result.identified_blockers:
        print(f"\n{'─' * 70}")
        print("BLOQUEIOS IDENTIFICADOS:")
        for blocker in result.identified_blockers[:10]:
            print(f"\n{blocker.task_id}: {blocker.task_title}")
            print(f"  Tipo: {blocker.blocker_type}")
            print(f"  Descrição: {blocker.description[:100]}...")
            print(f"  Confiança: {blocker.confidence:.2%}")
    
    # Risk tasks
    if result.risk_tasks:
        print(f"\n{'─' * 70}")
        print("TAREFAS COM RISCO:")
        for task in result.risk_tasks[:5]:
            print(f"\n{task['task_id']}: {task['task_title']}")
            print(f"  Severidade: {task['severity']}")
            print(f"  Score de Risco: {task['risk_score']:.2%}")
            print(f"  Indicadores: {task['risk_indicators_count']}")
    
    # Unresolved questions
    if result.unresolved_questions:
        print(f"\n{'─' * 70}")
        print("PERGUNTAS NÃO RESOLVIDAS:")
        for q in result.unresolved_questions[:5]:
            print(f"  - {q}")
    
    # Statistics
    stats = analyzer.get_statistics(result)
    print(f"\n{'─' * 70}")
    print("ESTATÍSTICAS:")
    print(json.dumps(stats, indent=2, ensure_ascii=False, default=str))
    
    # Export
    export_data = result.to_dict()
    DataExporter.to_json(export_data, "task_analysis_results.json")
    print(f"\nResultados exportados para: task_analysis_results.json")


# ============================================================================
# EXAMPLE 4: Text Preprocessing Utilities
# ============================================================================

def example_text_utilities():
    """Example: Text preprocessing utilities."""
    print("\n" + "=" * 70)
    print("EXAMPLE 4: Text Preprocessing Utilities")
    print("=" * 70)
    
    # Sample texts
    texts = [
        "  Olá   MUNDO  com   espaços  ",
        "Visite https://example.com para mais info @user #hashtag",
        "Texto muito muito muito muito muito muito muito longo que precisa ser truncado",
    ]
    
    for text in texts:
        print(f"\nOriginal: '{text}'")
        print(f"Normalizado: '{TextPreprocessor.normalize(text)}'")
        print(f"Limpo: '{TextPreprocessor.clean(text)}'")
        print(f"Truncado: '{TextPreprocessor.truncate(text, 40)}'")


# ============================================================================
# EXAMPLE 5: Cache and Performance Monitoring
# ============================================================================

def example_cache_and_monitoring():
    """Example: Cache and performance monitoring."""
    print("\n" + "=" * 70)
    print("EXAMPLE 5: Cache and Performance Monitoring")
    print("=" * 70)
    
    # Cache example
    print("\nDemonstrando Cache:")
    cache = Cache(".cache_demo")
    
    # Set value
    cache.set("user:123", {"name": "João", "email": "joao@example.com"})
    print("✓ Valor armazenado em cache")
    
    # Get value
    cached = cache.get("user:123")
    print(f"✓ Valor recuperado: {cached}")
    
    # Get non-existent
    not_cached = cache.get("user:999")
    print(f"✓ Valor não encontrado: {not_cached}")
    
    # Performance monitoring
    print("\nMonitorando Performance:")
    monitor = PerformanceMonitor()
    
    # Simulate work
    import time
    
    monitor.start("operacao_1")
    time.sleep(0.1)
    t1 = monitor.end("operacao_1")
    print(f"✓ Operação 1: {t1:.3f}s")
    
    monitor.start("operacao_2")
    time.sleep(0.2)
    t2 = monitor.end("operacao_2")
    print(f"✓ Operação 2: {t2:.3f}s")
    
    monitor.print_report()


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    print("\n" + "=" * 70)
    print("DATA MINING MODULE - COMPREHENSIVE EXAMPLES")
    print("=" * 70)
    
    try:
        # Run examples
        example_offensive_detection()
        example_recurring_questions()
        example_task_analysis()
        example_text_utilities()
        example_cache_and_monitoring()
        
        print("\n" + "=" * 70)
        print("✓ TODOS OS EXEMPLOS EXECUTADOS COM SUCESSO")
        print("=" * 70)
        
    except Exception as e:
        print(f"\n✗ Erro ao executar exemplos: {e}")
        import traceback
        traceback.print_exc()
