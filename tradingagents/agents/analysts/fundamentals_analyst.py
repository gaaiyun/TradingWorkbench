from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

from tradingagents.agents.utils.agent_utils import (
    get_balance_sheet,
    get_cashflow,
    get_fundamentals,
    get_income_statement,
    get_instrument_context_from_state,
    get_language_instruction,
)


def fundamentals_tools_for_state(state):
    if isinstance(state.get("evidence_packet"), dict):
        return []
    return [
        get_fundamentals,
        get_balance_sheet,
        get_cashflow,
        get_income_statement,
    ]


def create_fundamentals_analyst(llm):
    def fundamentals_analyst_node(state):
        current_date = state["trade_date"]
        instrument_context = get_instrument_context_from_state(state)
        tools = fundamentals_tools_for_state(state)
        if tools:
            system_message = (
                "You are a researcher tasked with analyzing fundamental information over the past week about a company. Please write a comprehensive report of the company's fundamental information such as financial documents, company profile, basic company financials, and company financial history to gain a full view of the company's fundamental information to inform traders. Make sure to include as much detail as possible. Provide specific, actionable insights with supporting evidence to help traders make informed decisions."
                + " Make sure to append a Markdown table at the end of the report to organize key points in the report, organized and easy to read."
                + " Use the available tools: `get_fundamentals` for comprehensive company analysis, `get_balance_sheet`, `get_cashflow`, and `get_income_statement` for specific financial statements."
                + get_language_instruction()
            )
        else:
            system_message = (
                "Evidence-ledger mode is active. Do not call or imitate a "
                "parallel fundamentals service. Use only facts printed in the "
                "EvidencePacketV1 ledger. For an ETF, do not invent operating "
                "company financial statements, holdings, fees, NAV, tracking "
                "error, AUM, valuation, or constituent weights. A filing title "
                "proves only that the filing exists, not its unseen contents. "
                "Every number must carry its exact bracketed Evidence ID. If "
                "the ledger lacks a fundamental field, state that it is "
                "unavailable and identify the next official document needed. "
                "Do not provide a rating, allocation, price target, entry, "
                "exit, or stop. Keep the report concise: verified facts, "
                "unavailable fields, bounded inference, and next checks."
                + get_language_instruction()
            )

        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You are a helpful AI assistant, collaborating with other assistants."
                    " Use the provided tools to progress towards answering the question."
                    " If you are unable to fully answer, that's OK; another assistant with different tools"
                    " will help where you left off. Execute what you can to make progress."
                    " Do not issue a final Buy/Hold/Sell proposal; your output is evidence for later decision agents."
                    " You have access to the following tools: {tool_names}."
                    " Today's date is {current_date}; treat it as 'now' for all analysis and tool-call date ranges. {instrument_context}\n"
                    "{system_message}",
                ),
                MessagesPlaceholder(variable_name="messages"),
            ]
        )

        prompt = prompt.partial(system_message=system_message)
        prompt = prompt.partial(tool_names=", ".join([tool.name for tool in tools]))
        prompt = prompt.partial(current_date=current_date)
        prompt = prompt.partial(instrument_context=instrument_context)

        chain = prompt | (llm.bind_tools(tools) if tools else llm)

        result = chain.invoke(state["messages"])

        report = ""

        if len(result.tool_calls) == 0:
            report = result.content

        return {
            "messages": [result],
            "fundamentals_report": report,
        }

    return fundamentals_analyst_node
