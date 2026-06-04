"""
Recurring Question Analyzer using NLP clustering techniques.

Identifies frequently asked questions and groups similar questions.
"""

import logging
from typing import List, Dict, Optional, Tuple
from datetime import datetime
import numpy as np
from collections import Counter

try:
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.cluster import DBSCAN, KMeans
    from sklearn.metrics.pairwise import cosine_similarity
    from sentence_transformers import SentenceTransformer
    import nltk
    from nltk.tokenize import sent_tokenize
except ImportError:
    raise ImportError(
        "scikit-learn and sentence-transformers required. "
        "Install with: pip install scikit-learn sentence-transformers nltk"
    )

from .models import RecurringQuestion, RecurringQuestionResult

logger = logging.getLogger(__name__)


class RecurringQuestionAnalyzer:
    """
    Analyzes messages to identify recurring questions and patterns.
    
    Uses multiple techniques:
    1. Sentence-level embeddings (SentenceTransformers)
    2. Semantic similarity clustering (DBSCAN)
    3. TF-IDF keyword extraction
    4. Question detection
    
    Supported languages: Portuguese, English
    
    Example:
        >>> analyzer = RecurringQuestionAnalyzer(language="pt")
        >>> messages = ["Como faço...?", "Como posso...?", "Qual é...?"]
        >>> result = analyzer.analyze(messages)
        >>> for q in result.recurring_questions:
        ...     print(q.question, q.frequency)
    """
    
    def __init__(
        self,
        language: str = "pt",
        embedding_model: str = "distiluse-base-multilingual-cased-v2",
        min_cluster_size: int = 3,
        similarity_threshold: float = 0.7,
        device: str = "cpu",
    ):
        """
        Initialize the analyzer.
        
        Args:
            language: Language code ("pt" or "en")
            embedding_model: SentenceTransformers model identifier
            min_cluster_size: Minimum messages in a cluster to be considered recurring
            similarity_threshold: Threshold for semantic similarity (0-1)
            device: "cpu" or "cuda"
        """
        self.language = language
        self.min_cluster_size = min_cluster_size
        self.similarity_threshold = similarity_threshold
        self.device = device
        
        # Load sentence embedder
        try:
            self.embedder = SentenceTransformer(
                embedding_model,
                device=device,
            )
            logger.info(f"Loaded embedding model: {embedding_model}")
        except Exception as e:
            logger.error(f"Failed to load embedding model: {e}")
            raise
        
        # Load TF-IDF vectorizer
        self.tfidf_vectorizer = TfidfVectorizer(
            max_features=100,
            stop_words="portuguese" if language == "pt" else "english",
            ngram_range=(1, 2),
        )
        
        # Question indicators
        self.question_indicators = self._get_question_indicators()
    
    def _get_question_indicators(self) -> List[str]:
        """Get language-specific question indicators."""
        if self.language == "pt":
            return [
                "como", "qual", "quando", "onde", "quem", "por que",
                "o que", "quanto", "será", "pode", "devo",
                "consigo", "posso", "preciso", "?",
            ]
        else:
            return [
                "how", "what", "when", "where", "who", "why",
                "which", "whose", "would", "could", "should",
                "can", "do", "does", "is", "are", "?",
            ]
    
    def _is_question(self, message: str) -> bool:
        """Detect if a message is a question."""
        message_lower = message.lower().strip()
        
        # Check for question mark
        if message_lower.endswith("?"):
            return True
        
        # Check for question indicators
        for indicator in self.question_indicators:
            if message_lower.startswith(indicator):
                return True
        
        return False
    
    def analyze(
        self,
        messages: List[str],
        min_frequency: int = 2,
        top_n_topics: int = 10,
    ) -> RecurringQuestionResult:
        """
        Analyze messages to identify recurring questions.
        
        Args:
            messages: List of messages/comments to analyze
            min_frequency: Minimum frequency to consider recurring (default: 2)
            top_n_topics: Number of top topics to extract
        
        Returns:
            RecurringQuestionResult with clustered questions
        """
        # Filter to questions only
        questions = [msg for msg in messages if self._is_question(msg)]
        
        if not questions or len(questions) < self.min_cluster_size:
            return RecurringQuestionResult(
                total_messages_analyzed=len(messages),
                unique_questions=len(questions),
                recurring_questions=[],
                top_topics=[],
                analysis_timestamp=datetime.now().isoformat(),
            )
        
        # Generate embeddings
        embeddings = self.embedder.encode(questions, show_progress_bar=True)
        
        # Cluster similar questions
        clusters = self._cluster_questions(embeddings, questions)
        
        # Create recurring question objects
        recurring_questions = self._create_recurring_questions(
            clusters, questions, min_frequency
        )
        
        # Extract top topics
        top_topics = self._extract_top_topics(
            recurring_questions, top_n_topics
        )
        
        # Sort by frequency
        recurring_questions.sort(key=lambda x: x.frequency, reverse=True)
        
        return RecurringQuestionResult(
            total_messages_analyzed=len(messages),
            unique_questions=len(questions),
            recurring_questions=recurring_questions,
            top_topics=top_topics,
            analysis_timestamp=datetime.now().isoformat(),
        )
    
    def _cluster_questions(
        self,
        embeddings: np.ndarray,
        questions: List[str],
    ) -> Dict[int, List[int]]:
        """
        Cluster similar questions using DBSCAN.
        
        Returns:
            Dictionary mapping cluster_id to list of question indices
        """
        # Calculate epsilon from similarity threshold
        distance_matrix = 1 - cosine_similarity(embeddings)
        eps = 1 - self.similarity_threshold
        
        # DBSCAN clustering
        clustering = DBSCAN(eps=eps, min_samples=1).fit(embeddings)
        labels = clustering.labels_
        
        # Group by cluster
        clusters = {}
        for idx, label in enumerate(labels):
            if label not in clusters:
                clusters[label] = []
            clusters[label].append(idx)
        
        return clusters
    
    def _create_recurring_questions(
        self,
        clusters: Dict[int, List[int]],
        questions: List[str],
        min_frequency: int,
    ) -> List[RecurringQuestion]:
        """Create RecurringQuestion objects from clusters."""
        recurring_questions = []
        cluster_id = 0
        
        for cluster_indices in clusters.values():
            if len(cluster_indices) < min_frequency:
                continue
            
            cluster_questions = [questions[i] for i in cluster_indices]
            
            # Find representative question (closest to centroid)
            representative_question = self._get_representative_question(
                cluster_questions
            )
            
            # Extract keywords
            keywords = self._extract_keywords(cluster_questions)
            
            # Calculate average similarity
            embeddings = self.embedder.encode(cluster_questions)
            similarity_matrix = cosine_similarity(embeddings)
            avg_similarity = np.mean(
                similarity_matrix[np.triu_indices_from(similarity_matrix, k=1)]
            )
            
            recurring_questions.append(
                RecurringQuestion(
                    cluster_id=cluster_id,
                    question=representative_question,
                    frequency=len(cluster_questions),
                    examples=cluster_questions[:5],
                    similarity_score=float(avg_similarity),
                    keywords=keywords,
                    category=self._categorize_question(representative_question),
                )
            )
            
            cluster_id += 1
        
        return recurring_questions
    
    def _get_representative_question(self, questions: List[str]) -> str:
        """Get most representative question from cluster."""
        if not questions:
            return ""
        
        # Use the shortest unique question (usually most concise)
        return min(questions, key=len)
    
    def _extract_keywords(self, questions: List[str], top_k: int = 5) -> List[str]:
        """Extract keywords using TF-IDF."""
        if not questions:
            return []
        
        try:
            tfidf_matrix = self.tfidf_vectorizer.fit_transform(questions)
            
            # Get feature names
            feature_names = self.tfidf_vectorizer.get_feature_names_out()
            
            # Calculate mean TF-IDF scores
            mean_scores = np.asarray(tfidf_matrix.mean(axis=0)).flatten()
            
            # Get top keywords
            top_indices = np.argsort(mean_scores)[-top_k:][::-1]
            keywords = [feature_names[i] for i in top_indices if mean_scores[i] > 0]
            
            return keywords
        except Exception as e:
            logger.warning(f"Error in keyword extraction: {e}")
            return []
    
    def _categorize_question(self, question: str) -> str:
        """Categorize question by type."""
        question_lower = question.lower()
        
        if any(word in question_lower for word in ["como", "way", "make"]):
            return "how_to"
        elif any(word in question_lower for word in ["por que", "why"]):
            return "why"
        elif any(word in question_lower for word in ["quando", "when"]):
            return "when"
        elif any(word in question_lower for word in ["onde", "where"]):
            return "where"
        elif any(word in question_lower for word in ["quanto", "how much"]):
            return "quantity"
        else:
            return "general"
    
    def _extract_top_topics(
        self,
        recurring_questions: List[RecurringQuestion],
        top_n: int,
    ) -> List[str]:
        """Extract top topics from recurring questions."""
        topics = []
        
        for question in recurring_questions[:top_n]:
            if question.keywords:
                topics.extend(question.keywords)
        
        # Count and get most common
        topic_counts = Counter(topics)
        top_topics = [topic for topic, _ in topic_counts.most_common(top_n)]
        
        return top_topics
    
    def find_similar_questions(
        self,
        query: str,
        messages: List[str],
        top_k: int = 5,
    ) -> List[Tuple[str, float]]:
        """
        Find messages similar to a query.
        
        Args:
            query: Query question
            messages: Messages to search in
            top_k: Number of results to return
        
        Returns:
            List of (message, similarity_score) tuples
        """
        # Get embeddings
        query_embedding = self.embedder.encode([query])[0]
        message_embeddings = self.embedder.encode(messages)
        
        # Calculate similarities
        similarities = cosine_similarity([query_embedding], message_embeddings)[0]
        
        # Get top k
        top_indices = np.argsort(similarities)[-top_k:][::-1]
        results = [
            (messages[i], float(similarities[i]))
            for i in top_indices
        ]
        
        return results
    
    def get_statistics(
        self,
        result: RecurringQuestionResult,
    ) -> Dict:
        """Get statistics from analysis result."""
        if not result.recurring_questions:
            return {
                "total_messages": result.total_messages_analyzed,
                "total_questions": result.unique_questions,
                "recurring_questions_found": 0,
            }
        
        avg_frequency = np.mean([q.frequency for q in result.recurring_questions])
        max_frequency = max([q.frequency for q in result.recurring_questions])
        
        category_counts = Counter(
            q.category for q in result.recurring_questions
        )
        
        return {
            "total_messages": result.total_messages_analyzed,
            "total_questions": result.unique_questions,
            "recurring_questions_found": len(result.recurring_questions),
            "average_frequency": round(float(avg_frequency), 2),
            "max_frequency": int(max_frequency),
            "top_topics": result.top_topics,
            "question_categories": dict(category_counts),
        }
