export const PROFILE_LIMIT = 8;
export const TARGET_LIMIT = 14;
export const PROFILE_STORAGE_KEY = "ta.workbench.selected-profile.v1";

const unavailableEnvelope = () => ({
  status: "unavailable",
  asOf: null,
  data: [],
  sources: [],
});

function validRevision(value) {
  return typeof value === "string"
    && value.trim().length > 0
    && !Number.isNaN(new Date(value).valueOf());
}

export function settingsSnapshotFromPayload(payload, { source = "remote" } = {}) {
  const explicitStatus = String(payload?.status || "").toLowerCase();
  const explicitlyUnavailable = ["unavailable", "error"].includes(explicitStatus);
  if (explicitlyUnavailable) {
    return {
      mode: "unavailable",
      settings: null,
      revision: null,
      writable: false,
      error: payload?.error || "远端监控配置不可用",
    };
  }

  const settings = payload?.settings?.profiles
    ? payload.settings
    : payload?.data?.profiles
      ? payload.data
      : payload;
  if (!Array.isArray(settings?.profiles) || settings.profiles.length === 0) {
    return {
      mode: "unavailable",
      settings: null,
      revision: null,
      writable: false,
      error: payload?.error || "服务端未返回监控配置",
    };
  }

  const revision = payload?.revision
    ?? payload?.updatedAt
    ?? settings?.revision
    ?? settings?.updatedAt
    ?? null;
  const degraded = source === "static"
    || ["degraded", "stale"].includes(explicitStatus)
    || !validRevision(revision);
  return {
    mode: degraded ? "degraded" : "ready",
    settings,
    revision: validRevision(revision) ? revision : null,
    writable: !degraded,
    error: degraded ? "远端设置不可写" : null,
  };
}

export function createProfileRequestCoordinator() {
  let generation = 0;
  let profileId = null;
  const active = new Map();

  function abortActive() {
    for (const request of active.values()) request.controller.abort();
    active.clear();
  }

  return {
    activate(nextProfileId) {
      abortActive();
      generation += 1;
      profileId = nextProfileId || null;
      return { generation, profileId };
    },
    snapshot() {
      return { generation, profileId };
    },
    matches(context) {
      return context?.generation === generation && context.profileId === profileId;
    },
    begin(channel, key = "") {
      active.get(channel)?.controller.abort();
      const controller = new AbortController();
      const request = {
        channel,
        key,
        generation,
        profileId,
        controller,
        signal: controller.signal,
      };
      active.set(channel, request);
      return request;
    },
    isCurrent(request) {
      return Boolean(
        request
        && active.get(request.channel) === request
        && request.generation === generation
        && request.profileId === profileId
        && !request.signal.aborted
      );
    },
    finish(request) {
      if (active.get(request?.channel) === request) active.delete(request.channel);
    },
  };
}

export function selectedProfileAfterMutation(profiles, {
  selectedAtResponse,
  selectionChanged,
  preferredProfileId,
} = {}) {
  const requestedId = selectionChanged ? selectedAtResponse : preferredProfileId;
  return resolveSelectedProfileId(profiles, requestedId);
}

export function isSettingsRevisionConflict(error) {
  return error?.status === 428
    || (
      error?.status === 409
      && error?.payload?.error_code === "SETTINGS_CONFLICT"
    );
}

export function normalizeProfileTargetSymbol(raw) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (["03887", "3887", "03887.HK", "3887.HK"].includes(value)) {
    return "3887.HK";
  }

  const hkEquity = /^(\d{4,5})\.HK$/.exec(value);
  if (hkEquity) return `${hkEquity[1]}.HK`;

  const hkBare = /^(\d{4,5})$/.exec(value);
  if (hkBare) return `${hkBare[1]}.HK`;

  if (/^\d{6}$/.test(value)) {
    return `${value}.${"569".includes(value[0]) ? "SS" : "SZ"}`;
  }
  if (/^\d{6}\.(?:SS|SZ)$/.test(value) || /^[A-Z]{1,5}(?:-[A-Z])?$/.test(value)) {
    return value;
  }
  return null;
}

export function marketForProfileTarget(symbol) {
  const value = String(symbol || "").toUpperCase();
  if (value.endsWith(".HK")) return "HK";
  if (value.endsWith(".SS") || value.endsWith(".SZ")) return "CN";
  return "US";
}

export function resolveSelectedProfileId(profiles, selectedProfileId) {
  const available = Array.isArray(profiles) ? profiles : [];
  return available.some(({ id }) => id === selectedProfileId)
    ? selectedProfileId
    : available[0]?.id || null;
}

export function currentProfileFor(settings, selectedProfileId) {
  const profiles = Array.isArray(settings?.profiles) ? settings.profiles : [];
  const resolvedId = resolveSelectedProfileId(profiles, selectedProfileId);
  return profiles.find(({ id }) => id === resolvedId) || null;
}

export function profileRequestUrl(path, profileId, params = {}) {
  const search = new URLSearchParams();
  if (profileId) search.set("profile", profileId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export function selectedSymbolForProfile(profile, selectedSymbol) {
  const targets = Array.isArray(profile?.targets) ? profile.targets : [];
  return targets.some(({ symbol }) => symbol === selectedSymbol)
    ? selectedSymbol
    : targets[0]?.symbol || null;
}

export function resetProfileContext(state, profile) {
  return {
    ...state,
    selectedSymbol: selectedSymbolForProfile(profile, state.selectedSymbol),
    market: unavailableEnvelope(),
    quotes: new Map(),
    feeds: [],
    feedEnvelope: unavailableEnvelope(),
    monitor: unavailableEnvelope(),
    latest: null,
    history: [],
    runs: [],
    reportAudit: null,
    showAuditReports: false,
    archiveEntries: [],
    selectedReportPath: null,
    selectedReportSection: null,
    selectedReportContent: "",
    latestReport: null,
    chart: {
      ...state.chart,
      bars: [],
      symbol: null,
      timeframe: null,
      hydrated: false,
    },
  };
}

export function replaceProfile(settings, profileId, replacement) {
  return {
    ...settings,
    profiles: (settings?.profiles || []).map((profile) =>
      profile.id === profileId ? replacement : profile
    ),
  };
}
