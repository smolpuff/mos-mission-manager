function formatNumber(value, max = 2) {
  const n = Number(value || 0);
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
}

function parseClaimEvents(logs = []) {
  const events = [];
  for (const entry of Array.isArray(logs) ? logs : []) {
    const text = String(entry?.text || "");
    if (!/\[WATCH\]\s+✅\s+Claimed:/i.test(text)) continue;
    const body = text.split("Claimed:")[1] || "";
    const mission = body.split(" slot=")[0]?.trim() || "unknown mission";
    const rewardMatch = body.match(/([0-9]+(?:\.[0-9]+)?)\s+([A-Z]{2,4})/);
    const amount = Number(rewardMatch?.[1] || 0);
    const token = String(rewardMatch?.[2] || "").toUpperCase();
    const atMs = Number.isFinite(new Date(entry?.at).getTime())
      ? new Date(entry?.at).getTime()
      : null;
    events.push({
      mission,
      token,
      amount: Number.isFinite(amount) ? amount : 0,
      atMs,
    });
  }
  return events.sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
}

function buildClaimStats(events = []) {
  const byMission = new Map();
  for (const event of events) {
    const current = byMission.get(event.mission) || {
      mission: event.mission,
      claims: 0,
      pbp: 0,
      tc: 0,
      cc: 0,
      lastAtMs: null,
    };
    current.claims += 1;
    if (event.token === "PBP") current.pbp += event.amount;
    if (event.token === "TC") current.tc += event.amount;
    if (event.token === "CC") current.cc += event.amount;
    current.lastAtMs = event.atMs || current.lastAtMs;
    byMission.set(event.mission, current);
  }
  return Array.from(byMission.values()).sort((a, b) => b.claims - a.claims);
}

function buildEarningsTimeline(events = [], sessionStartedAtMs) {
  const startMs = Number(sessionStartedAtMs || Date.now());
  const byBucket = new Map();
  const BUCKET_MS = 60 * 60 * 1000;
  for (const event of events) {
    const atMs = Number(event.atMs || 0);
    if (!Number.isFinite(atMs) || atMs <= 0) continue;
    const bucketIndex = Math.max(0, Math.floor((atMs - startMs) / BUCKET_MS));
    const current = byBucket.get(bucketIndex) || {
      bucketIndex,
      pbp: 0,
      tc: 0,
      cc: 0,
      claims: 0,
    };
    current.claims += 1;
    if (event.token === "PBP") current.pbp += event.amount;
    if (event.token === "TC") current.tc += event.amount;
    if (event.token === "CC") current.cc += event.amount;
    byBucket.set(bucketIndex, current);
  }
  const out = Array.from(byBucket.values()).sort(
    (a, b) => a.bucketIndex - b.bucketIndex,
  );
  let cumulativePbp = 0;
  let cumulativeTc = 0;
  let cumulativeCc = 0;
  for (const row of out) {
    cumulativePbp += row.pbp;
    cumulativeTc += row.tc;
    cumulativeCc += row.cc;
    row.cumulativePbp = cumulativePbp;
    row.cumulativeTc = cumulativeTc;
    row.cumulativeCc = cumulativeCc;
  }
  return out;
}

function buildMissionEfficiency(events = [], claimRows = []) {
  const eventsByMission = new Map();
  for (const event of events) {
    const list = eventsByMission.get(event.mission) || [];
    list.push(event);
    eventsByMission.set(event.mission, list);
  }
  return claimRows
    .map((row) => {
      const list = (eventsByMission.get(row.mission) || []).filter((e) =>
        Number.isFinite(e.atMs),
      );
      list.sort((a, b) => a.atMs - b.atMs);
      const gapsHours = [];
      for (let i = 1; i < list.length; i += 1) {
        const gapMs = list[i].atMs - list[i - 1].atMs;
        if (gapMs > 0) gapsHours.push(gapMs / 3600000);
      }
      const avgGapHours =
        gapsHours.length > 0
          ? gapsHours.reduce((sum, v) => sum + v, 0) / gapsHours.length
          : null;
      const pbpPerHour =
        avgGapHours && avgGapHours > 0
          ? Number(row.pbp || 0) / (Number(row.claims || 0) * avgGapHours)
          : null;
      return {
        mission: row.mission,
        claims: row.claims,
        pbp: row.pbp,
        avgGapHours,
        pbpPerHour,
      };
    })
    .sort((a, b) => Number(b.pbpPerHour || -1) - Number(a.pbpPerHour || -1));
}

