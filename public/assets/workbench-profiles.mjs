export const PROFILE_LIMIT = 8;
export const TARGET_LIMIT = 14;
export const PROFILE_STORAGE_KEY = "ta.workbench.selected-profile.v1";

const unavailableEnvelope = () => ({
  status: "unavailable",
  asOf: null,
  data: [],
  sources: [],
});

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
