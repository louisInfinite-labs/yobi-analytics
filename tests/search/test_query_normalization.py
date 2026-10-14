from search.query_normalization import normalize_query


def test_trims_collapses_whitespace_and_casefolds():
    assert normalize_query("  Monster   Hunter  ") == "monster hunter"
    assert normalize_query("MONSTER HUNTER") == "monster hunter"


def test_applies_nfkc_folding_full_width_forms():
    assert normalize_query("ＳＦ６") == "sf6"  # full-width "SF6"


def test_never_rewrites_cjk_text():
    assert normalize_query("魔物獵人") == "魔物獵人"
    assert normalize_query("モンハン") == "モンハン"


def test_empty_and_whitespace_only_normalize_to_empty_string():
    assert normalize_query("") == ""
    assert normalize_query("   ") == ""
