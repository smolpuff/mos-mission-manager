#!/usr/bin/env node
"use strict";

const { callTool, login } = require("../lib/mcp");

(async () => {
  try {
    await callTool("who_am_i", {});
    console.log("pbp-mcp is already authenticated.");
  } catch {
    const result = await login({});
    console.log(`Saved token to ${result.tokenFile}`);
  }
})();
