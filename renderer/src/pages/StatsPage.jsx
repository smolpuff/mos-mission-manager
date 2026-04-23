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

function parseRentalLeaseEvents(logs = []) {
  const leaseIds = new Set();
  let count = 0;
  for (const entry of Array.isArray(logs) ? logs : []) {
    const text = String(entry?.text || "");
    if (!/started rental lease/i.test(text)) continue;
    const idMatch = text.match(
      /started rental lease\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    const leaseId = String(idMatch?.[1] || "").trim().toLowerCase();
    if (leaseId) {
      if (leaseIds.has(leaseId)) continue;
      leaseIds.add(leaseId);
    }
    count += 1;
  }
  return count;
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

  const rewardsFromStatus = status.sessionRewardTotals || {};
  const rewardsFromAnalytics = sessionAnalytics?.currencyEarned || {};
  const rewards = {
    pbp: Number(
      rewardsFromStatus.pbp ??
        rewardsFromAnalytics.pbp ??
        lifetimeAnalytics?.currencyEarned?.pbp ??
        0,
    ),
    tc: Number(
      rewardsFromStatus.tc ??
        rewardsFromAnalytics.tc ??
        lifetimeAnalytics?.currencyEarned?.tc ??
        0,
    ),
    cc: Number(
      rewardsFromStatus.cc ??
        rewardsFromAnalytics.cc ??
        lifetimeAnalytics?.currencyEarned?.cc ??
        0,
    ),
  };
  const spendFromStatus = status.sessionSpendTotals || {};
  const spend = {
    pbp: Number(
      spendFromStatus.pbp ??
        sessionAnalytics?.totalResetCostPbp ??
        lifetimeAnalytics?.totalResetCostPbp ??
        0,
    ),
    tc: Number(spendFromStatus.tc ?? 0),
    cc: Number(spendFromStatus.cc ?? 0),
  };
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
  const claimRows = buildClaimStats(claimEvents);
  const efficiencyRows = buildMissionEfficiency(claimEvents, claimRows).slice(0, 8);
  const maxMissionClaims = Math.max(
    1,
    ...claimRows.map((row) => Number(row?.claims || 0)),
  );
  const totalNftsUsedTracked = Number(
    Array.isArray(lifetimeAnalytics?.nftsUsed) ? lifetimeAnalytics.nftsUsed.length : 0,
  );
  const sessionResetCount = Number(sessionAnalytics?.totalResets || 0);
  const sessionResetCostPbp = Number(sessionAnalytics?.totalResetCostPbp || 0);
  const leasedFromLogs = parseRentalLeaseEvents(logs);
  const totalLeasedAllTime = Number(
    lifetimeAnalytics?.totalLeased ??
      lifetimeAnalytics?.totalRentalLeases ??
      leasedFromLogs,
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
          <div>Total leased (all time): {formatNumber(totalLeasedAllTime, 0)}</div>
          <div>Resets this session: {formatNumber(sessionResetCount, 0)}</div>
          <div>Reset cost this session: {formatNumber(sessionResetCostPbp)} PBP</div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 min-h-0 flex-1 overflow-hidden">
        <div className="card min-h-0 flex flex-col">
          <div className="text-sm text-slate-300 mb-2">Session Currency Earned</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 min-h-0">
            <div className="rounded-lg border border-white/10 bg-black/15 p-3">
              <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">PBP</div>
              <div className="mt-2 text-2xl font-semibold text-slate-100">
                {formatNumber(rewards.pbp)}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                Total earned this app session
              </div>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/15 p-3">
              <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">TC</div>
              <div className="mt-2 text-2xl font-semibold text-slate-100">
                {formatNumber(rewards.tc)}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                Total earned this app session
              </div>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/15 p-3">
              <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">CC</div>
              <div className="mt-2 text-2xl font-semibold text-slate-100">
                {formatNumber(rewards.cc)}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                Total earned this app session
              </div>
            </div>
          </div>
        </div>

        <div className="card min-h-0 flex flex-col">
          <div className="text-sm text-slate-300 mb-2">Mission Claims Breakdown</div>
          <div className="overflow-y-auto min-h-0 space-y-2 pr-1">
            {claimRows.length ? (
              claimRows.slice(0, 8).map((row) => {
                const widthPct = Math.max(
                  6,
                  Math.round((Number(row.claims || 0) / maxMissionClaims) * 100),
                );
                return (
                  <div key={`claim_bar_${row.mission}`} className="space-y-1">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <div className="text-slate-200 truncate">{row.mission}</div>
                      <div className="text-slate-300 shrink-0">
                        {formatNumber(row.claims, 0)} claims
                      </div>
                    </div>
                    <div className="relative h-2 rounded-full overflow-hidden bg-zinc-800">
                      <div className="absolute inset-0 rounded-full bg-linear-to-r from-violet-500 via-fuchsia-500 to-pink-500" />
                      <div
                        className="absolute top-0 right-0 h-full rounded-r-full rounded-l-none bg-zinc-800 transition-all duration-500 ease-out"
                        style={{ width: `${100 - widthPct}%` }}
                      />
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="py-2 text-xs text-slate-400">
                No claim data yet for mission bars.
              </div>
            )}
          </div>
        </div>
      </div>

      
    </section>
  );
}
