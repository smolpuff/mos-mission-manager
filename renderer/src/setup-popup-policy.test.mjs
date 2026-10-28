import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { parseSync } from "rolldown/experimental";
import { availableAnalyticsSeasons } from "./analytics-seasons.mjs";

function walk(node, visit, parents = []) {
  if (!node || typeof node !== "object") return;
  visit(node, parents);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit, [...parents, node]));
    else if (value && typeof value === "object") walk(value, visit, [...parents, node]);
  }
}

function page(name) {
  const file = new URL(`./pages/${name}.jsx`, import.meta.url);
  const source = fs.readFileSync(file, "utf8");
  const parsed = parseSync(file.pathname, source);
  assert.equal(parsed.errors.length, 0, name);
  return { source, tree: parsed.program };
}

function evaluate(node, source, overrides = {}) {
  const variables = {};
  walk(node, child => { if (child.type === "Identifier") variables[child.name] = true; });
  return vm.runInNewContext(source.slice(node.start, node.end), { ...variables, ...overrides });
}

test("setup hides ordinary dialogs while permitting error and throttle dialogs", () => {
  let ordinary = 0, exceptions = 0;
  for (const name of ["ControlPage", "SettingsPage", "NftsPage"]) {
    const { source, tree } = page(name);
    walk(tree, (node, parents) => {
      if (node.type !== "JSXElement") return;
      const attrs = node.openingElement.attributes;
      if (!attrs.some(attr => attr.name?.name === "role" && attr.value?.value === "dialog")) return;
      if (attrs.some(attr => attr.name?.name === "data-onboarding-step")) return;
      const guards = parents.toReversed().flatMap(parent => parent.type === "ConditionalExpression"
        ? [parent.test] : parent.type === "LogicalExpression" && parent.operator === "&&" ? [parent.left] : []);
      const exception = guards.find(guard => ["resetErrorModal", "throttleModal"].includes(source.slice(guard.start, guard.end)));
      if (exception) {
        assert.equal(Boolean(evaluate(exception, source, { popupsBlocked: true, setupActive: true })), true);
        assert.ok(parents.some(parent => parent.type === "CallExpression" && parent.callee.name === "createPortal"));
        assert.ok(attrs.some(attr => attr.name?.name === "className" && attr.value.value.includes("z-[10020]")), "exception must appear above setup");
        exceptions++;
        return;
      }
      const guard = guards.find(candidate => /popupsBlocked|setupActive/.test(source.slice(candidate.start, candidate.end)));
      assert.ok(guard, `${name} dialog lacks the setup blocker`);
      assert.equal(Boolean(evaluate(guard, source, { popupsBlocked: true, setupActive: true })), false, name);
      assert.equal(Boolean(evaluate(guard, source, { popupsBlocked: false, setupActive: false })), true, name);
      ordinary++;
    });
  }
  assert.equal(ordinary, 12);
  assert.equal(exceptions, 2);
});

test("ordinary popup blocking releases after setup and the tour close", () => {
  const { source, tree } = page("ControlPage");
  let blocker, active;
  walk(tree, node => {
    if (node.type !== "VariableDeclarator") return;
    if (node.id.name === "popupsBlocked") blocker = node.init;
    if (node.id.name === "setupActive") active = node.init;
  });
  assert.ok(blocker);
  assert.ok(active);
  const state = { startupConfigLoaded: true, firstRunSetupComplete: true, onboardingOpen: false, interfaceTourOpen: false };
  const blocked = state => evaluate(blocker, source, { ...state, setupActive: evaluate(active, source, state) });
  assert.equal(blocked(state), false);
  for (const override of [{ startupConfigLoaded: false }, { firstRunSetupComplete: false }, { onboardingOpen: true }, { interfaceTourOpen: true }]) {
    assert.equal(blocked({ ...state, ...override }), true);
  }
  assert.equal(blocked(state), false);
  for (const name of ["SettingsPage", "NftsPage"]) {
    let wired = false;
    walk(tree, node => {
      if (node.type === "JSXOpeningElement" && node.name.name === name) {
        wired = node.attributes.some(attr => attr.name?.name === "setupActive" && attr.value?.expression?.name === "setupActive");
      }
    });
    assert.equal(wired, true, name);
  }
});

test("both stats views default to Season 73 and remember subsequent valid selections", () => {
  const { source, tree } = page("StatsPage");
  let savedRange;
  walk(tree, node => { if (node.type === "FunctionDeclaration" && node.id.name === "savedStatsRange") savedRange = node; });
  assert.ok(savedRange);
  let stored = null;
  const read = vm.runInNewContext(`(${source.slice(savedRange.start, savedRange.end)})`, {
    availableAnalyticsSeasons,
    localStorage: { getItem: () => stored },
  });
  assert.equal(read("overview"), "season73");
  assert.equal(read("nfts"), "season73");
  stored = "7d";
  assert.equal(read("overview"), "7d");
  stored = "invalid-range";
  assert.equal(read("nfts"), "season73");
});

test("MCP throttle notices open the dialog with its five-second countdown even during setup", () => {
  const { source, tree } = page("ControlPage");
  let noticeEffect, countdownEffect;
  walk(tree, node => {
    if (node.type !== "CallExpression" || node.callee.name !== "useEffect") return;
    const callback = node.arguments[0];
    const body = source.slice(callback.start, callback.end);
    if (body.includes('lastEvent?.type !== "throttle_notice"')) noticeEffect = body;
    if (body.includes("setThrottleModalCountdown(5)") && body.includes("const closeTimer")) countdownEffect = body;
  });
  assert.ok(noticeEffect);
  assert.ok(countdownEffect);
  let modal = null, countdown = null;
  const context = {
    lastEvent: { type: "throttle_notice", source: "mcp", trigger: "watch_and_claim", message: "Rate limited", waitSeconds: 62, retryAt: 12345 },
    lastThrottleModalKeyRef: { current: null },
    setThrottleModal: value => { modal = value; },
  };
  vm.runInNewContext(`(${noticeEffect})()`, context);
  assert.equal(modal.message, "Rate limited");
  assert.equal(modal.waitSeconds, 62);
  const timers = [];
  const timerContext = {
    popupsBlocked: true, throttleModal: modal,
    setThrottleModal: value => { modal = value; },
    setThrottleModalCountdown: value => { countdown = value; },
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); },
    setInterval: () => {}, clearTimeout: () => {}, clearInterval: () => {},
  };
  vm.runInNewContext(`(${countdownEffect})()`, timerContext);
  assert.equal(countdown, 5);
  assert.equal(timers[0].delay, 5000);
  assert.ok(modal, "dialog stays open until the five-second timeout");
  timers[0].callback();
  assert.equal(modal, null);
});
