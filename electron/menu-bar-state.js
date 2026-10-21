// Mac menu bar temporarily disabled; retained for later work.
// "use strict";
//
// function runnerLabel(status = {}) {
//   if (!status.running) return "Stopped";
//   if (status.watchLoopEnabled === false) return "Paused";
//   return status.watcherRunning === true ? "Watching missions..." : "Starting…";
// }
//
// function missionCards(status = {}) {
//   const slots = Array.isArray(status.guiMissionSlots) ? status.guiMissionSlots : [];
//   return [1, 2, 3, 4].map((slot) => {
//     const mission = slots.find((entry) => Number(entry.slot) === slot);
//     const nextUnlockSlot = Number(status.slotUnlockSummary?.nextUnlockSlot);
//     const locked = slot === 4 && status.slotUnlockSummary?.canUnlockMore === true &&
//       Number.isFinite(nextUnlockSlot) && slot >= nextUnlockSlot;
//     const progress = Number(mission?.progress);
//     const goal = Number(mission?.goal);
//     const hasProgress = mission?.progress != null && mission?.goal != null &&
//       Number.isFinite(progress) && Number.isFinite(goal) && goal > 0;
//     const assigned = Boolean(mission?.assignedNft || mission?.assignedNftAccount);
//     return {
//       ...mission,
//       slot,
//       locked,
//       imageSrc: locked ? null : missionImage(mission),
//       hasAssignedNft: assigned,
//       name: locked ? "Locked" : mission?.missionName || (status.startupMissionSlotsLoading ? "Loading…" : "No mission"),
//       state: locked ? "Locked" : !mission?.missionName ? "Empty" : !assigned ? "No NFT assigned" :
//         !mission.missionActive ? "Inactive" : hasProgress && progress >= goal ? "Claimable" : "Active",
//       progressText: hasProgress ? `${progress.toLocaleString()} / ${goal.toLocaleString()}` : "—",
//       percent: hasProgress ? Math.max(0, Math.min(100, progress / goal * 100)) : 0,
//     };
//   });
// }
//
// function missionImage(mission) {
//   const candidates = [
//     mission?.nftImage, mission?.assignedNftImage,
//     mission?.image, mission?.imageUrl, mission?.image_url,
//     mission?.thumbnail, mission?.thumbnailUrl, mission?.thumbnail_url,
//     ...[mission?.assignedNft, mission?.currentAssignedNFT, mission?.currentAssignedNft]
//       .flatMap((nft) => [nft?.image, nft?.imageUrl, nft?.image_url, nft?.thumbnail, nft?.thumbnailUrl, nft?.thumbnail_url]),
//   ];
//   for (const raw of candidates) {
//     const value = String(raw || "").trim();
//     if (/^https?:\/\//i.test(value)) return value;
//     if (/^\/\//.test(value)) return `https:${value}`;
//     if (/^gateway\.irys\.xyz\//i.test(value)) return `https://${value}`;
//     if (/^ipfs:\/\//i.test(value)) {
//       const cid = value.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
//       if (cid) return `https://ipfs.io/ipfs/${cid}`;
//     }
//     if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[0-9a-z]{20,})$/i.test(value)) {
//       return `https://ipfs.io/ipfs/${value}`;
//     }
//   }
//   return null;
// }
//
// // Use the same persisted mode commands and resume action as the main Start button.
// async function startFromMenuBar(bridge, status) {
//   const { config = {} } = await bridge.getConfig();
//   if (!status.running) {
//     const started = await bridge.startBackend();
//     if (started?.startCancelled === true) return;
//   }
//   if (config.autoModeEnabled === true) {
//     await bridge.sendCommand("am on");
//   } else if (config.missionModeEnabled === true) {
//     const level = Number(config.missionModeResetLevel || status.defaultMissionResetLevel || "10");
//     await bridge.sendCommand(`mm ${Number.isFinite(level) && level > 0 ? Math.floor(level) : 10}`);
//   } else {
//     await bridge.sendCommand("mm off");
//     await bridge.sendCommand(config.level20ResetEnabled === true ? "20r on" : "20r off");
//   }
//   await bridge.sendCommand("resume");
// }
//
// module.exports = { runnerLabel, missionCards, missionImage, startFromMenuBar };
