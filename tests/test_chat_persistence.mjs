import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  claimChatRequest,
  completeChatRequest,
  getChatSession,
  hashChatValue,
} from "../functions/api/_chat_repository.mjs";
import { loadWorkbenchEvidence } from "../functions/api/_chat_context.mjs";
import { onRequestGet as getChatSessionApi } from "../functions/api/chat-sessions.js";
import { onRequestPost as postChat } from "../functions/api/chat.js";
import { SqliteD1 } from "./helpers/sqlite_d1.mjs";

const migrations = [
  "../migrations/0001_workbench_dynamic.sql",
  "../migrations/0002_provider_circuit_breaker.sql",
  "../migrations/0003_monitor_scheduled_slots.sql",
  "../migrations/0004_monitor_slot_leases.sql",
  "../migrations/0005_chat_persistence.sql",
];

async function createD1(t) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable on this Node version");
    return null;
  }
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of migrations) {
    sqlite.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
  }
  return { sqlite, DB: new SqliteD1(sqlite) };
}

function chatRequest(body) {
  return new Request("https://example.test/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-access-code": "access-code",
      "x-request-id": body.requestId,
    },
    body: JSON.stringify(body),
  });
}

test("chat persistence migration adds replay-safe request state and lookup indexes", () => {
  const sql = readFileSync(
    new URL("../migrations/0005_chat_persistence.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS chat_requests/i);
  assert.match(sql, /request_hash\s+TEXT\s+NOT\s+NULL/i);
  assert.match(sql, /status\s+TEXT\s+NOT\s+NULL\s+CHECK/i);
  assert.match(sql, /response_json\s+TEXT/i);
  assert.match(sql, /context_hash\s+TEXT/i);
  assert.match(sql, /CREATE INDEX[^;]+chat_requests[^;]+session_id/i);
});

test("request claim is atomic, replays completed answers, and rejects key reuse", async (t) => {
  const fixture = await createD1(t);
  if (!fixture) return;
  const now = new Date("2026-07-24T00:00:00.000Z");
  const requestHash = await hashChatValue({
    sessionId: "session-12345678",
    profileId: "etf-semiconductor",
    symbol: "512480.SS",
    question: "今天为什么涨？",
  });

  const claimed = await claimChatRequest(fixture.DB, {
    requestId: "request-12345678",
    sessionId: "session-12345678",
    profileId: "etf-semiconductor",
    requestHash,
    now,
  });
  assert.equal(claimed.state, "claimed");

  const inProgress = await claimChatRequest(fixture.DB, {
    requestId: "request-12345678",
    sessionId: "session-12345678",
    profileId: "etf-semiconductor",
    requestHash,
    now,
  });
  assert.equal(inProgress.state, "processing");

  await completeChatRequest(fixture.DB, {
    requestId: "request-12345678",
    sessionId: "session-12345678",
    profileId: "etf-semiconductor",
    title: "今天为什么涨？",
    question: "今天为什么涨？",
    answer: "证据不足，暂时不能可靠归因。",
    contextHash: "context-hash",
    response: { answer: "证据不足，暂时不能可靠归因。" },
    now,
  });

  const replay = await claimChatRequest(fixture.DB, {
    requestId: "request-12345678",
    sessionId: "session-12345678",
    profileId: "etf-semiconductor",
    requestHash,
    now,
  });
  assert.equal(replay.state, "completed");
  assert.equal(replay.response.answer, "证据不足，暂时不能可靠归因。");

  const conflict = await claimChatRequest(fixture.DB, {
    requestId: "request-12345678",
    sessionId: "session-12345678",
    profileId: "etf-semiconductor",
    requestHash: "different-hash",
    now,
  });
  assert.equal(conflict.state, "conflict");

  const session = await getChatSession(fixture.DB, "session-12345678", now);
  assert.equal(session.messages.length, 2);
  assert.deepEqual(session.messages.map(({ role }) => role), ["user", "assistant"]);
});

test("workbench evidence labels current bars, news, and events with source timestamps", async (t) => {
  const fixture = await createD1(t);
  if (!fixture) return;
  fixture.sqlite.prepare(`
    INSERT INTO market_bars (
      symbol, profile_id, timeframe, ts, open, high, low, close, volume,
      source, as_of, fetched_at, freshness, adjustment, quality, expires_at
    ) VALUES (
      '512480.SS', 'etf-semiconductor', '15m', '2026-07-24T02:15:00.000Z',
      1.25, 1.28, 1.24, 1.27, 1200000,
      'tencent', '2026-07-24T02:15:00.000Z', '2026-07-24T02:15:05.000Z',
      'fresh', 'none', 'good', '2099-01-01T00:00:00.000Z'
    )
  `).run();
  fixture.sqlite.prepare(`
    INSERT INTO news_items (
      id, symbol, profile_id, topic, title, summary, url, published_at,
      source, as_of, fetched_at, freshness, adjustment, quality, expires_at
    ) VALUES (
      'news-1', '512480.SS', 'etf-semiconductor', 'semiconductor',
      '半导体行业发布新政策', '政策摘要', 'https://example.test/news/1',
      '2026-07-24T01:30:00.000Z', 'miit',
      '2026-07-24T01:30:00.000Z', '2026-07-24T01:31:00.000Z',
      'fresh', NULL, 'good', '2099-01-01T00:00:00.000Z'
    )
  `).run();
  fixture.sqlite.prepare(`
    INSERT INTO market_events (
      id, symbol, profile_id, topic, importance, event_at, title, description,
      source, as_of, fetched_at, freshness, adjustment, quality, expires_at
    ) VALUES (
      'event-1', '512480.SS', 'etf-semiconductor', 'market_move', 'high',
      '2026-07-24T02:15:00.000Z', '15分钟价格异动', '涨幅超过阈值',
      'signal-engine', '2026-07-24T02:15:00.000Z', '2026-07-24T02:15:05.000Z',
      'fresh', NULL, 'good', '2099-01-01T00:00:00.000Z'
    )
  `).run();

  const result = await loadWorkbenchEvidence(fixture.DB, {
    profileId: "etf-semiconductor",
    symbol: "512480.SS",
    now: new Date("2026-07-24T02:20:00.000Z"),
  });
  assert.match(result.context, /\[M1\].*512480\.SS.*1\.27.*tencent/s);
  assert.match(result.context, /\[N1\].*半导体行业发布新政策.*https:\/\/example\.test\/news\/1/s);
  assert.match(result.context, /\[E1\].*15分钟价格异动.*signal-engine/s);
  assert.equal(result.evidence.length, 4);
  assert.equal(result.evidence.some(({ id }) => id === "I1"), true);
  assert.match(result.contextHash, /^[a-f0-9]{64}$/);
  assert.equal(result.asOf, "2026-07-24T02:15:00.000Z");
});

test("workbench evidence includes the server-side technical snapshot", async (t) => {
  const fixture = await createD1(t);
  if (!fixture) return;
  const insert = fixture.sqlite.prepare(`
    INSERT INTO market_bars (
      symbol, profile_id, timeframe, ts, open, high, low, close, volume,
      source, as_of, fetched_at, freshness, adjustment, quality, expires_at
    ) VALUES (?, 'etf-semiconductor', '15m', ?, ?, ?, ?, ?, ?,
      'tencent', ?, ?, 'fresh', 'none', 'good', '2099-01-01T00:00:00.000Z')
  `);
  for (let index = 0; index < 70; index += 1) {
    const timestamp = new Date(Date.UTC(2026, 6, 20, 0, index * 15)).toISOString();
    const close = 1 + index * 0.01;
    insert.run(
      "512480.SS",
      timestamp,
      close - 0.005,
      close + 0.01,
      close - 0.01,
      close,
      100000 + index * 100,
      timestamp,
      timestamp,
    );
  }

  const result = await loadWorkbenchEvidence(fixture.DB, {
    profileId: "etf-semiconductor",
    symbol: "512480.SS",
  });

  assert.match(result.context, /\[I1\].*指标 512480\.SS.*MA20 1\.595.*MA60 1\.395/s);
  assert.match(result.context, /样本 70根.*MACD柱 0.*关系 快线等于信号线/s);
  assert.equal(result.evidence.some(({ id, type }) => id === "I1" && type === "indicator"), true);
});

test("A-share chat evidence reads the native five-minute bars stored by the worker", async (t) => {
  const fixture = await createD1(t);
  if (!fixture) return;
  fixture.sqlite.prepare(`
    INSERT INTO market_bars (
      symbol, profile_id, timeframe, ts, close, volume, source, as_of, fetched_at,
      freshness, adjustment, quality, expires_at
    ) VALUES (
      '512480.SS', 'etf-semiconductor', '5m', '2026-07-24T02:15:00.000Z',
      1.27, 1200000, 'tencent', '2026-07-24T02:15:00.000Z',
      '2026-07-24T02:15:05.000Z', 'fresh', 'none', 'good',
      '2099-01-01T00:00:00.000Z'
    )
  `).run();

  const result = await loadWorkbenchEvidence(fixture.DB, {
    profileId: "etf-semiconductor",
    symbol: "512480.SS",
  });

  assert.match(result.context, /\[M1\].*周期 5m.*收 1\.27/s);
});

test("US chat evidence reads daily bars for Oracle", async (t) => {
  const fixture = await createD1(t);
  if (!fixture) return;
  fixture.sqlite.prepare(`
    INSERT INTO market_bars (
      symbol, profile_id, timeframe, ts, close, volume, source, as_of, fetched_at,
      freshness, adjustment, quality, expires_at
    ) VALUES (
      'ORCL', 'etf-semiconductor', '1d', '2026-07-23T20:00:00.000Z',
      246.18, 12000000, 'tencent-us', '2026-07-23T20:00:00.000Z',
      '2026-07-23T20:01:00.000Z', 'fresh', 'qfq', 'good',
      '2099-01-01T00:00:00.000Z'
    )
  `).run();

  const result = await loadWorkbenchEvidence(fixture.DB, {
    profileId: "etf-semiconductor",
    symbol: "ORCL",
  });

  assert.match(result.context, /\[M1\].*行情 ORCL.*周期 1d.*收 246\.18/s);
  assert.equal(result.evidence.find(({ id }) => id === "I1")?.title, "ORCL 1d 技术指标");
});

test("chat prompt receives auditable evidence IDs and returns evidence metadata", async (t) => {
  const fixture = await createD1(t);
  if (!fixture) return;
  fixture.sqlite.prepare(`
    INSERT INTO market_bars (
      symbol, profile_id, timeframe, ts, close, volume, source, as_of, fetched_at,
      freshness, adjustment, quality, expires_at
    ) VALUES (
      '512480.SS', 'etf-semiconductor', '15m', '2026-07-24T02:15:00.000Z',
      1.27, 1200000, 'tencent', '2026-07-24T02:15:00.000Z',
      '2026-07-24T02:15:05.000Z', 'fresh', 'none', 'good',
      '2099-01-01T00:00:00.000Z'
    )
  `).run();
  let llmPayload;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (String(url).includes("raw.githubusercontent.com")) return new Response("");
    llmPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "收盘价为 1.27 [M1]，时间为 2026-07-24 02:15 UTC。" } }],
    }));
  });
  const body = {
    requestId: "request-evidence-1",
    sessionId: "session-evidence-1",
    profileId: "etf-semiconductor",
    symbol: "512480.SS",
    question: "当前价格是多少？",
  };
  const response = await postChat({
    request: chatRequest(body),
    env: {
      DB: fixture.DB,
      ACCESS_CODE: "access-code",
      OPENAI_COMPATIBLE_API_KEY: "api-secret",
    },
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.match(llmPayload.messages[0].content, /引用动态证据时必须保留/);
  assert.match(llmPayload.messages.at(-1).content, /\[M1\].*512480\.SS.*1\.27/s);
  assert.equal(payload.evidence[0].id, "M1");
  assert.equal(payload.asOf, "2026-07-24T02:15:00.000Z");
  assert.match(payload.contextHash, /^[a-f0-9]{64}$/);
});

