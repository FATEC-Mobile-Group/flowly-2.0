"""
Utility functions for the Data Mining Module.

Provides helper functions for text processing, caching, and API integration.
"""

import logging
import json
import hashlib
from typing import List, Dict, Optional, Any
from pathlib import Path
from datetime import datetime, timedelta
import pickle

logger = logging.getLogger(__name__)


class Cache:
    """Simple file-based cache for expensive operations."""
    
    def __init__(self, cache_dir: str = ".cache"):
        """
        Initialize cache.
        
        Args:
            cache_dir: Directory to store cache files
        """
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(exist_ok=True)
    
    def _get_key(self, key: str) -> str:
        """Generate cache key hash."""
        return hashlib.md5(key.encode()).hexdigest()
    
    def get(self, key: str, max_age_hours: int = 24) -> Optional[Any]:
        """
        Get cached value.
        
        Args:
            key: Cache key
            max_age_hours: Maximum age of cache in hours
        
        Returns:
            Cached value or None if expired/not found
        """
        cache_file = self.cache_dir / f"{self._get_key(key)}.pkl"
        
        if not cache_file.exists():
            return None
        
        # Check age
        file_age = datetime.now() - datetime.fromtimestamp(cache_file.stat().st_mtime)
        if file_age > timedelta(hours=max_age_hours):
            cache_file.unlink()
            return None
        
        try:
            with open(cache_file, "rb") as f:
                return pickle.load(f)
        except Exception as e:
            logger.warning(f"Error reading cache: {e}")
            return None
    
    def set(self, key: str, value: Any) -> None:
        """
        Set cache value.
        
        Args:
            key: Cache key
            value: Value to cache
        """
        cache_file = self.cache_dir / f"{self._get_key(key)}.pkl"
        
        try:
            with open(cache_file, "wb") as f:
                pickle.dump(value, f)
        except Exception as e:
            logger.warning(f"Error writing cache: {e}")
    
    def clear(self) -> None:
        """Clear all cache files."""
        for f in self.cache_dir.glob("*.pkl"):
            f.unlink()
        logger.info("Cache cleared")


class TextPreprocessor:
    """Text preprocessing utilities."""
    
    @staticmethod
    def normalize(text: str) -> str:
        """
        Normalize text for analysis.
        
        Args:
            text: Text to normalize
        
        Returns:
            Normalized text
        """
        # Remove extra whitespace
        text = " ".join(text.split())
        
        # Convert to lowercase
        text = text.lower()
        
        # Remove special characters (keep common punctuation)
        import re
        text = re.sub(r"[^\w\s?.!,-]", "", text)
        
        return text
    
    @staticmethod
    def clean(text: str) -> str:
        """
        Clean text for analysis.
        
        Args:
            text: Text to clean
        
        Returns:
            Cleaned text
        """
        import re
        
        # Remove URLs
        text = re.sub(r"http[s]?://(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\\(\\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+", "", text)
        
        # Remove mentions
        text = re.sub(r"@\w+", "", text)
        
        # Remove hashtags
        text = re.sub(r"#\w+", "", text)
        
        # Remove multiple spaces
        text = " ".join(text.split())
        
        return text
    
    @staticmethod
    def truncate(text: str, max_length: int = 512) -> str:
        """
        Truncate text to maximum length.
        
        Args:
            text: Text to truncate
            max_length: Maximum length
        
        Returns:
            Truncated text
        """
        if len(text) <= max_length:
            return text
        
        return text[:max_length - 3] + "..."


class BatchProcessor:
    """Process large datasets in batches."""
    
    @staticmethod
    def batch_list(
        items: List[Any],
        batch_size: int = 32,
    ) -> List[List[Any]]:
        """
        Split list into batches.
        
        Args:
            items: List to split
            batch_size: Size of each batch
        
        Returns:
            List of batches
        """
        batches = []
        for i in range(0, len(items), batch_size):
            batches.append(items[i:i + batch_size])
        return batches
    
    @staticmethod
    def process_with_progress(
        items: List[Any],
        process_fn,
        batch_size: int = 32,
        show_progress: bool = True,
    ) -> List[Any]:
        """
        Process items with optional progress bar.
        
        Args:
            items: Items to process
            process_fn: Function to apply
            batch_size: Batch size
            show_progress: Whether to show progress
        
        Returns:
            List of processed results
        """
        results = []
        batches = BatchProcessor.batch_list(items, batch_size)
        
        iterator = (
            batches if not show_progress else
            _get_tqdm_iterator(batches, desc="Processing batches")
        )
        
        for batch in iterator:
            batch_results = process_fn(batch)
            results.extend(batch_results)
        
        return results


