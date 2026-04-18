"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { execFile } = require("child_process");
const bip39 = require("bip39");
const { derivePath } = require("ed25519-hd-key");
const {
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  signTransactionWithSigners,
  getTransactionEncoder,
  getBase58Decoder,
} = require("@solana/kit");
const {
  validatePreparedMissionAction,
  decodePreparedTransaction,
} = require("./signer-prepare");
const {
  openMissionPlayPage,
  MISSION_PLAY_URL: MISSION_PLAY_URL_SHARED,
  MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT,
} = require("./mission-page");

const VAULT_VERSION = 1;
const VAULT_ALGORITHM = "aes-256-gcm";
const VAULT_KEY_BYTES = 32;
const VAULT_IV_BYTES = 12;
const SCOPED_SIGNER_SERVICE_PREFIX = "missions-v3-mcp.signer.v2";
const SIGNER_ACCOUNT = "app-wallet-vault-key";
const DEFAULT_VAULT_FILE = path.join("data", "signer-vault.json");
const SUPPORTED_SIGNER_MODES = new Set(["app_wallet", "manual", "dapp"]);
const SUPPORTED_MISSION_ACTIONS = new Set([
  "nft_cooldown_reset",
  "mission_reroll",
  "mission_swap",
  "mission_slot_unlock",
]);
const LEGACY_ACTION_ALIASES = {
  mission_cooldown_reset: "nft_cooldown_reset",
};
const UNLOCK_BACKOFF_BASE_MS = 1000;
const UNLOCK_BACKOFF_MAX_MS = 30000;
const DEFAULT_REPLAY_WINDOW_SECONDS = 180;
const DEFAULT_ACTION_COOLDOWN_SECONDS = {
  nft_cooldown_reset: 10,
  mission_reroll: 10,
  mission_swap: 15,
  mission_slot_unlock: 30,
};
const DEFAULT_MAX_ACTION_COST = {
  nft_cooldown_reset: 1000,
  mission_reroll: 1000,
  mission_swap: 1000,
  mission_slot_unlock: 5000,
};
const DEFAULT_MNEMONIC_DERIVATION_PATH = "m/44'/501'/0'/0'";
const COMMON_MNEMONIC_DERIVATION_PATHS = [
  "m/44'/501'/0'/0'",
  "m/44'/501'/0'",
  "m/44'/501'/0'/0'/0'",
  "m/44'/501'/1'/0'",
  "m/44'/501'/0'/1'",
];
const MISSION_PLAY_URL = "https://pixelbypixel.studio/missions/play";

function missionPageCooldownMsFromConfig(ctx) {
  const sec = Number(ctx?.config?.missionPageOpenCooldownSeconds);
  if (Number.isFinite(sec) && sec > 0) return Math.floor(sec * 1000);
  const ms = Number(ctx?.config?.missionPageOpenCooldownMs);
  if (Number.isFinite(ms) && ms >= 0) return Math.floor(ms);
  return MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT;
}

