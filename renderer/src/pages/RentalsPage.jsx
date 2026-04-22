import { useEffect, useState } from "react";

export default function RentalsPage({ bridge }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [data, setData] = useState({
    rentableCount: 0,
    rentable: [],
    activeRentals: [],
    slotSummary: [],
    poolByCollection: [],
  });

  const load = async () => {
    if (!bridge?.getRentalsPreview) return;
    setLoading(true);
    setError(null);
    try {
      const next = await bridge.getRentalsPreview();
      if (!next?.ok) {
        throw new Error(next?.error || "Failed to load rentals.");
      }
      setData({
        rentableCount: Number(next.rentableCount || 0),
        rentable: Array.isArray(next.rentable) ? next.rentable : [],
        activeRentals: Array.isArray(next.activeRentals)
          ? next.activeRentals
          : [],
        slotSummary: Array.isArray(next.slotSummary) ? next.slotSummary : [],
        poolByCollection: Array.isArray(next.poolByCollection)
          ? next.poolByCollection
          : [],
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

  return (
    <section className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-4 border border-white/10 bg-black/30 relative">
          <button
            type="button"
            className="btn btn-xs btn-outline z-10 !w-fit min-h-0 h-6 px-3 inline-flex ml-0 mr-0"
            style={{
              position: "absolute",
              top: "8px",
              right: "8px",
              left: "auto",
              width: "auto",
            }}
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          <div className="text-sm uppercase text-slate-300 pr-28">Rentable Pool</div>
          <div className="text-2xl font-semibold text-slate-100 mt-1">
            {Number(data.rentableCount || 0).toLocaleString()}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Pool size only (preview list hidden)
          </div>
        </div>
        <div className="card p-4 border border-white/10 bg-black/30">
          <div className="text-sm uppercase text-slate-300">
            Active Rental Missions
          </div>
          <div className="text-2xl font-semibold text-slate-100 mt-1">
            {data.activeRentals.length}
          </div>
          <div className="text-xs text-slate-400 mt-1">
            Based on missions with `nft_source = rental`
          </div>
        </div>
      </div>
      <div className="card p-3 border border-white/10 bg-black/30">
        <div className="text-xs uppercase text-slate-300">
          Mission Slot State
        </div>
        {data.slotSummary.length === 0 ? (
          <div className="text-xs text-slate-400 mt-1">No slot data yet.</div>
        ) : (
          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-1">
            {data.slotSummary.map((slot) => (
              <div
                key={slot.id}
                className="text-xs text-slate-300 flex items-center justify-between gap-2"
              >
                <span className="truncate">
                  S{slot.slot ?? "?"}: {slot.missionName || "Unknown"}
                </span>
                <span className="text-slate-400">
                  {slot.nftSource ? `${slot.nftSource}` : "unassigned"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {error ? (
        <div className="card p-4 border border-error/40 bg-error/10 text-error">
          {error}
        </div>
      ) : null}

      <div className="card p-4 border border-white/10 bg-black/30 space-y-3">
        <div className="text-sm font-semibold text-slate-200">
          Current Active Rental Missions
        </div>
        {data.activeRentals.length === 0 ? (
          <div className="text-sm text-slate-400">
            No active rental-backed missions detected.
          </div>
        ) : (
          <div className="space-y-2">
            {data.activeRentals.map((item) => (
              <div
                key={item.id}
                className="rounded-md border border-white/10 p-2 text-sm text-slate-200 flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {item.image ? (
                    <img
                      src={item.image}
                      alt={item.assignedNft || item.missionName || "Rental NFT"}
                      className="w-8 h-8 rounded object-cover border border-white/10 shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 rounded border border-white/10 bg-black/30 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="font-semibold">
                      Slot {item.slot ?? "?"}:{" "}
                      {item.missionName || "Unknown mission"}
                    </div>
                    <div className="text-xs text-slate-400 break-all leading-tight">
                      Lease: {item.rentalLeaseId || "n/a"}
                    </div>
                    <div className="text-xs text-slate-400 break-all leading-tight">
                      NFT: {item.assignedNft || "n/a"}
                    </div>
                  </div>
                </div>
                <div className="text-xs text-slate-300">
                  Lvl {item.currentLevel ?? "?"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
