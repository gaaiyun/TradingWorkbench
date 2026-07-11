import { RAW_BASE, gate, json, readJsonBody } from "./_util.js";

const ARK_URL = "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions";
const MAX_CONTEXT_CHARS = 22000;
const MAX_QUESTION_CHARS = 1200;

// POST /api/chat {code, question, report?, history?}
// 基于指定报告（或最新决策摘要）用 glm-5.2 回答问题。
export async function onRequestPost({ request, env }) {
  const body = await readJsonBody(request);
  if (!body) return json({ error: "请求体不是合法 JSON" }, 400);
  if (!gate(env, body.code)) return json({ error: "访问码不正确" }, 401);
  if (!env.OPENAI_COMPATIBLE_API_KEY) return json({ error: "服务端未配置 LLM key" }, 500);

  const question = String(body.question || "").trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) return json({ error: "问题为空" }, 400);

  // 上下文材料：优先取指定报告，否则取最新决策 JSON
  let context = "";
  let contextLabel = "";
  const reportPath = String(body.report || "");
  if (/^reports\/[A-Za-z0-9._\-\/]+\.md$/.test(reportPath) && !reportPath.includes("..")) {
    const r = await fetch(`${RAW_BASE}/${reportPath}`, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (r.ok) {
      context = (await r.text()).slice(0, MAX_CONTEXT_CHARS);
      contextLabel = reportPath;
    }
  }
  if (!context) {
    const r = await fetch(`${RAW_BASE}/data/latest.json`, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (r.ok) {
      context = (await r.text()).slice(0, MAX_CONTEXT_CHARS);
      contextLabel = "latest.json";
    }
  }

  const messages = [
    {
      role: "system",
      content:
        "你是 TradingAgents 研究终端的分析助理。仅依据提供的研究材料回答，" +
        "材料没有的信息就明说没有，不要编造数字。中文回答，直接、简洁、可执行。" +
        "结尾不加免责声明（页面已有）。",
    },
  ];
  // 携带最近几轮对话（可选）
  for (const turn of Array.isArray(body.history) ? body.history.slice(-6) : []) {
    if (turn && (turn.role === "user" || turn.role === "assistant") && turn.content) {
      messages.push({ role: turn.role, content: String(turn.content).slice(0, 2000) });
    }
  }
  messages.push({
    role: "user",
    content: `【研究材料 ${contextLabel}】\n${context}\n\n【问题】${question}`,
  });

  const resp = await fetch(ARK_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_COMPATIBLE_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "glm-5.2", messages, max_tokens: 1400, temperature: 0.3 }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    return json({ error: `LLM 上游错误 (${resp.status})`, detail: detail.slice(0, 200) }, 502);
  }
  const data = await resp.json();
  const answer = data?.choices?.[0]?.message?.content || "";
  return json({ answer, context: contextLabel });
}