function createSignerService(ctx, logger) {
  const { logWithTimestamp, logDebug } = logger;
  let approvalPromptHandler = null;

  function getBase58EncodedWireTransaction(transaction) {
    const wireTransactionBytes = getTransactionEncoder().encode(transaction);
    return getBase58Decoder().decode(wireTransactionBytes);
  }

  function normalizeSignerMode(value) {
    const normalized = String(value || "").trim();
    if (normalized === "app_wallet") return "app_wallet";
    if (normalized === "browser_wallet") return "manual";
    if (normalized === "signing") return "app_wallet";
    if (normalized === "dapp") return "dapp";
    return "manual";
  }

  function vaultFileRelative() {
    const configured = ctx.signerConfig?.vaultFile;
    if (typeof configured === "string" && configured.trim()) {
      return configured.trim();
    }
    return DEFAULT_VAULT_FILE;
  }

  function storageBaseDir() {
    if (typeof ctx.configPath === "string" && ctx.configPath.trim()) {
      return path.dirname(ctx.configPath);
    }
    return process.cwd();
  }

  function vaultFileAbsolute() {
    const relative = vaultFileRelative();
    return path.isAbsolute(relative)
      ? relative
      : path.join(storageBaseDir(), relative);
  }

  function ensureVaultDir() {
    const dir = path.dirname(vaultFileAbsolute());
    fs.mkdirSync(dir, { recursive: true });
  }

  function scopedSignerService() {
    const vaultPath = path.resolve(vaultFileAbsolute());
    const digest = crypto
      .createHash("sha256")
      .update(vaultPath)
      .digest("hex")
      .slice(0, 16);
    return `${SCOPED_SIGNER_SERVICE_PREFIX}.${digest}`;
  }

  function secureStorageIdentity() {
    return {
      service: scopedSignerService(),
      account: SIGNER_ACCOUNT,
    };
  }

  function configuredSecureStorageIdentity() {
    const service = String(ctx.signerConfig?.keyStoreService || "").trim();
    const account = String(ctx.signerConfig?.keyStoreAccount || "").trim();
    if (!service || !account) return null;
    return { service, account };
  }

  function secureStorageReadIdentities() {
    const identities = [];
    const seen = new Set();
    const configured = configuredSecureStorageIdentity();
    const scoped = secureStorageIdentity();
    for (const entry of [configured, scoped]) {
      if (!entry) continue;
      const key = `${entry.service}\u0000${entry.account}`;
      if (seen.has(key)) continue;
      seen.add(key);
      identities.push(entry);
    }
    return identities;
  }

  function auditFileRelative() {
    const configured = ctx.signerConfig?.auditFile;
    if (typeof configured === "string" && configured.trim()) {
      return configured.trim();
    }
    return path.join("data", "signer-audit.log");
  }

  function auditFileAbsolute() {
    const relative = auditFileRelative();
    return path.isAbsolute(relative)
      ? relative
      : path.join(storageBaseDir(), relative);
  }

  function ensureAuditDir() {
    const dir = path.dirname(auditFileAbsolute());
    fs.mkdirSync(dir, { recursive: true });
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function signerEnabled() {
    return ctx.signerConfig?.enabled !== false;
  }

  function replayWindowSeconds() {
    const raw = Number(ctx.signerConfig?.replayWindowSeconds);
    return Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : DEFAULT_REPLAY_WINDOW_SECONDS;
  }

  function normalizeActionName(actionName) {
    const normalized = String(actionName || "").trim();
    return LEGACY_ACTION_ALIASES[normalized] || normalized;
  }

  function actionCooldownSeconds(actionName) {
    const normalizedAction = normalizeActionName(actionName);
    const raw = Number(
      ctx.signerConfig?.actionCooldownSeconds?.[normalizedAction],
    );
    if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
    return DEFAULT_ACTION_COOLDOWN_SECONDS[normalizedAction] || 0;
  }

  function maxActionCost(actionName) {
    const normalizedAction = normalizeActionName(actionName);
    const raw = Number(ctx.signerConfig?.maxActionCost?.[normalizedAction]);
    if (Number.isFinite(raw) && raw >= 0) return raw;
    return DEFAULT_MAX_ACTION_COST[normalizedAction] ?? null;
  }

  function redactPath(filePath) {
    const absolute = String(filePath || "");
    if (!absolute) return "";
    return path.relative(storageBaseDir(), absolute) || absolute;
  }

  function walletRefFromSecret(secretBytes) {
    const digest = crypto
      .createHash("sha256")
      .update(secretBytes)
      .digest("hex");
    return `wallet_${digest.slice(0, 12)}`;
  }

  function fingerprintPreparedAction(actionName, validated) {
    const digest = crypto.createHash("sha256");
    digest.update(String(actionName || ""));
    digest.update("|");
    digest.update(String(validated.structuredContent?.[validated.tokenField] || ""));
    digest.update("|");
    digest.update(String(validated.structuredContent?.transaction || ""));
    return digest.digest("hex");
  }

  function appendAudit(eventType, payload = {}) {
    try {
      ensureAuditDir();
      const line = JSON.stringify({
        ts: nowIso(),
        eventType,
        signerMode: ctx.signerMode,
        walletRef: ctx.signerConfig?.walletRef || null,
        ...payload,
      });
      fs.appendFileSync(auditFileAbsolute(), `${line}\n`);
    } catch (error) {
      logDebug("signer", "audit_write_failed", {
        eventType,
        error: error.message,
        auditFile: redactPath(auditFileAbsolute()),
      });
    }
  }

  function pruneReplayFingerprints(nowMs = Date.now()) {
    const windowMs = replayWindowSeconds() * 1000;
    for (const [fingerprint, seenAt] of Object.entries(
      ctx.signerRecentActionFingerprints || {},
    )) {
      if (!Number.isFinite(Number(seenAt))) {
        delete ctx.signerRecentActionFingerprints[fingerprint];
        continue;
      }
      if (nowMs - Number(seenAt) > windowMs) {
        delete ctx.signerRecentActionFingerprints[fingerprint];
      }
    }
  }

  function assertSignerEnabled(actionName) {
    if (signerEnabled()) return;
    appendAudit("sign_blocked_disabled", { actionName });
    throw new Error("Signer is disabled by config.");
  }

  function assertActionCooldown(actionName, nowMs = Date.now()) {
    const cooldownMs = actionCooldownSeconds(actionName) * 1000;
    if (cooldownMs <= 0) return;
    const lastAt = Number(ctx.signerActionLastAt?.[actionName] || 0);
    if (!Number.isFinite(lastAt) || lastAt <= 0) return;
    const elapsed = nowMs - lastAt;
    if (elapsed >= cooldownMs) return;
    const waitSeconds = Math.ceil((cooldownMs - elapsed) / 1000);
    appendAudit("sign_blocked_cooldown", { actionName, waitSeconds });
    throw new Error(
      `Signer action cooldown active for ${actionName}. Retry in ${waitSeconds}s.`,
    );
  }

  function assertActionCostBound(actionName, validated) {
    const maxCost = maxActionCost(actionName);
    if (!Number.isFinite(Number(maxCost))) return;
    const cost = Number(validated.cost);
    if (!Number.isFinite(cost)) return;
    if (cost <= Number(maxCost)) return;
    appendAudit("sign_blocked_cost", {
      actionName,
      cost,
      maxCost,
      tokenPreview: validated.tokenPreview,
    });
    throw new Error(
      `Signer action cost ${cost} exceeds configured max ${maxCost} for ${actionName}.`,
    );
  }

  function assertFundingAffordable(actionName, validated) {
    if (ctx.signerMode !== "app_wallet") return;
    const summary = ctx.fundingWalletSummary || {};
    const expectedWallet = String(ctx.signerConfig?.walletAddress || "").trim();
    const summaryWallet = String(summary.address || "").trim();
    if (!expectedWallet || !summaryWallet || summaryWallet !== expectedWallet) return;
    if (summary.status !== "ok") {
      logDebug("signer", "sign_funds_unknown", {
        actionName,
        walletAddress: expectedWallet,
        summaryStatus: summary.status || "unknown",
      });
      return;
    }
    const issues = [];
    const cost = Number(validated.cost);
    const pbp =
      typeof summary.pbp === "number" && Number.isFinite(summary.pbp)
        ? summary.pbp
        : null;
    const sol =
      typeof summary.sol === "number" && Number.isFinite(summary.sol)
        ? summary.sol
        : null;
    if (Number.isFinite(cost) && cost > 0 && pbp !== null && pbp < cost) {
      issues.push(`PBP balance ${pbp} is below required cost ${cost}`);
    }
    if (sol !== null && sol <= 0) {
      issues.push("SOL balance is 0");
    }
    if (issues.length === 0) return;
    appendAudit("sign_blocked_funds", {
      actionName,
      cost: validated.cost,
      walletAddress: expectedWallet,
      fundingSol: Number.isFinite(sol) ? sol : null,
      fundingPbp: Number.isFinite(pbp) ? pbp : null,
      tokenPreview: validated.tokenPreview,
      identifiers: validated.identifiers,
    });
    logDebug("signer", "sign_blocked_funds", {
      actionName,
      walletAddress: expectedWallet,
      fundingSol: Number.isFinite(sol) ? sol : null,
      fundingPbp: Number.isFinite(pbp) ? pbp : null,
      requiredCost: validated.cost,
      identifiers: validated.identifiers,
    });
    logWithTimestamp(
      `[SIGNER] ⚠️ Local funding check warning for ${actionName}: ${issues.join("; ")}. Continuing so the real tx/sign error is visible.`,
    );
    return;
  }

  function assertReplayAllowed(actionName, validated, nowMs = Date.now()) {
    pruneReplayFingerprints(nowMs);
    const fingerprint = fingerprintPreparedAction(actionName, validated);
    if (ctx.signerRecentActionFingerprints?.[fingerprint]) {
      appendAudit("sign_blocked_replay", {
        actionName,
        tokenPreview: validated.tokenPreview,
        fingerprint: fingerprint.slice(0, 16),
      });
      throw new Error("Replay blocked for this prepared action.");
    }
    return fingerprint;
  }

  function markSignedAction(actionName, fingerprint, nowMs = Date.now()) {
    ctx.signerRecentActionFingerprints[fingerprint] = nowMs;
    ctx.signerActionLastAt[actionName] = nowMs;
  }

  function execFileAsync(file, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const execOptions = { encoding: "utf8" };
      if (opts && typeof opts === "object" && opts.env) {
        execOptions.env = { ...process.env, ...opts.env };
      }
      if (opts && typeof opts === "object" && typeof opts.cwd === "string") {
        execOptions.cwd = opts.cwd;
      }
      const child = execFile(
        file,
        args,
        execOptions,
        (error, stdout, stderr) => {
          if (error) {
            const message = String(
              stderr || stdout || error.message || "",
            ).trim();
            reject(new Error(message || error.message));
            return;
          }
          resolve(String(stdout || ""));
        },
      );
      if (typeof opts.input === "string") {
        child.stdin.end(opts.input);
      }
    });
  }

  function getBrowserBridgeUrl(structuredContent) {
    const sc = structuredContent && typeof structuredContent === "object"
      ? structuredContent
      : {};
    const candidates = [
      sc.signingBridgeUrl,
      sc.signingUrl,
      sc?.signingMethods?.browserBridge?.signingUrl,
      sc?.signingMethods?.browserBridge?.url,
    ];
    for (const value of candidates) {
      const url = String(value || "").trim();
      if (/^https?:\/\//i.test(url)) return url;
    }
    const bridgePath = String(sc.signingBridgePath || "").trim();
    if (bridgePath.startsWith("/")) {
      return `https://pixelbypixel.studio${bridgePath}`;
    }
    return null;
  }

  function secureStorageProvider() {
    if (process.platform === "darwin") return "macos_keychain";
    if (process.platform === "win32") return "windows_dpapi";
    if (process.platform === "linux") return "linux_secret_service";
    return "unsupported";
  }

  function keyStoreFileRelative() {
    const configured = ctx.signerConfig?.keyStoreFile;
    if (typeof configured === "string" && configured.trim()) {
      return configured.trim();
    }
    return path.join("data", "signer-vault-key.dpapi");
  }

  function keyStoreFileAbsolute() {
    const relative = keyStoreFileRelative();
    return path.isAbsolute(relative)
      ? relative
      : path.join(storageBaseDir(), relative);
  }

  function secureStorageDisplayName() {
    const provider = secureStorageProvider();
    if (provider === "macos_keychain") return "macOS Keychain";
    if (provider === "windows_dpapi") return "Windows DPAPI";
    if (provider === "linux_secret_service") return "Linux Secret Service";
    return "OS secure storage";
  }

  async function checkCommandAvailable(command, args = ["--help"]) {
    try {
      await execFileAsync(command, args);
      return true;
    } catch {
      return false;
    }
  }

  async function writeVaultKeyToSecureStorage(vaultKey) {
    const provider = secureStorageProvider();
    const encoded = vaultKey.toString("base64");
    const identity = secureStorageIdentity();
    if (!encoded) {
      throw new Error("Refusing to store an empty vault key.");
    }
    if (provider === "macos_keychain") {
      await execFileAsync("security", [
        "add-generic-password",
        "-U",
        "-a",
        identity.account,
        "-s",
        identity.service,
        "-w",
        encoded,
      ]);
      return;
    }
    if (provider === "windows_dpapi") {
      const file = keyStoreFileAbsolute();
      const script =
        "$ErrorActionPreference='Stop'; " +
        "$plain=[string]$env:SIGNER_VAULT_KEY_B64; " +
        "$file=[string]$env:SIGNER_VAULT_KEY_FILE; " +
        "if (-not $plain) { throw 'Vault key text is empty.' }; " +
        "if (-not $file) { throw 'Vault key path is empty.' }; " +
        "$secure=ConvertTo-SecureString -String $plain -AsPlainText -Force; " +
        "$enc=ConvertFrom-SecureString -SecureString $secure; " +
        "$dir=[System.IO.Path]::GetDirectoryName($file); " +
        "if ($dir) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }; " +
        "$tmp=$file + '.tmp'; " +
        "[System.IO.File]::WriteAllText($tmp,$enc); " +
        "if ([System.IO.File]::Exists($file)) { [System.IO.File]::Replace($tmp,$file,$null,$true) } else { [System.IO.File]::Move($tmp,$file) };";
      await execFileAsync("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ], {
        env: {
          SIGNER_VAULT_KEY_B64: encoded,
          SIGNER_VAULT_KEY_FILE: file,
        },
      });
      return;
    }
    if (provider === "linux_secret_service") {
      await execFileAsync(
        "secret-tool",
        [
          "store",
          "--label=missions-v3-mcp signer vault key",
          "service",
          identity.service,
          "account",
          identity.account,
        ],
        { input: encoded },
      );
      return;
    }
    throw new Error(
      `OS secure storage is not implemented on this platform (${process.platform}). Import is blocked.`,
    );
  }

  async function readRawVaultKeyFromSecureStorage() {
    const provider = secureStorageProvider();
    const identities = secureStorageReadIdentities();
    if (provider === "macos_keychain") {
      let lastError = null;
      for (const identity of identities) {
        try {
          const stdout = await execFileAsync("security", [
            "find-generic-password",
            "-a",
            identity.account,
            "-s",
            identity.service,
            "-w",
          ]);
          return String(stdout || "").trim();
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      throw new Error("No macOS secure storage identity is configured.");
    }
    if (provider === "windows_dpapi") {
      const file = keyStoreFileAbsolute();
      const script =
        "$ErrorActionPreference='Stop'; " +
        "$file=[string]$env:SIGNER_VAULT_KEY_FILE; " +
        "if (-not $file) { throw 'Vault key path is empty.' }; " +
        "if (-not [System.IO.File]::Exists($file)) { throw 'Vault key file not found.' }; " +
        "$enc=[System.IO.File]::ReadAllText($file).Trim(); " +
        "if (-not $enc) { throw 'Vault key file is empty.' }; " +
        "$secure=ConvertTo-SecureString -String $enc; " +
        "$bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); " +
        "try { $plain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) } }; " +
        "if (-not $plain) { throw 'Vault key decrypt failed.' }; " +
        "[Console]::Out.Write($plain);";
      const stdout = await execFileAsync("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ], {
        env: {
          SIGNER_VAULT_KEY_FILE: file,
        },
      });
      return String(stdout || "").trim();
    }
    if (provider === "linux_secret_service") {
      let lastError = null;
      for (const identity of identities) {
        try {
          const stdout = await execFileAsync("secret-tool", [
            "lookup",
            "service",
            identity.service,
            "account",
            identity.account,
          ]);
          return String(stdout || "").trim();
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      throw new Error("No Linux secure storage identity is configured.");
    }
    throw new Error(
      `OS secure storage is not implemented on this platform (${process.platform}). Unlock is blocked.`,
    );
  }

  async function readVaultKeyFromSecureStorage() {
    const provider = secureStorageProvider();
    const value = await readRawVaultKeyFromSecureStorage();
    if (!value) {
      if (provider === "macos_keychain") {
        throw new Error("Vault key not found in macOS Keychain.");
      }
      if (provider === "windows_dpapi") {
        throw new Error("Vault key not found in Windows DPAPI store.");
      }
      if (provider === "linux_secret_service") {
        throw new Error("Vault key not found in Linux Secret Service.");
      }
    }
    return Buffer.from(value, "base64");
  }

  async function deleteVaultKeyFromSecureStorage() {
    const provider = secureStorageProvider();
    const identity = secureStorageIdentity();
    if (provider === "unsupported") return;
    try {
      if (provider === "macos_keychain") {
        try {
          await execFileAsync("security", [
            "delete-generic-password",
            "-a",
            identity.account,
            "-s",
            identity.service,
          ]);
        } catch {}
        return;
      }
      if (provider === "windows_dpapi") {
        try {
          fs.unlinkSync(keyStoreFileAbsolute());
        } catch (error) {
          if (error && error.code !== "ENOENT") throw error;
        }
        return;
      }
      if (provider === "linux_secret_service") {
        try {
          await execFileAsync("secret-tool", [
            "clear",
            "service",
            identity.service,
            "account",
            identity.account,
          ]);
        } catch {}
      }
    } catch (error) {
      logDebug("signer", "secure_storage_delete_skipped", {
        error: error.message,
        keyStoreProvider: provider,
      });
    }
  }

  function loadVaultRecord() {
    const file = vaultFileAbsolute();
    if (!fs.existsSync(file)) return null;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      const compact = {
        version: Number(parsed.version) || VAULT_VERSION,
        algorithm: String(parsed.algorithm || VAULT_ALGORITHM),
        nonce: String(parsed.nonce || ""),
        authTag: String(parsed.authTag || ""),
        ciphertext: String(parsed.ciphertext || ""),
        createdAt:
          typeof parsed.createdAt === "string" && parsed.createdAt.trim()
            ? parsed.createdAt
            : nowIso(),
      };
      if (
        parsed.mnemonicBackup &&
        typeof parsed.mnemonicBackup === "object" &&
        !Array.isArray(parsed.mnemonicBackup)
      ) {
        const mnemonicBackup = {
          version:
            Number(parsed.mnemonicBackup.version) || VAULT_VERSION,
          algorithm: String(
            parsed.mnemonicBackup.algorithm || VAULT_ALGORITHM,
          ),
          nonce: String(parsed.mnemonicBackup.nonce || ""),
          authTag: String(parsed.mnemonicBackup.authTag || ""),
          ciphertext: String(parsed.mnemonicBackup.ciphertext || ""),
          createdAt:
            typeof parsed.mnemonicBackup.createdAt === "string" &&
            parsed.mnemonicBackup.createdAt.trim()
              ? parsed.mnemonicBackup.createdAt
              : nowIso(),
        };
        if (
          mnemonicBackup.nonce &&
          mnemonicBackup.authTag &&
          mnemonicBackup.ciphertext
        ) {
          compact.mnemonicBackup = mnemonicBackup;
        }
      }
      if (!compact.nonce || !compact.authTag || !compact.ciphertext) {
        throw new Error("Vault record is missing encrypted payload fields.");
      }
      const compactJson = JSON.stringify(compact);
      const parsedJson = JSON.stringify(parsed);
      if (compactJson !== parsedJson) {
        persistVaultRecord(compact);
        logDebug("signer", "vault_compacted", {
          removedKeys: Object.keys(parsed).filter(
            (key) => !Object.prototype.hasOwnProperty.call(compact, key),
          ),
          vaultFile: redactPath(file),
        });
      }
      return compact;
    } catch (error) {
      logDebug("signer", "vault_load_failed", {
        error: error.message,
        vaultFile: redactPath(file),
      });
      return null;
    }
  }

  function persistVaultRecord(record) {
    ensureVaultDir();
    const file = vaultFileAbsolute();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
  }

  function clearSignerSessionSecretKey() {
    if (Buffer.isBuffer(ctx.signerSessionSecretKey)) {
      ctx.signerSessionSecretKey.fill(0);
    }
    ctx.signerSessionSecretKey = null;
    ctx.signerReady = false;
    ctx.signerLocked = true;
  }

  function encryptSecret(secretBytes, vaultKey) {
    const iv = crypto.randomBytes(VAULT_IV_BYTES);
    const cipher = crypto.createCipheriv(VAULT_ALGORITHM, vaultKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(secretBytes),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      version: VAULT_VERSION,
      algorithm: VAULT_ALGORITHM,
      nonce: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      createdAt: nowIso(),
    };
  }

  function decryptSecret(record, vaultKey) {
    const iv = Buffer.from(String(record?.nonce || ""), "base64");
    const authTag = Buffer.from(String(record?.authTag || ""), "base64");
    const ciphertext = Buffer.from(String(record?.ciphertext || ""), "base64");
    const decipher = crypto.createDecipheriv(
      String(record?.algorithm || VAULT_ALGORITHM),
      vaultKey,
      iv,
    );
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  function decryptUtf8(record, vaultKey) {
    if (!record || typeof record !== "object") return null;
    const decrypted = decryptSecret(record, vaultKey);
    try {
      return decrypted.toString("utf8");
    } finally {
      decrypted.fill(0);
    }
  }

  function normalizeWalletAddress(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    const lowered = text.toLowerCase();
    if (
      lowered === "unknown" ||
      lowered === "n/a" ||
      lowered === "none" ||
      lowered === "null" ||
      lowered === "undefined"
    ) {
      return null;
    }
    return text;
  }

  function looksLikeRecoveryPhrase(raw) {
    const text = extractImportStringCandidate(raw);
    return Boolean(text) && bip39.validateMnemonic(text);
  }

  function extractImportStringCandidate(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const key of [
          "mnemonic",
          "seedPhrase",
          "recoveryPhrase",
          "secretKey",
          "privateKey",
          "keypair",
          "secret",
        ]) {
          if (typeof parsed[key] === "string" && parsed[key].trim()) {
            return parsed[key].trim().replace(/^["']|["']$/g, "");
          }
        }
      }
    } catch {}
    return text.replace(/^["']|["']$/g, "");
  }

  async function walletAddressFromSecret(secretBytes) {
    const signer =
      secretBytes.length === 64
        ? await createKeyPairSignerFromBytes(Uint8Array.from(secretBytes), false)
        : await createKeyPairSignerFromPrivateKeyBytes(
            Uint8Array.from(secretBytes),
            false,
          );
    return String(signer.address);
  }

  async function deriveMnemonicCandidates(mnemonic) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    try {
      const candidates = [];
      for (const derivationPath of COMMON_MNEMONIC_DERIVATION_PATHS) {
        const { key } = derivePath(derivationPath, seed.toString("hex"));
        const secretBytes = Buffer.from(key);
        const walletAddress = await walletAddressFromSecret(secretBytes);
        candidates.push({ derivationPath, secretBytes, walletAddress });
      }
      return candidates;
    } finally {
      seed.fill(0);
    }
  }

  function parseKeypairText(raw) {
    const text = String(raw || "").trim();
    if (!text) {
      throw new Error("Signer import text is empty.");
    }
    const base58Decoder = getBase58Decoder();
    let parsed = null;
    let stringCandidate = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      const parts = text
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => Number(part));
      if (parts.length > 0 && parts.every((n) => Number.isFinite(n))) {
        parsed = parts;
      } else {
        stringCandidate = text;
      }
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      if (Array.isArray(parsed.secretKey)) parsed = parsed.secretKey;
      else if (Array.isArray(parsed.privateKey)) parsed = parsed.privateKey;
      else if (Array.isArray(parsed.keypair)) parsed = parsed.keypair;
      else if (Array.isArray(parsed.secret)) parsed = parsed.secret;
      else if (typeof parsed.mnemonic === "string") stringCandidate = parsed.mnemonic;
      else if (typeof parsed.seedPhrase === "string") stringCandidate = parsed.seedPhrase;
      else if (typeof parsed.recoveryPhrase === "string") stringCandidate = parsed.recoveryPhrase;
      else if (typeof parsed.secretKey === "string") stringCandidate = parsed.secretKey;
      else if (typeof parsed.privateKey === "string") stringCandidate = parsed.privateKey;
      else if (typeof parsed.keypair === "string") stringCandidate = parsed.keypair;
      else if (typeof parsed.secret === "string") stringCandidate = parsed.secret;
    }

    if (Array.isArray(parsed)) {
      const bytes = Buffer.from(parsed);
      if (bytes.length !== 64 && bytes.length !== 32) {
        throw new Error("Signer import must contain 32 or 64 bytes.");
      }
      return bytes;
    }

    const candidate = String(stringCandidate || text).trim().replace(/^["']|["']$/g, "");
    if (candidate) {
      try {
        const decoded = Buffer.from(base58Decoder.decode(candidate));
        if (decoded.length === 64 || decoded.length === 32) {
          return decoded;
        }
      } catch {}

      try {
        const decoded = Buffer.from(candidate, "base64");
        if (
          (decoded.length === 64 || decoded.length === 32) &&
          decoded.toString("base64").replace(/=+$/g, "") === candidate.replace(/=+$/g, "")
        ) {
          return decoded;
        }
      } catch {}
    }

    throw new Error(
      "Signer import must be a pasted private key string, a standard recovery phrase, a 32/64-byte array, or a JSON object containing one.",
    );
  }

  async function resolveImportSecret(rawText, options = {}) {
    const text = String(rawText || "").trim();
    const stringCandidate = extractImportStringCandidate(text);
    const expectedWalletAddress = normalizeWalletAddress(
      options.expectedWalletAddress,
    );
    if (looksLikeRecoveryPhrase(text)) {
      const candidates = await deriveMnemonicCandidates(stringCandidate);
      const matched = expectedWalletAddress
        ? candidates.find((entry) => entry.walletAddress === expectedWalletAddress)
        : candidates.find(
            (entry) => entry.derivationPath === DEFAULT_MNEMONIC_DERIVATION_PATH,
          ) || candidates[0] || null;
      if (!matched && expectedWalletAddress) {
        throw new Error(
          `Recovery phrase did not match wallet ${expectedWalletAddress} on supported Solana derivation paths.`,
        );
      }
      if (!matched) {
        throw new Error(
          "Recovery phrase import failed to derive a supported Solana account.",
        );
      }
      return {
        secretBytes: matched.secretBytes,
        walletAddress: matched.walletAddress,
        derivationPath: matched.derivationPath,
        sourceType: "mnemonic",
      };
    }

    const secretBytes = parseKeypairText(text);
    const walletAddress = await walletAddressFromSecret(secretBytes);
    return {
      secretBytes,
      walletAddress,
      derivationPath: null,
      sourceType: "private_key",
    };
  }

  async function persistSignerSecret({
    secretBytes,
    walletAddress,
    derivationPath = null,
    sourceType = "private_key",
    mnemonic = null,
    successVerb = "imported",
  }) {
    const walletRef = walletRefFromSecret(secretBytes);
    const vaultKey = crypto.randomBytes(VAULT_KEY_BYTES);
    const encrypted = encryptSecret(secretBytes, vaultKey);
    const encryptedMnemonic =
      typeof mnemonic === "string" && mnemonic.trim()
        ? encryptSecret(Buffer.from(mnemonic.trim(), "utf8"), vaultKey)
        : null;
    const importedAt = nowIso();
    const vaultRecord = {
      ...encrypted,
      ...(encryptedMnemonic ? { mnemonicBackup: encryptedMnemonic } : {}),
    };
    const provider = secureStorageProvider();
    const keyStoreFile =
      provider === "windows_dpapi" ? keyStoreFileRelative() : null;
    const identity = secureStorageIdentity();
    const signerConfig = {
      vaultFile: vaultFileRelative(),
      walletRef,
      walletAddress,
      derivationPath,
      importSourceType: sourceType,
      hasRecoveryPhraseBackup: Boolean(encryptedMnemonic),
      vaultVersion: VAULT_VERSION,
      algorithm: VAULT_ALGORITHM,
      importedAt,
      keyStoreProvider: provider,
      keyStoreService: identity.service,
      keyStoreAccount: identity.account,
      keyStoreFile,
      allowedActions: Array.from(SUPPORTED_MISSION_ACTIONS),
      enabled: ctx.signerConfig?.enabled !== false,
      auditFile: ctx.signerConfig?.auditFile || auditFileRelative(),
      replayWindowSeconds:
        Number(ctx.signerConfig?.replayWindowSeconds) || replayWindowSeconds(),
      actionCooldownSeconds:
        ctx.signerConfig?.actionCooldownSeconds || DEFAULT_ACTION_COOLDOWN_SECONDS,
      maxActionCost:
        ctx.signerConfig?.maxActionCost || DEFAULT_MAX_ACTION_COST,
    };
    const vaultPath = vaultFileAbsolute();
    const hadPreviousVault = fs.existsSync(vaultPath);
    const previousVaultRaw = hadPreviousVault
      ? fs.readFileSync(vaultPath, "utf8")
      : null;
    const hadPreviousMacKeychain =
      provider === "macos_keychain" &&
      (await (async () => {
        try {
          await readRawVaultKeyFromSecureStorage();
          return true;
        } catch {
          return false;
        }
      })());
    const previousMacKeychainRaw =
      provider === "macos_keychain" && hadPreviousMacKeychain
        ? await readRawVaultKeyFromSecureStorage()
        : null;
    const keyStorePath =
      provider === "windows_dpapi" ? keyStoreFileAbsolute() : null;
    const hadPreviousKeyStore =
      provider === "windows_dpapi" && keyStorePath
        ? fs.existsSync(keyStorePath)
        : false;
    const previousKeyStoreRaw =
      provider === "windows_dpapi" && hadPreviousKeyStore && keyStorePath
        ? fs.readFileSync(keyStorePath, "utf8")
        : null;

    try {
      persistVaultRecord(vaultRecord);
      await writeVaultKeyToSecureStorage(vaultKey);
      ctx.config.signer = signerConfig;
      ctx.signerConfig = signerConfig;
      clearSignerSessionSecretKey();
      ctx.signerUnlockFailures = 0;
      ctx.signerUnlockAllowedAt = 0;
      updateSignerState();
      logWithTimestamp(
        `[SIGNER] ✅ App wallet ${successVerb} and encrypted. wallet=${walletAddress}`,
      );
      logWithTimestamp(
        "[SIGNER] 🔒 Vault is locked. Run 'signer unlock' before signing.",
      );
      logDebug("signer", "persist_secret_ok", {
        walletRef,
        walletAddress,
        sourceType,
        derivationPath,
        hasRecoveryPhraseBackup: Boolean(encryptedMnemonic),
        vaultFile: signerConfig.vaultFile,
        keyStoreProvider: signerConfig.keyStoreProvider,
      });
      return {
        walletRef,
        walletAddress,
        derivationPath,
        hasRecoveryPhraseBackup: Boolean(encryptedMnemonic),
      };
    } catch (error) {
      try {
        if (hadPreviousVault && typeof previousVaultRaw === "string") {
          fs.writeFileSync(vaultPath, previousVaultRaw);
        } else if (!hadPreviousVault && fs.existsSync(vaultPath)) {
          fs.unlinkSync(vaultPath);
        }
      } catch (rollbackError) {
        logDebug("signer", "persist_secret_rollback_failed", {
          error: rollbackError.message,
          vaultFile: vaultFileRelative(),
        });
      }
      if (provider === "macos_keychain") {
        try {
          if (hadPreviousMacKeychain && typeof previousMacKeychainRaw === "string") {
            await writeVaultKeyToSecureStorage(
              Buffer.from(previousMacKeychainRaw, "base64"),
            );
          } else {
            await deleteVaultKeyFromSecureStorage();
          }
        } catch (rollbackError) {
          logDebug("signer", "persist_secret_keychain_rollback_failed", {
            error: rollbackError.message,
            keyStoreProvider: provider,
          });
        }
      }
      if (provider === "windows_dpapi" && keyStorePath) {
        try {
          if (hadPreviousKeyStore && typeof previousKeyStoreRaw === "string") {
            fs.writeFileSync(keyStorePath, previousKeyStoreRaw);
          } else if (!hadPreviousKeyStore && fs.existsSync(keyStorePath)) {
            fs.unlinkSync(keyStorePath);
          }
        } catch (rollbackError) {
          logDebug("signer", "persist_secret_keystore_rollback_failed", {
            error: rollbackError.message,
            keyStoreFile: redactPath(keyStorePath),
          });
        }
      }
      logDebug("signer", "persist_secret_failed", {
        error: error.message,
        sourceType,
        mnemonicProvided:
          typeof mnemonic === "string" && mnemonic.trim().length > 0,
        vaultFile: vaultFileRelative(),
      });
      throw error;
    } finally {
      vaultKey.fill(0);
      secretBytes.fill(0);
    }
  }

  function parseKeypairFile(filePath) {
    const raw = fs.readFileSync(filePath, "utf8");
    return parseKeypairText(raw);
  }

  function updateSignerState() {
    ctx.signerMode = normalizeSignerMode(ctx.signerMode || ctx.config.signerMode);
    ctx.config.signerMode = ctx.signerMode;
    ctx.signerConfig =
      ctx.config.signer &&
      typeof ctx.config.signer === "object" &&
      !Array.isArray(ctx.config.signer)
        ? ctx.config.signer
        : {};

    const vault = loadVaultRecord();
    const imported =
      Boolean(vault) &&
      typeof ctx.signerConfig.walletRef === "string" &&
      ctx.signerConfig.walletRef.length > 0;

    if (!SUPPORTED_SIGNER_MODES.has(ctx.signerMode)) {
      clearSignerSessionSecretKey();
      ctx.signerStatus = "invalid_mode";
      logDebug("signer", "state_updated", {
        signerMode: ctx.signerMode,
        signerStatus: ctx.signerStatus,
      });
      return;
    }

    if (ctx.signerMode === "manual") {
      clearSignerSessionSecretKey();
      ctx.signerStatus = "manual_page_only";
      logDebug("signer", "state_updated", {
        signerMode: ctx.signerMode,
        signerStatus: ctx.signerStatus,
      });
      return;
    }
    if (ctx.signerMode === "dapp") {
      clearSignerSessionSecretKey();
      ctx.signerStatus = "dapp_browser_wallet";
      logDebug("signer", "state_updated", {
        signerMode: ctx.signerMode,
        signerStatus: ctx.signerStatus,
      });
      return;
    }

    if (!imported) {
      clearSignerSessionSecretKey();
      ctx.signerStatus = "app_wallet_not_imported";
      logDebug("signer", "state_updated", {
        signerMode: ctx.signerMode,
        signerStatus: ctx.signerStatus,
        vaultPresent: Boolean(vault),
      });
      return;
    }

    if (Buffer.isBuffer(ctx.signerSessionSecretKey)) {
      ctx.signerReady = true;
      ctx.signerLocked = false;
      ctx.signerStatus = "app_wallet_unlocked";
    } else {
      ctx.signerReady = false;
      ctx.signerLocked = true;
      ctx.signerStatus = "app_wallet_locked";
    }

    logDebug("signer", "state_updated", {
      signerMode: ctx.signerMode,
      signerStatus: ctx.signerStatus,
      walletRef: ctx.signerConfig.walletRef || null,
      vaultFile: ctx.signerConfig.vaultFile || vaultFileRelative(),
    });
  }

  function modeSummary() {
    const walletAddress = normalizeWalletAddress(ctx.signerConfig?.walletAddress);
    const walletRef =
      typeof ctx.signerConfig?.walletRef === "string"
        ? ctx.signerConfig.walletRef
        : null;
    return `mode=${ctx.signerMode} status=${ctx.signerStatus} ready=${ctx.signerReady} locked=${ctx.signerLocked}${walletAddress ? ` wallet=${walletAddress}` : walletRef ? ` wallet=${walletRef}` : ""}`;
  }

  function logModeSelected(source = "startup") {
    updateSignerState();
    logWithTimestamp(`[SIGNER] ${modeSummary()}`);
    logDebug("signer", "mode_selected", {
      source,
      signerMode: ctx.signerMode,
      signerStatus: ctx.signerStatus,
      signerReady: ctx.signerReady,
      signerLocked: ctx.signerLocked,
      walletRef: ctx.signerConfig.walletRef || null,
    });
  }

  function setSignerMode(mode, source = "console") {
    ctx.signerMode = normalizeSignerMode(mode);
    ctx.config.signerMode = ctx.signerMode;
    updateSignerState();
    if (ctx.signerMode === "app_wallet") {
      logWithTimestamp(
        "[SIGNER] ⚠️ app_wallet mode is for a dedicated burner wallet only.",
      );
    }
    if (ctx.signerMode === "dapp") {
      logWithTimestamp(
        "[SIGNER] 🌐 dapp mode uses your browser wallet to sign prepared txs.",
      );
    }
    logWithTimestamp(`[SIGNER] mode set to ${ctx.signerMode} (${source})`);
    logDebug("signer", "mode_set", {
      source,
      signerMode: ctx.signerMode,
      signerStatus: ctx.signerStatus,
    });
  }

  function manualApprovalPrompt(actionLabel = "this tx") {
    return `Are you sure you want to approve ${actionLabel}? yes/no`;
  }

  function setManualApprovalHandler(handler) {
    approvalPromptHandler =
      typeof handler === "function" ? handler : null;
    logDebug("signer", "approval_handler_set", {
      active: Boolean(approvalPromptHandler),
    });
  }

  async function importFromFile(filePath) {
    const sourcePath = path.resolve(String(filePath || "").trim());
    logDebug("signer", "import_start", {
      signerMode: ctx.signerMode,
      sourcePath: redactPath(sourcePath),
    });

    if (ctx.signerMode !== "app_wallet") {
      throw new Error("Switch signer mode to app_wallet before importing.");
    }
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Import file not found: ${sourcePath}`);
    }

    const secretBytes = parseKeypairFile(sourcePath);
    const walletAddress = await walletAddressFromSecret(secretBytes);
    await persistSignerSecret({
      secretBytes,
      walletAddress,
      sourceType: "private_key_file",
      successVerb: "imported",
    });
  }

  async function importFromText(rawText, options = {}) {
    logDebug("signer", "import_paste_start", {
      signerMode: ctx.signerMode,
      source: "paste",
    });

    if (ctx.signerMode !== "app_wallet") {
      throw new Error("Switch signer mode to app_wallet before importing.");
    }

    const { secretBytes, walletAddress, derivationPath, sourceType } =
      await resolveImportSecret(rawText, options);
    await persistSignerSecret({
      secretBytes,
      walletAddress,
      derivationPath,
      sourceType,
      mnemonic: sourceType === "mnemonic" ? extractImportStringCandidate(rawText) : null,
      successVerb: "pasted",
    });
  }

  async function unlock() {
    logDebug("signer", "unlock_start", {
      signerMode: ctx.signerMode,
      signerStatus: ctx.signerStatus,
      walletRef: ctx.signerConfig.walletRef || null,
    });

    if (ctx.signerMode !== "app_wallet") {
      throw new Error("Unlock is only available in app_wallet mode.");
    }
    if (!ctx.signerConfig?.walletRef) {
      throw new Error("No app wallet found. Run 'signer create' or 'signer import'.");
    }
    const now = Date.now();
    if (ctx.signerUnlockAllowedAt > now) {
      const waitMs = ctx.signerUnlockAllowedAt - now;
      throw new Error(
        `Unlock temporarily blocked. Retry in ${Math.ceil(waitMs / 1000)}s.`,
      );
    }

    let vaultKey = null;
    let secretKey = null;
    try {
      const vault = loadVaultRecord();
      if (!vault) throw new Error("Encrypted signer vault is missing or unreadable.");
      vaultKey = await readVaultKeyFromSecureStorage();
      if (vaultKey.length !== VAULT_KEY_BYTES) {
        throw new Error("Vault key length is invalid.");
      }
      secretKey = decryptSecret(vault, vaultKey);
      ctx.signerSessionSecretKey = Buffer.from(secretKey);
      ctx.signerUnlockFailures = 0;
      ctx.signerUnlockAllowedAt = 0;
      updateSignerState();
      logWithTimestamp(
        `[SIGNER] 🔓 App wallet unlocked. wallet=${ctx.signerConfig.walletRef}`,
      );
      logDebug("signer", "unlock_ok", {
        walletRef: ctx.signerConfig.walletRef,
        keyLength: ctx.signerSessionSecretKey.length,
      });
    } catch (error) {
      clearSignerSessionSecretKey();
      ctx.signerUnlockFailures += 1;
      const backoffMs = Math.min(
        UNLOCK_BACKOFF_MAX_MS,
        UNLOCK_BACKOFF_BASE_MS * 2 ** Math.max(0, ctx.signerUnlockFailures - 1),
      );
      ctx.signerUnlockAllowedAt = Date.now() + backoffMs;
      updateSignerState();
      logDebug("signer", "unlock_failed", {
        error: error.message,
        failures: ctx.signerUnlockFailures,
        backoffMs,
      });
      throw new Error(
        `Unlock failed. Check ${secureStorageDisplayName()} and vault state. Retry in ${Math.ceil(backoffMs / 1000)}s.`,
      );
    } finally {
      if (vaultKey) vaultKey.fill(0);
      if (secretKey) secretKey.fill(0);
    }
  }

  function lock(source = "console") {
    const hadSecret = Buffer.isBuffer(ctx.signerSessionSecretKey);
    clearSignerSessionSecretKey();
    updateSignerState();
    logWithTimestamp(
      hadSecret
        ? `[SIGNER] 🔒 App wallet locked (${source}).`
        : `[SIGNER] ℹ️ App wallet already locked (${source}).`,
    );
    logDebug("signer", "lock", {
      source,
      hadSecret,
      walletRef: ctx.signerConfig.walletRef || null,
    });
  }

  async function doctor() {
    const vault = loadVaultRecord();
    const provider = secureStorageProvider();
    const keyStoreFile =
      provider === "windows_dpapi" ? keyStoreFileRelative() : null;
    const diagnostics = {
      platform: process.platform,
      signerMode: ctx.signerMode,
      signerStatus: ctx.signerStatus,
      signerReady: ctx.signerReady,
      signerLocked: ctx.signerLocked,
      walletRef: ctx.signerConfig.walletRef || null,
      secureStorageProvider: provider,
      secureStorageDisplayName: secureStorageDisplayName(),
      vaultFile: vaultFileRelative(),
      vaultExists: Boolean(vault),
      keyStoreFile,
      keyStoreFileExists: keyStoreFile
        ? fs.existsSync(keyStoreFileAbsolute())
        : null,
      secureStorageToolAvailable:
        provider === "macos_keychain"
          ? fs.existsSync("/usr/bin/security")
          : provider === "windows_dpapi"
            ? await checkCommandAvailable("powershell", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"])
            : provider === "linux_secret_service"
              ? await checkCommandAvailable("secret-tool", ["--help"])
              : false,
      vaultVersion: vault?.version ?? null,
      vaultAlgorithm: vault?.algorithm ?? null,
      unlockFailures: ctx.signerUnlockFailures || 0,
      unlockBlocked: Number(ctx.signerUnlockAllowedAt || 0) > Date.now(),
      signerEnabled: signerEnabled(),
      replayWindowSeconds: replayWindowSeconds(),
      auditFile: auditFileRelative(),
    };

    logDebug("signer", "doctor", diagnostics);
    logWithTimestamp(
      `[SIGNER] doctor platform=${diagnostics.platform} provider=${diagnostics.secureStorageProvider} tool=${diagnostics.secureStorageToolAvailable ? "ok" : "missing"} vault=${diagnostics.vaultExists ? "present" : "missing"} locked=${diagnostics.signerLocked}`,
    );
    if (!diagnostics.secureStorageToolAvailable) {
      logWithTimestamp(
        `[SIGNER] ❌ Required secure-storage backend is unavailable: ${diagnostics.secureStorageDisplayName()}`,
      );
    }
    return diagnostics;
  }

  async function replaceImportFromFile(filePath) {
    clearSignerSessionSecretKey();
    await importFromFile(filePath);
  }

  async function createGeneratedWallet() {
    logDebug("signer", "create_wallet_start", {
      signerMode: ctx.signerMode,
      walletRef: ctx.signerConfig?.walletRef || null,
    });
    if (ctx.signerMode !== "app_wallet") {
      throw new Error("Switch signer mode to app_wallet before creating a wallet.");
    }
    const mnemonic = bip39.generateMnemonic(128);
    const candidates = await deriveMnemonicCandidates(mnemonic);
    const created = candidates.find(
      (entry) => entry.derivationPath === DEFAULT_MNEMONIC_DERIVATION_PATH,
    );
    if (!created) {
      throw new Error("Failed to derive the generated app wallet.");
    }
    const persisted = await persistSignerSecret({
      secretBytes: created.secretBytes,
      walletAddress: created.walletAddress,
      derivationPath: created.derivationPath,
      sourceType: "generated",
      mnemonic,
      successVerb: "created",
    });
    return {
      walletAddress: persisted.walletAddress,
      derivationPath: persisted.derivationPath,
      mnemonic,
    };
  }

  async function revealWalletBackup() {
    if (!ctx.signerConfig?.walletRef) {
      throw new Error("No app wallet found. Create or import one first.");
    }
    const vault = loadVaultRecord();
    if (!vault) throw new Error("Encrypted signer vault is missing or unreadable.");
    let vaultKey = null;
    try {
      vaultKey = await readVaultKeyFromSecureStorage();
      const mnemonic =
        vault.mnemonicBackup && typeof vault.mnemonicBackup === "object"
          ? decryptUtf8(vault.mnemonicBackup, vaultKey)
          : null;
      return {
        walletAddress: normalizeWalletAddress(ctx.signerConfig?.walletAddress) || null,
        derivationPath:
          typeof ctx.signerConfig?.derivationPath === "string"
            ? ctx.signerConfig.derivationPath
            : null,
        sourceType:
          typeof ctx.signerConfig?.importSourceType === "string"
            ? ctx.signerConfig.importSourceType
            : null,
        hasRecoveryPhraseBackupFlag:
          ctx.signerConfig?.hasRecoveryPhraseBackup === true,
        hasMnemonicBackupInVault: Boolean(
          vault.mnemonicBackup && typeof vault.mnemonicBackup === "object",
        ),
        mnemonic,
      };
    } finally {
      if (vaultKey) vaultKey.fill(0);
    }
  }

  async function removeImportedWallet() {
    logDebug("signer", "remove_start", {
      walletRef: ctx.signerConfig?.walletRef || null,
      vaultFile: ctx.signerConfig?.vaultFile || vaultFileRelative(),
    });
    clearSignerSessionSecretKey();
    try {
      await deleteVaultKeyFromSecureStorage();
      try {
        fs.unlinkSync(vaultFileAbsolute());
      } catch (error) {
        if (error && error.code !== "ENOENT") throw error;
      }
      const nextSignerConfig = {
        ...(ctx.config.signer || {}),
      };
      delete nextSignerConfig.walletRef;
      delete nextSignerConfig.walletAddress;
      delete nextSignerConfig.derivationPath;
      delete nextSignerConfig.importSourceType;
      delete nextSignerConfig.hasRecoveryPhraseBackup;
      delete nextSignerConfig.vaultVersion;
      delete nextSignerConfig.algorithm;
      delete nextSignerConfig.importedAt;
      delete nextSignerConfig.keyStoreProvider;
      delete nextSignerConfig.keyStoreService;
      delete nextSignerConfig.keyStoreAccount;
      delete nextSignerConfig.keyStoreFile;
      delete nextSignerConfig.allowedActions;
      ctx.config.signer = nextSignerConfig;
      ctx.signerConfig = nextSignerConfig;
      updateSignerState();
      logWithTimestamp("[SIGNER] ✅ Imported app wallet removed.");
      logDebug("signer", "remove_ok", {
        vaultFile: ctx.signerConfig?.vaultFile || vaultFileRelative(),
      });
    } catch (error) {
      logDebug("signer", "remove_failed", {
        error: error.message,
      });
      throw error;
    }
  }

  function ensureMissionActionSupported(actionName) {
    const action = normalizeActionName(actionName);
    const actionSupported = SUPPORTED_MISSION_ACTIONS.has(action);
    logDebug("signer", "ensure_action_supported", {
      action,
      actionSupported,
      signerMode: ctx.signerMode,
      signerStatus: ctx.signerStatus,
    });

    if (!actionSupported) {
      throw new Error(`Unsupported signer action: ${action}`);
    }
    assertSignerEnabled(action);
    const allowedActions = Array.isArray(ctx.signerConfig?.allowedActions)
      ? ctx.signerConfig.allowedActions.map(normalizeActionName)
      : [];
    if (allowedActions.length > 0 && !allowedActions.includes(action)) {
      throw new Error(`Signer action is not allowed: ${action}`);
    }
    if (ctx.signerMode === "manual") {
      throw new Error(
        "manual mode selected. Open the missions page and reset it yourself.",
      );
    }
    if (ctx.signerMode === "dapp") {
      return;
    }
    if (ctx.signerMode !== "app_wallet") {
      throw new Error(`Unsupported signer mode: ${ctx.signerMode}`);
    }
    if (!ctx.signerConfig?.walletRef) {
      throw new Error("No app wallet found. Run 'signer create' or 'signer import'.");
    }
  }

  function validatePreparedMissionActionPayload(actionName, result, expected = {}) {
    const expectedSignerAddress =
      ctx.signerMode === "dapp"
        ? String(ctx.currentUserWalletId || "").trim() || null
        : String(ctx.signerConfig?.walletAddress || "").trim() ||
          String(ctx.currentUserWalletId || "").trim() ||
          null;
    logDebug("signer", "validate_prepared_action_start", {
      actionName,
      prepareTool: result?.structuredContent ? "present" : "missing",
      expected,
      currentWalletId: ctx.currentUserWalletId || null,
      expectedSignerAddress,
    });
    const validated = validatePreparedMissionAction({
      actionName,
      result,
      expected,
      currentWalletId: ctx.currentUserWalletId || null,
      expectedSignerAddress,
    });
    logDebug("signer", "validate_prepared_action_ok", {
      actionName,
      submitTool: validated.submitTool,
      signerAddresses: validated.decode.signerAddresses,
      expectedSignerAddress: validated.decode.expectedSignerAddress,
      signerMatchesExpectation: validated.decode.signerMatchesExpectation,
      version: validated.decode.version,
      instructionCount: validated.decode.instructionCount,
      cost: validated.cost,
      tokenPreview: validated.tokenPreview,
    });
    return validated;
  }

  async function createUnlockedKeyPairSigner() {
    if (!Buffer.isBuffer(ctx.signerSessionSecretKey)) {
      throw new Error("Signer session secret is unavailable.");
    }
    const signerBytes = Uint8Array.from(ctx.signerSessionSecretKey);
    try {
      if (signerBytes.byteLength === 64) {
        return await createKeyPairSignerFromBytes(signerBytes, false);
      }
      if (signerBytes.byteLength === 32) {
        return await createKeyPairSignerFromPrivateKeyBytes(signerBytes, false);
      }
      throw new Error(
        `Unlocked signer secret length is invalid: ${signerBytes.byteLength}`,
      );
    } finally {
      signerBytes.fill(0);
    }
  }

  async function requestManualApproval(actionName, validated) {
    if (typeof approvalPromptHandler !== "function") {
      throw new Error(
        "Manual signer approval handler is not configured. Signing is blocked.",
      );
    }
    const actionLabel =
      actionName === "nft_cooldown_reset"
        ? "this NFT cooldown reset tx"
        : actionName === "mission_reroll"
        ? "this mission reroll tx"
        : actionName === "mission_swap"
          ? "this mission swap tx"
          : actionName === "mission_slot_unlock"
            ? "this mission slot unlock tx"
            : "this tx";
    const approved = await approvalPromptHandler({
      actionName,
      prompt: manualApprovalPrompt(actionLabel),
      summary: {
        actionName,
        submitTool: validated.submitTool,
        identifiers: validated.identifiers,
        cost: validated.cost,
        tokenPreview: validated.tokenPreview,
        transactionEncoding: validated.decode.transactionEncoding,
        instructionCount: validated.decode.instructionCount,
      },
    });
    const ok = approved === true;
    logDebug("signer", "manual_approval_result", {
      actionName,
      approved: ok,
      submitTool: validated.submitTool,
      tokenPreview: validated.tokenPreview,
    });
    if (!ok) {
      logWithTimestamp(
        `[SIGNER] ❌ Manual approval rejected for ${actionName}.`,
      );
      throw new Error("Manual approval rejected.");
    }
    logWithTimestamp(
      `[SIGNER] ✅ Manual approval accepted for ${actionName}.`,
    );
  }

  async function signPreparedMissionActionPayload(
    actionName,
    result,
    expected = {},
  ) {
    const normalizedAction = normalizeActionName(actionName);
    ensureMissionActionSupported(normalizedAction);
    const validated = validatePreparedMissionActionPayload(
      normalizedAction,
      result,
      expected,
    );

    if (ctx.signerMode === "dapp") {
      const directBridgeUrl = getBrowserBridgeUrl(validated.structuredContent);
      if (!directBridgeUrl) {
        const keys = Object.keys(validated.structuredContent || {}).slice(0, 40);
        logDebug("dapp", "signing_url_missing", {
          actionName: normalizedAction,
          topLevelKeys: keys,
          signingMode: validated.structuredContent?.signingMode || null,
        });
        throw new Error(
          `dapp mode requires prepare payload bridge fields for ${normalizedAction} (expected signingBridgeUrl/signingBridgePath/signingUrl). keys=${keys.join(",")}`,
        );
      }
      const targetUrl = directBridgeUrl;
      logWithTimestamp(
        `[DAPP] 🌐 Opening PbP signing page for ${normalizedAction}...`,
      );
      const openResult = await openMissionPlayPage({
        cooldownMs: missionPageCooldownMsFromConfig(ctx),
        targetUrl,
      });
      if (openResult?.suppressed) {
        logDebug("dapp", "mission_page_open_suppressed", {
          actionName: normalizedAction,
          cooldownMs:
            openResult?.cooldownMs ?? MISSION_PAGE_OPEN_COOLDOWN_MS_DEFAULT,
          nextAllowedInMs: openResult?.nextAllowedInMs ?? null,
        });
      }
      if (!openResult?.ok) {
        logWithTimestamp("[DAPP] ❌ Failed to open browser automatically.");
      }
      logWithTimestamp(`[DAPP] Open manually: ${targetUrl}`);
      appendAudit("dapp_sign_opened", {
        actionName: normalizedAction,
        submitTool: validated.submitTool,
        cost: validated.cost,
        tokenPreview: validated.tokenPreview,
        identifiers: validated.identifiers,
        signingUrl: targetUrl,
      });
      return {
        ok: true,
        actionName: normalizedAction,
        submitTool: null,
        submitArgs: null,
        tokenField: validated.tokenField,
        tokenPreview: validated.tokenPreview,
        identifiers: validated.identifiers,
        cost: validated.cost,
        signingUrl: targetUrl,
      };
    }

    const nowMs = Date.now();
    assertActionCooldown(normalizedAction, nowMs);
    assertActionCostBound(normalizedAction, validated);
    assertFundingAffordable(normalizedAction, validated);
    const replayFingerprint = assertReplayAllowed(
      normalizedAction,
      validated,
      nowMs,
    );
    appendAudit("sign_prepare_validated", {
      actionName: normalizedAction,
      submitTool: validated.submitTool,
      cost: validated.cost,
      tokenPreview: validated.tokenPreview,
      identifiers: validated.identifiers,
      replayFingerprint: replayFingerprint.slice(0, 16),
    });
    let signer = null;
    let unlockedForSign = false;
    try {
      if (
        ctx.signerMode === "app_wallet" &&
        (ctx.signerLocked ||
          !ctx.signerReady ||
          !Buffer.isBuffer(ctx.signerSessionSecretKey))
      ) {
        await unlock();
        unlockedForSign = true;
      }
      if (validated.decode.signerMatchesExpectation === false) {
        logWithTimestamp(
          `[SIGNER] ⚠️ Prepared tx signer mismatch for ${normalizedAction}: tx requires ${validated.decode.signerAddresses.join(", ")} but app wallet is ${validated.decode.expectedSignerAddress}. Attempting sign anyway for diagnostics.`,
        );
      }
      logDebug("signer", "sign_start", {
        actionName: normalizedAction,
        submitTool: validated.submitTool,
        identifiers: validated.identifiers,
        cost: validated.cost,
        tokenPreview: validated.tokenPreview,
        txSignerAddresses: validated.decode.signerAddresses,
        expectedSignerAddress: validated.decode.expectedSignerAddress,
        signerMatchesExpectation: validated.decode.signerMatchesExpectation,
      });
      signer = await createUnlockedKeyPairSigner();
      const decoded = decodePreparedTransaction(validated.structuredContent.transaction);
      const signedTransaction = await signTransactionWithSigners(
        [signer],
        decoded.decodedTransaction,
      );
      const encodedSignedTransaction =
        getBase58EncodedWireTransaction(signedTransaction);
      const submitArgs = {
        [validated.tokenField]: validated.structuredContent[validated.tokenField],
        encodedSignedTransaction,
      };
      markSignedAction(normalizedAction, replayFingerprint, nowMs);
      logWithTimestamp(
        `[SIGNER] ✅ Signed ${normalizedAction}. submitTool=${validated.submitTool}`,
      );
      appendAudit("sign_ok", {
        actionName: normalizedAction,
        submitTool: validated.submitTool,
        cost: validated.cost,
        tokenPreview: validated.tokenPreview,
        identifiers: validated.identifiers,
        replayFingerprint: replayFingerprint.slice(0, 16),
      });
      logDebug("signer", "sign_ok", {
        actionName: normalizedAction,
        submitTool: validated.submitTool,
        identifiers: validated.identifiers,
        cost: validated.cost,
        tokenPreview: validated.tokenPreview,
        encodedSignedTransactionLength: encodedSignedTransaction.length,
      });
      return {
        ok: true,
        actionName: normalizedAction,
        submitTool: validated.submitTool,
        submitArgs,
        tokenField: validated.tokenField,
        tokenPreview: validated.tokenPreview,
        identifiers: validated.identifiers,
        cost: validated.cost,
      };
    } catch (error) {
      appendAudit("sign_failed", {
        actionName: normalizedAction,
        error: error.message,
        expected,
      });
      logWithTimestamp(
        `[SIGNER] ❌ Sign failed for ${normalizedAction}: ${error.message}`,
      );
      logDebug("signer", "sign_failed", {
        actionName: normalizedAction,
        error: error.message,
        expected,
      });
      throw error;
    } finally {
      if (ctx.signerMode === "app_wallet" && ctx.signerReady && !ctx.signerLocked) {
        lock("post_sign");
      } else if (ctx.signerMode === "app_wallet" && unlockedForSign) {
        clearSignerSessionSecretKey();
        updateSignerState();
      }
    }
  }

  function shutdown() {
    clearSignerSessionSecretKey();
    updateSignerState();
    logDebug("signer", "shutdown", {
      signerMode: ctx.signerMode,
      signerStatus: ctx.signerStatus,
    });
  }

  updateSignerState();

  return {
    manualApprovalPrompt,
    updateSignerState,
    modeSummary,
    logModeSelected,
    setSignerMode,
    setManualApprovalHandler,
    createGeneratedWallet,
    importFromFile,
    replaceImportFromFile,
    importFromText,
    looksLikeRecoveryPhrase,
    revealWalletBackup,
    removeImportedWallet,
    unlock,
    lock,
    doctor,
    shutdown,
    ensureMissionActionSupported,
    validatePreparedMissionActionPayload,
    signPreparedMissionActionPayload,
  };
}

module.exports = {
  createSignerService,
};
