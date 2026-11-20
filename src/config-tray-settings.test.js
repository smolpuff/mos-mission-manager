"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { saveConfig, flushConfig } = require("./config");

for (const key of ["windowsTrayEnabled", "macMenuBarEnabled"]) {
  for (const enabled of [true, false]) {
    test(`${key}=${enabled} survives stale runner saves and shutdown`, t => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "missions-tray-config-"));
      t.after(() => {
        for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
        fs.rmdirSync(directory);
      });
      const configPath = path.join(directory, "config.json");
      for (const staleConfig of [{}, { [key]: !enabled }]) {
        fs.writeFileSync(configPath, JSON.stringify({ [key]: enabled }));
        const ctx = { configPath, config: { ...staleConfig, totalClaimed: 12 } };
        saveConfig(ctx, () => {});
        t.mock.timers.tick(350);
        assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8"))[key], enabled);
        ctx.config = { ...staleConfig, totalClaimed: 13 };
        flushConfig(ctx, () => {});
        const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
        assert.equal(saved[key], enabled);
        assert.equal(saved.totalClaimed, 13);
      }
    });
  }
}
