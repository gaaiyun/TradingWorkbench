"""Portfolio Manager: synthesises the risk-analyst debate into the final decision.

Uses LangChain's ``with_structured_output`` so the LLM produces a typed
``PortfolioDecision`` directly, in a single call.  The result is rendered
back to markdown for storage in ``final_trade_decision`` so memory log,
CLI display, and saved reports continue to consume the same shape they do
today.  When a provider does not expose structured output, the agent falls
back gracefully to free-text generation.
"""

from __future__ import annotations

from tradingagents.agents.schemas import PortfolioDecision, render_pm_decision
from tradingagents.agents.utils.agent_utils import (
    get_final_evidence_guardrail,
    get_instrument_context_from_state,
    get_language_instruction,
)
from tradingagents.agents.utils.structured import (
    bind_structured,
    invoke_structured_or_freetext,
)
from tradingagents.reporting import _filter_public_final_decision


def create_portfolio_manager(llm):
    structured_llm = bind_structured(llm, PortfolioDecision, "Portfolio Manager")

    def portfolio_manager_node(state) -> dict:
        instrument_context = get_instrument_context_from_state(state)

        history = state["risk_debate_state"]["history"]
        risk_debate_state = state["risk_debate_state"]
        research_plan = state["investment_plan"]
        trader_plan = state["trader_investment_plan"]

        past_context = state.get("past_context", "")
        lessons_line = (
            f"- Lessons from prior decisions and outcomes:\n{past_context}\n"
            if past_context
            else ""
        )

        prompt = f"""As the Portfolio Manager, synthesize the risk analysts' debate and deliver the final trading decision.

{instrument_context}

---

**Rating Scale** (use exactly one):
- **Buy**: Strong conviction to enter or add to position
- **Overweight**: Favorable outlook, gradually increase exposure
- **Hold**: Maintain current position, no action needed
- **Underweight**: Reduce exposure, take partial profits
- **Sell**: Exit position or avoid entry

**Context:**
- Research Manager's investment plan: **{research_plan}**
- Trader's transaction proposal: **{trader_plan}**
{lessons_line}
**Risk Analysts Debate History:**
{history}

---

Non-negotiable evidence rules:
- Every numerical claim must carry an exact bracketed Evidence ID from the packet.
- Copy every cited numerical value exactly as it appears in the Evidence ledger; do not add digits,
  round, reformat, or recompute it.
- Write one evidence-backed claim per paragraph or bullet. Every substantive paragraph or bullet must include
  at least one exact bracketed Evidence ID. Do not compress the entire Executive Summary or Investment Thesis
  into one long paragraph: an unsupported clause would otherwise invalidate unrelated supported claims.
- A statement from an earlier agent without an Evidence ID is not a verified fact.
- No user holdings, cost basis, time horizon, or risk budget were supplied in this run. Do not
  prescribe a numeric portfolio allocation, forced liquidation, entry level, or stop loss.
- Leave the optional price target fields empty unless method, inputs, range, scenario probabilities,
  and matching Evidence IDs are all present.
- In free-text fallback, use only **Rating**, **Executive Summary**, and
  **Investment Thesis** labels; do not add numbered sections or custom headings.
- Unless a cited ledger row explicitly exposes matching claimCapabilities, omit
  transmission paths, confidence calibration, counterfactual price paths, and
  corporate-action effects. Agreement among agents is not evidence.
- Policy documents and corporate actions prove only that the event occurred. Unless the ledger explicitly
  provides the effect, do not call an event a catalyst, benefit, liquidity improvement, or price effect.

Be decisive only within those evidence limits.{get_language_instruction()}
{get_final_evidence_guardrail()}"""

        final_trade_decision = invoke_structured_or_freetext(
            structured_llm,
            llm,
            prompt,
            render_pm_decision,
            "Portfolio Manager",
            required_labels=("**Rating**", "**Executive Summary**", "**Investment Thesis**"),
        )

        packet = state.get("evidence_packet")
        if isinstance(packet, dict):
            for revision_number in range(1, 3):
                _, omitted, error_codes_set = _filter_public_final_decision(
                    final_trade_decision,
                    packet,
                )
                if omitted == 0:
                    break
                error_codes = ", ".join(sorted(error_codes_set))
                revision_prompt = f"""{prompt}

---

Your previous draft failed the deterministic Evidence claim gate with these stable error codes:
{error_codes}

Previous draft:
{final_trade_decision}

Revise the draft once (bounded revision {revision_number} of 2). Preserve the three required labels,
but remove every unsupported claim and
copy every numerical value exactly from its cited ledger row. Split reasoning into short paragraphs
or bullets with an exact Evidence ID in each substantive paragraph. Never use an Evidence family
placeholder such as [M], [I], [D], [CA], [N], or [S]; every citation requires its numeric suffix,
for example [M654] or [D2]. Do not explain the validation process or repeat these error codes in the answer."""
                revised = llm.invoke(revision_prompt).content
                if all(
                    label in revised
                    for label in (
                        "**Rating**",
                        "**Executive Summary**",
                        "**Investment Thesis**",
                    )
                ):
                    final_trade_decision = revised
                else:
                    break

        new_risk_debate_state = {
            "judge_decision": final_trade_decision,
            "history": risk_debate_state["history"],
            "aggressive_history": risk_debate_state["aggressive_history"],
            "conservative_history": risk_debate_state["conservative_history"],
            "neutral_history": risk_debate_state["neutral_history"],
            "latest_speaker": "Judge",
            "current_aggressive_response": risk_debate_state["current_aggressive_response"],
            "current_conservative_response": risk_debate_state["current_conservative_response"],
            "current_neutral_response": risk_debate_state["current_neutral_response"],
            "count": risk_debate_state["count"],
        }

        return {
            "risk_debate_state": new_risk_debate_state,
            "final_trade_decision": final_trade_decision,
        }

    return portfolio_manager_node
