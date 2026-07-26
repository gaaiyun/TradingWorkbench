function configured(value) {
  return typeof value === "string" && value.trim() !== "";
}

function validRepository(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function timestampAt(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return date.toISOString();
}

async function hashJson(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function headers(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "TradingWorkbench-monitor-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function expectedRunName(profileId, slotId, scheduledFor) {
  return [
    "Daily analysis",
    "profile",
    "monitor",
    profileId,
    slotId,
    scheduledFor,
  ].join(" · ");
}

async function readDispatchState(db, slotId, payloadHash) {
  const receipt = await db.prepare(`
    SELECT slot_id, payload_hash, external_run_id, external_run_url
    FROM github_dispatch_receipts
    WHERE slot_id = ?
      AND payload_hash = ?
  `).bind(slotId, payloadHash).first();
  if (receipt) return { kind: "receipt", row: receipt };
  const outbox = await db.prepare(`
    SELECT slot_id, payload_hash, status, post_attempt_count,
      lookup_attempt_count, external_run_id, external_run_url
    FROM github_dispatch_outbox
    WHERE slot_id = ?
      AND payload_hash = ?
  `).bind(slotId, payloadHash).first();
  return outbox ? { kind: "outbox", row: outbox } : null;
}

async function createOutbox(db, input) {
  await db.prepare(`
    INSERT INTO github_dispatch_outbox (
      slot_id, payload_hash, request_json, status, post_attempt_count,
      lookup_attempt_count, external_run_id, external_run_url,
      last_error_code, created_at, updated_at
    )
    VALUES (?, ?, ?, 'pending', 0, 0, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(slot_id) DO NOTHING
  `).bind(
    input.slotId,
    input.payloadHash,
    input.requestJson,
    input.timestamp,
    input.timestamp,
  ).run();
}

async function updateOutbox(db, slotId, status, timestamp, errorCode = null) {
  await db.prepare(`
    UPDATE github_dispatch_outbox
    SET status = ?,
        last_error_code = ?,
        updated_at = ?
    WHERE slot_id = ?
  `).bind(status, errorCode, timestamp, slotId).run();
}

async function markPosting(db, slotId, timestamp) {
  const result = await db.prepare(`
    UPDATE github_dispatch_outbox
    SET status = 'posting',
        post_attempt_count = post_attempt_count + 1,
        last_error_code = NULL,
        updated_at = ?
    WHERE slot_id = ?
      AND status = 'pending'
  `).bind(timestamp, slotId).run();
  return Number(result?.meta?.changes ?? 0) === 1;
}

async function recordReceipt(db, input) {
  await db.prepare(`
    INSERT INTO github_dispatch_receipts (
      slot_id, payload_hash, external_run_id, external_run_url, accepted_at
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slot_id) DO NOTHING
  `).bind(
    input.slotId,
    input.payloadHash,
    input.runId ?? null,
    input.runUrl ?? null,
    input.timestamp,
  ).run();
  await db.prepare(`
    UPDATE github_dispatch_outbox
    SET status = 'accepted',
        external_run_id = ?,
        external_run_url = ?,
        last_error_code = NULL,
        updated_at = ?
    WHERE slot_id = ?
  `).bind(
    input.runId ?? null,
    input.runUrl ?? null,
    input.timestamp,
    input.slotId,
  ).run();
}

async function reconcileRun({
  db,
  fetcher,
  token,
  repository,
  workflowId,
  profileId,
  slotId,
  payloadHash,
  scheduledFor,
  timestamp,
}) {
  try {
    await db.prepare(`
      UPDATE github_dispatch_outbox
      SET lookup_attempt_count = lookup_attempt_count + 1,
          updated_at = ?
      WHERE slot_id = ?
    `).bind(timestamp, slotId).run();
    const url = new URL(
      `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflowId)}/runs`,
    );
    url.searchParams.set("event", "workflow_dispatch");
    url.searchParams.set("per_page", "100");
    const response = await fetcher(url.toString(), {
      method: "GET",
      headers: headers(token),
    });
    if (response.status !== 200) {
      return { found: false, lookupFailed: true };
    }
    const payload = await response.json();
    const title = expectedRunName(profileId, slotId, scheduledFor);
    const run = Array.isArray(payload?.workflow_runs)
      ? payload.workflow_runs.find((item) => item?.display_title === title)
      : null;
    if (!run) return { found: false, lookupFailed: false };
    await recordReceipt(db, {
      slotId,
      payloadHash,
      runId: run.id,
      runUrl: run.html_url,
      timestamp,
    });
    return { found: true, runId: run.id, runUrl: run.html_url };
  } catch {
    return { found: false, lookupFailed: true };
  }
}

async function legacyDispatch({
  fetcher,
  token,
  repository,
  workflowId,
  requestJson,
}) {
  let response;
  try {
    response = await fetcher(
      `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
      {
        method: "POST",
        headers: headers(token),
        body: requestJson,
      },
    );
  } catch {
    return { status: "failed", errorCode: "GITHUB_DISPATCH_NETWORK" };
  }
  if (response.status !== 204) {
    return {
      status: "failed",
      errorCode: `GITHUB_DISPATCH_HTTP_${response.status}`,
    };
  }
  return { status: "completed" };
}

export async function dispatchFullAnalysis({
  env,
  db,
  fetcher = globalThis.fetch,
  profile,
  slotId,
  payloadHash: providedPayloadHash,
  scheduledFor,
  now = new Date(),
}) {
  const token = env?.GITHUB_DISPATCH_TOKEN;
  const repository = env?.GITHUB_REPOSITORY;
  const workflowId = env?.GITHUB_WORKFLOW_ID;
  if (
    !configured(token) ||
    !configured(workflowId) ||
    !validRepository(repository)
  ) {
    return {
      status: "deferred",
      errorCode: "GITHUB_DISPATCH_NOT_CONFIGURED",
    };
  }

  const tickers = profile.targets
    .filter((target) =>
      target.role === "core" &&
      target.analysis === "full")
    .map((target) => target.symbol);
  if (tickers.length === 0) {
    return { status: "deferred", errorCode: "NO_CORE_FULL_TICKERS" };
  }

  const requestJson = JSON.stringify({
    ref: "main",
    inputs: {
      profileId: profile.id,
      slotId,
      scheduledFor,
      tickers: tickers.join(","),
    },
  });
  if (!db?.prepare) {
    return legacyDispatch({
      fetcher,
      token,
      repository,
      workflowId,
      requestJson,
    });
  }

  const payloadHash = providedPayloadHash || await hashJson(requestJson);
  const timestamp = timestampAt(now);
  let state;
  try {
    state = await readDispatchState(db, slotId, payloadHash);
    if (state?.kind === "receipt" || state?.row?.status === "accepted") {
      return { status: "completed", dispatchState: "receipt" };
    }
    if (!state) {
      await createOutbox(db, {
        slotId,
        payloadHash,
        requestJson,
        timestamp,
      });
      state = await readDispatchState(db, slotId, payloadHash);
    }
  } catch {
    return {
      status: "failed",
      errorCode: "GITHUB_DISPATCH_OUTBOX_WRITE_FAILED",
      dispatchState: "not-posted",
    };
  }

  if (!state) {
    return {
      status: "failed",
      errorCode: "GITHUB_DISPATCH_OUTBOX_WRITE_FAILED",
      dispatchState: "not-posted",
    };
  }

  if (["posting", "unknown"].includes(state.row.status)) {
    const reconciled = await reconcileRun({
      db,
      fetcher,
      token,
      repository,
      workflowId,
      profileId: profile.id,
      slotId,
      payloadHash,
      scheduledFor,
      timestamp,
    });
    return reconciled.found
      ? { status: "completed", dispatchState: "reconciled" }
      : {
          status: "failed",
          errorCode: "GITHUB_DISPATCH_UNCERTAIN",
          dispatchState: reconciled.lookupFailed ? "lookup-failed" : "unknown",
        };
  }
  if (state.row.status !== "pending") {
    return {
      status: "failed",
      errorCode: "GITHUB_DISPATCH_REJECTED",
      dispatchState: state.row.status,
    };
  }

  try {
    if (!await markPosting(db, slotId, timestamp)) {
      return {
        status: "failed",
        errorCode: "GITHUB_DISPATCH_CLAIM_CONFLICT",
        dispatchState: "not-posted",
      };
    }
  } catch {
    return {
      status: "failed",
      errorCode: "GITHUB_DISPATCH_OUTBOX_WRITE_FAILED",
      dispatchState: "not-posted",
    };
  }

  let response;
  try {
    response = await fetcher(
      `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
      {
        method: "POST",
        headers: headers(token),
        body: requestJson,
      },
    );
  } catch {
    await updateOutbox(
      db,
      slotId,
      "unknown",
      timestamp,
      "GITHUB_DISPATCH_NETWORK",
    ).catch(() => {});
    const reconciled = await reconcileRun({
      db,
      fetcher,
      token,
      repository,
      workflowId,
      profileId: profile.id,
      slotId,
      payloadHash,
      scheduledFor,
      timestamp,
    });
    return reconciled.found
      ? { status: "completed", dispatchState: "reconciled" }
      : {
          status: "failed",
          errorCode: "GITHUB_DISPATCH_UNCERTAIN",
          dispatchState: reconciled.lookupFailed ? "lookup-failed" : "unknown",
        };
  }

  if (response.status !== 204) {
    const uncertain = response.status >= 500;
    await updateOutbox(
      db,
      slotId,
      uncertain ? "unknown" : "rejected",
      timestamp,
      `GITHUB_DISPATCH_HTTP_${response.status}`,
    ).catch(() => {});
    if (uncertain) {
      const reconciled = await reconcileRun({
        db,
        fetcher,
        token,
        repository,
        workflowId,
        profileId: profile.id,
        slotId,
        payloadHash,
        scheduledFor,
        timestamp,
      });
      if (reconciled.found) {
        return { status: "completed", dispatchState: "reconciled" };
      }
    }
    return {
      status: "failed",
      errorCode: `GITHUB_DISPATCH_HTTP_${response.status}`,
      dispatchState: uncertain ? "unknown" : "rejected",
    };
  }

  try {
    await recordReceipt(db, {
      slotId,
      payloadHash,
      timestamp,
    });
  } catch {
    await updateOutbox(
      db,
      slotId,
      "unknown",
      timestamp,
      "GITHUB_DISPATCH_RECEIPT_WRITE_FAILED",
    ).catch(() => {});
    return {
      status: "failed",
      errorCode: "GITHUB_DISPATCH_RECEIPT_WRITE_FAILED",
      dispatchState: "unknown",
    };
  }
  return { status: "completed", dispatchState: "accepted" };
}
