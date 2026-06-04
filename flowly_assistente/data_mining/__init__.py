"""
Data Mining Module for Flowly AI Assistant

This module provides NLP-based analysis capabilities for:
- Offensive message detection and classification
- Recurring question identification and clustering
- Task discussion analysis with blocker detection
"""

from .offensive_detector import OffensiveMessageDetector
from .recurring_questions import RecurringQuestionAnalyzer
from .task_analysis import TaskDiscussionAnalyzer
from .models import (
    OffensiveAnalysisResult,
    RecurringQuestionResult,
    TaskAnalysisResult,
    MessageAnalysis,
)

__version__ = "1.0.0"
__author__ = "Flowly Team"

__all__ = [
    "OffensiveMessageDetector",
    "RecurringQuestionAnalyzer",
    "TaskDiscussionAnalyzer",
    "OffensiveAnalysisResult",
    "RecurringQuestionResult",
    "TaskAnalysisResult",
    "MessageAnalysis",
]
