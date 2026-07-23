import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_DEFAULTS,
  createSseParser,
  loadResearchContext,
  normalizeHistory,
  prepareChatMessages,
  resolveChatConfig,
} from "../functions/api/_chat.mjs";
import { onRequestGet, onRequestPost } from "../functions/api/chat.js";

const BASE_ENV = Object.freeze({
  ACCESS_CODE: "access-code",
  OPENAI_COMPATIBLE_API_KEY: "api-secret",
});

function chatRequest(body, extraHeaders = {}) {
  return new Request("https://example.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("默认配置保持 Ark 和 glm-5.2，并支持 endpoint/model/key binding 覆盖", () => {
  const defaults = resolveChatConfig(BASE_ENV);
  assert.equal(defaults.endpoint, CHAT_DEFAULTS.endpoint);
  assert.equal(defaults.model, "glm-5.2");
  assert.equal(defaults.apiKey, "api-secret");
  assert.equal(defaults.thinkingType, "disabled");
  assert.equal(defaults.ready, true);

  const configured = resolveChatConfig({
    ACCESS_CODE: "code",
    TRADINGAGENTS_LLM_BACKEND_URL: "https://relay.example/v1/",
    TRADINGAGENTS_CHAT_MODEL: "relay-model",
    TRADINGAGENTS_CHAT_API_KEY_ENV: "RELAY_SECRET",
    RELAY_SECRET: "relay-key",
  });
  assert.equal(configured.endpoint, "https://relay.example/v1/chat/completions");
  assert.equal(configured.model, "relay-model");
  assert.equal(configured.apiKey, "relay-key");
  assert.equal(configured.thinkingType, "");
  assert.equal(configured.ready, true);

  const explicitThinking = resolveChatConfig({
    ...BASE_ENV,
    TRADINGAGENTS_CHAT_MODEL: "relay-model",
    CHAT_THINKING_TYPE: "auto",
  });
  assert.equal(explicitThinking.thinkingType, "auto");

  const keyless = resolveChatConfig({
    ACCESS_CODE: "code",
    CHAT_REQUIRE_API_KEY: "false",
  });
  assert.equal(keyless.configured.apiKey, false);
  assert.equal(keyless.apiKeyRequired, false);
  assert.equal(keyless.ready, true);

  const insecureRemote = resolveChatConfig({
    ...BASE_ENV,
    TRADINGAGENTS_CHAT_ENDPOINT: "http://relay.example/v1",
    CHAT_ALLOW_INSECURE_HTTP: "true",
  });
  assert.equal(insecureRemote.configured.endpoint, false);
  assert.equal(insecureRemote.ready, false);

  const localDevelopment = resolveChatConfig({
    ACCESS_CODE: "code",
    CHAT_REQUIRE_API_KEY: "false",
    TRADINGAGENTS_CHAT_ENDPOINT: "http://127.0.0.1:8000/v1",
    CHAT_ALLOW_INSECURE_HTTP: "true",
  });
  assert.equal(localDevelopment.configured.endpoint, true);
  assert.equal(localDevelopment.ready, true);
});

test("GET 只返回配置状态和能力，不泄露配置值", async () => {
  const response = await onRequestGet({
    env: {
      ACCESS_CODE: "private-access-code",
      OPENAI_COMPATIBLE_API_KEY: "private-api-key",
      TRADINGAGENTS_CHAT_ENDPOINT: "https://private-relay.example/v1",
      TRADINGAGENTS_CHAT_MODEL: "private-model-name",
    },
  });
  const text = await response.text();
  const data = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(data.status, "ready");
  assert.deepEqual(data.configured, {
    accessCode: true,
    apiKey: true,
    endpoint: true,
    model: true,
  });
  assert.equal(data.capabilities.streaming, true);
  assert.equal(data.requirements.apiKey, true);
  assert.equal(text.includes("private-access-code"), false);
  assert.equal(text.includes("private-api-key"), false);
  assert.equal(text.includes("private-relay"), false);
  assert.equal(text.includes("private-model-name"), false);
});

test("history 同时受轮数、单条和总字符限额约束，并优先保留最近轮次", () => {
  const history = normalizeHistory(
    [
      { role: "user", content: "old" },
      { role: "assistant", content: "BBBBBB" },
      { role: "user", content: "CCCCCC" },
      { role: "system", content: "ignored" },
    ],
    { historyTurns: 3, historyItemChars: 4, historyChars: 6 },
  );
  assert.deepEqual(history, [
    { role: "assistant", content: "BB" },
    { role: "user", content: "CCCC" },
  ]);
});

