"""
Task Discussion Analyzer for identifying blockers and risks.

Analyzes messages associated with project tasks to extract insights.
"""

import logging
from typing import List, Dict, Optional, Set
from datetime import datetime
from collections import Counter

try:
    from sentence_transformers import SentenceTransformer
    import numpy as np
except ImportError:
    raise ImportError(
        "sentence-transformers required. Install with: pip install sentence-transformers"
    )

from .models import TaskAnalysisResult, Blocker
from .recurring_questions import RecurringQuestionAnalyzer

logger = logging.getLogger(__name__)


class TaskDiscussionAnalyzer:
    """
    Analyzes discussions in project tasks to identify blockers and risks.
    
    Detects:
    - Tasks with high discussion volume
    - Unresolved questions
    - Potential blockers (delays, dependencies, unclear requirements)
    - Risk indicators
    
    Example:
        >>> analyzer = TaskDiscussionAnalyzer(language="pt")
        >>> tasks_data = [
        ...     {"task_id": "T1", "title": "Feature X", "messages": ["...", "..."]},
        ... ]
        >>> result = analyzer.analyze(tasks_data)
    """
    
    def __init__(
        self,
        language: str = "pt",
        embedding_model: str = "distiluse-base-multilingual-cased-v2",
        device: str = "cpu",
    ):
        """
        Initialize the analyzer.
        
        Args:
            language: Language code ("pt" or "en")
            embedding_model: SentenceTransformers model identifier
            device: "cpu" or "cuda"
        """
        self.language = language
        self.device = device
        
        # Load embedder
        try:
            self.embedder = SentenceTransformer(embedding_model, device=device)
            logger.info(f"Loaded embedding model: {embedding_model}")
        except Exception as e:
            logger.error(f"Failed to load embedding model: {e}")
            raise
        
        # Initialize recurring question analyzer
        self.question_analyzer = RecurringQuestionAnalyzer(
            language=language,
            embedding_model=embedding_model,
            device=device,
        )
        
        # Blocker and risk indicators
        self.blocker_keywords = self._get_blocker_keywords()
        self.risk_keywords = self._get_risk_keywords()
        self.unresolved_keywords = self._get_unresolved_keywords()
    
    def _get_blocker_keywords(self) -> Dict[str, List[str]]:
        """Get keywords for different blocker types."""
        if self.language == "pt":
            return {
                "delay": [
                    "atrasado", "atraso", "demora", "dependência",
                    "bloqueado", "parado", "aguardando", "esperar",
                    "pendente", "em atraso", "não consegui", "não consigo",
                ],
                "dependency": [
                    "depende de", "dependência", "precisa de", "requer",
                    "aguardando", "bloqueado por", "espera", "outro time",
                    "não começar", "antes de", "depois de",
                ],
                "unresolved_question": [
                    "não sei", "dúvida", "como fazer", "qual é",
                    "quando", "onde", "por que", "esclarecimento",
                    "informação", "confirmação", "certeza",
                ],
                "risk": [
                    "risco", "problema", "erro", "bug", "falha",
                    "quebra", "crash", "timeout", "performance",
                    "crítico", "urgente", "grave", "sério",
                ],
            }
        else:
            return {
                "delay": [
                    "delayed", "late", "slow", "dependency",
                    "blocked", "stuck", "waiting", "pending",
                    "couldn't", "can't", "unable",
                ],
                "dependency": [
                    "depends on", "dependency", "needs", "requires",
                    "waiting for", "blocked by", "another team",
                    "before", "after", "must first",
                ],
                "unresolved_question": [
                    "not sure", "doubt", "how to", "what is",
                    "when", "where", "why", "clarification",
                    "information", "confirmation", "unclear",
                ],
                "risk": [
                    "risk", "problem", "error", "bug", "fail",
                    "crash", "timeout", "performance", "critical",
                    "urgent", "severe", "serious",
                ],
            }
    
    def _get_risk_keywords(self) -> List[str]:
        """Get keywords indicating risks."""
        if self.language == "pt":
            return [
                "risco", "problema", "crítico", "urgente", "grave",
                "erro", "bug", "falha", "performance", "leak",
                "segurança", "quebra", "crash", "timeout",
            ]
        else:
            return [
                "risk", "problem", "critical", "urgent", "severe",
                "error", "bug", "fail", "performance", "leak",
                "security", "break", "crash", "timeout",
            ]
    
    def _get_unresolved_keywords(self) -> List[str]:
        """Get keywords indicating unresolved questions."""
        if self.language == "pt":
            return [
                "?", "dúvida", "não sei", "como", "qual",
                "quando", "onde", "por que", "possível",
                "pode", "conseguir", "fazer", "dar", "colocar",
            ]
        else:
            return [
                "?", "doubt", "not sure", "how", "what",
                "when", "where", "why", "possible", "can",
                "could", "would", "should", "need",
            ]
    
    def analyze(
        self,
        tasks_data: List[Dict],
        min_discussion_threshold: int = 3,
    ) -> TaskAnalysisResult:
        """
        Analyze task discussions.
        
        Args:
            tasks_data: List of task dictionaries with structure:
                {
                    "task_id": str,
                    "title": str,
                    "messages": List[str],
                    "assignee": Optional[str],
                    "created_at": Optional[str],
                }
            min_discussion_threshold: Minimum messages to analyze
        
        Returns:
            TaskAnalysisResult with identified blockers and risks
        """
        if not tasks_data:
            return TaskAnalysisResult(
                total_tasks_analyzed=0,
                total_messages_analyzed=0,
                high_activity_tasks=[],
                identified_blockers=[],
                unresolved_questions=[],
                risk_tasks=[],
                analysis_timestamp=datetime.now().isoformat(),
            )
        
        # Analyze each task
        task_analyses = []
        all_messages = []
        
        for task in tasks_data:
            if not isinstance(task.get("messages"), list):
                continue
            
            messages = task["messages"]
            if len(messages) < min_discussion_threshold:
                continue
            
            all_messages.extend(messages)
            
            task_analysis = self._analyze_single_task(task, messages)
            task_analyses.append(task_analysis)
        
        # Identify high-activity tasks
        high_activity_tasks = self._identify_high_activity_tasks(task_analyses)
        
        # Identify blockers
        blockers = self._identify_blockers(task_analyses)
        
        # Identify unresolved questions
        unresolved_questions = self._identify_unresolved_questions(
            all_messages
        )
        
        # Identify risk tasks
        risk_tasks = self._identify_risk_tasks(task_analyses)
        
        return TaskAnalysisResult(
            total_tasks_analyzed=len(tasks_data),
            total_messages_analyzed=len(all_messages),
            high_activity_tasks=high_activity_tasks,
            identified_blockers=blockers,
            unresolved_questions=unresolved_questions,
            risk_tasks=risk_tasks,
            analysis_timestamp=datetime.now().isoformat(),
        )
    
    def _analyze_single_task(
        self,
        task: Dict,
        messages: List[str],
    ) -> Dict:
        """Analyze a single task's discussion."""
        task_id = task.get("task_id", "unknown")
        task_title = task.get("title", "Untitled")
        
        # Count indicators
        blocker_count = self._count_indicators(messages, self.blocker_keywords)
        risk_count = self._count_indicators(messages, self.risk_keywords)
        question_count = sum(1 for msg in messages if "?" in msg)
        
        # Extract users
        users = task.get("users", [])
        
        return {
            "task_id": task_id,
            "task_title": task_title,
            "message_count": len(messages),
            "users": users,
            "blocker_indicators": blocker_count,
            "risk_indicators": risk_count,
            "question_count": question_count,
            "messages": messages,
        }
    
    def _count_indicators(
        self,
        messages: List[str],
        indicators: Dict[str, List[str]] | List[str],
    ) -> int:
        """Count indicator occurrences in messages."""
        count = 0
        
        if isinstance(indicators, dict):
            indicators_list = [item for items in indicators.values() for item in items]
        else:
            indicators_list = indicators
        
        for message in messages:
            message_lower = message.lower()
            for indicator in indicators_list:
                if indicator in message_lower:
                    count += 1
                    break
        
        return count
    
    def _identify_high_activity_tasks(
        self,
        task_analyses: List[Dict],
    ) -> List[Dict]:
        """Identify tasks with most discussion."""
        # Sort by message count
        sorted_tasks = sorted(
            task_analyses,
            key=lambda x: x["message_count"],
            reverse=True,
        )
        
        result = []
        for task in sorted_tasks[:10]:  # Top 10
            result.append({
                "task_id": task["task_id"],
                "task_title": task["task_title"],
                "message_count": task["message_count"],
                "question_count": task["question_count"],
                "blocker_indicators": task["blocker_indicators"],
            })
        
        return result
    
    def _identify_blockers(
        self,
        task_analyses: List[Dict],
    ) -> List[Blocker]:
        """Identify potential blockers."""
        blockers = []
        
        for task in task_analyses:
            if task["blocker_indicators"] == 0:
                continue
            
            messages = task["messages"]
            
            # Detect blocker types
            blocker_types = self._detect_blocker_types(
                messages, self.blocker_keywords
            )
            
            for blocker_type, count in blocker_types.items():
                if count > 0:
                    blocker = Blocker(
                        task_id=task["task_id"],
                        task_title=task["task_title"],
                        blocker_type=blocker_type,
                        description=self._generate_blocker_description(
                            task, blocker_type, messages
                        ),
                        mentioned_in_count=count,
                        confidence=min(count / max(len(messages), 1), 1.0),
                        related_users=task.get("users", []),
                    )
                    blockers.append(blocker)
        
        return blockers
    
    def _detect_blocker_types(
        self,
        messages: List[str],
        blocker_keywords: Dict[str, List[str]],
    ) -> Dict[str, int]:
        """Detect types of blockers present."""
        types_count = {}
        
        for blocker_type, keywords in blocker_keywords.items():
            count = 0
            for message in messages:
                message_lower = message.lower()
                if any(keyword in message_lower for keyword in keywords):
                    count += 1
            types_count[blocker_type] = count
        
        return types_count
    
    def _generate_blocker_description(
        self,
        task: Dict,
        blocker_type: str,
        messages: List[str],
    ) -> str:
        """Generate description for a blocker."""
        # Find messages mentioning this blocker type
        relevant_messages = []
        keywords = self.blocker_keywords.get(blocker_type, [])
        
        for message in messages:
            if any(kw in message.lower() for kw in keywords):
                relevant_messages.append(message)
        
        if relevant_messages:
            # Use first relevant message as basis
            return relevant_messages[0][:200]
        
        return f"Possível {blocker_type} detectado na tarefa {task['task_id']}"
    
    def _identify_unresolved_questions(
        self,
        messages: List[str],
    ) -> List[str]:
        """Identify unresolved questions."""
        questions = [msg for msg in messages if "?" in msg]
        
        # Remove duplicates and sort by relevance
        unique_questions = list(set(questions))
        
        # Sort by length (longer questions usually more specific)
        unique_questions.sort(key=len, reverse=True)
        
        return unique_questions[:20]  # Top 20
    
    def _identify_risk_tasks(
        self,
        task_analyses: List[Dict],
    ) -> List[Dict]:
        """Identify tasks with risk indicators."""
        risk_tasks = []
        
        for task in task_analyses:
            if task["risk_indicators"] == 0:
                continue
            
            risk_score = (
                task["risk_indicators"] / max(task["message_count"], 1)
            )
            
            risk_tasks.append({
                "task_id": task["task_id"],
                "task_title": task["task_title"],
                "risk_score": round(risk_score, 4),
                "risk_indicators_count": task["risk_indicators"],
                "message_count": task["message_count"],
                "severity": self._determine_risk_severity(risk_score),
            })
        
        # Sort by risk score
        risk_tasks.sort(key=lambda x: x["risk_score"], reverse=True)
        
        return risk_tasks
    
    def _determine_risk_severity(self, risk_score: float) -> str:
        """Determine risk severity from score."""
        if risk_score > 0.5:
            return "HIGH"
        elif risk_score > 0.3:
            return "MEDIUM"
        else:
            return "LOW"
    
    def get_statistics(
        self,
        result: TaskAnalysisResult,
    ) -> Dict:
        """Get statistics from analysis result."""
        return {
            "total_tasks_analyzed": result.total_tasks_analyzed,
            "total_messages_analyzed": result.total_messages_analyzed,
            "high_activity_tasks_count": len(result.high_activity_tasks),
            "identified_blockers_count": len(result.identified_blockers),
            "unresolved_questions_count": len(result.unresolved_questions),
            "risk_tasks_count": len(result.risk_tasks),
            "blocker_types": Counter(
                b.blocker_type for b in result.identified_blockers
            ),
            "highest_risk_task": (
                result.risk_tasks[0] if result.risk_tasks else None
            ),
        }
