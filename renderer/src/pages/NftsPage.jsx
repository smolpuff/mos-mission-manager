import { useEffect, useState } from "react";

const NFT_COOLDOWN_RING_MAX_SECONDS = 24 * 60 * 60;

function formatAccount(value) {
  const text = String(value || "").trim();
  if (!text) return "n/a";
  if (text.length <= 18) return text;
  return `${text.slice(0, 8)}...${text.slice(-8)}`;
}

function formatCooldownLabel(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds || 0)));
  if (seconds <= 0) return "Ready";
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

function remainingCooldownSeconds(item, nowMs) {
  const endsAtMs = item?.cooldownEndsAt
    ? new Date(item.cooldownEndsAt).getTime()
    : NaN;
  if (Number.isFinite(endsAtMs)) {
    return Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000));
  }
  return Math.max(0, Number(item?.cooldownSeconds || 0));
}

function isNftReady(item) {
  const cooldownSeconds = Math.max(0, Number(item?.cooldownSeconds || 0));
  const onCooldown = item?.onCooldown === true;
  if (onCooldown) return false;
  if (cooldownSeconds > 0) return false;
  return item?.available === true;
}

function CooldownBadge({ seconds = 0 }) {
  const cooldownSeconds = Math.max(0, Number(seconds || 0));
  const progress = Math.max(
    0,
    Math.min(1, cooldownSeconds / NFT_COOLDOWN_RING_MAX_SECONDS),
  );
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - progress);

  return (
    <div className="absolute top-2 left-2 z-20 h-6 w-6 rounded-full bg-black/60 backdrop-blur-[2px] shadow-md shadow-black/40 border border-white/10 grid place-items-center">
      <svg
        viewBox="0 0 44 44"
        className="-rotate-90 absolute inset-0 h-full w-full"
        aria-hidden="true"
      >
        <circle
          cx="22"
          cy="22"
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.14)"
          strokeWidth="3"
        />
        <circle
          cx="22"
          cy="22"
          r={radius}
          fill="none"
          stroke="url(#nftCooldownRing)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          style={{ transition: "stroke-dashoffset 220ms ease-out" }}
        />
        <defs>
          <linearGradient
            id="nftCooldownRing"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#fb7185" />
            <stop offset="50%" stopColor="#f59e0b" />
            <stop offset="100%" stopColor="#fde68a" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

function NftCardImage({ src, alt }) {
  const [failed, setFailed] = useState(false);
  const activeSrc = !failed ? String(src || "").trim() : "";

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (!activeSrc) {
    return <div className="mission-image-placeholder">No image</div>;
  }

  return (
    <img
      src={activeSrc}
      alt={alt || "NFT"}
      loading="lazy"
      decoding="async"
      className="absolute inset-0 z-0 h-full w-full rounded-md object-cover"
      onError={() => setFailed(true)}
    />
  );
}

