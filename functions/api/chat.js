import { RAW_BASE, gate, json } from "./_util.js";
import {
  chatCapabilities,
  createSseParser,
  extractChatAnswer,
  extractChatDelta,
  formatSseEvent,
  loadResearchContext,
  normalizeFetchError,
  normalizeQuestion,
  normalizeUpstreamStatus,
  prepareChatMessages,
  readJsonBodyLimited,
  resolveChatConfig,
  safeUsage,
} from "./_chat.mjs";

function requestId() {
  return globalThis.crypto?.randomUUID?.() || `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function responseHeaders(id, extra = {}) {
  return { "x-request-id": id, ...extra };
}

function errorJson(id, error, status, code, extra = {}) {
  return json(
    { error, code, requestId: id, ...extra },
    status,
    responseHeaders(id, { "cache-control": "no-store" }),
  );
}

function llmHeaders(config, id) {
  const headers = { "content-type": "application/json", "x-request-id": id };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return headers;
}

async function fetchLlm(config, payload, id, requestSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromClient = () => controller.abort();
  if (requestSignal?.aborted) controller.abort();
  else requestSignal?.addEventListener("abort", abortFromClient, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeouts.llmMs);
  const cleanup = () => {
    clearTimeout(timer);
    requestSignal?.removeEventListener("abort", abortFromClient);
  };
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: llmHeaders(config, id),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return {
      response,
      abort: () => controller.abort(),
      cleanup,
      timedOut: () => timedOut,
    };
  } catch (error) {
    const didTimeOut = timedOut;
    cleanup();
    if (didTimeOut && error?.name !== "AbortError") {
      const timeoutError = new Error("LLM request timed out");
      timeoutError.name = "AbortError";
      throw timeoutError;
    }
    throw error;
  }
}

function upstreamError(id, status) {
  const normalized = normalizeUpstreamStatus(status);
  return errorJson(id, normalized.error, normalized.status, normalized.code, {
    upstreamStatus: status,
  });
}

async function jsonChatResponse({ upstream, id, contextLabel, source, limits }) {
  try {
    const data = await upstream.response.json();
    const answer = extractChatAnswer(data);
    if (!answer) {
      return errorJson(id, "LLM 上游返回无效内容", 502, "upstream_invalid_response");
    }
    if (answer.length > limits.outputChars) {
      return errorJson(id, "LLM 上游响应超过限制", 502, "upstream_response_too_large");
    }
    return json(
      {
        answer,
        context: contextLabel,
        requestId: id,
        source,
        ...(safeUsage(data) ? { usage: safeUsage(data) } : {}),
      },
      200,
      responseHeaders(id, { "cache-control": "no-store" }),
    );
  } catch (error) {
    if (upstream.timedOut() || error?.name === "AbortError") {
      const normalized = normalizeFetchError({ name: "AbortError" });
      return errorJson(id, normalized.error, normalized.status, normalized.code);
    }
    return errorJson(id, "LLM 上游返回无法解析", 502, "upstream_invalid_response");
  } finally {
    upstream.cleanup();
  }
}

function streamHeaders(id) {
  return responseHeaders(id, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
}

function createDownstreamStream({ upstream, id, contextLabel, source, limits }) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const parser = createSseParser(limits.sseEventChars);
  const reader = upstream.response.body.getReader();
  let usage;
  let finished = false;
  let sawContent = false;
  let downstreamCancelled = false;
  let outputChars = 0;

  function send(controller, event, data) {
    controller.enqueue(encoder.encode(formatSseEvent(event, data)));
  }

  function finish(controller) {
    if (finished) return;
    finished = true;
    send(controller, "done", {
      requestId: id,
      context: contextLabel,
      source,
      ...(usage ? { usage } : {}),
    });
  }

  function consumeEvents(controller, events) {
    for (const event of events) {
      if (event.data === "[DONE]") {
        if (!sawContent) throw new Error("empty upstream SSE");
        finish(controller);
        return;
      }
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        throw new Error("invalid upstream SSE");
      }
      if (data?.error) {
        const error = new Error("upstream stream error");
        error.code = "upstream_stream_error";
        throw error;
      }
      usage = safeUsage(data) || usage;
      const content = extractChatDelta(data) || extractChatAnswer(data);
      if (content) {
        if (outputChars + content.length > limits.outputChars) {
          const error = new Error("upstream output too large");
          error.code = "upstream_output_too_large";
          throw error;
        }
        outputChars += content.length;
        sawContent = true;
        send(controller, "delta", { content });
      }
    }
  }

  return new ReadableStream({
    async start(controller) {
      send(controller, "meta", { requestId: id, context: contextLabel, source });
      try {
        while (!finished) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = decoder.decode();
            if (tail) consumeEvents(controller, parser.push(tail));
            consumeEvents(controller, parser.finish());
            if (!sawContent) throw new Error("empty upstream SSE");
            finish(controller);
            break;
          }
          consumeEvents(controller, parser.push(decoder.decode(value, { stream: true })));
        }
      } catch (error) {
        if (!downstreamCancelled) {
          const timedOut = upstream.timedOut() || error?.name === "AbortError";
          const responseTooLarge =
            error?.code === "upstream_output_too_large" ||
            error?.code === "upstream_sse_event_too_large";
          const normalized = normalizeFetchError(timedOut ? { name: "AbortError" } : error);
          send(controller, "error", {
            error: timedOut
              ? normalized.error
              : responseTooLarge
                ? "LLM 上游响应超过限制"
              : error?.code === "upstream_stream_error"
                ? "LLM 上游流式响应失败"
                : "LLM 上游流式响应无效",
            code: timedOut
              ? normalized.code
              : responseTooLarge
                ? "upstream_response_too_large"
              : error?.code === "upstream_stream_error"
                ? "upstream_error"
                : "upstream_invalid_response",
            requestId: id,
          });
        }
      } finally {
        upstream.cleanup();
        try {
          await reader.cancel();
        } catch {
          // 上游可能已经正常关闭。
        }
        if (!downstreamCancelled) controller.close();
      }
    },
    cancel() {
      downstreamCancelled = true;
      upstream.cleanup();
      upstream.abort();
      return reader.cancel("client disconnected");
    },
  });
}

async function syntheticStreamResponse({ upstream, id, contextLabel, source, limits }) {
  const jsonResponse = await jsonChatResponse({ upstream, id, contextLabel, source, limits });
  if (!jsonResponse.ok) return jsonResponse;
  const data = await jsonResponse.json();
  const body =
    formatSseEvent("meta", { requestId: id, context: contextLabel, source }) +
    formatSseEvent("delta", { content: data.answer }) +
    formatSseEvent("done", {
      requestId: id,
      context: contextLabel,
      source,
      ...(data.usage ? { usage: data.usage } : {}),
    });
  return new Response(body, { status: 200, headers: streamHeaders(id) });
}

// GET /api/chat -> 仅报告配置状态和能力，不返回 endpoint、model、key 或访问码。
export async function onRequestGet({ env }) {
  return json(chatCapabilities(resolveChatConfig(env)), 200, {
    "cache-control": "no-store",
  });
}

// POST /api/chat {code, question, report?, volguard?, history?, stream?}
// 默认保持 JSON；stream=true 时返回标准化 SSE 增量。
export async function onRequestPost({ request, env }) {
  const id = requestId();
  const config = resolveChatConfig(env);
  const headerCode = request.headers.get("x-access-code");
  if (headerCode !== null && !gate(env, headerCode)) {
    return errorJson(id, "访问码不正确", 401, "invalid_access_code");
  }

  const parsedBody = await readJsonBodyLimited(request, config.limits.requestBytes);
  if (!parsedBody.ok && parsedBody.reason === "too_large") {
    return errorJson(id, "请求体过大", 413, "request_too_large");
  }
  const body = parsedBody.ok ? parsedBody.value : null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorJson(id, "请求体不是合法 JSON", 400, "invalid_json");
  }
  if (headerCode === null && !gate(env, body.code)) {
    return errorJson(id, "访问码不正确", 401, "invalid_access_code");
  }
  if (!config.configured.endpoint || !config.configured.model) {
    return errorJson(id, "服务端 LLM 配置无效", 500, "llm_not_configured");
  }
  if (config.apiKeyRequired && !config.configured.apiKey) {
    return errorJson(id, "服务端未配置 LLM key", 500, "llm_not_configured");
  }

  const normalizedQuestion = normalizeQuestion(body.question, config.limits.questionChars);
  if (!normalizedQuestion.value) return errorJson(id, "问题为空", 400, "empty_question");

  const contextResult = await loadResearchContext({
    body,
    fetchImpl: fetch,
    rawBase: RAW_BASE,
    contextLimit: config.limits.contextChars,
    timeoutMs: config.timeouts.contextMs,
    signal: request.signal,
  });
  const prepared = prepareChatMessages({
    question: normalizedQuestion.value,
    history: body.history,
    context: contextResult.context,
    contextLabel: contextResult.contextLabel,
    limits: config.limits,
  });
  const source = { ...contextResult.source };
  if (prepared.input.contextChars !== contextResult.source.chars) {
    source.loadedChars = contextResult.source.chars;
    source.chars = prepared.input.contextChars;
    source.truncated = true;
  }
  const wantsStream = body.stream === true;
  const payload = {
    model: config.model,
    messages: prepared.messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    ...(config.thinkingType ? { thinking: { type: config.thinkingType } } : {}),
    ...(wantsStream ? { stream: true } : {}),
  };

  let upstream;
  try {
    upstream = await fetchLlm(config, payload, id, request.signal);
  } catch (error) {
    const normalized = normalizeFetchError(error);
    return errorJson(id, normalized.error, normalized.status, normalized.code);
  }

  if (!upstream.response.ok) {
    upstream.cleanup();
    upstream.abort();
    return upstreamError(id, upstream.response.status);
  }
  if (!wantsStream) {
    return jsonChatResponse({
      upstream,
      id,
      contextLabel: contextResult.contextLabel,
      source,
      limits: config.limits,
    });
  }

  const contentType = upstream.response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/event-stream") || !upstream.response.body) {
    return syntheticStreamResponse({
      upstream,
      id,
      contextLabel: contextResult.contextLabel,
      source,
      limits: config.limits,
    });
  }
  return new Response(
    createDownstreamStream({
      upstream,
      id,
      contextLabel: contextResult.contextLabel,
      source,
      limits: config.limits,
    }),
    { status: 200, headers: streamHeaders(id) },
  );
}
