import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Tune this value to change how often the PBP timer API is refreshed.
export const PBP_TIMER_REFRESH_INTERVAL_MS = 30_000;

function timerEndMs(record, timespanSeconds) {
  const updatedAt = Date.parse(String(record?.updatedAt || ""));
  const timespan = Number(timespanSeconds);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(timespan)) return null;
  return updatedAt + timespan * 1000;
}

function formatCountdown(endMs, nowMs) {
  if (!Number.isFinite(endMs)) return "Unknown";
  const totalSeconds = Math.max(0, Math.ceil((endMs - nowMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function profileForHost(profiles, host) {
  if (!Array.isArray(profiles)) return null;
  const hostKey = String(host || "")
    .trim()
    .toLowerCase();
  return (
    profiles.find((profile) =>
      [profile?.login, profile?.display_name, profile?.displayName].some(
        (value) =>
          String(value || "")
            .trim()
            .toLowerCase() === hostKey,
      ),
    ) || null
  );
}

function HostProfileImage({ host, src }) {
  const [failed, setFailed] = useState(false);
  const initial =
    String(host || "?")
      .trim()
      .slice(0, 1)
      .toUpperCase() || "?";
  if (!src || failed) {
    return (
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/10 text-xs text-slate-300">
        {initial}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={`${host} profile`}
      className="size-7 shrink-0 rounded-full border border-white/20 object-cover"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

export default function PbpTimersPage({ bridge }) {
  const [session, setSession] = useState({
    loading: true,
    authenticated: false,
  });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nowMs, setNowMs] = useState(Date.now());
  const refreshBusyRef = useRef(false);

  const checkSession = useCallback(async () => {
    if (!bridge?.getPbpTimerSessionStatus) {
      setSession({ loading: false, authenticated: false });
      setError("This sample is available in the desktop app.");
      return null;
    }
    const next = await bridge.getPbpTimerSessionStatus();
    setSession({ ...next, loading: false });
    return next;
  }, [bridge]);

  const refreshTimers = useCallback(async () => {
    if (!bridge?.getPbpTimers || refreshBusyRef.current) return;
    refreshBusyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await bridge.getPbpTimers();
      if (!next?.ok) {
        setSession((current) => ({
          ...current,
          loading: false,
          authenticated: next?.authenticated === true,
          user: next?.user || current.user,
        }));
        setError(next?.error || "Could not load PBP timers.");
        return;
      }
      setResult(next);
      setSession({
        loading: false,
        authenticated: true,
        user: next.user,
      });
    } catch (fetchError) {
      setError(String(fetchError?.message || fetchError));
    } finally {
      refreshBusyRef.current = false;
      setBusy(false);
    }
  }, [bridge]);

  useEffect(() => {
    void checkSession().then((status) => {
      if (status?.authenticated) void refreshTimers();
    });
  }, [checkSession, refreshTimers]);

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!session.authenticated) return undefined;
    const interval = window.setInterval(() => {
      void refreshTimers();
    }, PBP_TIMER_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [session.authenticated, refreshTimers]);

  const playHistory = result?.timers?.data?.playHistory;
  const records = Array.isArray(playHistory?.records)
    ? [...playHistory.records].sort(
        (left, right) =>
          Date.parse(String(right?.updatedAt || "")) -
          Date.parse(String(left?.updatedAt || "")),
      )
    : [];
  const maxStreams = Number(playHistory?.maxStreams) || 3;
  const twitchProfiles = Array.isArray(result?.timers?.twitchProfiles)
    ? result.timers.twitchProfiles
    : [];
  const timeoutEndMs = useMemo(() => {
    const remainingSeconds = Number(playHistory?.timeRemaining);
    return Number.isFinite(remainingSeconds)
      ? (result ? Date.parse(result.fetchedAt) : Date.now()) +
          remainingSeconds * 1000
      : null;
  }, [playHistory?.timeRemaining, result]);

  const login = async () => {
    if (!bridge?.openPbpTimerLogin) return;
    setBusy(true);
    setError("");
    try {
      const loginResult = await bridge.openPbpTimerLogin();
      if (loginResult?.authenticated) {
        await refreshTimers();
      } else if (!loginResult?.alreadyOpen) {
        setError(
          loginResult?.error || "PBP login was closed before it completed.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="h-full min-h-0 flex flex-col gap-4 overflow-y-auto pb-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-normal leading-tight">
            PBP Timers Sample
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Signs in to the PBP website in a separate saved browser session,
            then reads the same recent-host timer API used by the PBP missions
            page.
          </p>
        </div>
        <span
          className={`badge badge-sm ${session.authenticated ? "badge-success" : "badge-ghost"}`}
        >
          {session.loading
            ? "Checking..."
            : session.authenticated
              ? `Signed in${session.user?.name ? ` as ${session.user.name}` : ""}`
              : "Not signed in"}
        </span>
      </div>

      <div className="card flex-row items-center gap-3">
        <button
          type="button"
          className="btn btn-gradient btn-sm"
          onClick={() => void login()}
          disabled={busy || session.authenticated}
        >
          {session.authenticated ? "PBP connected" : "Log in to PBP"}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-black"
          onClick={() => void refreshTimers()}
          disabled={busy || !session.authenticated}
        >
          {busy ? "Loading..." : "Refresh timers"}
        </button>
        <code className="ml-auto text-xs text-slate-500">
          GET /api/user/streams/twitch · auto 30s
        </code>
      </div>

      {error ? (
        <div className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="card col-span-full">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg">Recent hosts</h2>
            <span className="text-sm text-slate-400">
              {records.length} / {maxStreams}
            </span>
          </div>
          {!result ? (
            <div className="text-sm text-slate-400">
              Log in and refresh to load timers.
            </div>
          ) : records.length === 0 ? (
            <div className="text-sm text-slate-400">No active host timers.</div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {records.map((record, index) => {
                const host = String(record?.hostDisplayName || "Unknown host");
                const profile = profileForHost(twitchProfiles, host);
                const image =
                  profile?.profile_image_url ||
                  profile?.profileImageUrl ||
                  null;
                const twitchLogin = String(profile?.login || host).trim();
                const endMs = timerEndMs(record, playHistory?.timespan);
                return (
                  <button
                    type="button"
                    key={`${host}_${record?.updatedAt || index}`}
                    className="group flex w-full min-w-0 items-center gap-2 text-left "
                    title={`Open ${host} on Twitch`}
                    aria-label={`Open ${host} on Twitch in your browser`}
                    onClick={() =>
                      void bridge?.openExternal?.(
                        `https://twitch.tv/${encodeURIComponent(twitchLogin)}`,
                      )
                    }
                  >
                    <HostProfileImage host={host} src={image} />
                    <div className="min-w-0 leading-tight text-xs">
                      <div className="flex items-center gap-1 truncate  text-slate-100">
                        {host}
                        <span className="text-xs text-slate-500 transition-colors group-hover:text-[#bf94ff]">
                          ↗
                        </span>
                      </div>
                      <div className=" text-[11px]  text-info ">
                        {formatCountdown(endMs, nowMs)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {result?.timers ? (
        <details className="card">
          <summary className="cursor-default text-sm text-slate-300">
            Raw API response
          </summary>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-black/30 p-3 text-xs text-slate-400 select-text">
            {JSON.stringify(result.timers, null, 2)}
          </pre>
        </details>
      ) : null}
    </section>
  );
}
