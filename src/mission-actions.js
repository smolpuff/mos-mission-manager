"use strict";

const {
  toolCallSucceeded,
  extractToolFailureMessage,
} = require("./signer-prepare");

function createMissionActionExecutor(logger, mcp, signer) {
  const { logDebug } = logger;

  function summarizeToolResult(result) {
    const sc = result?.structuredContent || {};
    return {
      success: sc?.success ?? null,
      topLevelKeys: Object.keys(sc),
      walletId: sc?.walletId || null,
      assignedMissionId: sc?.assignedMissionId || null,
      nftId: sc?.nftId || null,
      cost:
        sc?.resetCost ??
        sc?.rerollCost ??
        sc?.swapCost ??
        sc?.unlockCost ??
        null,
      tokenFields: Object.keys(sc).filter((key) => /token$/i.test(key)),
      transactionLength:
        typeof sc?.transaction === "string" ? sc.transaction.length : null,
      note: sc?.note || null,
    };
  }

  async function executePreparedMissionAction({
    actionName,
    prepareResult,
    expected = {},
    debugScope = "action",
    submitDebugAction = "submit",
    debugMeta = {},
  }) {
    logDebug(debugScope, "prepare_result", {
      actionName,
      prepareSummary: summarizeToolResult(prepareResult),
      ...debugMeta,
    });
    logger.logWithTimestamp(
      `[SIGNER] ✍️ Signing prepared action=${actionName}...`,
    );
    const signed = await signer.signPreparedMissionActionPayload(
      actionName,
      prepareResult,
      expected,
    );
    if (!signed.submitTool) {
      logger.logWithTimestamp(
        `[DAPP] ✅ Opened signing page for action=${actionName}. Complete signing in the browser.`,
      );
      logDebug(debugScope, "dapp_signing_opened", {
        actionName,
        tokenPreview: signed.tokenPreview,
        cost: signed.cost,
        signingUrl: signed.signingUrl || null,
        ...debugMeta,
      });
      return {
        ok: true,
        signed,
        submitted: null,
      };
    }
    logger.logWithTimestamp(
      `[SIGNER] 📤 Submitting signed action=${actionName} via ${signed.submitTool}...`,
    );
    logDebug(debugScope, `${submitDebugAction}_start`, {
      actionName,
      submitTool: signed.submitTool,
      tokenPreview: signed.tokenPreview,
      cost: signed.cost,
      ...debugMeta,
    });
    const submitted = await mcp.mcpToolCall(signed.submitTool, signed.submitArgs);
    logDebug(debugScope, `${submitDebugAction}_result`, {
      actionName,
      submitTool: signed.submitTool,
      submitSummary: summarizeToolResult(submitted),
      ...debugMeta,
    });
    if (!toolCallSucceeded(submitted)) {
      throw new Error(
        extractToolFailureMessage(submitted, `${signed.submitTool} failed`),
      );
    }
    logger.logWithTimestamp(
      `[SIGNER] ✅ Submitted action=${actionName} via ${signed.submitTool}.`,
    );
    logDebug(debugScope, `${submitDebugAction}_ok`, {
      actionName,
      submitTool: signed.submitTool,
      tokenPreview: signed.tokenPreview,
      cost: signed.cost,
      ...debugMeta,
    });
    return {
      ok: true,
      signed,
      submitted,
    };
  }

  return {
    executePreparedMissionAction,
  };
}

module.exports = {
  createMissionActionExecutor,
};
