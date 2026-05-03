import pbpIcon from "../img/icon_pbp.webp";
import ccIcon from "../img/icon_cc.webp";
import tcIcon from "../img/icon_tc.webp";

function formatNumber(value, max = 2) {
  const n = Number(value || 0);
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
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

function parseClaimEvents(logs = []) {
  const events = [];
  for (const entry of Array.isArray(logs) ? logs : []) {
    const text = String(entry?.text || "");
    const match = text.match(
      /\[WATCH\]\s+✅\s+Claimed(?:\s+\([^)]+\))?:\s*(.+)$/i,
    );
    if (!match) continue;
    const body = String(match[1] || "").trim();
    if (!body || body.startsWith("+")) continue;
    const reward = body.match(/([0-9]+(?:\.[0-9]+)?)\s+([A-Z]{2,4})/);
    const atMs = new Date(entry?.at).getTime();
    events.push({
      mission: missionName(body.split(" slot=")[0]),
      amount: asNumber(reward?.[1], 0),
      token: String(reward?.[2] || "").toUpperCase(),
      atMs: Number.isFinite(atMs) ? atMs : null,
    });
  }
  return events.sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
}

function buildMissionRows(events = [], missionClaims = {}, history = []) {
  const rows = new Map();

  if (missionClaims && typeof missionClaims === "object") {
    for (const [name, count] of Object.entries(missionClaims)) {
      const claims = asNumber(count, 0);
      if (claims <= 0) continue;
      rows.set(missionName(name), {
        mission: missionName(name),
        claims,
        pbp: 0,
        tc: 0,
        cc: 0,
      });
    }
  }

  if (rows.size === 0 && Array.isArray(history)) {
    for (const entry of history) {
      const mission = missionName(entry?.mission);
      if (!mission || mission === "unknown mission") continue;
      const current = rows.get(mission) || {
        mission,
        claims: 0,
        pbp: 0,
        tc: 0,
        cc: 0,
      };
      current.claims += 1;
      rows.set(mission, current);
    }
  }

  if (rows.size === 0) {
    for (const event of events) {
      const current = rows.get(event.mission) || {
        mission: event.mission,
        claims: 0,
        pbp: 0,
        tc: 0,
        cc: 0,
      };
      current.claims += 1;
      if (event.token === "PBP") current.pbp += event.amount;
      if (event.token === "TC") current.tc += event.amount;
      if (event.token === "CC") current.cc += event.amount;
      rows.set(event.mission, current);
    }
  } else {
    for (const event of events) {
      const current = rows.get(event.mission) || {
        mission: event.mission,
        claims: 0,
        pbp: 0,
        tc: 0,
        cc: 0,
      };
      if (event.token === "PBP") current.pbp += event.amount;
      if (event.token === "TC") current.tc += event.amount;
      if (event.token === "CC") current.cc += event.amount;
      rows.set(mission, current);
    }
  }

  return Array.from(rows.values()).sort((a, b) => b.claims - a.claims);
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

function buildTimelineFromEvents(events = []) {
  return buildClaimBuckets(
    events
      .filter((event) => Number.isFinite(event.atMs))
      .map((event, index) => ({
        at: event.atMs,
        claims: index + 1,
      })),
  );
}

function buildTimelineFromHistory(history = []) {
  return buildClaimBuckets(history);
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
    <div className="flex items-center justify-between gap-3 text-xs leading-5">
      <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-slate-400">
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

export default function StatsPage({
  status,
  logs,
  missionStats,
  sessionStartedAtMs,
}) {
  const safeStatus = status && typeof status === "object" ? status : {};
  const safeMissionStats =
    missionStats && typeof missionStats === "object" ? missionStats : {};
  const analytics =
    safeStatus.analytics && typeof safeStatus.analytics === "object"
      ? safeStatus.analytics
      : {};
  const sessionAnalytics =
    analytics.session && typeof analytics.session === "object"
      ? analytics.session
      : {};

  const statusRewards = safeStatus.sessionRewardTotals || {};
  const analyticsRewards = sessionAnalytics.currencyEarned || {};
  const rewards = {
    pbp: asNumber(statusRewards.pbp ?? analyticsRewards.pbp, 0),
    tc: asNumber(statusRewards.tc ?? analyticsRewards.tc, 0),
    cc: asNumber(statusRewards.cc ?? analyticsRewards.cc, 0),
  };

  const statusSpend = safeStatus.sessionSpendTotals || {};
  const spend = {
    pbp: asNumber(statusSpend.pbp ?? sessionAnalytics.totalResetCostPbp, 0),
    tc: asNumber(statusSpend.tc, 0),
    cc: asNumber(statusSpend.cc, 0),
  };

  const claimEvents = parseClaimEvents(logs);
  const claims = Math.max(
    asNumber(sessionAnalytics.totalClaims, 0),
    asNumber(safeMissionStats.claimed, 0),
    claimEvents.length,
  );
  const elapsedHours = Math.max(
    1 / 60,
    (Date.now() - asNumber(sessionStartedAtMs, Date.now())) / 3600000,
  );
  const sessionHistory = Array.isArray(sessionAnalytics.claimHistory)
    ? sessionAnalytics.claimHistory
    : [];
  const sessionMissionClaims =
    sessionAnalytics.missionClaims &&
    typeof sessionAnalytics.missionClaims === "object"
      ? sessionAnalytics.missionClaims
      : {};
  const rows = buildMissionRows(claimEvents, sessionMissionClaims, sessionHistory);
  const rankedClaims = rows.reduce(
    (sum, row) => sum + asNumber(row.claims, 0),
    0,
  );
  const maxClaims = Math.max(1, ...rows.map((row) => asNumber(row.claims, 0)));
  const chartClaimTotal = Math.max(
    claims,
    asNumber(sessionAnalytics.totalClaims, 0),
    ...sessionHistory.map((entry) => asNumber(entry?.claims, 0)),
  );
  const timelineData = sessionHistory.length
    ? buildTimelineFromHistory(sessionHistory)
    : buildTimelineFromEvents(claimEvents);
  const chartBuckets = Array.isArray(timelineData.buckets)
    ? timelineData.buckets
    : [];
  const chartTotalClaims = chartBuckets.reduce(
    (sum, bucket) => sum + asNumber(bucket.count, 0),
    0,
  );
  const netPbp = rewards.pbp - spend.pbp;
  const claimsPerHour = claims / elapsedHours;
  const resets = asNumber(sessionAnalytics.totalResets, 0);
  const missionResets = asNumber(sessionAnalytics.resetTypes?.mission, 0);
  const nftResets = asNumber(sessionAnalytics.resetTypes?.nft, 0);
  const resetCost = asNumber(
    sessionAnalytics.totalResetCostPbp ?? spend.pbp,
    0,
  );
  const spendByAction =
    sessionAnalytics.spendByAction &&
    typeof sessionAnalytics.spendByAction === "object"
      ? sessionAnalytics.spendByAction
      : {};
  const missionResetPbp = asNumber(spendByAction.mission_reroll, 0);
  const nftResetPbp = asNumber(
    spendByAction.nft_cooldown_reset ?? spendByAction.cooldown_reset,
    0,
  );
  const slotUnlockPbp = asNumber(spendByAction.mission_slot_unlock, 0);
  const sessionRentals = asNumber(sessionAnalytics.totalLeased, 0);
  const netPerHour = netPbp / elapsedHours;
  const tokenIconClass = "h-3.5 w-3.5 object-contain";

  return (
    <section className="h-full min-h-0 overflow-hidden">
      <div className="grid h-full min-h-0 grid-rows-[118px_210px_minmax(0,1fr)] gap-2 overflow-hidden">
        <section className="card grid grid-cols-[minmax(195px,0.28fr)_minmax(0,1fr)] items-center gap-4 overflow-hidden">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-400">Net PBP</div>
            <div
              className={`mt-1 text-4xl font-semibold leading-none ${
                netPbp >= 0 ? "text-success" : "text-error"
              }`}
            >
              {formatNumber(netPbp)} PBP
            </div>
            <div className="mt-2 flex gap-2 text-xs text-slate-300">
              <span className="rounded-md bg-black/20 px-2 py-1">
                {formatNumber(claims, 0)} claims
              </span>
              <span className="rounded-md bg-black/20 px-2 py-1">
                {formatAge(elapsedHours)}
              </span>
            </div>
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(112px,0.9fr)] gap-x-5 gap-y-1.5">
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
          </div>
        </section>

        <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_minmax(300px,0.9fr)] gap-2 overflow-hidden">
          <section className="card stats-live-card min-h-0 overflow-hidden">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-slate-200">
                  Claims per {timelineData.mode === "daily" ? "Day" : "Hour"}
                </div>
                <div className="text-[11px] text-slate-500">
                  {timelineData.mode === "daily"
                    ? "Recent active days"
                    : "Recent active hours"}
                </div>
              </div>
              <div className="text-right text-xs text-slate-400">
                <div>{formatNumber(chartTotalClaims, 0)} claims shown</div>
                <div>peak {formatNumber(timelineData.max, 0)}</div>
              </div>
            </div>
            <div className="mt-2 h-[calc(100%-38px)] rounded-md bg-black/20 p-2.5 overflow-hidden">
              {chartBuckets.length ? (
                <div className="relative h-full min-w-0">
                  <div className="absolute inset-x-0 top-0 border-t border-slate-400/10" />
                  <div className="absolute inset-x-0 top-1/2 border-t border-slate-400/10" />
                  <div className="absolute inset-x-0 bottom-0 border-t border-slate-400/20" />
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
                            {count > 0 ? (
                              <div className="mb-1 text-center text-[10px] font-semibold leading-none text-slate-100">
                                {formatNumber(count, 0)}
                              </div>
                            ) : null}
                            <div
                              className="claim-bar mx-auto w-4 rounded-t-sm"
                              style={{ height: `${height}%` }}
                            />
                          </div>
                          <div className="h-3 max-w-full truncate text-[9px] leading-3 text-slate-500">
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
                  Session Mission Ranking
                </div>
                <div className="text-xs text-slate-500">
                  {formatNumber(rankedClaims, 0)}/{formatNumber(claims, 0)}{" "}
                  claims
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

        <div className="grid grid-cols-3 gap-2 overflow-hidden">
          <DetailCard title="Session Activity">
            <DetailRow label="Claims" value={formatNumber(claims, 0)} />
            <DetailRow
              label="Mission resets"
              value={formatNumber(missionResets, 0)}
            />
            <DetailRow label="NFT resets" value={formatNumber(nftResets, 0)} />
            <DetailRow
              label="Claims / hr"
              value={formatNumber(claimsPerHour)}
            />
          </DetailCard>

          <DetailCard title="Session Costs">
            <DetailRow
              label="Mission reset PBP"
              value={formatNumber(missionResetPbp)}
            />
            <DetailRow
              label="NFT reset PBP"
              value={formatNumber(nftResetPbp)}
            />
            <DetailRow
              label="Slot unlock PBP"
              value={formatNumber(slotUnlockPbp)}
            />
            <DetailRow
              label="Total spent PBP"
              value={formatNumber(resetCost)}
            />
          </DetailCard>

          <DetailCard title="Rentals">
            <DetailRow
              label="Session leases"
              value={formatNumber(sessionRentals, 0)}
            />
            <DetailRow
              label="Tracked claims"
              value={formatNumber(sessionHistory.length, 0)}
            />
            <DetailRow
              label="Ranked claims"
              value={formatNumber(rankedClaims, 0)}
            />
            <DetailRow label="Reset actions" value={formatNumber(resets, 0)} />
          </DetailCard>
        </div>
      </div>
    </section>
  );
}
