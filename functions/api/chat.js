import { RAW_BASE, gate, json } from "./_util.js";
import {
  loadWorkbenchEvidence,
  resolveWorkbenchTarget,
} from "./_chat_context.mjs";
import { d1Binding, readSettingsFromD1 } from "./_d1_repository.mjs";
import {
  claimChatRequest,
  completeChatRequest,
  failChatRequest,
  hashChatValue,
  normalizeChatId,
} from "./_chat_repository.mjs";
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

async function jsonChatResponse({
  upstream,
  id,
  contextLabel,
  source,
  limits,
  metadata = {},
  onComplete,
  onFailure,
}) {
  try {
    const data = await upstream.response.json();
    const answer = extractChatAnswer(data);
    if (!answer) {
      await onFailure?.({
        error: "LLM 上游返回无效内容",
        code: "upstream_invalid_response",
        status: 502,
      });
      return errorJson(id, "LLM 上游返回无效内容", 502, "upstream_invalid_response");
    }
    if (answer.length > limits.outputChars) {
      await onFailure?.({
        error: "LLM 上游响应超过限制",
        code: "upstream_response_too_large",
        status: 502,
      });
      return errorJson(id, "LLM 上游响应超过限制", 502, "upstream_response_too_large");
    }
    const usage = safeUsage(data);
    const payload = {
      answer,
      context: contextLabel,
      requestId: id,
      source,
      ...metadata,
      ...(usage ? { usage } : {}),
    };
    const persistence = await onComplete?.(payload, answer);
    if (persistence) payload.persistence = persistence;
    return json(
      payload,
      200,
      responseHeaders(id, { "cache-control": "no-store" }),
    );
  } catch (error) {
    if (upstream.timedOut() || error?.name === "AbortError") {
      const normalized = normalizeFetchError({ name: "AbortError" });
      await onFailure?.({ ...normalized, status: normalized.status });
      return errorJson(id, normalized.error, normalized.status, normalized.code);
    }
    await onFailure?.({
      error: "LLM 上游返回无法解析",
      code: "upstream_invalid_response",
      status: 502,
    });
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

function createDownstreamStream({
  upstream,
  id,
  contextLabel,
  source,
  limits,
  metadata = {},
  onComplete,
  onFailure,
}) {
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const parser = createSseParser(limits.sseEventChars);
  const reader = upstream.response.body.getReader();
  let usage;
  let finished = false;
  let sawContent = false;
  let downstreamCancelled = false;
  let outputChars = 0;
  let answer = "";

  function send(controller, event, data) {
    if (downstreamCancelled) return;
    controller.enqueue(encoder.encode(formatSseEvent(event, data)));
  }

  function finish(controller) {
    if (finished) return;
    finished = true;
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
        answer += content;
        sawContent = true;
        send(controller, "delta", { content });
      }
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      send(controller, "meta", {
        requestId: id,
        context: contextLabel,
        source,
        ...metadata,
      });
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
        if (finished && sawContent) {
          const completionPayload = {
            answer,
            context: contextLabel,
            requestId: id,
            source,
            ...metadata,
            ...(usage ? { usage } : {}),
          };
          const saved = await onComplete?.(completionPayload, answer);
          send(controller, "done", {
            ...completionPayload,
            ...(saved ? { persistence: saved } : {}),
          });
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
        await onFailure?.({
          error: "LLM 上游流式响应失败",
          code: error?.code || "upstream_invalid_response",
          status: 502,
        });
      } finally {
        upstream.cleanup();
        try {
          await reader.cancel();
        } catch {
          // 上游可能已经正常关闭。
        }
        if (!downstreamCancelled) controller.close();
        resolveCompletion();
      }
    },
    cancel() {
      downstreamCancelled = true;
      // 继续消费并保存最终回答，客户端稍后可按 requestId 恢复，
      // 同一个问题也不会因断线重试而再次调用模型。
      return undefined;
    },
  });
  return { stream, completion };
}

