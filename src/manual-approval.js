"use strict";

const readline = require("readline");

function createManualApprovalService(logger, opts = {}) {
  const { logWithTimestamp } = logger;
  const promptSuffix =
    typeof opts.promptSuffix === "string" ? opts.promptSuffix : " ";

  function askQuestion(rl, prompt) {
    return new Promise((resolve) => {
      rl.question(prompt, (answer) => resolve(String(answer || "").trim()));
    });
  }

  async function confirmYes(rl, prompt) {
    const answer = (await askQuestion(rl, `${prompt}${promptSuffix}`)).toLowerCase();
    return answer === "yes" || answer === "y";
  }

  async function confirmSignerApproval(rl, payload = {}) {
    const { actionName, prompt, summary } = payload;
    logWithTimestamp(
      `[SIGNER] approval requested action=${actionName} cost=${summary?.cost ?? "unknown"} submit=${summary?.submitTool || "unknown"}`,
    );
    return confirmYes(rl, prompt || "Are you sure you want to approve this tx? yes/no");
  }

  return {
    askQuestion,
    confirmYes,
    confirmSignerApproval,
  };
}

module.exports = {
  createManualApprovalService,
};
