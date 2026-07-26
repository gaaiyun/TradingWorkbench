const PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function isValidProfileId(value) {
  return typeof value === "string" && PROFILE_ID.test(value);
}

function normalizedRunId(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

export function legacyRunIdentity(runId = null) {
  return {
    scope: "legacy",
    kind: "legacy",
    runId: normalizedRunId(runId),
    profileId: null,
    requestId: null,
    slotId: null,
    scheduledFor: null,
  };
}

export function profileManualIdentity(profileId, runId = null) {
  return {
    scope: "profile",
    kind: "manual",
    runId: normalizedRunId(runId),
    profileId,
    requestId: null,
    slotId: null,
    scheduledFor: null,
  };
}

export function monitorRunIdentity(
  profileId,
  slotId,
  scheduledFor,
  runId = null,
) {
  return {
    scope: "profile",
    kind: "monitor",
    runId: normalizedRunId(runId),
    profileId,
    requestId: null,
    slotId,
    scheduledFor,
  };
}

export function adhocRunIdentity(requestId, runId = null) {
  return {
    scope: "adhoc",
    kind: "adhoc",
    runId: normalizedRunId(runId),
    profileId: null,
    requestId: requestId.toLowerCase(),
    slotId: null,
    scheduledFor: null,
  };
}

export function normalizeStoredRunIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return legacyRunIdentity();
  }
  if (
    value.scope === "profile"
    && value.kind === "manual"
    && PROFILE_ID.test(value.profileId || "")
    && value.requestId == null
    && value.slotId == null
    && value.scheduledFor == null
  ) {
    return profileManualIdentity(value.profileId, value.runId);
  }
  if (
    value.scope === "profile"
    && value.kind === "monitor"
    && PROFILE_ID.test(value.profileId || "")
    && typeof value.slotId === "string"
    && value.slotId.trim()
    && typeof value.scheduledFor === "string"
    && value.scheduledFor.trim()
    && value.requestId == null
  ) {
    return monitorRunIdentity(
      value.profileId,
      value.slotId.trim(),
      value.scheduledFor.trim(),
      value.runId,
    );
  }
  if (
    value.scope === "adhoc"
    && value.kind === "adhoc"
    && value.profileId == null
    && UUID.test(value.requestId || "")
    && value.slotId == null
    && value.scheduledFor == null
  ) {
    return adhocRunIdentity(value.requestId, value.runId);
  }
  return legacyRunIdentity();
}

export function runIdentityFromTitle(title) {
  const parts = String(title || "")
    .split("·")
    .map((part) => part.trim());
  if (parts.shift() !== "Daily analysis") return legacyRunIdentity();

  if (parts[0] === "profile" && parts[1] === "manual" && PROFILE_ID.test(parts[2] || "")) {
    return profileManualIdentity(parts[2]);
  }
  if (
    parts[0] === "profile"
    && parts[1] === "monitor"
    && PROFILE_ID.test(parts[2] || "")
    && parts[3]
    && parts[4]
  ) {
    return monitorRunIdentity(parts[2], parts[3], parts.slice(4).join(" · "));
  }
  if (parts[0] === "adhoc" && UUID.test(parts[1] || "")) {
    return adhocRunIdentity(parts[1]);
  }

  // 兼容已经产生的旧标题；只从明确字段解析，不为历史数据猜测 profile。
  if (parts[0] === "manual" && UUID.test(parts[1] || "")) {
    return adhocRunIdentity(parts[1]);
  }
  if (
    parts.length >= 3
    && parts[0] !== "manual"
    && PROFILE_ID.test(parts[0] || "")
    && parts[1]
    && parts[2]
  ) {
    return monitorRunIdentity(parts[0], parts[1], parts.slice(2).join(" · "));
  }
  if (
    parts.length === 2
    && parts[0] !== "manual"
    && PROFILE_ID.test(parts[0] || "")
  ) {
    return profileManualIdentity(parts[0]);
  }
  return legacyRunIdentity();
}

export function parseRunSelectors(request) {
  const params = new URL(request?.url || "https://workbench.invalid/").searchParams;
  const hasProfile = params.has("profile");
  const profile = hasProfile ? params.get("profile") : null;
  if (hasProfile && !PROFILE_ID.test(profile || "")) {
    throw new Error("无效的 profile 参数");
  }
  const hasRequestId = params.has("requestId");
  const selectedRequestId = hasRequestId ? params.get("requestId") : null;
  if (hasRequestId && !UUID.test(selectedRequestId || "")) {
    throw new Error("无效的 requestId 参数");
  }
  return {
    hasSelector: hasProfile || hasRequestId,
    // requestId uniquely identifies an adhoc run and must not inherit the
    // browser's currently selected profile.
    profile: hasRequestId ? null : profile,
    requestId: selectedRequestId?.toLowerCase() || null,
  };
}

export function identityMatches(identity, selectors) {
  const normalized = normalizeStoredRunIdentity(identity);
  if (selectors.profile !== null && normalized.profileId !== selectors.profile) {
    return false;
  }
  if (
    selectors.requestId !== null
    && normalized.requestId !== selectors.requestId
  ) {
    return false;
  }
  return true;
}
