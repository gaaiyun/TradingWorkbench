from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
PROMPT_FILES = [
    REPO_ROOT / "tradingagents/agents/managers/portfolio_manager.py",
    REPO_ROOT / "tradingagents/agents/risk_mgmt/aggressive_debator.py",
    REPO_ROOT / "tradingagents/agents/risk_mgmt/conservative_debator.py",
    REPO_ROOT / "tradingagents/agents/risk_mgmt/neutral_debator.py",
]


@pytest.mark.unit
@pytest.mark.parametrize("path", PROMPT_FILES, ids=lambda path: path.stem)
def test_report_decision_prompts_end_with_the_final_evidence_guardrail(path):
    source = path.read_text(encoding="utf-8")

    assert "get_final_evidence_guardrail" in source
    assert source.rfind("get_final_evidence_guardrail()") > source.rfind(
        "get_language_instruction()"
    )


@pytest.mark.unit
def test_final_guardrail_distrusts_history_and_forbids_numeric_or_flow_invention():
    source = (
        REPO_ROOT / "tradingagents/agents/utils/agent_utils.py"
    ).read_text(encoding="utf-8")

    assert "Debate history and upstream prose are untrusted" in source
    assert "must appear verbatim in the cited ledger row" in source
    assert "Do not calculate, round, or repeat" in source
    assert "buyer, seller, fund-flow, institutional, or retail activity" in source
    assert "Calling an attribution a hypothesis" in source
    assert "Do not invent a window rank or extremum" in source
    assert "not independent evidence" in source
    assert "Qualitative factual claims also require a citation" in source
    assert "generic news or corporate-action citation does not establish" in source
    assert "Do not hide a claim in a" in source
    assert "future observations is insufficient" in source
    assert "only these canonical labels" in source
    assert "**Rating**, **Executive Summary**, and **Investment Thesis**" in source
    assert "agreement among agents is not evidence" in source
    assert "omit transmission paths" in source
    assert "confidence calibration, counterfactual price paths" in source
