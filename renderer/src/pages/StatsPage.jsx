import pbpIcon from "../img/icon_pbp.webp";
import ccIcon from "../img/icon_cc.webp";
import tcIcon from "../img/icon_tc.webp";
import { useEffect, useState } from "react";
import useDesktopBridge from "../components/useDesktopBridge";

function formatNumber(value, max = 2) {
  const n = Number(value || 0);
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatAge(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n) || n <= 0) return "n/a";
  if (n < 1) return `${Math.max(1, Math.round(n * 60))}m`;
  if (n < 24) return `${formatNumber(n, 1)}h`;
  return `${formatNumber(n / 24, 1)}d`;
}

function missionName(value) {
  return String(value || "unknown mission").trim() || "unknown mission";
}

function missionNameKey(value) {
  return missionName(value).toLowerCase().replace(/\s+/g, " ");
}

function looksLikeOpaqueMissionId(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    text,
  );
}

function preferMissionLabel(...values) {
  let fallback = "";
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    if (!looksLikeOpaqueMissionId(text) && text !== "unknown mission") {
      return text;
    }
    if (!fallback) fallback = text;
  }
  return fallback || "unknown mission";
}

function buildMissionResolvers(guiMissionSlots = []) {
  const byId = new Map();
  const bySlot = new Map();
  for (const entry of Array.isArray(guiMissionSlots) ? guiMissionSlots : []) {
    const name = preferMissionLabel(entry?.missionName, entry?.name);
    if (!name || name === "unknown mission") continue;
    const ids = [
      entry?.id,
      entry?.missionId,
      entry?.assignedMissionId,
      entry?.assigned_mission_id,
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    for (const id of ids) {
      if (!looksLikeOpaqueMissionId(id) && !byId.has(id)) byId.set(id, name);
      if (looksLikeOpaqueMissionId(id) && !byId.has(id)) byId.set(id, name);
    }
    const slot = Number(entry?.slot);
    if (Number.isFinite(slot) && !bySlot.has(slot)) bySlot.set(slot, name);
  }
  return { byId, bySlot };
}

function buildMissionRows(
  events = [],
  missionClaims = {},
  history = [],
  guiMissionSlots = [],
) {
  const rows = new Map();
  const aliasToCanonical = new Map();
  const { byId, bySlot } = buildMissionResolvers(guiMissionSlots);

  const rememberAlias = (value, canonical) => {
    const alias = missionNameKey(value);
    const target = missionName(canonical);
    if (!alias || alias === "unknown mission") return;
    if (!target || target === "unknown mission") return;
    aliasToCanonical.set(alias, target);
  };

  for (const event of events) {
    const canonical = preferMissionLabel(event?.mission);
    rememberAlias(event?.mission, canonical);
  }

  for (const entry of Array.isArray(history) ? history : []) {
    const canonical = preferMissionLabel(
      entry?.mission,
      byId.get(String(entry?.assignedMissionId || "").trim()),
      bySlot.get(Number(entry?.slot)),
    );
    rememberAlias(entry?.mission, canonical);
  }

  const resolveMission = (value, meta = {}) => {
    const raw = missionName(value);
    const alias = missionNameKey(raw);
    const canonical = aliasToCanonical.get(alias);
    if (canonical) return canonical;
    const assignedMissionId = String(meta?.assignedMissionId || "").trim();
    if (assignedMissionId) {
      const resolvedById = byId.get(assignedMissionId);
      if (resolvedById) return resolvedById;
    }
    const slot = Number(meta?.slot);
    if (Number.isFinite(slot)) {
      const resolvedBySlot = bySlot.get(slot);
      if (resolvedBySlot) return resolvedBySlot;
    }
    if (looksLikeOpaqueMissionId(raw)) return "unknown mission";
    return raw;
  };

  const upsertRow = (value, meta = {}) => {
    const mission = resolveMission(value, meta);
    const current = rows.get(mission) || {
      mission,
      claims: 0,
      pbp: 0,
      tc: 0,
      cc: 0,
    };
    rows.set(mission, current);
    return current;
  };

  if (missionClaims && typeof missionClaims === "object") {
    for (const [name, count] of Object.entries(missionClaims)) {
      const claims = asNumber(count, 0);
      if (claims <= 0) continue;
      const current = upsertRow(name);
      current.claims += claims;
    }
  }

  if (rows.size === 0 && Array.isArray(history)) {
    for (const entry of history) {
      const mission = resolveMission(entry?.mission, entry);
      if (!mission || mission === "unknown mission") continue;
      const current = upsertRow(mission, entry);
      current.claims += 1;
    }
  }

  if (rows.size === 0) {
    for (const event of events) {
      const current = upsertRow(event.mission);
      current.claims += 1;
      if (event.token === "PBP") current.pbp += event.amount;
      if (event.token === "TC") current.tc += event.amount;
      if (event.token === "CC") current.cc += event.amount;
    }
  } else {
    for (const event of events) {
      const current = upsertRow(event.mission);
      if (event.token === "PBP") current.pbp += event.amount;
      if (event.token === "TC") current.tc += event.amount;
      if (event.token === "CC") current.cc += event.amount;
    }
  }

  if (rows.size > 1 && rows.has("unknown mission")) {
    const unknown = rows.get("unknown mission");
    if (unknown && asNumber(unknown.claims, 0) <= 1) {
      rows.delete("unknown mission");
    }
  }

  return Array.from(rows.values())
    .filter((row) => row.mission !== "unknown mission" || row.claims > 0)
    .sort((a, b) => b.claims - a.claims);
}

function buildClaimBuckets(history = []) {
  const list = Array.isArray(history)
    ? history
        .map((entry) => ({
          at: asNumber(entry?.at, null),
          claims: asNumber(entry?.claims, 0),
        }))
        .filter((entry) => entry.at && entry.claims > 0)
        .sort((a, b) => a.at - b.at)
    : [];
  if (list.length === 0) {
    return {
      points: [],
      labels: { start: "", end: "now" },
      max: 0,
      mode: "hourly",
    };
  }
  const spanMs = Math.max(1, Date.now() - list[0].at);
  const bucketMs = spanMs > 48 * 3600000 ? 24 * 3600000 : 3600000;
  const bucketCount =
    bucketMs === 3600000 ? 24 : Math.min(14, Math.ceil(spanMs / bucketMs));
  const endBucket = Math.floor(Date.now() / bucketMs) * bucketMs;
  const startBucket = endBucket - (bucketCount - 1) * bucketMs;
  const counts = Array.from({ length: bucketCount }, (_, index) => ({
    at: startBucket + index * bucketMs,
    count: 0,
  }));
  for (const entry of list) {
    if (entry.at < startBucket || entry.at > endBucket + bucketMs) continue;
    const index = Math.floor((entry.at - startBucket) / bucketMs);
    if (index >= 0 && index < counts.length) counts[index].count += 1;
  }
  const firstClaimIndex = counts.findIndex((bucket) => bucket.count > 0);
  const lastClaimIndex = counts.findLastIndex((bucket) => bucket.count > 0);
  const visibleCounts =
    firstClaimIndex >= 0
      ? counts.slice(
          firstClaimIndex,
          Math.min(counts.length, lastClaimIndex + 1),
        )
      : counts.slice(-Math.min(6, counts.length));
  const max = Math.max(1, ...visibleCounts.map((bucket) => bucket.count));
  const denom = Math.max(1, visibleCounts.length - 1);
  return {
    buckets: visibleCounts,
    points: visibleCounts.map((bucket, index) => ({
      x: (index / denom) * 100,
      y: 96 - (bucket.count / max) * 88,
      count: bucket.count,
      at: bucket.at,
    })),
    labels: {
      start:
        bucketMs === 3600000
          ? bucketLabel(visibleCounts[0], "hourly", 0, visibleCounts.length)
          : bucketLabel(visibleCounts[0], "daily", 0, visibleCounts.length),
      end: "now",
    },
    max,
    mode: bucketMs === 3600000 ? "hourly" : "daily",
  };
}

function buildTimelineFromHistory(history = []) {
  return buildClaimBuckets(history);
}

function analyticsRefreshKey(analytics) {
  const root = analytics && typeof analytics === "object" ? analytics : {};
  const session =
    root.session && typeof root.session === "object" ? root.session : {};
  const lifetime =
    root.lifetime && typeof root.lifetime === "object" ? root.lifetime : {};
  const summarize = (bucket) => ({
    startedAt: asNumber(bucket.startedAt, 0),
    totalClaims: asNumber(bucket.totalClaims, 0),
    totalResets: asNumber(bucket.totalResets, 0),
    totalResetCostPbp: asNumber(bucket.totalResetCostPbp, 0),
    totalLeased: asNumber(bucket.totalLeased, 0),
    claimHistoryLength: Array.isArray(bucket.claimHistory)
      ? bucket.claimHistory.length
      : 0,
    spendHistoryLength: Array.isArray(bucket.spendHistory)
      ? bucket.spendHistory.length
      : 0,
    resetHistoryLength: Array.isArray(bucket.resetHistory)
      ? bucket.resetHistory.length
      : 0,
    rentalHistoryLength: Array.isArray(bucket.rentalHistory)
      ? bucket.rentalHistory.length
      : 0,
    assignmentHistoryLength: Array.isArray(bucket.assignmentHistory)
      ? bucket.assignmentHistory.length
      : 0,
  });
  return JSON.stringify({
    session: summarize(session),
    lifetime: summarize(lifetime),
  });
}

function bucketLabel(bucket, mode, index, total) {
  if (!bucket) return "";
  if (index === total - 1) return "now";
  const date = new Date(bucket.at);
  if (mode === "daily") {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
  });
}