function bucketLabel(bucketIndex = 0) {
  return `Hour ${Number(bucketIndex) + 1}`;
}

function buildSessionHourClaims(events = [], sessionStartedAtMs, endAtMs = null) {
  const now = Number.isFinite(Number(endAtMs)) ? Number(endAtMs) : Date.now();
  const HOUR_MS = 60 * 60 * 1000;
  const sessionStart = Number(sessionStartedAtMs || now);
  const elapsedMs = Math.max(0, now - sessionStart);
  const elapsedHours = Math.max(1, Math.ceil(elapsedMs / HOUR_MS));
  const bucketCount = Math.min(24, elapsedHours);
  const buckets = [];
  for (let i = bucketCount - 1; i >= 0; i -= 1) {
    const start = now - (i + 1) * HOUR_MS;
    const end = now - i * HOUR_MS;
    const labelDate = new Date(start);
    const hour = labelDate.getHours();
    const hour12 = hour % 12 || 12;
    const ampm = hour >= 12 ? "pm" : "am";
    buckets.push({
      index: bucketCount - 1 - i,
      start,
      end,
      label: `${hour12}${ampm}`,
      claims: 0,
    });
  }
  for (const event of events) {
    const atMs = Number(event?.atMs || 0);
    if (!Number.isFinite(atMs)) continue;
    for (const bucket of buckets) {
      if (atMs >= bucket.start && atMs < bucket.end) {
        bucket.claims += 1;
        break;
      }
    }
  }
  return buckets;
}