export default function NftsPage({ bridge }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [selectedCollection, setSelectedCollection] = useState("all");
  const [sortBy, setSortBy] = useState("cooldown_remaining");
  const [data, setData] = useState({
    total: 0,
    nfts: [],
  });

  const load = async () => {
    if (!bridge?.getUserNfts) return;
    setLoading(true);
    setError(null);
    try {
      const next = await bridge.getUserNfts();
      if (!next?.ok) {
        throw new Error(next?.error || "Failed to load NFTs.");
      }
      setData({
        total: Number(next.total || 0),
        nfts: Array.isArray(next.nfts) ? next.nfts : [],
      });
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [bridge]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const collectionOptions = [];
  const collectionSeen = new Set();
  for (const item of data.nfts) {
    const key = String(item?.collection || "unknown").trim() || "unknown";
    if (collectionSeen.has(key)) continue;
    collectionSeen.add(key);
    collectionOptions.push({
      key,
      label: key,
      image: item?.image || null,
      count: data.nfts.filter(
        (entry) =>
          (String(entry?.collection || "unknown").trim() || "unknown") === key,
      ).length,
    });
  }
  collectionOptions.sort((a, b) => a.label.localeCompare(b.label));

  const visibleNfts = data.nfts
    .filter((item) => {
      if (selectedCollection === "all") return true;
      return (
        (String(item?.collection || "unknown").trim() || "unknown") ===
        selectedCollection
      );
    })
    .sort((a, b) => {
      const cooldownA = remainingCooldownSeconds(a, nowMs);
      const cooldownB = remainingCooldownSeconds(b, nowMs);
      const levelA = Number(a?.level || 0);
      const levelB = Number(b?.level || 0);
      if (sortBy === "cooldown_largest")
        return cooldownB - cooldownA || levelB - levelA;
      if (sortBy === "level_highest")
        return levelB - levelA || cooldownA - cooldownB;
      if (sortBy === "level_lowest")
        return levelA - levelB || cooldownA - cooldownB;
      return cooldownA - cooldownB || levelB - levelA;
    });

  return (
    <section className="h-full min-h-0 flex flex-col gap-4 overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-[150px_auto] gap-4 shrink-0">
        <div className="card p-4 border border-white/10 bg-black/30 relative">
          <div className="text-sm uppercase text-slate-300 ">My NFTs</div>
          <div className="text-2xl font-semibold text-slate-100 mt-1">
            {Number(data.total || 0).toLocaleString()}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            <button
              type="button"
              className="btn btn-xs btn-outline z-10 !w-fit min-h-0 h-6 px-3 inline-flex"
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>
        <div className="card p-4 border border-white/10 bg-black/30">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="text-sm uppercase text-slate-300">Filters</div>
              <div className="text-xs text-slate-400">
                {visibleNfts.length} shown
              </div>
            </div>
            <label className="text-[11px] text-slate-400 flex items-center gap-2">
              <span>Sort by</span>
              <select
                className="bg-black/30 border border-white/10 rounded-md px-2 py-1 text-xs text-slate-200"
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value)}
              >
                <option value="cooldown_remaining">Cooldown Remaining</option>
                <option value="cooldown_largest">Cooldown Largest</option>
                <option value="level_highest">Level Highest</option>
                <option value="level_lowest">Level Lowest</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={`h-7 px-1 rounded-full border text-xs inline-flex items-center gap-2 ${
                selectedCollection === "all"
                  ? "border-white/25 bg-white/10 text-white"
                  : "border-white/10 bg-black/20 text-slate-300"
              }`}
              onClick={() => setSelectedCollection("all")}
            >
              <span>All</span>
              <span className="text-slate-400">{data.nfts.length}</span>
            </button>
            {collectionOptions.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`h-7 px-1 pr-3 rounded-full border text-xs inline-flex items-center gap-2 ${
                  selectedCollection === option.key
                    ? "border-white/25 bg-white/10 text-white"
                    : "border-white/10 bg-black/20 text-slate-300"
                }`}
                onClick={() => setSelectedCollection(option.key)}
                title={option.label}
              >
                {option.image ? (
                  <img
                    src={option.image}
                    alt={option.label}
                    className="w-5 h-5 rounded-full object-cover border border-white/10"
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <span className="w-5 h-5 rounded-full bg-white/10 border border-white/10" />
                )}
                <span className="max-w-20 truncate">{option.label}</span>
                <span className="text-slate-400">{option.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {error ? (
        <div className="card p-4 border border-error/40 bg-error/10 text-error shrink-0">
          {error}
        </div>
      ) : null}

      <div className="card p-4 border border-white/10 bg-black/30 h-120 flex flex-col overflow-hidden">
        {data.nfts.length === 0 ? (
          <div className="text-sm text-slate-400 mt-3 flex items-center gap-2">
            {loading ? (
              <>
                <span className="loading loading-spinner loading-sm text-success" />
                <span>Loading NFTs...</span>
              </>
            ) : (
              <span>No NFTs found.</span>
            )}
          </div>
        ) : (
          <div className="nft-grid-scrollw-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
            <div className="grid grid-cols-5 gap-3 pb-3">
              {visibleNfts.map((item) => {
                const liveCooldownSeconds = remainingCooldownSeconds(
                  item,
                  nowMs,
                );
                const isReady = isNftReady({
                  ...item,
                  cooldownSeconds: liveCooldownSeconds,
                });
                return (
                  <div key={item.id} className="card-mission min-w-0">
                    <div className="card-mission__header relative overflow-clip relative">
                      <NftCardImage src={item.image} alt={item.name || "NFT"} />
                      {!isReady ? (
                        <CooldownBadge seconds={liveCooldownSeconds} />
                      ) : null}
                      <div
                        className="z-10 text-sm flex items-center justify-center rounded-tl-md absolute bottom-0 right-0 w-7 h-7 opacity-100 shadow-md shadow-black/30 font-semibold text-violet-950 border border-white/40"
                        style={{
                          background:
                            "linear-gradient(145deg, rgba(248,250,252,0.96) 0%, rgba(226,232,240,0.94) 22%, rgba(186,230,253,0.9) 48%, rgba(221,214,254,0.88) 72%, rgba(255,255,255,0.95) 100%)",
                          boxShadow:
                            "0 0 0 1px rgba(255,255,255,0.3), 0 0 10px rgba(255,255,255,0.12), 0 0 14px rgba(148,163,184,0.16)",
                        }}
                      >
                        {item.level !== null ? item.level : "?"}
                      </div>
                    </div>
                    <div className="card-mission__meta">
                      <div className="card-mission__title truncate">
                        {item.name || "Unknown NFT"}
                      </div>

                      <div className="mt-1 flex items-center justify-center gap-2 text-[11px]">
                        <span
                          className={
                            !isReady ? "text-amber-300" : "text-emerald-300"
                          }
                        >
                          {!isReady
                            ? `CD ${liveCooldownSeconds > 0 ? ` ${formatCooldownLabel(liveCooldownSeconds)}` : ""}`
                            : ""}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
