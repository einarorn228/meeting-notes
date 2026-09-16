"""Vocabulary support: the meeting's names and terms, used to restore their casing in the output and - for
models that can take it - to bias the decoder through Whisper's ``initial_prompt``."""

from __future__ import annotations

import math
import re
from functools import lru_cache
from typing import Iterable, Optional, Pattern, Sequence, Tuple

# Whisper allows at most 224 prompt tokens; stay well below so the prompt never gets truncated.
MAX_PROMPT_TOKENS = 200

_PROMPT_PREFIX = {
    "is": ("Fundur.", "Nöfn og hugtök:"),
    "en": ("Meeting.", "Names and terms:"),
}


def normalize_vocabulary(vocabulary: Optional[Iterable[object]]) -> list[str]:
    """Trim, drop empties and case-insensitive duplicates, keep the original order."""
    if not vocabulary:
        return []
    seen: set[str] = set()
    result: list[str] = []
    for raw in vocabulary:
        if not isinstance(raw, str):
            continue
        term = " ".join(raw.split())
        key = term.casefold()
        if not term or key in seen:
            continue
        seen.add(key)
        result.append(term)
    return result


def estimate_tokens(text: str) -> int:
    """Rough BPE token estimate for Icelandic/English text (Whisper's tokenizer is byte-level,
    and accented letters cost extra, hence ~3 characters per token)."""
    return int(math.ceil(len(text) / 3.0))


def build_initial_prompt(
    vocabulary: Optional[Iterable[object]],
    language: Optional[str] = "is",
    punctuated: bool = True,
    max_tokens: int = MAX_PROMPT_TOKENS,
) -> Optional[str]:
    """Build a prompt such as ``"Fundur. Nöfn og hugtök: Einar Örn, Alþingi."`` - or nothing at all.

    ``punctuated`` says whether the model writes its own punctuation, which is also what separates a stock
    Whisper model from the Icelandic fine-tunes. Stock Whisper takes a prompt the way the Whisper paper
    describes. The fine-tunes do not: they were trained to emit bare lowercase speech, and a list of names in
    front of that pushes them out of what they know. Measured on Spjallrómur conversations, a prompt made them
    drop words, invert meaning ("gengur upp" became "gengur ekki") and, often enough to matter, run away
    repeating the prompt until Whisper's own quality thresholds forced a re-decode at every fallback
    temperature - 153 seconds of processing for four seconds of speech, and a transcript worse than useless.
    So they get no prompt. The vocabulary still restores their spelling afterwards and still goes to the AI
    pass, which corrects names from context instead of guessing at them mid-decode.
    """
    if not punctuated:
        return None
    terms = normalize_vocabulary(vocabulary)
    if not terms:
        return None
    lead, label = _PROMPT_PREFIX.get((language or "is").lower(), _PROMPT_PREFIX["en"])
    kept: list[str] = []
    for term in terms:
        candidate = _render_prompt(lead, label, kept + [term])
        if estimate_tokens(candidate) > max_tokens:
            break
        kept.append(term)
    if not kept:
        return None
    return _render_prompt(lead, label, kept)


def _render_prompt(lead: str, label: str, terms: Sequence[str]) -> str:
    return f"{lead} {label} {', '.join(terms)}."


@lru_cache(maxsize=32)
def _casing_pattern(terms: Tuple[str, ...]) -> Optional[Tuple[Pattern[str], dict[str, str]]]:
    """Compile one alternation for all terms whose spelling contains uppercase letters."""
    cased = [t for t in terms if t != t.casefold()]
    if not cased:
        return None
    # Longest first so "Einar Örn" wins over "Einar".
    cased.sort(key=len, reverse=True)
    alternation = "|".join(re.escape(t).replace(r"\ ", r"\s+") for t in cased)
    pattern = re.compile(rf"(?<!\w)(?:{alternation})(?!\w)", re.IGNORECASE | re.UNICODE)
    lookup = {" ".join(t.split()).casefold(): t for t in cased}
    return pattern, lookup


def apply_vocabulary_casing(text: str, vocabulary: Optional[Iterable[object]]) -> str:
    """Case-insensitive whole-word replacement of vocabulary terms with their canonical spelling."""
    if not text:
        return text
    terms = tuple(normalize_vocabulary(vocabulary))
    compiled = _casing_pattern(terms)
    if compiled is None:
        return text
    pattern, lookup = compiled

    def replace(match: "re.Match[str]") -> str:
        key = " ".join(match.group(0).split()).casefold()
        return lookup.get(key, match.group(0))

    return pattern.sub(replace, text)