export default function StatsPage({ status, logs, missionStats, sessionStartedAtMs }) {
  const analytics = status?.analytics && typeof status.analytics === "object"
    ? status.analytics
    : null;
  const sessionAnalytics =
    analytics?.session && typeof analytics.session === "object"
      ? analytics.session
      : null;
  const lifetimeAnalytics =
    analytics?.lifetime && typeof analytics.lifetime === "object"
      ? analytics.lifetime
      : null;

  const rewards = status.sessionRewardTotals || { pbp: 0, tc: 0, cc: 0 };
  const spend = status.sessionSpendTotals || { pbp: 0, tc: 0, cc: 0 };
  const netPbp = Number(rewards.pbp || 0) - Number(spend.pbp || 0);
  const claims = Number(
    sessionAnalytics?.totalClaims ?? missionStats?.claimed ?? 0,
  );
  const lifetimeClaims = Number(
    lifetimeAnalytics?.totalClaims ?? missionStats?.totalClaimed ?? 0,
  );
  const lifetimeStartedAt = Number(lifetimeAnalytics?.startedAt || 0);
  const elapsedHours = Math.max(
    1 / 60,
    (Date.now() - Number(sessionStartedAtMs || Date.now())) / 3600000,
  );
  const claimsPerHour = claims / elapsedHours;
  const elapsedLifetimeHours =
    Number.isFinite(lifetimeStartedAt) && lifetimeStartedAt > 0
      ? Math.max(1 / 60, (Date.now() - lifetimeStartedAt) / 3600000)
      : null;
  const avgClaimsPerHourOverTime = elapsedLifetimeHours
    ? lifetimeClaims / elapsedLifetimeHours
    : null;

  const claimEvents = parseClaimEvents(logs);
  const sessionWindowStartMs = Number(
    sessionAnalytics?.startedAt || sessionStartedAtMs || Date.now(),
  );
  const lastActivityMs = Array.isArray(logs)
    ? logs.reduce((max, entry) => {
        const n = Number(entry?.at || 0);
        return Number.isFinite(n) ? Math.max(max, n) : max;
      }, 0)
    : 0;
  const sessionWindowEndMs =
    status?.running === true ? Date.now() : lastActivityMs || Date.now();
  const claimRows = buildClaimStats(claimEvents);
  const earningsTimeline = buildEarningsTimeline(claimEvents, sessionStartedAtMs);
  const efficiencyRows = buildMissionEfficiency(claimEvents, claimRows).slice(0, 8);
  const sessionHourClaimBuckets = buildSessionHourClaims(
    claimEvents,
    sessionWindowStartMs,
    sessionWindowEndMs,
  );
  const sessionHourClaimTotal = sessionHourClaimBuckets.reduce(
    (sum, b) => sum + Number(b?.claims || 0),
    0,
  );
  const maxSessionHourClaims = Math.max(
    1,
    ...sessionHourClaimBuckets.map((b) => Number(b?.claims || 0)),
  );
  const totalNftsUsedTracked = Number(
    Array.isArray(lifetimeAnalytics?.nftsUsed) ? lifetimeAnalytics.nftsUsed.length : 0,
  );
  const sessionResetCount = Number(sessionAnalytics?.totalResets || 0);
  const sessionResetCostPbp = Number(sessionAnalytics?.totalResetCostPbp || 0);
  const trackedResetCount = Number(lifetimeAnalytics?.totalResets || 0);
  const trackedResetCostPbp = Number(
    lifetimeAnalytics?.totalResetCostPbp || 0,
  );

  return (
    <section className="h-full min-h-0 flex flex-col gap-2 overflow-hidden">
      <div className="grid grid-cols-5 gap-2">
        <div className="card !p-2">
          <div className="text-xs text-slate-400">Session Net (PBP)</div>
          <div
            className={`text-lg font-semibold ${netPbp >= 0 ? "text-success" : "text-error"}`}
          >
            {formatNumber(netPbp)}
          </div>
        </div>
        <div className="card !p-2">
          <div className="text-xs text-slate-400">Session Claims</div>
          <div className="text-lg font-semibold">{formatNumber(claims, 0)}</div>
        </div>
        <div className="card !p-2">
          <div className="text-xs text-slate-400">Claims / Hour</div>
          <div className="text-lg font-semibold">{formatNumber(claimsPerHour)}</div>
        </div>
        <div className="card !p-2">
          <div className="text-xs text-slate-400">Projected / Hour</div>
          <div className="text-lg font-semibold">{formatNumber(claimsPerHour, 0)}</div>
        </div>
        <div className="card !p-2">
          <div className="text-xs text-slate-400">Avg Claims / Hour (Over Time)</div>
          <div className="text-lg font-semibold">
            {avgClaimsPerHourOverTime === null
              ? "n/a"
              : formatNumber(avgClaimsPerHourOverTime)}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="grid grid-cols-2 xl:grid-cols-5 gap-x-3 gap-y-1 text-xs text-slate-300">
          <div>Earned PBP: {formatNumber(rewards.pbp)}</div>
          <div>Spent PBP: {formatNumber(spend.pbp)}</div>
          <div>Lifetime claims: {formatNumber(lifetimeClaims, 0)}</div>
          <div>Session claims: {formatNumber(claims, 0)}</div>
          <div>Total NFTs used (tracked): {formatNumber(totalNftsUsedTracked, 0)}</div>
          <div>Total rented: 0 (placeholder)</div>
          <div>Resets this session: {formatNumber(sessionResetCount, 0)}</div>
          <div>Reset cost this session: {formatNumber(sessionResetCostPbp)} PBP</div>
          <div>Resets over time (tracked): {formatNumber(trackedResetCount, 0)}</div>
          <div>Reset cost over time (tracked): {formatNumber(trackedResetCostPbp)} PBP</div>
        </div>
      </div>

      <div className="card space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm text-slate-100">Claims - Session Runtime Hours</div>
            <div className="text-xs text-slate-400">
              {formatNumber(sessionHourClaimTotal, 0)} completed across running session hours
            </div>
          </div>
          <div className="text-[11px] text-slate-400">
            Rough session-hour buckets
          </div>
        </div>
        <div className="rounded-md border border-white/10 bg-black/20 p-2">
          <div className="flex items-end gap-1 h-28">
            {sessionHourClaimBuckets.map((bucket) => {
              const claims = Number(bucket?.claims || 0);
              const height = Math.max(
                claims > 0 ? 10 : 4,
                Math.round((claims / maxSessionHourClaims) * 100),
              );
              return (
                <div
                  key={`h_${bucket.index}_${bucket.label}`}
                  className="flex-1 min-w-0 flex flex-col items-center justify-end gap-1"
                  title={`${bucket.label}: ${claims} claims`}
                >
                  <div className="text-[10px] text-slate-300 leading-none">
                    {claims}
                  </div>
                  <div
                    className="w-full max-w-4 rounded-sm bg-sky-400/95 transition-all duration-300"
                    style={{ height: `${height}%` }}
                  />
                  <div className="text-[9px] text-slate-500 leading-none">
                    {bucket.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 min-h-0 flex-1 overflow-hidden">
        <div className="card min-h-0 flex flex-col">
          <div className="text-sm text-slate-300 mb-2">Currency Earned Over Time (Session)</div>
          <div className="overflow-y-auto min-h-0">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400">
                  <th className="text-left py-1">Window</th>
                  <th className="text-right py-1">Claims</th>
                  <th className="text-right py-1">PBP</th>
                  <th className="text-right py-1">TC</th>
                  <th className="text-right py-1">CC</th>
                  <th className="text-right py-1">Cum PBP</th>
                </tr>
              </thead>
              <tbody>
                {earningsTimeline.length ? (
                  earningsTimeline.map((row) => (
                    <tr key={`bucket_${row.bucketIndex}`} className="border-t border-white/10">
                      <td className="py-1">{bucketLabel(row.bucketIndex)}</td>
                      <td className="py-1 text-right">{formatNumber(row.claims, 0)}</td>
                      <td className="py-1 text-right">{formatNumber(row.pbp)}</td>
                      <td className="py-1 text-right">{formatNumber(row.tc)}</td>
                      <td className="py-1 text-right">{formatNumber(row.cc)}</td>
                      <td className="py-1 text-right">{formatNumber(row.cumulativePbp)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="py-2 text-slate-400">
                      No claim earnings yet this session.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card min-h-0 flex flex-col">
          <div className="text-sm text-slate-300 mb-2">Best Paying Mission (PBP / Hour est.)</div>
          <div className="overflow-y-auto min-h-0">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400">
                  <th className="text-left py-1">Mission</th>
                  <th className="text-right py-1">Claims</th>
                  <th className="text-right py-1">PBP</th>
                  <th className="text-right py-1">Avg hrs/claim</th>
                  <th className="text-right py-1">PBP/hr</th>
                </tr>
              </thead>
              <tbody>
                {efficiencyRows.length ? (
                  efficiencyRows.map((row) => (
                    <tr key={`eff_${row.mission}`} className="border-t border-white/10">
                      <td className="py-1">{row.mission}</td>
                      <td className="py-1 text-right">{formatNumber(row.claims, 0)}</td>
                      <td className="py-1 text-right">{formatNumber(row.pbp)}</td>
                      <td className="py-1 text-right">
                        {row.avgGapHours ? formatNumber(row.avgGapHours) : "n/a"}
                      </td>
                      <td className="py-1 text-right">
                        {row.pbpPerHour ? formatNumber(row.pbpPerHour) : "n/a"}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="py-2 text-slate-400">
                      Not enough data yet (needs repeated claims per mission).
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      
    </section>
  );
}
