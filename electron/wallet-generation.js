"use strict";

const WALLET_GENERATION_SLOW_MS = 30_000;
const WALLET_GENERATION_TIMEOUT_MS = 60_000;

// A response deadline cannot cancel a wallet write. Keep the original operation
// alive until it succeeds, fails, or its backend exits; retries must join it.
function createWalletGenerationRequest(generate, {
  timeoutMs = WALLET_GENERATION_TIMEOUT_MS,
  slowMs = WALLET_GENERATION_SLOW_MS,
  onSlow = () => {},
} = {}) {
  let pending = null;
  return function requestWalletGeneration() {
    if (pending?.finished) {
      const result = pending.result;
      pending = null;
      return Promise.resolve(result);
    }
    if (pending) return pending.promise;
    const operation = { promise: null, finished: false, result: null, timedOut: false };
    pending = operation;
    operation.promise = new Promise((resolve, reject) => {
      const slowTimer = setTimeout(onSlow, slowMs);
      const deadlineTimer = setTimeout(() => {
        operation.timedOut = true;
        reject(new Error("Wallet creation did not finish within 60 seconds. Retry will check the original operation before creating another wallet."));
      }, timeoutMs);
      const clearTimers = () => {
        clearTimeout(slowTimer);
        clearTimeout(deadlineTimer);
      };
      Promise.resolve().then(generate).then(result => {
        clearTimers();
        if (operation.timedOut) {
          // A late success must be returned by Retry instead of replacing it.
          operation.finished = true;
          operation.result = result;
        } else {
          pending = null;
          resolve(result);
        }
      }, error => {
        clearTimers();
        pending = null;
        reject(error);
      });
    });
    return operation.promise;
  };
}

module.exports = { createWalletGenerationRequest, WALLET_GENERATION_TIMEOUT_MS, WALLET_GENERATION_SLOW_MS };