async function syntheticStreamResponse({
  upstream,
  id,
  contextLabel,
  source,
  limits,
  metadata,
  onComplete,
  onFailure,
}) {
  const jsonResponse = await jsonChatResponse({
    upstream,
    id,
    contextLabel,
    source,
    limits,
    metadata,
    onComplete,
    onFailure,
  });
  if (!jsonResponse.ok) return jsonResponse;
  const data = await jsonResponse.json();
  const body =
    formatSseEvent("meta", { requestId: id, context: contextLabel, source, ...metadata }) +
    formatSseEvent("delta", { content: data.answer }) +
    formatSseEvent("done", {
      requestId: id,
      context: contextLabel,
      source,
      ...metadata,
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
export async function onRequestPost({ request, env, waitUntil }) {
  let id = requestId();
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

  const requestedId = request.headers.get("x-request-id") || body.requestId;
  if (requestedId !== undefined && requestedId !== null) {
    const normalizedId = normalizeChatId(requestedId);
    if (!normalizedId) return errorJson(id, "请求 ID 无效", 400, "invalid_request_id");
    id = normalizedId;
  }
  const sessionId = body.sessionId === undefined || body.sessionId === null
    ? `session-${id}`
    : normalizeChatId(body.sessionId);
  if (!sessionId) return errorJson(id, "会话 ID 无效", 400, "invalid_session_id");
  const profileId = typeof body.profileId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(body.profileId)
    ? body.profileId
    : null;
  if (body.profileId && !profileId) return errorJson(id, "监控目标 ID 无效", 400, "invalid_profile_id");
  const symbol = typeof body.symbol === "string" && /^[A-Z0-9][A-Z0-9.^_-]{0,31}$/.test(body.symbol.toUpperCase())
    ? body.symbol.toUpperCase()
    : null;
  if (body.symbol && !symbol) return errorJson(id, "标的代码无效", 400, "invalid_symbol");

  const db = d1Binding(env);
  let resolvedSymbol = symbol;
  if (db && profileId) {
    try {
      const storedSettings = await readSettingsFromD1(db);
      resolvedSymbol = resolveWorkbenchTarget(storedSettings?.settings, {
        profileId,
        question: normalizedQuestion.value,
        requestedSymbol: symbol,
      });
    } catch {
      // 设置读取失败时仍使用页面当前标的，避免问答整体不可用。
    }
  }
  const requestHash = await hashChatValue({
    sessionId,
    profileId,
    symbol: resolvedSymbol,
    question: normalizedQuestion.value,
    report: typeof body.report === "string" ? body.report : null,
    volguard: body.volguard === true,
    history: Array.isArray(body.history) ? body.history : [],
  });
  let persistence = db ? "d1" : "unavailable";
  if (db) {
    try {
      const claim = await claimChatRequest(db, {
        requestId: id,
        sessionId,
        profileId,
        requestHash,
      });
      if (claim.state === "conflict") {
        return errorJson(id, "请求 ID 已用于其他问题", 409, "idempotency_conflict");
      }
      if (claim.state === "processing") {
        return errorJson(id, "相同请求仍在处理中", 409, "request_in_progress", {
          retryable: true,
        });
      }
      if (claim.state === "completed") {
        const cached = { ...claim.response, requestId: id, replayed: true, persistence: "d1" };
        if (body.stream === true) {
          const replayBody =
            formatSseEvent("meta", {
              requestId: id,
              context: cached.context,
              source: cached.source,
              evidence: cached.evidence || [],
              asOf: cached.asOf || null,
              contextHash: cached.contextHash || claim.contextHash || null,
              replayed: true,
            }) +
            formatSseEvent("delta", { content: cached.answer || "" }) +
            formatSseEvent("done", cached);
          return new Response(replayBody, { status: 200, headers: streamHeaders(id) });
        }
        return json(cached, 200, responseHeaders(id, { "cache-control": "no-store" }));
      }
      if (claim.state === "failed") {
        const cached = claim.response || {};
        return errorJson(
          id,
          cached.error || "相同请求此前未完成，请使用新的请求 ID 重试",
          cached.status || 502,
          cached.code || "cached_request_failed",
          { replayed: true },
        );
      }
    } catch {
      persistence = "degraded";
    }
  }

  let workbenchContext = null;
  if (db && profileId && resolvedSymbol) {
    try {
      workbenchContext = await loadWorkbenchEvidence(db, {
        profileId,
        symbol: resolvedSymbol,
      });
    } catch {
      persistence = persistence === "d1" ? "degraded" : persistence;
    }
  }
  const archiveContext = await loadResearchContext({
    body,
    fetchImpl: fetch,
    rawBase: RAW_BASE,
    contextLimit: config.limits.contextChars,
    timeoutMs: config.timeouts.contextMs,
    signal: request.signal,
  });
  const combinedContext = [workbenchContext?.context, archiveContext.context]
    .filter(Boolean)
    .join("\n\n【归档研究材料】\n");
  const contextLabel = [workbenchContext?.contextLabel, archiveContext.contextLabel]
    .filter(Boolean)
    .join(" + ");
  const prepared = prepareChatMessages({
    question: normalizedQuestion.value,
    history: body.history,
    context: combinedContext,
    contextLabel,
    limits: config.limits,
  });
  const source = workbenchContext?.evidence?.length
    ? {
      type: "combined",
      label: contextLabel,
      chars: prepared.input.contextChars,
      truncated: prepared.input.contextTruncated,
      components: [workbenchContext.source, archiveContext.source],
    }
    : { ...archiveContext.source };
  if (!workbenchContext?.evidence?.length && prepared.input.contextChars !== archiveContext.source.chars) {
    source.loadedChars = archiveContext.source.chars;
    source.chars = prepared.input.contextChars;
    source.truncated = true;
  }
  const contextHash = await hashChatValue(prepared.context);
  const metadata = {
    sessionId,
    profileId,
    symbol: resolvedSymbol,
    asOf: workbenchContext?.asOf || null,
    evidence: workbenchContext?.evidence || [],
    contextHash,
    persistence,
  };
  const complete = async (payload, answer) => {
    if (!db || persistence === "unavailable") return persistence;
    try {
      const saved = await completeChatRequest(db, {
        requestId: id,
        sessionId,
        profileId,
        title: normalizedQuestion.value,
        question: normalizedQuestion.value,
        answer,
        contextHash,
        response: payload,
      });
      return saved ? "d1" : "degraded";
    } catch {
      return "degraded";
    }
  };
  const fail = async (failure) => {
    if (!db || persistence !== "d1") return;
    try {
      await failChatRequest(db, { requestId: id, response: failure });
    } catch {
      // 问答错误仍按原错误返回，存储故障不覆盖根因。
    }
  };
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
    await fail({ ...normalized, status: normalized.status });
    return errorJson(id, normalized.error, normalized.status, normalized.code);
  }

  if (!upstream.response.ok) {
    const normalized = normalizeUpstreamStatus(upstream.response.status);
    await fail({ ...normalized, status: normalized.status });
    upstream.cleanup();
    upstream.abort();
    return upstreamError(id, upstream.response.status);
  }
  if (!wantsStream) {
    return jsonChatResponse({
      upstream,
      id,
      contextLabel,
      source,
      limits: config.limits,
      metadata,
      onComplete: complete,
      onFailure: fail,
    });
  }

  const contentType = upstream.response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/event-stream") || !upstream.response.body) {
    return syntheticStreamResponse({
      upstream,
      id,
      contextLabel,
      source,
      limits: config.limits,
      metadata,
      onComplete: complete,
      onFailure: fail,
    });
  }
  const downstream = createDownstreamStream({
    upstream,
    id,
    contextLabel,
    source,
    limits: config.limits,
    metadata,
    onComplete: complete,
    onFailure: fail,
  });
  if (typeof waitUntil === "function") waitUntil(downstream.completion);
  return new Response(downstream.stream, {
    status: 200,
    headers: streamHeaders(id),
  });
}
