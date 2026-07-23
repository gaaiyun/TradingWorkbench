function configured(value) {
  return typeof value === "string" && value.trim() !== "";
}

function validRepository(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

export async function dispatchFullAnalysis({
  env,
  fetcher = globalThis.fetch,
  profile,
  slotId,
  scheduledFor,
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

  let response;
  try {
    response = await fetcher(
      `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "TradingAgents-monitor-worker",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: {
            profileId: profile.id,
            slotId,
            scheduledFor,
            tickers: tickers.join(","),
          },
        }),
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
