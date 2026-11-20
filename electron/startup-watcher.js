"use strict";

function scheduleStartupWatching({ getConfig, getStatus, isQuitting, startWatching, onError }) {
  if (getConfig().autoStartWatchingEnabled !== true) return () => {};
  const timer = setTimeout(async () => {
    try {
      if (isQuitting() || getConfig().autoStartWatchingEnabled !== true || getStatus().running) return;
      await startWatching();
    } catch (error) {
      onError(error);
    }
  }, 750);
  return () => clearTimeout(timer);
}

module.exports = { scheduleStartupWatching };
