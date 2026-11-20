"use strict";

const NORMAL_DELAY_MS = 30 * 60 * 1000;
const RETRY_DELAY_MS = 5 * 60 * 1000;

function createWalletRefreshScheduler({ refresh, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let retried = false;
  let retryPending = false;

  function stop() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    retryPending = false;
  }

  function schedule(failed = false) {
    if (failed && retryPending) return;
    stop();
    if (!failed) retried = false;
    const retry = failed && !retried;
    retryPending = retry;
    timer = setTimer(() => {
      timer = null;
      retryPending = false;
      if (retry) retried = true;
      return refresh(retry ? "retry_5m" : "periodic_30m");
    }, retry ? RETRY_DELAY_MS : NORMAL_DELAY_MS);
    timer.unref?.();
  }

  return { schedule, stop };
}

module.exports = { createWalletRefreshScheduler };
