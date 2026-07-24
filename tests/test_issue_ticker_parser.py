from scripts.parse_issue_tickers import extract_tickers_from_issue_body


def test_issue_parser_reads_only_the_structured_ticker_field():
    body = """### 标的代码

NVDA, 600519, 03887

### 备注

Please review this ISSUE and API output.
"""
    assert extract_tickers_from_issue_body(body) == ["NVDA", "600519.SS", "3887.HK"]


def test_issue_title_and_free_text_are_never_guessed_as_tickers():
    assert extract_tickers_from_issue_body("") == []
    assert extract_tickers_from_issue_body("Analyze ISSUE and NEW API") == []
    assert extract_tickers_from_issue_body("### 备注\n\nGOOGL") == []


def test_issue_parser_accepts_google_aliases_and_rejects_invalid_tokens():
    body = "### 标的代码\n\nGOOGL GOOG 3887.HK BTC-USD BAD!"
    assert extract_tickers_from_issue_body(body) == ["GOOGL", "GOOG", "3887.HK"]
