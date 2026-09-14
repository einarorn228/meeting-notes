from fundarritari_stt.vocab import MAX_PROMPT_TOKENS, apply_vocabulary_casing, build_initial_prompt, estimate_tokens, normalize_vocabulary


def test_normalize_vocabulary_dedupes_and_trims():
    assert normalize_vocabulary(["  Einar Örn ", "einar örn", "", None, 3, "Alþingi"]) == ["Einar Örn", "Alþingi"]
    assert normalize_vocabulary(None) == []


def test_prompt_for_punctuated_model_is_icelandic_sentence():
    prompt = build_initial_prompt(["Einar Örn", "Alþingi"], "is", punctuated=True)
    assert prompt == "Fundur. Nöfn og hugtök: Einar Örn, Alþingi."


def test_prompt_for_lowercase_model_matches_its_style():
    prompt = build_initial_prompt(["Einar Örn", "Alþingi"], "is", punctuated=False)
    assert prompt == "fundur nöfn og hugtök einar örn alþingi"


def test_prompt_english_and_empty():
    assert build_initial_prompt(["Acme"], "en").startswith("Meeting. Names and terms: Acme")
    assert build_initial_prompt([], "is") is None
    assert build_initial_prompt(["   "], "is") is None


def test_prompt_respects_token_budget():
    words = [f"Hugtak{i}þæö" for i in range(500)]
    prompt = build_initial_prompt(words, "is")
    assert prompt is not None
    assert estimate_tokens(prompt) <= MAX_PROMPT_TOKENS
    assert "Hugtak0þæö" in prompt and "Hugtak499þæö" not in prompt


def test_casing_whole_word_case_insensitive():
    text = "við töluðum við einar örn og siggu um alþingi og ALÞINGI"
    out = apply_vocabulary_casing(text, ["Einar Örn", "Sigga", "Alþingi"])
    assert out == "við töluðum við Einar Örn og siggu um Alþingi og Alþingi"


def test_casing_does_not_touch_substrings_or_lowercase_terms():
    assert apply_vocabulary_casing("ari fór á barinn", ["Ari"]) == "Ari fór á barinn"
    assert apply_vocabulary_casing("þetta er bari", ["Ari"]) == "þetta er bari"
    assert apply_vocabulary_casing("bónus er búð", ["bónus"]) == "bónus er búð"
    assert apply_vocabulary_casing("", ["Ari"]) == ""
    assert apply_vocabulary_casing("óbreytt", None) == "óbreytt"


def test_casing_prefers_longest_term():
    assert apply_vocabulary_casing("ég hitti jón sigurðsson í gær", ["Jón", "Jón Sigurðsson"]) == "ég hitti Jón Sigurðsson í gær"
