"use strict";

function runnerLabel(status = {}) {
  if (!status.running) return "Stopped";
  if (status.watchLoopEnabled === false) return "Paused";
  return status.watcherRunning === true ? "Watching missions…" : "Starting…";
}

function missionRows(status = {}) {
  const missions = Array.isArray(status.guiMissionSlots) ? status.guiMissionSlots : [];
  return [1, 2, 3, 4].map((slot) => {
    const mission = missions.find((item) => Number(item.slot) === slot);
    const nextUnlock = Number(status.slotUnlockSummary?.nextUnlockSlot);
    if (slot === 4 && status.slotUnlockSummary?.canUnlockMore === true &&
        Number.isFinite(nextUnlock) && nextUnlock <= slot) {
      return `${slot}. Locked`;
    }
    if (!mission?.missionName) return `${slot}. ${status.startupMissionSlotsLoading ? "Loading…" : "No mission"}`;
    const level = mission.missionLevel == null ? "—" : mission.missionLevel;
    const progress = Number(mission.progress);
    const goal = Number(mission.goal);
    const hasProgress = mission.progress != null && mission.goal != null &&
      Number.isFinite(progress) && Number.isFinite(goal) && goal > 0;
    const assigned = Boolean(mission.assignedNft || mission.assignedNftAccount);
    const state = !assigned ? "No NFT assigned" : !mission.missionActive ? "Inactive" :
      hasProgress && progress >= goal ? "Claimable" : "Active";
    const detail = hasProgress
      ? `${progress.toLocaleString()} / ${goal.toLocaleString()} (${Math.round(Math.max(0, Math.min(100, progress / goal * 100)))}%)`
      : "—";
    return `${slot}. ${mission.missionName} · Level ${level} · ${state} · ${detail}`;
  });
}

async function startFromWindowsTray(bridge, status) {
  const { config = {} } = await bridge.getConfig();
  if (!status.running) {
    const result = await bridge.startBackend();
    if (result?.startCancelled === true) return;
  }
  if (config.autoModeEnabled === true) {
    await bridge.sendCommand("am on");
  } else if (config.missionModeEnabled === true) {
    const level = Number(config.missionModeResetLevel || status.defaultMissionResetLevel || "10");
    await bridge.sendCommand(`mm ${Number.isFinite(level) && level > 0 ? Math.floor(level) : 10}`);
  } else {
    await bridge.sendCommand("mm off");
    await bridge.sendCommand(config.level20ResetEnabled === true ? "20r on" : "20r off");
  }
  await bridge.sendCommand("resume");
}

module.exports = { runnerLabel, missionRows, startFromWindowsTray };
