// In-memory desktop bridge used ONLY by the onboarding demo entry point.
// This module has no IPC, filesystem, wallet, network, or process access.
export function createDemoBridge({ setup = false } = {}) {
  const listeners = { status: new Set(), command: new Set(), event: new Set() };
  const subscribe = type => callback => {
    listeners[type].add(callback);
    return () => listeners[type].delete(callback);
  };
  let config = {
    firstRunOnboardingCompleted: !setup,
    autoStartWatchingEnabled: false,
    autoUpdateCheckEnabled: false,
    missionCompetitionCheckEnabled: false,
    autoModeEnabled: true,
    missionModeEnabled: false,
    enableRentals: true,
    level20ResetEnabled: false,
    missionResetLevel: '20',
    missionModeResetLevel: '10',
    nftCooldownResetEnabled: false,
    nftCooldownResetMaxPbp: 10,
    nftAssignmentOrder: 'rotate_least_used',
    signerMode: 'app_wallet',
    missionActionEnabledBySlot: { 1: true, 2: true, 3: true, 4: true },
  };
  const missions = ['Race!', 'Fight!', 'Give da hurt!', 'Get Tilted for Points!'];
  const collections = ['100K', '500K', 'Great Goats', 'Drippies'];
  const art = ['100k', '500k', 'goats', 'drip'];
  let status = {
    running: !setup,
    watcherRunning: !setup,
    watchLoopEnabled: !setup,
    isAuthenticated: true,
    signerReady: !setup,
    signerLocked: false,
    signerStatus: setup ? 'not_configured' : 'app_wallet_unlocked',
    signerMode: 'app_wallet',
    currentUserDisplayName: 'Onboarding demo',
    currentUserWalletId: 'demo-wallet',
    currentUserWalletSummary: { displayName: 'Onboarding demo', balances: [{ key: 'sol', balance: 0.42 }, { key: 'pbp', balance: 2480 }] },
    fundingWalletSummary: setup ? null : { status: 'ok', sol: 0.42, pbp: 2480 },
    currentMissionStats: { active: 0, nftsAvailable: 12, claimable: 0, claimed: 0 },
    guiMissionSlots: missions.map((missionName, i) => ({
      slot: i + 1, missionName, missionLevel: i + 3, progress: i + 2, goal: 20,
      nftImage: new URL(`/renderer/src/img/nft/${art[i]}.webp`, location.origin).href,
      assignedNftAccount: `demo-nft-${i}`, missionActive: false,
    })),
    slotUnlockSummary: { canUnlockMore: false },
    nftUsageStats: [],
    missionDataLoading: false,
    defaultMissionResetLevel: 10,
    currentMissionResetLevel: 20,
    sessionRewardTotals: { pbp: 0, tc: 0, cc: 0 },
    sessionSpendTotals: { pbp: 0, tc: 0, cc: 0 },
    ...config,
  };
  const emit = () => {
    status = { ...status, ...config };
    for (const callback of listeners.status) callback(structuredClone(status));
  };
  const blocked = async () => ({ ok: false, error: 'This action is outside the onboarding demo.' });
  const bridge = {
    platform: 'darwin',
    desktopDevMode: false,
    getState: async () => ({ status: structuredClone(status), logs: [] }),
    getConfig: async () => ({ ok: true, config: structuredClone(config) }),
    updateConfig: async patch => {
      config = { ...config, ...patch };
      status.currentMissionResetLevel = config.autoModeEnabled ? 20 : Number(config.missionModeEnabled ? config.missionModeResetLevel : config.missionResetLevel);
      emit();
      return { ok: true, config: structuredClone(config) };
    },
    onBackendStatus: subscribe('status'),
    onBackendCommand: subscribe('command'),
    onBackendEvent: subscribe('event'),
    onBackendOutput: () => () => {},
    onUpdateStatus: () => () => {},
    reportUpdateUiReady: async () => ({ ok: true }),
    sendCommand: async command => {
      if (command === 'resume') { status.watchLoopEnabled = true; emit(); }
      for (const callback of listeners.command) callback({ command: `> ${command}` });
      return { ok: true };
    },
    startBackend: async () => {
      status.running = true;
      status.watcherRunning = true;
      status.watchLoopEnabled = true;
      status.currentMissionStats = { ...status.currentMissionStats, active: 4 };
      status.guiMissionSlots = status.guiMissionSlots.map(slot => ({ ...slot, missionActive: true }));
      emit();
      return { ok: true };
    },
    stopBackend: async () => {
      status.running = false;
      status.watcherRunning = false;
      status.watchLoopEnabled = false;
      status.currentMissionStats = { ...status.currentMissionStats, active: 0 };
      status.guiMissionSlots = status.guiMissionSlots.map(slot => ({ ...slot, missionActive: false }));
      emit();
      return { ok: true };
    },
    refreshWalletSummary: async () => ({ ok: true, fundingWalletSummary: structuredClone(status.fundingWalletSummary) }),
    getUserNfts: async () => ({ ok: true, total: 0, nfts: [] }),
    getRentalsPreview: async () => ({ ok: true, rentals: [] }),
    getCompetitionCount: async () => ({ ok: true, count: 0 }),
    getLatestCompetition: async () => ({ ok: true, competitions: [] }),
    checkForUpdates: async () => ({ ok: true, updateAvailable: false }),
    getWindowPosition: async () => [0, 0],
    setWindowPosition: async () => {},
    closeWindow: async () => {},
    minimizeWindow: async () => {},
    openCliWindow: async () => {},
    openExternal: blocked,
    copyToClipboard: async () => ({ ok: true }),
    createGeneratedWallet: async () => {
      // Deliberately not a valid deposit address. This is an isolated UI demo.
      const address = 'DEMO-ONLY-NOT-A-REAL-WALLET';
      status.signerWallet = address;
      status.signerStatus = 'app_wallet_unlocked';
      status.signerReady = true;
      status.fundingWalletSummary = { status: 'ok', address, sol: 0, pbp: 0 };
      emit();
      return { ok: true, created: { walletAddress: address } };
    },
    fetchOnboardingAccount: async () => ({
      ok: true,
      walletSummary: structuredClone(status.currentUserWalletSummary),
      missions: status.guiMissionSlots.map(slot => ({
        id: `demo-assigned-${slot.slot}`, name: slot.missionName,
        slot: slot.slot, currentLevel: slot.missionLevel,
        assignedNftAccount: slot.assignedNftAccount,
        assignedNftImage: slot.nftImage, image: slot.nftImage,
        hasAssignedNft: true, isActive: false,
      })),
      missionCatalog: status.guiMissionSlots.map(slot => ({
        id: `demo-mission-${slot.slot}`, name: slot.missionName,
        image: slot.nftImage, collections: [collections[slot.slot - 1]],
      })),
      ownedCollections: collections,
    }),
    applyOnboardingSelection: async patch => bridge.updateConfig(patch),
    importWallet: blocked,
    revealSignerBackup: blocked,
    installUpdate: blocked,
    prepareSlot4Unlock: blocked,
    fetchMissionPickerData: async () => ({
      ok: true,
      missionCatalog: status.guiMissionSlots.map(slot => ({
        id: `demo-mission-${slot.slot}`, name: slot.missionName,
        collections: [collections[slot.slot - 1]],
      })),
      ownedCollections: collections,
    }),
    prepareNftCooldownReset: blocked,
    resetNftCooldown: blocked,
  };
  return bridge;
}
