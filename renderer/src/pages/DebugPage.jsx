import ToggleSwitch from "../components/ToggleSwitch/app";
import pbpIcon from "../img/icon_pbp.webp";

const SLOT_IDS = [1, 2, 3, 4];

export default function DebugPage({
  desktopDevMode,
  debugEnabled,
  setDebugMode,
  reducedMotionEnabled,
  setReducedMotionEnabled,
  isMissionMode,
  competitionRangeLockEnabled,
  competitionRangeLockMinRank,
  competitionRangeLockMaxRank,
  competitionRangeLockPollSeconds,
  setCompetitionRangeLock,
  setCompetitionRangeLockMin,
  setCompetitionRangeLockMax,
  setCompetitionRangeLockPoll,
  nftResetEnabled,
  nftResetMaxPbp,
  setAutoNftResetEnabled,
  setAutoNftResetMaxPbp,
  missionActionEnabledBySlot,
  setMissionActionEnabled,
  missionResetPerSlotModeEnabled,
  setMissionResetPerSlotModeEnabled,
  missionResetPerSlotEnabledBySlot,
  setPerSlotMissionResetEnabled,
  missionResetPerSlotLevelBySlot,
  setPerSlotMissionResetLevel,
}) {
  const competitionRangeLockDisabled =
    debugEnabled !== true || isMissionMode !== true;
  const competitionRangeLockInputsDisabled =
    competitionRangeLockDisabled || competitionRangeLockEnabled !== true;
  const nftResetInputsDisabled =
    isMissionMode !== true || nftResetEnabled !== true;
  const perSlotResetModeDisabled = debugEnabled !== true;

  return (
    <section className="space-y-4">
      <div className="card gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-normal">Debug</h1>
            <div className="text-sm text-slate-300">
              Runtime switches for dev-only behavior and renderer performance.
            </div>
          </div>
          <div className="text-right text-xs uppercase text-slate-400">
            <div>{desktopDevMode ? ":dev active" : ":dev off"}</div>
            <div>{debugEnabled ? "debug on" : "debug off"}</div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <ToggleSwitch
              switchID="debugModeEnabled"
              checked={debugEnabled === true}
              title="Debug mode"
              helperText="Enables debug-only runtime controls and verbose behavior."
              onChange={(event) => void setDebugMode(event.target.checked)}
            />
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <ToggleSwitch
              switchID="reducedMotionEnabled"
              checked={reducedMotionEnabled === true}
              title="Reduced motion"
              helperText="Stops UI animations and transitions to reduce motion and CPU usage."
              onChange={(event) =>
                void setReducedMotionEnabled(event.target.checked)
              }
            />
          </div>
        </div>
      </div>
    </section>
  );
}
