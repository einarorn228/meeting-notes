from fundarritari_stt.postprocess import clean_text, collapse_repeats, finalize_text, hallucination_reason


def test_guard_drops_empty():
    assert hallucination_reason("", -0.1, 0.0) == "empty"
    assert hallucination_reason("   ", -0.1, 0.0) == "empty"
    assert finalize_text(None, 0, 0) is None


def test_guard_no_speech_requires_both_conditions():
    assert hallucination_reason("takk fyrir", -1.5, 0.9) is not None
    assert hallucination_reason("takk fyrir", -0.5, 0.9) is None
    assert hallucination_reason("takk fyrir", -1.5, 0.5) is None


def test_guard_repeated_token():
    assert hallucination_reason("já já já já já", -0.2, 0.1) is not None
    assert hallucination_reason("já já já já", -0.2, 0.1) is None  # 4 repeats allowed
    assert hallucination_reason("Já, já. JÁ já já!", -0.2, 0.1) is not None
    assert hallucination_reason("já nei já já já já", -0.2, 0.1) is None


def test_collapse_repeats_words_and_phrases():
    assert collapse_repeats("já já já já já já nei") == "já já já nei"
    assert collapse_repeats("og svo og svo og svo og svo og svo búið") == "og svo og svo og svo búið"
    assert collapse_repeats("ekki ekki ekki") == "ekki ekki ekki"
    assert collapse_repeats("") == ""


def test_clean_text_whitespace_and_edges():
    assert clean_text("  þetta   er \n prófun. ") == "þetta er prófun."
    assert clean_text("- halló") == "halló"
    assert clean_text(None) == ""


def test_finalize_text_pipeline():
    assert finalize_text(" fundur með jóni  jóni ", -0.2, 0.1, ["Jón"]) == "fundur með jóni jóni"
    assert finalize_text("halló einar", -0.2, 0.1, ["Einar"]) == "halló Einar"
    assert finalize_text("ha ha ha ha ha ha", -0.2, 0.1) is None
    assert finalize_text("...", -0.2, 0.1) is None