test("统一输入预算预留输出窗口，并优先裁剪旧历史和上下文", () => {
  const config = resolveChatConfig({
    ...BASE_ENV,
    CHAT_CONTEXT_WINDOW_TOKENS: "4096",
    CHAT_MAX_TOKENS: "1000",
    CHAT_MAX_INPUT_CHARS: "10000",
  });
  const prepared = prepareChatMessages({
    question: "Q".repeat(300),
    history: [
      { role: "user", content: "U".repeat(2000) },
      { role: "assistant", content: "A".repeat(2000) },
    ],
    context: "C".repeat(5000),
    contextLabel: "latest.json",
    limits: config.limits,
  });

  assert.equal(config.maxTokens, 1000);
  assert.equal(config.limits.inputChars + config.maxTokens + 512 <= 4096, true);
  assert.equal(prepared.input.chars <= config.limits.inputChars, true);
  assert.equal(prepared.input.historyChars < 4000, true);
  assert.equal(prepared.input.contextTruncated, true);
});

test("上下文按 VolGuard、报告、latest 降级，并返回来源和截断元数据", async () => {
  const calls = [];
  const result = await loadResearchContext({
    body: { volguard: true, report: "reports/NVDA/report.md" },
    rawBase: "https://raw.example/public",
    contextLimit: 5,
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response("unavailable", { status: 503 });
      return new Response("123456789", { status: 200 });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.context, "12345");
  assert.equal(result.contextLabel, "reports/NVDA/report.md");
  assert.deepEqual(result.source, {
    type: "report",
    label: "reports/NVDA/report.md",
    path: "reports/NVDA/report.md",
    chars: 5,
    truncated: true,
  });
});

test("成功但为空的高优先级上下文会继续降级", async () => {
  const calls = [];
  const result = await loadResearchContext({
    body: { volguard: true, report: "reports/NVDA/report.md" },
    rawBase: "https://raw.example/public",
    contextLimit: 100,
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(calls.length < 3 ? "" : "latest context", { status: 200 });
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(result.context, "latest context");
  assert.equal(result.source.type, "latest");
});

test("上下文候选共享总 deadline，并随浏览器 signal 取消", async () => {
  let clock = 0;
  let calls = 0;
  const result = await loadResearchContext({
    body: { volguard: true, report: "reports/NVDA/report.md" },
    rawBase: "https://raw.example/public",
    contextLimit: 100,
    timeoutMs: 1000,
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      clock += 600;
      return new Response("unavailable", { status: 503 });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.source.type, "none");

  const abortController = new AbortController();
  abortController.abort();
  calls = 0;
  await loadResearchContext({
    body: { volguard: true },
    rawBase: "https://raw.example/public",
    contextLimit: 100,
    timeoutMs: 1000,
    signal: abortController.signal,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({});
    },
  });
  assert.equal(calls, 0);
});

test("header 访问码先于 body 解析，legacy body code 仍兼容且 body 有硬上限", async () => {
  const oversized = {
    code: "access-code",
    question: "问题",
    padding: "X".repeat(5000),
  };
  const earlyAuth = await onRequestPost({
    request: chatRequest(oversized, { "x-access-code": "wrong-code" }),
    env: { ...BASE_ENV, CHAT_MAX_REQUEST_BYTES: "1024" },
  });
  assert.equal(earlyAuth.status, 401);
  assert.equal((await earlyAuth.json()).code, "invalid_access_code");

  const limited = await onRequestPost({
    request: chatRequest(oversized, { "x-access-code": "access-code" }),
    env: { ...BASE_ENV, CHAT_MAX_REQUEST_BYTES: "1024" },
  });
  assert.equal(limited.status, 413);
  assert.equal((await limited.json()).code, "request_too_large");
});

test("生产配置拒绝 HTTP 上游，避免 Bearer key 明文发送", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called");
  });
  const response = await onRequestPost({
    request: chatRequest({ code: "access-code", question: "问题" }),
    env: { ...BASE_ENV, TRADINGAGENTS_CHAT_ENDPOINT: "http://relay.example/v1" },
  });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, "llm_not_configured");
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("非流式 POST 保持 answer/context JSON，并使用可配置上游", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("raw.githubusercontent.com")) {
      return jsonResponse({ ticker: "NVDA", decision: "BUY" });
    }
    return jsonResponse({
      choices: [{ message: { content: "基于材料的回答" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });

  const response = await onRequestPost({
    request: chatRequest({
      code: "access-code",
      question: "怎么看？",
      history: [{ role: "user", content: "上一问" }],
    }),
    env: {
      ...BASE_ENV,
      TRADINGAGENTS_LLM_BACKEND_URL: "https://relay.example/v1",
      TRADINGAGENTS_CHAT_MODEL: "configured-model",
    },
  });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.answer, "基于材料的回答");
  assert.equal(data.context, "latest.json");
  assert.equal(data.source.type, "latest");
  assert.equal(data.requestId, response.headers.get("x-request-id"));
  assert.deepEqual(data.usage, { prompt_tokens: 10, completion_tokens: 5 });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://relay.example/v1/chat/completions");
  assert.equal(calls[1].init.headers.authorization, "Bearer api-secret");
  assert.equal(calls[1].init.headers["x-request-id"], data.requestId);
  const payload = JSON.parse(calls[1].init.body);
  assert.equal(payload.model, "configured-model");
  assert.equal("stream" in payload, false);
  assert.equal("thinking" in payload, false);
  assert.equal(payload.messages[0].content.includes("不受信任的数据"), true);
  assert.equal(payload.messages[0].content.includes("不输出密钥"), true);
  assert.equal(payload.messages.at(-1).content.includes("怎么看？"), true);
});

test("stream=true 将 OpenAI SSE 标准化为 meta/delta/done", async (t) => {
  const encoder = new TextEncoder();
  let llmPayload;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (String(url).includes("raw.githubusercontent.com")) {
      return jsonResponse({ ticker: "NVDA" });
    }
    llmPayload = JSON.parse(init.body);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"第一"}}]}\n\n'),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"段"}}],"usage":{"completion_tokens":2}}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });

  const response = await onRequestPost({
    request: chatRequest({ code: "access-code", question: "流式回答", stream: true }),
    env: BASE_ENV,
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(llmPayload.stream, true);
  assert.deepEqual(llmPayload.thinking, { type: "disabled" });
  assert.match(text, /event: meta/);
  assert.match(text, /event: delta\ndata: {"content":"第一"}/);
  assert.match(text, /event: delta\ndata: {"content":"段"}/);
  assert.match(text, /event: done/);
  assert.match(text, /"completion_tokens":2/);
});

