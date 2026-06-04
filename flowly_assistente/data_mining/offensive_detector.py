"""
Offensive Message Detector using NLP and Transformer models.

Detects and classifies offensive, toxic, and inappropriate messages.
"""

import logging
from typing import List, Dict, Optional, Tuple
import numpy as np
from dataclasses import dataclass

try:
    from transformers import pipeline, AutoTokenizer, AutoModelForSequenceClassification
    import torch
except ImportError:
    raise ImportError(
        "transformers and torch required. Install with: pip install transformers torch"
    )

from .models import OffensiveAnalysisResult, OffenseSeverity, OffenseCategory

logger = logging.getLogger(__name__)


@dataclass
class OffensiveTermPattern:
    """Pattern for detecting offensive terms."""
    terms: List[str]
    category: OffenseCategory
    severity_multiplier: float = 1.0


class OffensiveMessageDetector:
    """
    Detects and classifies offensive messages using transformer models.
    
    Uses multiple strategies:
    1. Transformer-based toxicity detection
    2. Pattern matching for known offensive terms
    3. Context-based analysis
    
    Supported languages: Portuguese, English
    
    Example:
        >>> detector = OffensiveMessageDetector(language="pt")
        >>> result = detector.analyze("Sua mensagem aqui")
        >>> print(result.is_offensive, result.toxicity_score)
    """
    
    def __init__(
        self,
        language: str = "pt",
        model_name: str = "distilbert-base-multilingual-cased",
        device: str = "cpu",
        cache_dir: Optional[str] = None,
    ):
        """
        Initialize the detector.
        
        Args:
            language: Language code ("pt" for Portuguese, "en" for English)
            model_name: HuggingFace model identifier
            device: "cpu" or "cuda"
            cache_dir: Directory to cache models
        """
        self.language = language
        self.device = device
        self.cache_dir = cache_dir
        
        # Load the toxicity classification model
        try:
            self.classifier = pipeline(
                "text-classification",
                model="michellejieli/NSFW_text_classifier",
                device=0 if device == "cuda" else -1,
            )
            logger.info("Loaded NSFW classifier model")
        except Exception as e:
            logger.warning(f"Could not load NSFW classifier: {e}")
            self.classifier = None
        
        # Load sentiment analysis for context
        try:
            self.sentiment_analyzer = pipeline(
                "sentiment-analysis",
                model="nlptown/bert-base-multilingual-uncased-sentiment",
                device=0 if device == "cuda" else -1,
            )
            logger.info("Loaded sentiment analysis model")
        except Exception as e:
            logger.warning(f"Could not load sentiment model: {e}")
            self.sentiment_analyzer = None
        
        # Initialize offensive term patterns
        self._init_patterns()
    
    def _init_patterns(self) -> None:
        """Initialize patterns for offensive terms."""
        self.patterns = {
            OffenseCategory.PROFANITY: OffensiveTermPattern(
                terms=self._get_profanity_terms(),
                category=OffenseCategory.PROFANITY,
                severity_multiplier=0.8,
            ),
            OffenseCategory.HARASSMENT: OffensiveTermPattern(
                terms=self._get_harassment_terms(),
                category=OffenseCategory.HARASSMENT,
                severity_multiplier=1.2,
            ),
            OffenseCategory.DISCRIMINATION: OffensiveTermPattern(
                terms=self._get_discrimination_terms(),
                category=OffenseCategory.DISCRIMINATION,
                severity_multiplier=1.3,
            ),
            OffenseCategory.INSULT: OffensiveTermPattern(
                terms=self._get_insult_terms(),
                category=OffenseCategory.INSULT,
                severity_multiplier=1.0,
            ),
        }
    
    def _get_profanity_terms(self) -> List[str]:
        """Get list of profanity terms (Portuguese)."""
        return [
            "porra", "merda", "desgraçado", "maldito", "droga",
            "caralho", "inferno", "idiota", "estúpido", "imbecil",
        ]
    
    def _get_harassment_terms(self) -> List[str]:
        """Get list of harassment terms."""
        return [
            "vou te matar", "vou te agredir", "vou destruir",
            "implodir", "arrebentar", "surrar", "atacar",
        ]
    
    def _get_discrimination_terms(self) -> List[str]:
        """Get list of discrimination terms."""
        return [
            "negro", "preto", "índio", "chinês", "muçulmano",
            "judeu", "gay", "lésbica", "trans", "mulher",
            "homem", "gordo", "magro", "feio", "velho",
        ]
    
    def _get_insult_terms(self) -> List[str]:
        """Get list of insult terms."""
        return [
            "burro", "inútil", "chato", "entediante", "ridículo",
            "patético", "nojento", "repugnante", "asqueroso",
        ]
    
    def analyze(
        self,
        message: str,
        context: Optional[str] = None,
    ) -> OffensiveAnalysisResult:
        """
        Analyze a message for offensive content.
        
        Args:
            message: The message to analyze
            context: Optional context (conversation history, etc.)
        
        Returns:
            OffensiveAnalysisResult with detailed classification
        """
        message_clean = message.strip()
        
        if not message_clean:
            return OffensiveAnalysisResult(
                message=message,
                is_offensive=False,
                toxicity_score=0.0,
                severity=OffenseSeverity.LOW,
                categories=[],
                confidence=1.0,
            )
        
        # Get toxicity score from transformer model
        toxicity_score, model_confidence = self._get_toxicity_score(message_clean)
        
        # Pattern matching for known offensive terms
        offensive_terms, pattern_categories = self._detect_offensive_terms(message_clean)
        
        # Determine severity and categories
        categories = self._categorize_offense(pattern_categories, toxicity_score)
        severity = self._determine_severity(toxicity_score, categories)
        
        # Decide if message is offensive
        is_offensive = toxicity_score > 0.5 or len(offensive_terms) > 0
        confidence = max(model_confidence, 0.9 if len(offensive_terms) > 0 else 0.5)
        
        # Generate explanation
        explanation = self._generate_explanation(
            toxicity_score, categories, offensive_terms, context
        )
        
        return OffensiveAnalysisResult(
            message=message,
            is_offensive=is_offensive,
            toxicity_score=toxicity_score,
            severity=severity,
            categories=categories,
            confidence=confidence,
            offensive_terms=offensive_terms,
            explanation=explanation,
        )
    
    def _get_toxicity_score(self, message: str) -> Tuple[float, float]:
        """
        Get toxicity score from transformer model.
        
        Returns:
            Tuple of (toxicity_score, confidence)
        """
        if self.classifier is None:
            return 0.0, 0.5
        
        try:
            result = self.classifier(message[:512])[0]  # Limit to 512 tokens
            
            # Convert LABEL_1 (toxic/NSFW) to score
            if result["label"] == "LABEL_1":
                score = result["score"]
            else:
                score = 1 - result["score"]
            
            return float(score), float(result["score"])
        except Exception as e:
            logger.warning(f"Error in toxicity scoring: {e}")
            return 0.0, 0.5
    
    def _detect_offensive_terms(self, message: str) -> Tuple[List[str], List[OffenseCategory]]:
        """
        Detect known offensive terms in message.
        
        Returns:
            Tuple of (offensive_terms, categories)
        """
        message_lower = message.lower()
        found_terms = []
        categories = []
        
        for pattern in self.patterns.values():
            for term in pattern.terms:
                if term in message_lower:
                    found_terms.append(term)
                    if pattern.category not in categories:
                        categories.append(pattern.category)
        
        return found_terms, categories
    
    def _categorize_offense(
        self,
        detected_categories: List[OffenseCategory],
        toxicity_score: float,
    ) -> List[OffenseCategory]:
        """Determine offense categories."""
        if detected_categories:
            return detected_categories
        
        # Infer from toxicity score if no patterns matched
        if toxicity_score > 0.7:
            return [OffenseCategory.PROFANITY, OffenseCategory.HARASSMENT]
        elif toxicity_score > 0.5:
            return [OffenseCategory.INSULT]
        
        return [OffenseCategory.NONE]
    
    def _determine_severity(
        self,
        toxicity_score: float,
        categories: List[OffenseCategory],
    ) -> OffenseSeverity:
        """Determine severity level."""
        # Check for high-severity categories
        high_severity_categories = {
            OffenseCategory.HARASSMENT,
            OffenseCategory.HATE_SPEECH,
            OffenseCategory.THREAT,
            OffenseCategory.BULLYING,
        }
        
        if any(cat in high_severity_categories for cat in categories):
            return OffenseSeverity.HIGH
        
        # Score-based severity
        if toxicity_score > 0.75:
            return OffenseSeverity.HIGH
        elif toxicity_score > 0.55:
            return OffenseSeverity.MEDIUM
        else:
            return OffenseSeverity.LOW
    
    def _generate_explanation(
        self,
        toxicity_score: float,
        categories: List[OffenseCategory],
        offensive_terms: List[str],
        context: Optional[str] = None,
    ) -> str:
        """Generate human-readable explanation."""
        if not categories or categories == [OffenseCategory.NONE]:
            return "Mensagem não contém conteúdo ofensivo detectado."
        
        explanation_parts = []
        
        if offensive_terms:
            terms_str = ", ".join(offensive_terms)
            explanation_parts.append(f"Termos ofensivos detectados: {terms_str}")
        
        if toxicity_score > 0.5:
            explanation_parts.append(
                f"Nível de toxicidade: {toxicity_score:.0%}"
            )
        
        category_names = [cat.value for cat in categories if cat != OffenseCategory.NONE]
        if category_names:
            explanation_parts.append(f"Categorias: {', '.join(category_names)}")
        
        return ". ".join(explanation_parts) + "."
    
    def batch_analyze(
        self,
        messages: List[str],
        show_progress: bool = True,
    ) -> List[OffensiveAnalysisResult]:
        """
        Analyze multiple messages.
        
        Args:
            messages: List of messages to analyze
            show_progress: Whether to show progress bar
        
        Returns:
            List of analysis results
        """
        results = []
        
        iterator = (
            messages if not show_progress else
            self._get_tqdm_iterator(messages)
        )
        
        for message in iterator:
            results.append(self.analyze(message))
        
        return results
    
    @staticmethod
    def _get_tqdm_iterator(items: List, desc: str = "Processing"):
        """Get tqdm iterator if available, otherwise return plain iterator."""
        try:
            from tqdm import tqdm
            return tqdm(items, desc=desc)
        except ImportError:
            return items
    
    def get_statistics(
        self,
        results: List[OffensiveAnalysisResult],
    ) -> Dict:
        """
        Get statistics from analysis results.
        
        Args:
            results: List of analysis results
        
        Returns:
            Dictionary with statistics
        """
        if not results:
            return {}
        
        offensive_count = sum(1 for r in results if r.is_offensive)
        avg_toxicity = np.mean([r.toxicity_score for r in results])
        
        severity_counts = {
            "LOW": sum(1 for r in results if r.severity == OffenseSeverity.LOW),
            "MEDIUM": sum(1 for r in results if r.severity == OffenseSeverity.MEDIUM),
            "HIGH": sum(1 for r in results if r.severity == OffenseSeverity.HIGH),
        }
        
        category_counts = {}
        for result in results:
            for category in result.categories:
                category_counts[category.value] = category_counts.get(category.value, 0) + 1
        
        return {
            "total_messages": len(results),
            "offensive_messages": offensive_count,
            "offensive_percentage": round(offensive_count / len(results) * 100, 2),
            "average_toxicity_score": round(float(avg_toxicity), 4),
            "severity_distribution": severity_counts,
            "category_distribution": category_counts,
        }
