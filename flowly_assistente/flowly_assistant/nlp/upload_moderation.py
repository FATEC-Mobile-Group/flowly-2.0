from __future__ import annotations

import base64
import re
import unicodedata
from typing import Any, Dict, List


BLOCKED_CATEGORIES = [
    "explicit_pornography",
    "suggestive_content",
    "violence",
    "gore",
    "hate_symbols",
    "offensive_content",
]

# Mesmas regras de flowly_api/services/uploadSafetyService.js (FILENAME_RULES e TEXT_RULES).
# Termos comparados como palavras inteiras, sem acento e em minusculas: "sexta", "episodio" e
# "Gorete" nao contem "sex", "odio" e "gore". Isto e correspondencia de texto, nao analise de significado.

# Palavras que, sozinhas, ja nomeiam material pornografico (flexoes e compostos explicitos).
PORN_WORDS = [
    "porn",
    "porno",
    "pornos",
    "pornografia",
    "pornografias",
    "pornografico",
    "pornograficos",
    "pornografica",
    "pornograficas",
    "pornography",
    "pornographic",
    "pornstar",
    "pornstars",
    "pornhub",
    "youporn",
]

# Expressoes explicitas. Palavras de tema ("sangue", "violencia", "nazismo", "sexo") ficam de fora sozinhas.
PROHIBITED_PHRASES = [
    "pornografia explicita",
    "conteudo sexual",
    "sexo explicito",
    "sexually explicit",
    "simbolo de odio",
    "simbolos de odio",
    "hate symbol",
    "hate symbols",
    "ku klux klan",
    "white supremacy",
    "white supremacist",
    "white supremacists",
    "white supremacism",
    "supremacia branca",
    "heil hitler",
    "sieg heil",
    "apologia ao nazismo",
]

# Compostos colados (freeporn, PORNvideo): so raiz + prefixo e/ou sufixo destas listas fechadas, como palavra
# inteira. Nao e busca por trecho: "foodporn", "Pornic" e "earthporn" nao formam composto da lista.
PORN_COMPOUND_ROOTS = ["porn", "porno"]
PORN_COMPOUND_PREFIXES = ["free", "hard", "hardcore", "softcore", "xxx", "hd", "live", "amateur"]
PORN_COMPOUND_SUFFIXES = [
    "video", "videos", "vid", "vids", "tube", "site", "sites", "star", "stars", "hub", "pic", "pics",
    "foto", "fotos", "filme", "filmes", "film", "films", "movie", "movies", "clip", "clips", "cam", "cams",
]
PORN_COMPOUNDS = sorted(
    {prefix + root for root in PORN_COMPOUND_ROOTS for prefix in PORN_COMPOUND_PREFIXES}
    | {root + suffix for root in PORN_COMPOUND_ROOTS for suffix in PORN_COMPOUND_SUFFIXES}
    | {
        prefix + root + suffix
        for root in PORN_COMPOUND_ROOTS
        for prefix in PORN_COMPOUND_PREFIXES
        for suffix in PORN_COMPOUND_SUFFIXES
    }
)

FILENAME_TERMS = PORN_WORDS + PROHIBITED_PHRASES
TEXT_TERMS = PROHIBITED_PHRASES


def _to_words(value: str) -> str:
    """ " palavra palavra ": sem acento, minusculo; camelCase, letra/digito e separadores viram espaco."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = re.sub(r"[̀-ͯ]", "", text)
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    text = text.lower()
    text = re.sub(r"([a-z])(\d)", r"\1 \2", text)
    text = re.sub(r"(\d)([a-z])", r"\1 \2", text)
    text = re.sub(r"[^a-z0-9]+", " ", text).strip()
    return f" {text} "


def _contains_term(value: str, terms: List[str]) -> bool:
    words = _to_words(value)
    return any(f" {term} " in words for term in terms)


def moderate_upload_payload(body: Dict[str, Any]) -> Dict[str, Any]:
    filename = str(body.get("filename") or "")
    mimetype = str(body.get("mimetype") or "")
    content_base64 = str(body.get("contentBase64") or "")

    categories: List[str] = []
    if _contains_term(filename, FILENAME_TERMS + PORN_COMPOUNDS):
        categories.append("offensive_content")

    if mimetype == "application/pdf" and content_base64:
        sample = _decode_sample(content_base64)
        if _contains_term(sample, TEXT_TERMS):
            categories.append("offensive_content")

    # Hook para substituir por classificador visual real:
    # OpenAI Vision/Moderation, Google Vision SafeSearch, AWS Rekognition etc.
    allowed = not any(category in BLOCKED_CATEGORIES for category in categories)
    return {
        "allowed": allowed,
        "categories": sorted(set(categories)),
        "reason": "" if allowed else "Arquivo bloqueado pela moderacao de upload.",
        "provider": "flowly_assistant_upload_moderation",
    }


def _decode_sample(content_base64: str) -> str:
    try:
        raw = base64.b64decode(content_base64[:700_000], validate=False)
    except Exception:
        return ""
    return raw[:512_000].decode("latin1", errors="ignore")
