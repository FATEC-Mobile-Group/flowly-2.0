"""
Data models for the Data Mining Module.

Provides structured data classes for analysis results.
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional
from enum import Enum


class OffenseSeverity(str, Enum):
    """Severity levels for offensive content."""
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class OffenseCategory(str, Enum):
    """Categories of offensive content."""
    INSULT = "INSULT"
    HARASSMENT = "HARASSMENT"
    HATE_SPEECH = "HATE_SPEECH"
    PROFANITY = "PROFANITY"
    DISCRIMINATION = "DISCRIMINATION"
    THREAT = "THREAT"
    BULLYING = "BULLYING"
    SPAM = "SPAM"
    NONE = "NONE"


@dataclass
class OffensiveAnalysisResult:
    """Result of offensive message analysis."""
    
    message: str
    is_offensive: bool
    toxicity_score: float  # 0.0 to 1.0
    severity: OffenseSeverity
    categories: List[OffenseCategory]
    confidence: float  # 0.0 to 1.0
    offensive_terms: List[str] = field(default_factory=list)
    explanation: str = ""
    
    def to_dict(self) -> Dict:
        """Convert result to dictionary."""
        return {
            "message": self.message,
            "is_offensive": self.is_offensive,
            "toxicity_score": round(self.toxicity_score, 4),
            "severity": self.severity.value,
            "categories": [cat.value for cat in self.categories],
            "confidence": round(self.confidence, 4),
            "offensive_terms": self.offensive_terms,
            "explanation": self.explanation,
        }


@dataclass
class RecurringQuestion:
    """Represents a recurring question cluster."""
    
    cluster_id: int
    question: str  # Representative/summarized question
    frequency: int  # Number of similar questions
    examples: List[str]  # Example questions from cluster
    similarity_score: float  # Average similarity within cluster
    keywords: List[str] = field(default_factory=list)
    category: str = ""
    
    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        return {
            "cluster_id": self.cluster_id,
            "question": self.question,
            "frequency": self.frequency,
            "examples": self.examples[:5],  # Top 5 examples
            "similarity_score": round(self.similarity_score, 4),
            "keywords": self.keywords,
            "category": self.category,
        }


@dataclass
class RecurringQuestionResult:
    """Result of recurring question analysis."""
    
    total_messages_analyzed: int
    unique_questions: int
    recurring_questions: List[RecurringQuestion]
    top_topics: List[str]
    analysis_timestamp: str
    
    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        return {
            "total_messages_analyzed": self.total_messages_analyzed,
            "unique_questions": self.unique_questions,
            "recurring_questions": [q.to_dict() for q in self.recurring_questions],
            "top_topics": self.top_topics,
            "analysis_timestamp": self.analysis_timestamp,
        }


@dataclass
class Blocker:
    """Represents a potential blocker or risk."""
    
    task_id: str
    task_title: str
    blocker_type: str  # "delay", "dependency", "unresolved_question", "risk", "unclear_requirement"
    description: str
    mentioned_in_count: int
    confidence: float
    related_users: List[str] = field(default_factory=list)
    
    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        return {
            "task_id": self.task_id,
            "task_title": self.task_title,
            "blocker_type": self.blocker_type,
            "description": self.description,
            "mentioned_in_count": self.mentioned_in_count,
            "confidence": round(self.confidence, 4),
            "related_users": self.related_users,
        }


@dataclass
class TaskAnalysisResult:
    """Result of task discussion analysis."""
    
    total_tasks_analyzed: int
    total_messages_analyzed: int
    high_activity_tasks: List[Dict]  # Tasks with most discussion
    identified_blockers: List[Blocker]
    unresolved_questions: List[str]
    risk_tasks: List[Dict]
    analysis_timestamp: str
    
    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        return {
            "total_tasks_analyzed": self.total_tasks_analyzed,
            "total_messages_analyzed": self.total_messages_analyzed,
            "high_activity_tasks": self.high_activity_tasks[:10],
            "identified_blockers": [b.to_dict() for b in self.identified_blockers],
            "unresolved_questions": self.unresolved_questions[:20],
            "risk_tasks": self.risk_tasks[:10],
            "analysis_timestamp": self.analysis_timestamp,
        }


@dataclass
class MessageAnalysis:
    """Comprehensive analysis of a single message."""
    
    message_id: str
    message_text: str
    author: str
    timestamp: str
    offensive_result: Optional[OffensiveAnalysisResult] = None
    is_question: bool = False
    sentiment: str = ""  # "positive", "negative", "neutral"
    entities: List[Dict] = field(default_factory=list)
    
    def to_dict(self) -> Dict:
        """Convert to dictionary."""
        return {
            "message_id": self.message_id,
            "message_text": self.message_text,
            "author": self.author,
            "timestamp": self.timestamp,
            "offensive_result": self.offensive_result.to_dict() if self.offensive_result else None,
            "is_question": self.is_question,
            "sentiment": self.sentiment,
            "entities": self.entities,
        }
