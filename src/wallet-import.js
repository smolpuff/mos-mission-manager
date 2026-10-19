"use strict";

async function importWalletAndVerify({ signer, ctx, key, save }) {
  if (typeof key !== "string" || !key.trim() || key.length > 32768) {
    throw new Error("Enter a private key, recovery phrase, or keypair JSON.");
  }
  const previousMode = ctx.signerMode;
  let imported = false;
  try {
    signer.setSignerMode("app_wallet", "ui_import");
    await signer.importFromText(key);
    imported = true;
    await save();
    await signer.unlock();
    if (ctx.signerLocked !== false || ctx.signerReady !== true) {
      throw new Error("Unlock verification failed.");
    }
  } catch {
    if (!imported) signer.setSignerMode(previousMode, "ui_import_failed");
    throw new Error(imported
      ? "Wallet imported, but verification failed. Check wallet storage before using it."
      : "Import failed. Check the key or recovery phrase and try again.");
  } finally {
    key = "";
    signer.lock("ui_import_verification");
  }
  if (ctx.signerLocked !== true || ctx.signerReady === true) {
    throw new Error("Wallet imported, but lock verification failed.");
  }
  return { ok: true, walletAddress: ctx.signerConfig.walletAddress, locked: true };
}

module.exports = { importWalletAndVerify };