test("上游忽略 stream 时合成兼容 SSE", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("raw.githubusercontent.com")) return jsonResponse({ ticker: "SPY" });
    return jsonResponse({ choices: [{ message: { content: "一次性回答" } }] });
  });

  const response = await onRequestPost({
    request: chatRequest({ code: "access-code", question: "问题", stream: true }),
    env: BASE_ENV,
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  assert.match(text, /event: delta\ndata: {"content":"一次性回答"}/);
  assert.match(text, /event: done/);
});

test("浏览器取消 SSE 后同步取消上游流且不再写错误事件", async (t) => {
  let upstreamCancelled = false;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("raw.githubusercontent.com")) return jsonResponse({ ticker: "SPY" });
    const body = new ReadableStream({
      cancel() {
        upstreamCancelled = true;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });

  const response = await onRequestPost({
    request: chatRequest({ code: "access-code", question: "问题", stream: true }),
    env: BASE_ENV,
  });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value).includes("event: meta"), true);
  await reader.cancel("test client disconnected");
  assert.equal(upstreamCancelled, true);
});

test("上游状态被归一化，错误体不回显原始详情", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("raw.githubusercontent.com")) return jsonResponse({ ticker: "SPY" });
    return new Response("provider detail with api-secret", { status: 429 });
  });

  const response = await onRequestPost({
    request: chatRequest({ code: "access-code", question: "问题" }),
    env: BASE_ENV,
  });
  const text = await response.text();
  const data = JSON.parse(text);
  assert.equal(response.status, 503);
  assert.equal(data.code, "upstream_rate_limited");
  assert.equal(data.upstreamStatus, 429);
  assert.equal(data.requestId, response.headers.get("x-request-id"));
  assert.equal(text.includes("provider detail"), false);
  assert.equal(text.includes("api-secret"), false);
});

test("SSE 单事件和累计输出超过上限时中止并返回稳定 error event", async (t) => {
  const encoder = new TextEncoder();
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("raw.githubusercontent.com")) return jsonResponse({ ticker: "SPY" });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "X".repeat(300) } }] })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });

  const response = await onRequestPost({
    request: chatRequest({ code: "access-code", question: "问题", stream: true }),
    env: { ...BASE_ENV, CHAT_MAX_OUTPUT_CHARS: "256" },
  });
  const text = await response.text();
  assert.match(text, /event: error/);
  assert.match(text, /"code":"upstream_response_too_large"/);
  assert.equal(text.includes("event: done"), false);
});

test("LLM 请求超时归一化为 504 和稳定错误码", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (String(url).includes("raw.githubusercontent.com")) return jsonResponse({ ticker: "SPY" });
    return new Promise((resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        },
        { once: true },
      );
    });
  });

  const response = await onRequestPost({
    request: chatRequest({ code: "access-code", question: "问题" }),
    env: { ...BASE_ENV, CHAT_TIMEOUT_MS: "1000" },
  });
  const data = await response.json();
  assert.equal(response.status, 504);
  assert.equal(data.code, "upstream_timeout");
  assert.equal(data.requestId, response.headers.get("x-request-id"));
});

test("SSE parser 支持跨 chunk 和 CRLF 边界", () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push("event: delta\r\ndata: {\"content\":\"A"), []);
  assert.deepEqual(parser.push("\"}\r\n\r\n"), [
    { event: "delta", data: '{"content":"A"}' },
  ]);
  assert.deepEqual(parser.push("data: [DONE]"), []);
  assert.deepEqual(parser.finish(), [{ event: "message", data: "[DONE]" }]);

  const bounded = createSseParser(8);
  assert.throws(
    () => bounded.push("data: an event without a delimiter"),
    (error) => error.code === "upstream_sse_event_too_large",
  );
});