class DataExporter:
    """Export analysis results to various formats."""
    
    @staticmethod
    def to_json(data: Dict, filepath: str) -> None:
        """
        Export data to JSON file.
        
        Args:
            data: Data to export
            filepath: Output file path
        """
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            logger.info(f"Exported to {filepath}")
        except Exception as e:
            logger.error(f"Error exporting to JSON: {e}")
    
    @staticmethod
    def to_csv(
        data: List[Dict],
        filepath: str,
        fieldnames: Optional[List[str]] = None,
    ) -> None:
        """
        Export data to CSV file.
        
        Args:
            data: List of dictionaries to export
            filepath: Output file path
            fieldnames: Column names (auto-detected if not provided)
        """
        try:
            import csv
            
            if not data:
                logger.warning("No data to export")
                return
            
            if fieldnames is None:
                fieldnames = list(data[0].keys())
            
            with open(filepath, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(data)
            
            logger.info(f"Exported to {filepath}")
        except Exception as e:
            logger.error(f"Error exporting to CSV: {e}")
    
    @staticmethod
    def to_html_report(
        title: str,
        sections: Dict[str, str],
        filepath: str,
    ) -> None:
        """
        Export data as HTML report.
        
        Args:
            title: Report title
            sections: Dictionary of {section_name: content_html}
            filepath: Output file path
        """
        try:
            html_content = f"""
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>{title}</title>
                <style>
                    body {{ font-family: Arial, sans-serif; margin: 20px; }}
                    h1 {{ color: #333; }}
                    h2 {{ color: #666; margin-top: 30px; }}
                    table {{ border-collapse: collapse; width: 100%; margin: 20px 0; }}
                    th, td {{ border: 1px solid #ddd; padding: 10px; text-align: left; }}
                    th {{ background-color: #f2f2f2; }}
                    .stats {{ background-color: #f9f9f9; padding: 15px; border-radius: 5px; }}
                </style>
            </head>
            <body>
                <h1>{title}</h1>
                <p>Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}</p>
            """
            
            for section_name, content in sections.items():
                html_content += f"<h2>{section_name}</h2>\n{content}\n"
            
            html_content += """
            </body>
            </html>
            """
            
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(html_content)
            
            logger.info(f"Exported report to {filepath}")
        except Exception as e:
            logger.error(f"Error exporting HTML report: {e}")


def _get_tqdm_iterator(items: List, desc: str = "Processing"):
    """Get tqdm iterator if available, otherwise return plain iterator."""
    try:
        from tqdm import tqdm
        return tqdm(items, desc=desc)
    except ImportError:
        return items


class PerformanceMonitor:
    """Monitor performance metrics."""
    
    def __init__(self):
        """Initialize monitor."""
        self.metrics = {}
    
    def start(self, name: str) -> None:
        """Start timing a metric."""
        import time
        self.metrics[name] = {"start": time.time()}
    
    def end(self, name: str) -> float:
        """
        End timing a metric.
        
        Returns:
            Elapsed time in seconds
        """
        import time
        
        if name not in self.metrics:
            logger.warning(f"Metric {name} not started")
            return 0.0
        
        elapsed = time.time() - self.metrics[name]["start"]
        self.metrics[name]["elapsed"] = elapsed
        
        return elapsed
    
    def get_report(self) -> Dict:
        """Get performance report."""
        report = {}
        for name, data in self.metrics.items():
            if "elapsed" in data:
                report[name] = {
                    "elapsed_seconds": round(data["elapsed"], 4),
                    "elapsed_ms": round(data["elapsed"] * 1000, 2),
                }
        return report
    
    def print_report(self) -> None:
        """Print performance report."""
        report = self.get_report()
        print("\n=== Performance Report ===")
        for name, metrics in report.items():
            print(f"{name}: {metrics['elapsed_ms']}ms")