test("question target overrides the chart selection and loads that target's evidence", async (t) => {
  const fixture = await createD1(t);
  if (!fixture) return;
  fixture.sqlite.prepare(`
    INSERT INTO workbench_settings (id, version, settings_json, updated_at)
    VALUES (1, 2, ?, '2026-07-24T02:00:00.000Z')
  `).run(JSON.stringify({
    version: 2,
    profiles: [{
      id: "cn-semi-comms",
      targets: [
        { symbol: "515880.SS", name: "通信ETF" },
        { symbol: "512480.SS", name: "半导体ETF" },
        { symbol: "ORCL", name: "Oracle" },
      ],
      systemBenchmarks: [],
    }],
  }));
  fixture.sqlite.prepare(`
    INSERT INTO market_bars (
      symbol, profile_id, timeframe, ts, close, volume, source, as_of, fetched_at,
      freshness, adjustment, quality, expires_at
    ) VALUES (
      '512480.SS', 'cn-semi-comms', '15m', '2026-07-24T02:15:00.000Z',
      1.27, 1200000, 'tencent', '2026-07-24T02:15:00.000Z',
      '2026-07-24T02:15:05.000Z', 'fresh', 'none', 'good',
      '2099-01-01T00:00:00.000Z'
    )
  `).run();

  let llmPayload;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (String(url).includes("raw.githubusercontent.com")) return new Response("");
    llmPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "512480 的动态证据为 [M1]。" } }],
    }));
  });

  const response = await postChat({
    request: chatRequest({
      requestId: "request-question-target",
      sessionId: "session-question-target",
      profileId: "cn-semi-comms",
      symbol: "515880.SS",
      question: "今天 512480 为什么涨跌？",
    }),
    env: {
      DB: fixture.DB,
      ACCESS_CODE: "access-code",
      OPENAI_COMPATIBLE_API_KEY: "api-secret",
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.symbol, "512480.SS");
  assert.match(payload.context, /512480\.SS 动态证据账本/);
  assert.match(llmPayload.messages.at(-1).content, /\[M1\].*512480\.SS.*1\.27/s);
});

