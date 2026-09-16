"""Light, language-agnostic cleanup of model output plus the hallucination guards.

Full punctuation is the LLM's job. What happens here is the part that needs no model: vocabulary terms get
their canonical casing back, and a segment from a model that writes no punctuation at all is given a capital
letter and a full stop, so a meeting transcribed without an AI key reads as sentences rather than as one long
lowercase mumble.
"""

from __future__ import annotations

import re
from typing import Iterable, Optional

from .vocab import apply_vocabulary_casing

NO_SPEECH_PROB_LIMIT = 0.85
AVG_LOGPROB_LIMIT = -1.0
MAX_TOKEN_REPEATS = 4  # a segment that is one token repeated more than this is dropped
MAX_WORD_REPEATS = 3  # longer runs of the same word/phrase are collapsed to this many

_WS = re.compile(r"\s+")
_PUNCT_EDGES = re.compile(r"^[\s\.,;:!?\-–—\"'«»]+|[\s\-–—\"'«»]+$")


def _word_key(token: str) -> str:
    return token.casefold().strip(".,;:!?\"'«»-–—")


def collapse_repeats(text: str, max_repeats: int = MAX_WORD_REPEATS, max_ngram: int = 4) -> str:
    """Collapse runs of the same word or short phrase that occur more than ``max_repeats`` times.

    ``"já já já já já já"`` becomes ``"já já já"``; looping phrases such as
    ``"og svo og svo og svo og svo og svo"`` are collapsed the same way.
    """
    words = text.split()
    if len(words) <= max_repeats:
        return text
    keys = [_word_key(w) for w in words]
    out: list[str] = []
    out_keys: list[str] = []
    i = 0
    while i < len(words):
        collapsed = False
        for n in range(1, max_ngram + 1):
            if i + n > len(words):
                break
            phrase = keys[i : i + n]
            if not any(phrase):
                continue
            repeats = 1
            while keys[i + repeats * n : i + (repeats + 1) * n] == phrase:
                repeats += 1
            if repeats > max_repeats:
                for _ in range(max_repeats):
                    out.extend(words[i : i + n])
                    out_keys.extend(phrase)
                i += repeats * n
                collapsed = True
                break
        if not collapsed:
            out.append(words[i])
            out_keys.append(keys[i])
            i += 1
    return " ".join(out)


def clean_text(text: Optional[str]) -> str:
    """Normalise whitespace, strip stray edge punctuation and collapse runaway repetitions."""
    if not text:
        return ""
    cleaned = _WS.sub(" ", text).strip()
    cleaned = _PUNCT_EDGES.sub("", cleaned).strip()
    return collapse_repeats(cleaned)


def hallucination_reason(
    text: Optional[str],
    avg_logprob: float,
    no_speech_prob: float,
    *,
    max_token_repeats: int = MAX_TOKEN_REPEATS,
) -> Optional[str]:
    """Return why a raw model output should be dropped, or ``None`` if it looks genuine."""
    tokens = (text or "").split()
    if not tokens:
        return "empty"
    if no_speech_prob > NO_SPEECH_PROB_LIMIT and avg_logprob < AVG_LOGPROB_LIMIT:
        return f"no-speech (no_speech_prob={no_speech_prob:.2f}, avg_logprob={avg_logprob:.2f})"
    keys = {_word_key(t) for t in tokens}
    keys.discard("")
    if len(tokens) > max_token_repeats and len(keys) <= 1:
        return f"repeated-token ({tokens[0]!r} x {len(tokens)})"
    return None


_SENTENCE_END = ".!?…:;"


def sentence_case(text: str) -> str:
    """Capitalise the first letter and close the segment with a full stop.

    A segment is one run of speech between pauses, which is where a sentence usually ends, so this is a fair
    guess and a large readability win on models that emit neither capitals nor punctuation. A first word that
    already carries capitals is left alone: it came from the vocabulary list (``iPhone``, ``SAP``).
    """
    if not text:
        return text
    head = text.split(" ", 1)[0]
    if head == head.casefold():
        text = text[0].upper() + text[1:]
    if text[-1] not in _SENTENCE_END:
        text += "."
    return text


def finalize_text(
    raw_text: Optional[str],
    avg_logprob: float,
    no_speech_prob: float,
    vocabulary: Optional[Iterable[object]] = None,
    punctuated: bool = True,
) -> Optional[str]:
    """Full output pipeline for one segment: guards, cleanup, vocabulary casing, sentence shape.

    ``punctuated`` says whether the model writes its own punctuation; when it does not (the Icelandic
    fine-tunes) the segment is given a capital and a full stop here.

    Returns the text to emit, or ``None`` when the segment must be dropped.
    """
    if hallucination_reason(raw_text, avg_logprob, no_speech_prob) is not None:
        return None
    text = clean_text(raw_text)
    if not text:
        return None
    text = apply_vocabulary_casing(text, vocabulary)
    return text if punctuated else sentence_case(text)
