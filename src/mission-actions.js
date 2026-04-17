"use strict";

const {
  toolCallSucceeded,
  extractToolFailureMessage,
} = require("./signer-prepare");

function createMissionActionExecutor(logger, mcp, signer) {
  const { logDebug } = logger;
  const SUBMIT_SIGNED_TIMEOUT_MS = 120000;

  function formatTokenAmount(value, token = "PBP") {
    const n = Number(value);
    if (!Number.isFinite(n)) return "n/a";
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${token}`;
  }

  function extractToolMessages(result) {
    const contentMessages = Array.isArray(result?.content)
      ? result.content
          .map((entry) =>
            entry && typeof entry === "object" ? String(entry.text || "").trim() : "",
          )
          .filter(Boolean)
      : [];
    const detailsMessage = String(
      result?.structuredContent?.details?.message || "",
    ).trim();
    const noteMessage = String(result?.structuredContent?.note || "").trim();
    const allMessages = [
      ...contentMessages,
      ...(detailsMessage ? [detailsMessage] : []),
      ...(noteMessage ? [noteMessage] : []),
    ];
    return {
      contentMessages,
      detailsMessage: detailsMessage || null,
      noteMessage: noteMessage || null,
      allMessages,
      joined: allMessages.join(" | "),
    };
  }

  function classifySubmitError(message) {
    const text = String(message || "");
    if (
      /fetch failed|ENOTFOUND|ECONN|EAI_AGAIN|network|socket|request timeout|timed out/i.test(
        text,
      )
    ) {
      return "transport";
    }
    return "server_response";
  }

  function summarizeToolResult(result) {
    const sc = result?.structuredContent || {};
    const messages = extractToolMessages(result);
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
      errorId: sc?.errorId || null,
      responseMessage: messages.joined || null,
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
    let submitted = null;
    const submitTimeoutMs =
      String(signed.submitTool || "").startsWith("submit_signed_")
        ? SUBMIT_SIGNED_TIMEOUT_MS
        : undefined;
    try {
      submitted = await mcp.mcpToolCall(
        signed.submitTool,
        signed.submitArgs,
        submitTimeoutMs ? { timeoutMs: submitTimeoutMs } : {},
      );
    } catch (error) {
      const errorMessage = String(error?.message || error || "unknown submit error");
      const category = classifySubmitError(errorMessage);
      logger.logWithTimestamp(
        `[SIGNER] Submit failed (${category}) action=${actionName} tool=${signed.submitTool} cost=${formatTokenAmount(signed.cost)}: ${errorMessage}`,
      );
      logDebug(debugScope, `${submitDebugAction}_transport_error`, {
        actionName,
        submitTool: signed.submitTool,
        submitTimeoutMs: submitTimeoutMs || null,
        category,
        error: errorMessage,
        submitArgsKeys:
          signed.submitArgs && typeof signed.submitArgs === "object"
            ? Object.keys(signed.submitArgs)
            : [],
        encodedSignedTransactionLength:
          typeof signed.submitArgs?.encodedSignedTransaction === "string"
            ? signed.submitArgs.encodedSignedTransaction.length
            : null,
        ...debugMeta,
      });
      throw error;
    }
    logDebug(debugScope, `${submitDebugAction}_result`, {
      actionName,
      submitTool: signed.submitTool,
      submitSummary: summarizeToolResult(submitted),
      ...debugMeta,
    });
    if (!toolCallSucceeded(submitted)) {
      const failureMessage = extractToolFailureMessage(
        submitted,
        `${signed.submitTool} failed`,
      );
      const submitMessages = extractToolMessages(submitted);
      logger.logWithTimestamp(
        `[SIGNER] Submit failed (server_response) action=${actionName} tool=${signed.submitTool} cost=${formatTokenAmount(signed.cost)}: ${failureMessage}`,
      );
      logDebug(debugScope, `${submitDebugAction}_response_error`, {
        actionName,
        submitTool: signed.submitTool,
        error: failureMessage,
        responseMessages: submitMessages.allMessages,
        responseMessageJoined: submitMessages.joined || null,
        submitSummary: summarizeToolResult(submitted),
        ...debugMeta,
      });
      throw new Error(
        failureMessage,
      );
    }
    const submitMessages = extractToolMessages(submitted);
    logger.logWithTimestamp(
      `[SIGNER] ✅ Submitted action=${actionName} via ${signed.submitTool} cost=${formatTokenAmount(signed.cost)}.`,
    );
    logDebug(debugScope, `${submitDebugAction}_ok`, {
      actionName,
      submitTool: signed.submitTool,
      tokenPreview: signed.tokenPreview,
      cost: signed.cost,
      responseMessages: submitMessages.allMessages,
      responseMessageJoined: submitMessages.joined || null,
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