function DetailRow({ icon, label, value, tone = "text-slate-100" }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs leading-4.5">
      <span className="flex min-w-0 items-center gap-1 whitespace-nowrap text-slate-400">
        {icon ? (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            {icon}
          </span>
        ) : null}
        {label}
      </span>
      <span className={`shrink-0 text-right font-semibold ${tone}`}>
        {value}
      </span>
    </div>
  );
}

function DetailCard({ title, children }) {
  return (
    <div className="card min-h-0 overflow-hidden">
      <div className="mb-1 text-sm font-semibold text-slate-200">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export default function StatsPage({ status }) {
  const bridge = useDesktopBridge();
  const safeStatus = status && typeof status === "object" ? status : {};
  const refreshKey = analyticsRefreshKey(safeStatus.analytics);
  const [rangeKey, setRangeKey] = useState("session");
  const [analyticsView, setAnalyticsView] = useState(null);
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError("");
    bridge
      .getAnalyticsView(rangeKey)
      .then((result) => {
        if (!mounted) return;
        setAnalyticsView(result);
      })
      .catch((loadError) => {
        if (!mounted) return;
        setError(String(loadError?.message || loadError));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [bridge, rangeKey, refreshKey]);

  const scopedAnalytics =
    analyticsView?.analytics && typeof analyticsView.analytics === "object"
      ? analyticsView.analytics
      : {};

  const rewards = {
    pbp: asNumber(scopedAnalytics?.currencyEarned?.pbp, 0),
    tc: asNumber(scopedAnalytics?.currencyEarned?.tc, 0),
    cc: asNumber(scopedAnalytics?.currencyEarned?.cc, 0),
  };

  const spend = {
    pbp: asNumber(scopedAnalytics.totalResetCostPbp, 0),
    tc: 0,
    cc: 0,
  };

  const claimEvents = [];
  const claims = asNumber(scopedAnalytics.totalClaims, 0);
  const elapsedHours = Math.max(
    1 / 60,
    (Date.now() - asNumber(scopedAnalytics.startedAt, Date.now())) / 3600000,
  );
  const sessionHistory = Array.isArray(scopedAnalytics.claimHistory)
    ? scopedAnalytics.claimHistory
    : [];
  const sessionMissionClaims =
    scopedAnalytics.missionClaims &&
    typeof scopedAnalytics.missionClaims === "object"
      ? scopedAnalytics.missionClaims
      : {};
  const rows = buildMissionRows(
    claimEvents,
    sessionMissionClaims,
    sessionHistory,
    safeStatus.guiMissionSlots,
  );
  const maxClaims = Math.max(1, ...rows.map((row) => asNumber(row.claims, 0)));
  const timelineData = buildTimelineFromHistory(sessionHistory);
  const chartBuckets = Array.isArray(timelineData.buckets)
    ? timelineData.buckets
    : [];
  const chartTotalClaims = chartBuckets.reduce(
    (sum, bucket) => sum + asNumber(bucket.count, 0),
    0,
  );
  const netPbp = rewards.pbp - spend.pbp;
  const claimsPerHour = claims / elapsedHours;
  const missionResets = asNumber(scopedAnalytics.resetTypes?.mission, 0);
  const nftResets = asNumber(scopedAnalytics.resetTypes?.nft, 0);
  const resetCost = asNumber(scopedAnalytics.totalResetCostPbp ?? spend.pbp, 0);
  const spendByAction =
    scopedAnalytics.spendByAction &&
    typeof scopedAnalytics.spendByAction === "object"
      ? scopedAnalytics.spendByAction
      : {};
  const missionResetPbp = asNumber(spendByAction.mission_reroll, 0);
  const nftResetPbp = asNumber(
    spendByAction.nft_cooldown_reset ?? spendByAction.cooldown_reset,
    0,
  );
  const missionSelectionPbp = asNumber(spendByAction.mission_swap, 0);
  const sessionRentals = asNumber(scopedAnalytics.totalLeased, 0);
  const nftResetUsage =
    scopedAnalytics.nftResetUsage &&
    typeof scopedAnalytics.nftResetUsage === "object"
      ? scopedAnalytics.nftResetUsage
      : {};
  const ownedResetStats =
    nftResetUsage.owned && typeof nftResetUsage.owned === "object"
      ? nftResetUsage.owned
      : {};
  const rentalResetStats =
    nftResetUsage.rental && typeof nftResetUsage.rental === "object"
      ? nftResetUsage.rental
      : {};
  const ownedNftResets = asNumber(ownedResetStats.resets, 0);
  const ownedNftResetAssigned = asNumber(ownedResetStats.assigned, 0);
  const ownedNftResetMissed = Math.max(
    0,
    ownedNftResets - ownedNftResetAssigned,
  );
  const rentalNftResets = asNumber(rentalResetStats.resets, 0);
  const rentalNftResetAssigned = asNumber(rentalResetStats.assigned, 0);
  const rentalNftResetMissed = Math.max(
    0,
    rentalNftResets - rentalNftResetAssigned,
  );
  const netPerHour = netPbp / elapsedHours;
  const tokenIconClass = "h-3.5 w-3.5 object-contain";
  const rangeLabel =
    rangeKey === "session"
      ? "Session"
      : rangeKey === "24h"
        ? "Last 24hrs"
        : rangeKey === "7d"
          ? "Last 7days"
          : "All Time";

  async function handleResetSession() {
    if (actionBusy) return;
    setActionBusy(true);
    setError("");
    try {
      const next = await bridge.resetAnalyticsRange(rangeKey);
      setAnalyticsView(next);
    } catch (resetError) {
      setError(String(resetError?.message || resetError));
    } finally {
      setActionBusy(false);
    }
  }

  async function handleExportCsv() {
    if (actionBusy) return;
    setActionBusy(true);
    setError("");
    try {
      const result = await bridge.exportAnalyticsCsv(rangeKey);
      if (!result?.ok && result?.canceled !== true) {
        throw new Error(result?.error || "CSV export failed.");
      }
    } catch (exportError) {
      setError(String(exportError?.message || exportError));
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <section className="h-full min-h-0 overflow-hidden">
      <div className="grid  grid-rows-[auto_200px_auto_auto] gap-3 overflow-hidden">
        <section className="card grid grid-cols-[minmax(195px,0.28fr)_minmax(0,1fr)] items-center gap-4 ">
          <div className=" col-span-full flex flex-row items-center gap-3 items-center w-full  justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-xs btn-black z-10 rounded-sm font-normal px-2 inline-flex ml-0 "
                onClick={() => void handleExportCsv()}
                disabled={actionBusy || loading}
                title="Export stats to CSV"
              >
                Export .csv
              </button>{" "}
              <button
                type="button"
                className="btn btn-xs bg-error font-normal border-error rounded-sm not-disabled:hover:bg-error-content transition-all opacity-70 hover:opacity-100 "
                onClick={() => void handleResetSession()}
                disabled={actionBusy || loading}
                title={`Clear persisted stats for ${rangeLabel}`}
              >
                Clear Stats
              </button>
            </div>
            <div className="flex gap-2 items-center ">
              <div className="text-[11px] text-slate-400 w-auto">
                Stats Window
              </div>
              <select
                className="select select-sm  bg-black/50 focus-within:bg-black border-white/10 text-slate-100 w-36"
                value={rangeKey}
                onChange={(event) =>
                  setRangeKey(String(event.target.value || "session"))
                }
                disabled={loading || actionBusy}
              >
                <option value="session">This session</option>
                <option value="24h">Last 24hrs</option>
                <option value="7d">Last 7days</option>
                <option value="all">All time</option>
              </select>
            </div>
          </div>
          <div className="">
            <div className="text-xs  text-slate-400">Net PBP</div>
            <div
              className={` text-4xl font-semibold leading-none ${
                netPbp >= 0 ? "text-success" : "text-error"
              }`}
            >
              {formatNumber(netPbp)} PBP
            </div>
          </div>
          <div className=" grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(112px,0.9fr)] gap-x-5 gap-y-1.5">
            <DetailRow
              icon={<img src={pbpIcon} className={tokenIconClass} alt="" />}
              label="PBP earned"
              value={formatNumber(rewards.pbp)}
            />
            <DetailRow
              icon={<img src={tcIcon} className={tokenIconClass} alt="" />}
              label="TC earned"
              value={formatNumber(rewards.tc)}
            />
            <DetailRow
              icon={<img src={ccIcon} className={tokenIconClass} alt="" />}
              label="CC earned"
              value={formatNumber(rewards.cc)}
            />
            <DetailRow
              icon={<img src={pbpIcon} className={tokenIconClass} alt="" />}
              label="PBP spent"
              value={formatNumber(spend.pbp)}
              tone={spend.pbp > 0 ? "text-error" : "text-slate-100"}
            />
            <DetailRow
              icon={<span>↗</span>}
              label="PBP / hr"
              value={formatNumber(netPerHour)}
              tone={netPerHour >= 0 ? "text-success" : "text-error"}
            />
            <DetailRow
              icon={<span>#</span>}
              label="Claims / hr"
              value={formatNumber(claimsPerHour)}
            />
          </div>
        </section>

        <div className="grid min-h-0 grid-cols-2 gap-3 overflow-hidden">
          <section className="card stats-live-card min-h-0 overflow-hidden">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-200">
                Claims per {timelineData.mode === "daily" ? "Day" : "Hour"}
              </div>

              <div className="text-right  text-slate-400">
                <div className="text-[11px]">
                  {formatNumber(chartTotalClaims, 0)} claims shown
                </div>
              </div>
            </div>
            <div className="mt-2 h-full rounded-md bg-black/20 px-2 pt-2 pb-1 overflow-hidden">
              {chartBuckets.length ? (
                <div className="relative h-full min-w-0">
                  {/* <div className="absolute inset-x-0 top-0 border-t border-slate-400/10" /> */}
                  {/* <div className="absolute inset-x-0 top-1/2 border-t border-slate-400/10" /> */}
                  <div className="absolute inset-x-0 bottom-5.5 border-t border-slate-400/20" />
                  <div className="relative z-10 flex h-full items-end justify-end gap-0.5 overflow-hidden">
                    {chartBuckets.map((bucket, index) => {
                      const count = asNumber(bucket.count, 0);
                      const height =
                        count > 0
                          ? Math.max(
                              16,
                              (count / Math.max(1, timelineData.max)) * 100,
                            )
                          : 0;
                      return (
                        <div
                          className="flex h-full w-7 shrink-0 flex-col items-center justify-end gap-1"
                          key={`claim_bucket_${bucket.at}_${index}`}
                          title={`${bucketLabel(bucket, timelineData.mode, index, chartBuckets.length)}: ${formatNumber(count, 0)} claims`}
                        >
                          <div className="flex h-[calc(100%-14px)] w-full flex-col justify-end">
                            <div
                              className="claim-bar mx-auto w-5 rounded-t-sm"
                              style={{ height: `${height}%` }}
                            />
                          </div>
                          <div className="h-auto max-w-full truncate text-[9px] leading-3 text-slate-400 flex-row">
                            <div>
                              {count > 0 ? (
                                <div className="mb-0.5 text-center text-[10px] font-semibold leading-none text-slate-100">
                                  {formatNumber(count, 0)}
                                </div>
                              ) : null}
                            </div>{" "}
                            {bucketLabel(
                              bucket,
                              timelineData.mode,
                              index,
                              chartBuckets.length,
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-slate-500">
                  No claim history saved yet.
                </div>
              )}
            </div>
          </section>

          <div className="grid min-h-0 grid-rows-1 overflow-hidden">
            <section className="card min-h-0 overflow-hidden">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-slate-200">
                  {rangeLabel} Missions
                </div>
              </div>
              <div className="mt-2 space-y-1 overflow-hidden">
                {rows.length ? (
                  rows.slice(0, 4).map((row, index) => {
                    const progress = Math.max(
                      0,
                      Math.min(
                        100,
                        (asNumber(row.claims, 0) / maxClaims) * 100,
                      ),
                    );
                    return (
                      <div className="min-w-0" key={row.mission}>
                        <div className="flex items-center justify-between gap-2 text-xs leading-4">
                          <div className="min-w-0 flex items-center gap-1.5">
                            <span className="shrink-0 text-slate-500">
                              #{index + 1}
                            </span>
                            <span className="text-slate-200">
                              {row.mission}
                            </span>
                          </div>
                          <div className="shrink-0 font-semibold text-slate-100">
                            {formatNumber(row.claims, 0)}
                          </div>
                        </div>
                        <div className="relative h-2 rounded-full overflow-hidden bg-zinc-800">
                          <div className="absolute rounded-full inset-0 z-0 bg-linear-to-r from-violet-500 via-fuchsia-500 to-pink-500 after:hidden transition-all" />
                          <div
                            className="mission-progress-mask absolute rounded-r-full rounded-l-none top-0 right-0 z-10 h-full bg-zinc-800 after:hidden transition-all"
                            style={{ width: `${100 - progress}%` }}
                          />
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-500">
                    No mission claims yet.
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 overflow-hidden">
          <DetailCard title={`${rangeLabel} Activity`}>
            <DetailRow label="Claims" value={formatNumber(claims, 0)} />{" "}
            <DetailRow
              label="Mission resets"
              value={formatNumber(missionResets, 0)}
            />
            <DetailRow label="NFT resets" value={formatNumber(nftResets, 0)} />
          </DetailCard>

          <DetailCard title={`${rangeLabel} Costs`}>
            <DetailRow
              label="Mission reset"
              value={formatNumber(missionResetPbp)}
            />
            <DetailRow label="NFT reset" value={formatNumber(nftResetPbp)} />
            <DetailRow
              label="Mission changes"
              value={formatNumber(missionSelectionPbp)}
            />
          </DetailCard>
        </div>

        <div className="grid grid-cols-2 gap-3 overflow-hidden">
          <DetailCard title={`${rangeLabel} Rentals`}>
            <DetailRow
              label="Rentals used"
              value={formatNumber(sessionRentals, 0)}
            />{" "}
            <DetailRow
              label="NFT resets"
              value={formatNumber(rentalNftResets, 0)}
            />{" "}
            <DetailRow
              label="Missed after reset"
              value={formatNumber(rentalNftResetMissed, 0)}
              tone={
                rentalNftResetMissed > 0 ? "text-amber-300" : "text-slate-100"
              }
            />
          </DetailCard>{" "}
        </div>
        <div
          className={`min-h-[16px] text-xs ${
            error
              ? "text-error"
              : loading
                ? "text-slate-400"
                : "text-transparent"
          }`}
        >
          {error ? error : loading ? "Loading stats…" : "."}
        </div>
      </div>
    </section>
  );
}