test("duplicate chat POST replays the stored answer without another model call", async (t) => {
  const fixture = await createD1(t);
  if (!fixture) return;
  let llmCalls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("raw.githubusercontent.com")) {
      return new Response('{"ticker":"512480.SS"}', {
        headers: { "content-type": "application/json" },
      });
    }
    llmCalls += 1;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "基于当前证据的回答" } }],
    }), { headers: { "content-type": "application/json" } });
  });
  const body = {
    requestId: "request-replay-1234",
    sessionId: "session-replay-1234",
    profileId: "etf-semiconductor",
    symbol: "512480.SS",
    question: "今天为什么涨？",
  };
  const env = {
    DB: fixture.DB,
    ACCESS_CODE: "access-code",
    OPENAI_COMPATIBLE_API_KEY: "api-secret",
  };

  const first = await postChat({ request: chatRequest(body), env });
  const second = await postChat({ request: chatRequest(body), env });
  const firstData = await first.json();
  const secondData = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(llmCalls, 1);
  assert.equal(firstData.answer, "基于当前证据的回答");
  assert.equal(secondData.answer, firstData.answer);
  assert.equal(secondData.replayed, true);

  const recovery = await getChatSessionApi({
    request: new Request(
      "https://example.test/api/chat-sessions?sessionId=session-replay-1234",
      { headers: { "x-access-code": "access-code" } },
    ),
    env,
  });
  const recovered = await recovery.json();
  assert.equal(recovery.status, 200);
  assert.equal(recovered.data.messages.length, 2);
  assert.equal(recovered.data.messages[1].content, "基于当前证据的回答");
});

test("a disconnected SSE is completed in the background and recoverable from D1", async (t) => {
  const fixture = await createD1(t);
  if (!fixture) return;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("raw.githubusercontent.com")) {
      return new Response('{"ticker":"512480.SS"}');
    }
    const body = new ReadableStream({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"断线后仍完成"}}]}\n\ndata: [DONE]\n\n',
          ));
          controller.close();
        }, 10);
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const body = {
    requestId: "request-disconnect-1",
    sessionId: "session-disconnect-1",
    profileId: "etf-semiconductor",
    symbol: "512480.SS",
    question: "断线测试",
    stream: true,
  };
  const env = {
    DB: fixture.DB,
    ACCESS_CODE: "access-code",
    OPENAI_COMPATIBLE_API_KEY: "api-secret",
  };
  let backgroundCompletion;
  const response = await postChat({
    request: chatRequest(body),
    env,
    waitUntil(promise) {
      backgroundCompletion = promise;
    },
  });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel("network lost");
  assert.ok(backgroundCompletion instanceof Promise);
  await backgroundCompletion;

  const session = await getChatSession(fixture.DB, "session-disconnect-1");
  assert.equal(session.messages.at(-1).content, "断线后仍完成");
});
