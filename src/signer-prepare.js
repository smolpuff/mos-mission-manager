"use strict";

const {
  getBase58Encoder,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} = require("@solana/kit");

const PREPARED_MISSION_ACTION_SPECS = {
  nft_cooldown_reset: {
    prepareTool: "prepare_nft_cooldown_reset",
    submitTool: "submit_signed_nft_cooldown_reset",
    tokenField: "resetToken",
    requiredFields: ["nftId", "resetCost", "transaction"],
    costField: "resetCost",
    identifierFields: ["nftId"],
  },
  mission_reroll: {
    prepareTool: "prepare_mission_reroll",
    submitTool: "submit_signed_mission_reroll",
    tokenField: "rerollToken",
    requiredFields: ["assignedMissionId", "rerollCost", "transaction"],
    costField: "rerollCost",
    identifierFields: ["assignedMissionId"],
  },
  mission_swap: {
    prepareTool: "prepare_mission_swap",
    submitTool: "submit_signed_mission_swap",
    tokenField: "swapToken",
    requiredFields: [
      "assignedMissionId",
      "chosenMissionId",
      "swapCost",
      "transaction",
    ],
    costField: "swapCost",
    identifierFields: ["assignedMissionId", "chosenMissionId"],
  },
  mission_slot_unlock: {
    prepareTool: "unlock_mission_slot",
    submitTool: "submit_signed_mission_slot_unlock",
    tokenField: "unlockToken",
    requiredFields: ["slotNumber", "transaction"],
    costField: "unlockCost",
    identifierFields: ["slotNumber"],
  },
};

// Had the wrong name before so linked it instead
const PREPARED_MISSION_ACTION_ALIASES = {
  mission_cooldown_reset: "nft_cooldown_reset",
};

function getPreparedMissionActionSpec(actionName) {
  const normalized = String(actionName || "").trim();
  const canonical = PREPARED_MISSION_ACTION_ALIASES[normalized] || normalized;
  return PREPARED_MISSION_ACTION_SPECS[canonical] || null;
}

function toolCallSucceeded(result) {
  if (!result || typeof result !== "object") return true;
  if (result.isError === true) return false;
  const sc = result.structuredContent || {};
  if (sc.success === false) return false;
  return true;
}

function extractToolFailureMessage(result, fallback = "tool call failed") {
  return (
    result?.structuredContent?.details?.message ||
    result?.content?.[0]?.text ||
    fallback
  );
}

function truncateSensitive(value, keep = 8) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= keep * 2) return text;
  return `${text.slice(0, keep)}...${text.slice(-keep)}`;
}

function decodePreparedTransaction(transactionString) {
  const transaction = String(transactionString || "").trim();
  if (!transaction) {
    throw new Error("Prepared transaction string is missing.");
  }
  const transactionBytes = getBase58Encoder().encode(transaction);
  const decodedTransaction = getTransactionDecoder().decode(transactionBytes);
  const compiledMessage = getCompiledTransactionMessageDecoder().decode(
    decodedTransaction.messageBytes,
  );
  return {
    transactionBytes,
    decodedTransaction,
    compiledMessage,
    signerAddresses: Object.keys(decodedTransaction.signatures || {}),
  };
}

function collectMissingFields(sc, fields = []) {
  return fields.filter((field) => {
    const value = sc?.[field];
    if (value === null || value === undefined) return true;
    if (typeof value === "string") return value.trim().length === 0;
    return false;
  });
}

function validatePreparedMissionAction({
  actionName,
  result,
  expected = {},
  currentWalletId = null,
  expectedSignerAddress = null,
}) {
  const spec = getPreparedMissionActionSpec(actionName);
  if (!spec)
    throw new Error(`Unsupported prepared mission action: ${actionName}`);
  if (!toolCallSucceeded(result)) {
    throw new Error(`${spec.prepareTool} returned an error result.`);
  }

  const sc = result?.structuredContent || {};
  const missingFields = collectMissingFields(sc, [
    ...spec.requiredFields,
    spec.tokenField,
  ]);
  if (missingFields.length > 0) {
    throw new Error(
      `${spec.prepareTool} payload missing fields: ${missingFields.join(", ")}`,
    );
  }

  for (const field of spec.identifierFields) {
    if (
      expected[field] !== undefined &&
      String(expected[field]) !== String(sc[field])
    ) {
      throw new Error(
        `${spec.prepareTool} payload mismatch for ${field}: expected ${expected[field]} got ${sc[field]}`,
      );
    }
  }

  const decoded = decodePreparedTransaction(sc.transaction);
  if (!decoded.transactionBytes?.length) {
    throw new Error(`${spec.prepareTool} transaction bytes failed to decode.`);
  }
  if (!decoded.compiledMessage?.instructions?.length) {
    throw new Error(
      `${spec.prepareTool} decoded transaction has no instructions.`,
    );
  }
  if (!decoded.signerAddresses.length) {
    throw new Error(
      `${spec.prepareTool} decoded transaction has no signer slots.`,
    );
  }
  const expectedSigner =
    String(expectedSignerAddress || currentWalletId || "").trim() || null;
  const signerMatchesExpectation = expectedSigner
    ? decoded.signerAddresses.includes(expectedSigner)
    : null;

  return {
    ok: true,
    actionName,
    prepareTool: spec.prepareTool,
    submitTool: spec.submitTool,
    tokenField: spec.tokenField,
    tokenPreview: truncateSensitive(sc[spec.tokenField]),
    costField: spec.costField,
    cost: sc[spec.costField] ?? null,
    identifiers: spec.identifierFields.reduce((acc, field) => {
      acc[field] = sc[field] ?? null;
      return acc;
    }, {}),
    decode: {
      transactionEncoding: "base58_wire_transaction",
      transactionBytesLength: decoded.transactionBytes.length,
      messageBytesLength: decoded.decodedTransaction.messageBytes.length,
      signerAddresses: decoded.signerAddresses,
      expectedSignerAddress: expectedSigner,
      signerMatchesExpectation,
      version: decoded.compiledMessage.version ?? null,
      instructionCount: decoded.compiledMessage.instructions.length,
      staticAccountCount: decoded.compiledMessage.staticAccounts.length,
      hasLifetimeToken: Boolean(decoded.compiledMessage.lifetimeToken),
      lifetimeTokenLength:
        decoded.compiledMessage.lifetimeToken &&
        typeof decoded.compiledMessage.lifetimeToken.length === "number"
          ? decoded.compiledMessage.lifetimeToken.length
          : null,
    },
    structuredContent: sc,
  };
}

module.exports = {
  PREPARED_MISSION_ACTION_SPECS,
  getPreparedMissionActionSpec,
  toolCallSucceeded,
  extractToolFailureMessage,
  decodePreparedTransaction,
  validatePreparedMissionAction,
};
