"""The market analyst is bound (and prompt-instructed) to call
get_verified_market_snapshot; if the executor ToolNode doesn't register it, the
call fails and the model reports the tool "unavailable" and skips verification.

Regression guard for that wiring gap (snapshot bound to the LLM but missing from
the market ToolNode).
"""
import pytest

from tradingagents.agents.analysts.fundamentals_analyst import (
    fundamentals_tools_for_state,
)
from tradingagents.agents.analysts.market_analyst import market_tools_for_state
from tradingagents.agents.analysts.news_analyst import news_tools_for_state
from tradingagents.graph.trading_graph import TradingAgentsGraph


@pytest.mark.unit
def test_market_toolnode_can_execute_verified_snapshot():
    # _create_tool_nodes does not use self -> call unbound (avoids building LLMs).
    nodes = TradingAgentsGraph._create_tool_nodes(None)
    market_tools = set(nodes["market"].tools_by_name)
    assert "get_verified_market_snapshot" in market_tools, (
        "get_verified_market_snapshot is bound to the market analyst but not "
        "registered in the market ToolNode, so the model's call fails."
    )
    # the other core market tools must remain too
    assert {"get_stock_data", "get_indicators"} <= market_tools


@pytest.mark.unit
def test_evidence_packet_disables_competing_market_data_tools():
    assert market_tools_for_state({
        "evidence_packet": {"schemaVersion": "EvidencePacketV1"},
    }) == []
    assert {
        tool.name for tool in market_tools_for_state({})
    } == {"get_stock_data", "get_indicators", "get_verified_market_snapshot"}


@pytest.mark.unit
def test_evidence_packet_disables_parallel_news_and_fundamental_data_paths():
    state = {"evidence_packet": {"schemaVersion": "EvidencePacketV1"}}
    assert news_tools_for_state(state) == []
    assert fundamentals_tools_for_state(state) == []
    assert {tool.name for tool in news_tools_for_state({})} == {
        "get_news",
        "get_global_news",
        "get_macro_indicators",
        "get_prediction_markets",
    }
    assert {tool.name for tool in fundamentals_tools_for_state({})} == {
        "get_fundamentals",
        "get_balance_sheet",
        "get_cashflow",
        "get_income_statement",
    }
