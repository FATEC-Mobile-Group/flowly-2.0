from __future__ import annotations

import os
from dataclasses import dataclass
from dotenv import load_dotenv


load_dotenv()


def _get_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


@dataclass(frozen=True)
class Settings:
    base_url: str = os.getenv("FLOWLY_API_BASE_URL", "http://localhost:5000/api").rstrip("/")
    api_base_url: str = base_url  # Usar diretamente, já inclui /api
    api_token: str = os.getenv("FLOWLY_API_TOKEN", "").strip()

    api_timeout_sec: float = float(os.getenv("FLOWLY_API_TIMEOUT_SEC", os.getenv("FLOWLY_API_TIMEOUT", "20")))
    debug: bool = _get_bool("FLOWLY_DEBUG", False)

    # Forçar modo texto (não usa microfone/Google STT)
    text_only: bool = _get_bool("FLOWLY_TEXT_ONLY", False)

    # Permite desligar TTS (evita travas do pyttsx3 em alguns ambientes)
    tts_enabled: bool = _get_bool("FLOWLY_TTS_ENABLED", True)

    # Optional; if empty we'll try to detect via /users/me
    user_type: str = os.getenv("FLOWLY_USER_TYPE", "").strip().lower()  # admin|user

    language: str = os.getenv("FLOWLY_LANGUAGE", "pt-BR")
    listen_timeout: int = int(os.getenv("FLOWLY_LISTEN_TIMEOUT", "5"))
    phrase_time_limit: int = int(os.getenv("FLOWLY_PHRASE_TIME_LIMIT", "10"))

    # SpeechRecognition tuning (google)
    sr_energy_threshold: int = int(os.getenv("FLOWLY_SR_ENERGY_THRESHOLD", "300"))
    sr_dynamic_energy: bool = os.getenv("FLOWLY_SR_DYNAMIC_ENERGY", "True").lower() == "true"
    sr_pause_threshold: float = float(os.getenv("FLOWLY_SR_PAUSE_THRESHOLD", "0.8"))
    sr_non_speaking_duration: float = float(os.getenv("FLOWLY_SR_NON_SPEAKING_DURATION", "0.5"))

    match_threshold: int = int(os.getenv("FLOWLY_MATCH_THRESHOLD", "78"))

    tts_rate: int = int(os.getenv("FLOWLY_TTS_RATE", "175"))
    tts_volume: float = float(os.getenv("FLOWLY_TTS_VOLUME", "1.0"))

    def validate(self) -> None:
        if not self.api_token:
            raise ValueError("FLOWLY_API_TOKEN não configurado (.env)")


def get_settings() -> Settings:
    settings = Settings()
    settings.validate()
    return settings
