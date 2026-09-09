"use strict";

const fs = require("fs");
const path = require("path");

const SNAPSHOT_VERSION = 1;
const SEARCH_INTERVAL_MS = 61_000;
const MAX_SNAPSHOT_CANDIDATES = 100;
const MAX_WORKING_QUEUE = 10;
const DEFAULT_ATTEMPTS_PER_WAKE = 3;
const DEFAULT_CONTINUATION_DELAY_SECONDS = 3;
const DEFAULT_READINESS_BUFFER_MS = 1_000;
const DEFAULT_BOUNDARY_RETRY_WINDOW_MS = 2_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

const SEARCH_ARGS = Object.freeze({
  hideCooldowned: false,
  showRented: false,
  showOwned: false,
  sortOrder: "cooldown_asc",
  pageSize: 100,
});

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function clampRentalAttemptsPerWake(value) {
  return clampInteger(value, DEFAULT_ATTEMPTS_PER_WAKE, 1, 5);
}

function clampContinuationDelaySeconds(value) {
  return clampInteger(value, DEFAULT_CONTINUATION_DELAY_SECONDS, 1, 30);
}

function hasOwn(value, key) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, key),
  );
}

function firstValue(sources, keys) {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of keys) {
      if (hasOwn(source, key) && source[key] !== undefined) return source[key];
    }
  }
  return undefined;
}

function usableId(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (["null", "undefined", "none", "false", "n/a"].includes(text.toLowerCase())) {
    return null;
  }
  return text;
}

function timestampMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  // Epoch seconds occasionally appear in APIs; explicit date strings and
  // millisecond epochs remain unchanged.
  return parsed > 0 && parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function candidateIdentity(candidate) {
  return `${candidate.listingId}\u0000${candidate.nftAccount}`;
}

function normalizeRentalCandidate(entry, options = {}) {
  if (!entry || typeof entry !== "object") return null;
  const snapshotAt = Number(options.snapshotAt || Date.now());
  const snapshotGeneration = Number(options.snapshotGeneration || 0);
  const nft = entry.nft || entry.nftData || entry;
  const cooldown = entry.cooldown || nft?.cooldown || null;
  const sources = [entry, nft, cooldown];
  const listingId = usableId(
    firstValue(sources, ["rentalListingId", "listingId", "listing_id"]),
  );
  const nftAccount = usableId(
    firstValue([nft, entry], [
      "account",
      "nftAccount",
      "nft_account",
      "tokenAddress",
      "token_address",
      "mintAddress",
      "mint_address",
      "mint",
    ]),
  );
  if (!listingId || !nftAccount) return null;

  const rentalStatus = String(
    firstValue(sources, ["rentalStatus", "rental_status", "status"]) || "",
  )
    .trim()
    .toLowerCase();
  if (/^(rented|leased|paused|expired|unavailable|inactive|closed|cancelled)$/.test(rentalStatus)) {
    return null;
  }
  if (
    firstValue(sources, ["paused", "isPaused", "expired", "isExpired"]) === true
  ) {
    return null;
  }
  const usesRaw = firstValue(sources, ["usesRemaining", "uses_remaining"]);
  const usesRemaining = usesRaw === undefined ? null : Number(usesRaw);
  if (Number.isFinite(usesRemaining) && usesRemaining <= 0) return null;

  const cooldownEndRaw = firstValue(sources, [
    "cooldownEndAt",
    "cooldown_end_at",
    "cooldownEndsAt",
    "cooldown_ends_at",
    "cooldownEndDate",
    "cooldown_end_date",
    "endsAt",
    "ends_at",
    "endAt",
    "end_at",
  ]);
  const cooldownEndAt = timestampMs(cooldownEndRaw);
  const explicitReady =
    firstValue(sources, ["ready", "isReady", "available", "isAvailable"]) ===
    true;
  const explicitCooldown = firstValue(sources, [
    "onCooldown",
    "on_cooldown",
    "cooldownActive",
    "cooldown_active",
  ]);
  const cooldownExplicitlyAbsent =
    explicitCooldown === false ||
    (hasOwn(entry, "cooldown") && entry.cooldown === null) ||
    (entry !== nft && hasOwn(nft, "cooldown") && nft.cooldown === null);

  let readyAt = null;
  let readinessSource = "unknown";
  if (explicitReady) {
    readyAt = snapshotAt;
    readinessSource = "explicit_ready";
  } else if (cooldownEndAt !== null) {
    readyAt = Math.max(snapshotAt, cooldownEndAt);
    readinessSource = "cooldown_end_at";
  } else if (cooldownExplicitlyAbsent) {
    readyAt = snapshotAt;
    readinessSource = "explicit_no_cooldown";
  }

  const levelRaw = firstValue([nft, entry], ["level"]);
  const nestedLevelRaw = firstValue([nft?.stats, entry?.stats], ["level"]);
  const nftLevelValue = levelRaw === undefined ? nestedLevelRaw : levelRaw;
  const nftLevel = Number.isFinite(Number(nftLevelValue))
    ? Number(nftLevelValue)
    : null;

  return {
    listingId,
    nftAccount,
    nftName:
      usableId(
        firstValue(
          [nft, entry, nft?.offChainMetadata?.metadata, nft?.DASMetadata],
          ["name"],
        ),
      ) || "Unknown NFT",
    nftLevel,
    rentalStatus: rentalStatus || null,
    rentalLeaseId:
      usableId(firstValue(sources, ["rentalLeaseId", "rental_lease_id"])) ||
      null,
    usesRemaining: Number.isFinite(usesRemaining) ? usesRemaining : null,
    listingExpiresAt: timestampMs(
      firstValue(sources, ["listingExpiresAt", "listing_expires_at"]),
    ),
    effectiveLeaseEndsAt: timestampMs(
      firstValue(sources, ["effectiveLeaseEndsAt", "effective_lease_ends_at"]),
    ),
    cooldownEndAt,
    readyAt,
    readinessSource,
    cooldownResetAttemptedGeneration: null,
    snapshotAt,
    snapshotGeneration,
    attemptCount: 0,
    lastAttemptAt: null,
    lastFailureCode: null,
    quarantinedUntil: null,
    inFlightMissionKey: null,
    inFlightAt: null,
    incompatibleMissionKeys: [],
    state: "available",
  };
}

function compareRentalCandidates(a, b, now = Date.now()) {
  const aDue = Number.isFinite(a.readyAt) && a.readyAt <= now;
  const bDue = Number.isFinite(b.readyAt) && b.readyAt <= now;
  if (aDue !== bDue) return aDue ? -1 : 1;
  const aReady = Number.isFinite(a.readyAt) ? a.readyAt : Infinity;
  const bReady = Number.isFinite(b.readyAt) ? b.readyAt : Infinity;
  if (aReady !== bReady) return aReady - bReady;
  const levelDifference = Number(b.nftLevel || 0) - Number(a.nftLevel || 0);
  if (levelDifference !== 0) return levelDifference;
  return (
    String(a.listingId).localeCompare(String(b.listingId)) ||
    String(a.nftAccount).localeCompare(String(b.nftAccount))
  );
}

function normalizeRentalSnapshot(entries, options = {}) {
  const snapshotAt = Number(options.snapshotAt || Date.now());
  const snapshotGeneration = Number(options.snapshotGeneration || 0);
  const byListing = new Set();
  const byAccount = new Set();
  const result = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const candidate = normalizeRentalCandidate(entry, {
      snapshotAt,
      snapshotGeneration,
    });
    if (!candidate) continue;
    if (byListing.has(candidate.listingId) || byAccount.has(candidate.nftAccount)) {
      continue;
    }
    byListing.add(candidate.listingId);
    byAccount.add(candidate.nftAccount);
    result.push(candidate);
    if (result.length >= MAX_SNAPSHOT_CANDIDATES) break;
  }
  return result.sort((a, b) => compareRentalCandidates(a, b, snapshotAt));
}

function candidateIsSelectable(candidate, options = {}) {
  if (!candidate || candidate.state !== "available") return false;
  const now = Number(options.now || Date.now());
  const missionKey = String(options.missionKey || "");
  if (candidate.inFlightMissionKey) return false;
  if (
    Number.isFinite(candidate.quarantinedUntil) &&
    candidate.quarantinedUntil > now
  ) {
    return false;
  }
  if (
    missionKey &&
    Array.isArray(candidate.incompatibleMissionKeys) &&
    candidate.incompatibleMissionKeys.includes(missionKey)
  ) {
    return false;
  }
  return true;
}

function rankRentalCandidates(candidates, options = {}) {
  const now = Number(options.now || Date.now());
  const limit = clampInteger(options.limit, MAX_WORKING_QUEUE, 1, MAX_WORKING_QUEUE);
  return (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidateIsSelectable(candidate, options))
    .sort((a, b) => compareRentalCandidates(a, b, now))
    .slice(0, limit);
}

function createEmptyState() {
  return {
    version: SNAPSHOT_VERSION,
    generation: 0,
    snapshotAt: 0,
    stale: true,
    lastSearchError: null,
    lastSearchErrorAt: null,
    search: {
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      nextAllowedAt: 0,
    },
    candidates: [],
    tombstones: [],
    worker: {
      continuationNotBefore: 0,
      continuationGeneration: 0,
      pausedGeneration: 0,
      assignmentRetryAt: 0,
      missionCursor: 0,
    },
  };
}

function sanitizePersistedState(input) {
  const empty = createEmptyState();
  if (!input || typeof input !== "object" || input.version !== SNAPSHOT_VERSION) {
    return empty;
  }
  const generation = Math.max(0, Math.floor(Number(input.generation || 0)));
  const snapshotAt = Math.max(0, Number(input.snapshotAt || 0));
  const seenListing = new Set();
  const seenAccount = new Set();
  const candidates = [];
  for (const raw of Array.isArray(input.candidates) ? input.candidates : []) {
    const listingId = usableId(raw?.listingId);
    const nftAccount = usableId(raw?.nftAccount);
    if (!listingId || !nftAccount) continue;
    if (seenListing.has(listingId) || seenAccount.has(nftAccount)) continue;
    const readyAt = raw.readyAt === null ? null : Number(raw.readyAt);
    const candidate = {
      ...raw,
      listingId,
      nftAccount,
      readyAt: Number.isFinite(readyAt) ? readyAt : null,
      snapshotAt: Number(raw.snapshotAt || snapshotAt || 0),
      snapshotGeneration: Number(raw.snapshotGeneration || generation),
      attemptCount: Math.max(0, Math.floor(Number(raw.attemptCount || 0))),
      lastAttemptAt: Number.isFinite(Number(raw.lastAttemptAt))
        ? Number(raw.lastAttemptAt)
        : null,
      cooldownResetAttemptedGeneration: Number.isFinite(
        Number(raw.cooldownResetAttemptedGeneration),
      )
        ? Number(raw.cooldownResetAttemptedGeneration)
        : null,
      quarantinedUntil: Number.isFinite(Number(raw.quarantinedUntil))
        ? Number(raw.quarantinedUntil)
        : null,
      incompatibleMissionKeys: Array.isArray(raw.incompatibleMissionKeys)
        ? [...new Set(raw.incompatibleMissionKeys.map(String))]
        : [],
      state: ["available", "removed", "ambiguous"].includes(raw.state)
        ? raw.state
        : "available",
    };
    seenListing.add(listingId);
    seenAccount.add(nftAccount);
    candidates.push(candidate);
    if (candidates.length >= MAX_SNAPSHOT_CANDIDATES) break;
  }
  return {
    ...empty,
    ...input,
    version: SNAPSHOT_VERSION,
    generation,
    snapshotAt,
    search: {
      ...empty.search,
      ...(input.search && typeof input.search === "object" ? input.search : {}),
    },
    worker: {
      ...empty.worker,
      ...(input.worker && typeof input.worker === "object" ? input.worker : {}),
    },
    candidates,
    tombstones: (Array.isArray(input.tombstones) ? input.tombstones : [])
      .filter((row) => usableId(row?.listingId) && usableId(row?.nftAccount))
      .slice(-MAX_SNAPSHOT_CANDIDATES),
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RentalSnapshotStore {
  constructor(snapshotPath, options = {}) {
    if (!snapshotPath) throw new Error("snapshotPath is required");
    this.snapshotPath = path.resolve(String(snapshotPath));
    this.lockPath = path.resolve(
      String(options.lockPath || `${this.snapshotPath}.lock`),
    );
    this.clock = options.clock || Date.now;
    // Lock age must use the filesystem's wall clock. The scheduler clock is
    // injectable and may intentionally be frozen or advanced in tests.
    this.lockClock = options.lockClock || Date.now;
    this.sleep = options.sleep || defaultSleep;
  }

  load() {
    try {
      return sanitizePersistedState(
        JSON.parse(fs.readFileSync(this.snapshotPath, "utf8")),
      );
    } catch {
      return createEmptyState();
    }
  }

  save(state) {
    const clean = sanitizePersistedState(state);
    fs.mkdirSync(path.dirname(this.snapshotPath), { recursive: true });
    const tempPath = `${this.snapshotPath}.${process.pid}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(clean, null, 2));
    fs.renameSync(tempPath, this.snapshotPath);
    return clean;
  }

  async withLock(callback, options = {}) {
    const startedAt = this.lockClock();
    const timeoutMs = Number(options.timeoutMs || LOCK_TIMEOUT_MS);
    let handle = null;
    let token = null;
    while (!handle) {
      try {
        fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
        handle = fs.openSync(this.lockPath, "wx");
        token = `${process.pid}:${this.lockClock()}:${Math.random()}`;
        fs.writeFileSync(handle, token);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const stat = fs.statSync(this.lockPath);
          if (this.lockClock() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch (statError) {
          if (statError?.code !== "ENOENT") throw statError;
        }
        if (this.lockClock() - startedAt >= timeoutMs) {
          throw new Error("Timed out acquiring rental snapshot lock");
        }
        await this.sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await callback();
    } finally {
      try {
        fs.closeSync(handle);
      } catch {}
      try {
        if (fs.readFileSync(this.lockPath, "utf8") === token) {
          fs.unlinkSync(this.lockPath);
        }
      } catch {}
    }
  }

  async transact(mutator) {
    return this.withLock(async () => {
      const current = this.load();
      const proposed = (await mutator(current)) || current;
      if (Number(proposed.generation || 0) < Number(current.generation || 0)) {
        throw new Error("Refusing stale rental snapshot generation write");
      }
      return this.save(proposed);
    });
  }
}

function errorText(error) {
  return String(
    error?.message || error?.error || error?.details?.message || error || "",
  ).trim();
}

function failureReadyAt(error) {
  return timestampMs(
    error?.readyAt ??
      error?.cooldownEndAt ??
      error?.cooldown_end_at ??
      error?.details?.readyAt ??
      error?.details?.cooldownEndAt ??
      error?.details?.cooldown_end_date,
  );
}

function classifyRentalAssignmentFailure(error, options = {}) {
  const message = errorText(error);
  const lower = message.toLowerCase();
  const now = Number(options.now || Date.now());
  const explicitKind = String(error?.kind || error?.code || "").toLowerCase();
  const readyAt = failureReadyAt(error);
  const retryAt = timestampMs(error?.retryAt ?? error?.details?.retryAt);
  const retryAfterSeconds = Number(
    error?.retryAfterSeconds ?? error?.details?.retryAfterSeconds,
  );
  const derivedRetryAt = Number.isFinite(retryAfterSeconds)
    ? now + Math.max(0, retryAfterSeconds) * 1000
    : null;

  if (
    error?.rateLimited === true ||
    explicitKind === "rate_limit" ||
    /rate limit|http 429|retry in \d+s/.test(lower)
  ) {
    return { code: "rate_limit", retryAt: retryAt || derivedRetryAt };
  }
  if (
    explicitKind === "auth" ||
    /unauthori[sz]ed|authentication|login required|token expired/.test(lower)
  ) {
    return { code: "auth" };
  }
  if (
    explicitKind === "network" ||
    error?.timeout === true ||
    /timed? out|timeout|socket|network|econnreset|fetch failed/.test(lower)
  ) {
    return { code: "network_ambiguous" };
  }
  if (/mission already has|mission is no longer active|no longer needs/.test(lower)) {
    return { code: "mission_filled" };
  }
  if (explicitKind === "cooldown_reset_unusable") {
    return { code: "cooldown_reset_unusable", readyAt };
  }
  if (/incompatible|not eligible|cannot be used for (?:this )?mission/.test(lower)) {
    return { code: "incompatible" };
  }
  if (/cooldown|not ready|too early/.test(lower) || explicitKind === "not_ready") {
    return readyAt === null
      ? { code: "not_ready_unknown", readyAt: null }
      : { code: "not_ready_timed", readyAt };
  }
  if (
    /listing.*(?:gone|missing|not found|leased|rented|paused|expired)|no uses|uses remaining.*0/.test(
      lower,
    )
  ) {
    return { code: "terminal" };
  }
  return { code: "unknown" };
}

function extractRentalRows(result) {
  const structured = result?.structuredContent || result || {};
  if (Array.isArray(structured.data)) return structured.data;
  if (Array.isArray(structured.nfts)) return structured.nfts;
  if (Array.isArray(structured.items)) return structured.items;
  if (Array.isArray(result)) return result;
  return [];
}

function missionKeyOf(mission, index = 0) {
  return String(
    mission?.missionKey ||
      mission?.assignedMissionId ||
      mission?.assigned_mission_id ||
      mission?.id ||
      mission?.slot ||
      `mission-${index}`,
  );
}

function budgetAdmission(result) {
  if (result === true || result === undefined || result === null) {
    return { admitted: true, nextAvailableAt: null, token: null, raw: result };
  }
  if (result === false) {
    return { admitted: false, nextAvailableAt: null, token: null, raw: result };
  }
  return {
    admitted: result.admitted !== false && result.ok !== false,
    nextAvailableAt: timestampMs(result.nextAvailableAt || result.retryAt),
    token: usableId(result.token || result.reservationToken),
    raw: result,
  };
}

class RentalCoordinator {
  constructor(options = {}) {
    for (const required of [
      "snapshotPath",
      "searchRentals",
      "getMissionsNeedingRental",
      "missionStillNeedsRental",
      "reserveAssignmentBudget",
      "assignCandidate",
    ]) {
      if (!options[required] && required !== "snapshotPath") {
        throw new Error(`${required} is required`);
      }
    }
    if (!options.snapshotPath) throw new Error("snapshotPath is required");
    this.clock = options.clock || Date.now;
    this.sleep = options.sleep || defaultSleep;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.log = options.log || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onScheduledWake = options.onScheduledWake || null;
    this.searchRentals = options.searchRentals;
    this.getMissionsNeedingRental = options.getMissionsNeedingRental;
    this.missionStillNeedsRental = options.missionStillNeedsRental;
    this.reserveAssignmentBudget = options.reserveAssignmentBudget;
    this.assignCandidate = options.assignCandidate;
    this.reconcileAmbiguous = options.reconcileAmbiguous || null;
    this.attemptsPerWake = clampRentalAttemptsPerWake(options.attemptsPerWake);
    this.continuationDelayMs =
      clampContinuationDelaySeconds(options.continuationDelaySeconds) * 1000;
    this.readinessBufferMs = Math.max(
      0,
      Number(options.readinessBufferMs ?? DEFAULT_READINESS_BUFFER_MS),
    );
    this.boundaryRetryWindowMs = Math.max(
      0,
      Number(options.boundaryRetryWindowMs ?? DEFAULT_BOUNDARY_RETRY_WINDOW_MS),
    );
    this.store =
      options.store ||
      new RentalSnapshotStore(options.snapshotPath, {
        lockPath: options.lockPath,
        clock: this.clock,
        sleep: this.sleep,
      });
    this.state = createEmptyState();
    this.demand = false;
    this.timer = null;
    this.timerAt = 0;
    this.searchInflight = null;
    this.workerInflight = null;
    this.closed = false;
  }

  load() {
    this.state = this.store.load();
    this._emit();
    return this.getSnapshot();
  }

  configure(options = {}) {
    if (options.attemptsPerWake !== undefined) {
      this.attemptsPerWake = clampRentalAttemptsPerWake(
        options.attemptsPerWake,
      );
    }
    if (options.continuationDelaySeconds !== undefined) {
      this.continuationDelayMs =
        clampContinuationDelaySeconds(options.continuationDelaySeconds) * 1000;
    }
    this.schedule();
    return {
      attemptsPerWake: this.attemptsPerWake,
      continuationDelaySeconds: this.continuationDelayMs / 1000,
    };
  }

  shutdown() {
    this.closed = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = 0;
  }

  getSnapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  getStatus() {
    const now = this.clock();
    const working = rankRentalCandidates(this.state.candidates, { now });
    return {
      generation: this.state.generation,
      snapshotAt: this.state.snapshotAt,
      stale: this.state.stale,
      lastSearchError: this.state.lastSearchError,
      lastAttemptAt: Number(this.state.search.lastAttemptAt || 0),
      lastSuccessAt: Number(this.state.search.lastSuccessAt || 0),
      nextAllowedAt: Number(this.state.search.nextAllowedAt || 0),
      candidateCount: this.state.candidates.filter((row) => row.state === "available")
        .length,
      readyCount: working.filter(
        (row) => Number.isFinite(row.readyAt) && row.readyAt <= now,
      ).length,
      coolingCount: this.state.candidates.filter(
        (row) => Number.isFinite(row.readyAt) && row.readyAt > now,
      ).length,
      unknownCount: this.state.candidates.filter((row) => row.readyAt === null)
        .length,
      workingQueue: working,
      nextWakeAt: this.timerAt || null,
      demand: this.demand,
    };
  }

  setDemand(needed, meta = {}) {
    this.demand = needed === true;
    this.log("demand", { needed: this.demand, reason: meta.reason || null });
    if (!this.demand && this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
      this.timerAt = 0;
    }
    if (this.demand) this.schedule();
  }

  handleResume() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = 0;
    return this.schedule();
  }

  async _commit(mutator) {
    this.state = await this.store.transact(mutator);
    this._emit();
    return this.state;
  }

  _emit() {
    try {
      this.onStateChange(this.getStatus());
    } catch {}
  }

  async requestSearch(options = {}) {
    if (this.searchInflight) return this.searchInflight;
    if (options.rentalsNeeded === false) {
      return { searched: false, reason: "not_needed", status: this.getStatus() };
    }
    this.searchInflight = this._requestSearch(options).finally(() => {
      this.searchInflight = null;
      this.schedule();
    });
    return this.searchInflight;
  }

  async _requestSearch(options) {
    const now = this.clock();
    let admitted = false;
    await this._commit((current) => {
      if (now < Number(current.search.nextAllowedAt || 0)) return current;
      admitted = true;
      return {
        ...current,
        search: {
          ...current.search,
          lastAttemptAt: now,
          nextAllowedAt: Math.max(
            Number(current.search.nextAllowedAt || 0),
            now + SEARCH_INTERVAL_MS,
          ),
        },
      };
    });
    if (!admitted) {
      return {
        searched: false,
        reason: "cooldown",
        nextAllowedAt: this.state.search.nextAllowedAt,
      };
    }

    try {
      const result = await this.searchRentals({ ...SEARCH_ARGS });
      const rows = extractRentalRows(result);
      const completedAt = this.clock();
      await this._commit((current) => {
        const nextGeneration = Number(current.generation || 0) + 1;
        const tombstones = (current.tombstones || []).filter(
          (row) => Number(row.suppressThroughGeneration || 0) >= nextGeneration,
        );
        const suppressed = new Set(
          tombstones.map((row) => `${row.listingId}\u0000${row.nftAccount}`),
        );
        const fresh = normalizeRentalSnapshot(rows, {
          snapshotAt: completedAt,
          snapshotGeneration: nextGeneration,
        }).filter((candidate) => !suppressed.has(candidateIdentity(candidate)));
        // A fresh rental page cannot prove whether an assignment whose result
        // is still in flight or ambiguous succeeded. Preserve those
        // reservations until authoritative mission reconciliation resolves
        // them, even if the listing appears again in the search response.
        const unresolved = current.candidates.filter(
          (candidate) =>
            candidate.state === "ambiguous" || candidate.inFlightMissionKey,
        );
        const unresolvedIdentities = new Set(unresolved.map(candidateIdentity));
        const reconciled = [
          ...unresolved,
          ...fresh.filter(
            (candidate) => !unresolvedIdentities.has(candidateIdentity(candidate)),
          ),
        ];
        return {
          ...current,
          generation: nextGeneration,
          snapshotAt: completedAt,
          stale: false,
          lastSearchError: null,
          lastSearchErrorAt: null,
          candidates: reconciled.slice(0, MAX_SNAPSHOT_CANDIDATES),
          tombstones,
          search: {
            ...current.search,
            lastSuccessAt: completedAt,
          },
        };
      });
      this.log("search_success", { count: this.state.candidates.length });
      return { searched: true, count: this.state.candidates.length };
    } catch (error) {
      const failure = classifyRentalAssignmentFailure(error, { now: this.clock() });
      await this._commit((current) => ({
        ...current,
        stale: true,
        lastSearchError: errorText(error) || "rental search failed",
        lastSearchErrorAt: this.clock(),
        search: {
          ...current.search,
          nextAllowedAt: Math.max(
            Number(current.search.nextAllowedAt || 0),
            Number(failure.retryAt || error?.retryAt || 0),
          ),
        },
      }));
      this.log("search_failed", { error: errorText(error) });
      return { searched: true, ok: false, error, nextAllowedAt: this.state.search.nextAllowedAt };
    }
  }

  _candidateForMission(
    missionKey,
    attemptedIdentities,
    now,
    { allowCoolingReset = false } = {},
  ) {
    return rankRentalCandidates(this.state.candidates, {
      now,
      missionKey,
      limit: MAX_WORKING_QUEUE,
    }).find(
      (candidate) =>
        Number.isFinite(candidate.readyAt) &&
        (candidate.readyAt <= now ||
          (allowCoolingReset &&
            candidate.readyAt > now &&
            Number(candidate.cooldownResetAttemptedGeneration) !==
              Number(this.state.generation))) &&
        !attemptedIdentities.has(candidateIdentity(candidate)),
    );
  }

  async _reserveCandidate(candidate, missionKey) {
    let reserved = null;
    await this._commit((current) => {
      const index = current.candidates.findIndex(
        (row) => candidateIdentity(row) === candidateIdentity(candidate),
      );
      if (index < 0) return current;
      const found = current.candidates[index];
      if (!candidateIsSelectable(found, { now: this.clock(), missionKey })) {
        return current;
      }
      const candidates = current.candidates.slice();
      reserved = {
        ...found,
        inFlightMissionKey: missionKey,
        inFlightAt: this.clock(),
        attemptCount: Number(found.attemptCount || 0) + 1,
        lastAttemptAt: this.clock(),
      };
      candidates[index] = reserved;
      return { ...current, candidates };
    });
    return reserved;
  }

  async _releaseWithFailure(candidate, missionKey, failure) {
    await this._commit((current) => {
      const index = current.candidates.findIndex(
        (row) => candidateIdentity(row) === candidateIdentity(candidate),
      );
      if (index < 0) return current;
      const found = current.candidates[index];
      const candidates = current.candidates.slice();
      const next = {
        ...found,
        inFlightMissionKey: null,
        inFlightAt: null,
        lastFailureCode: failure.code,
      };
      if (failure.code === "terminal" || failure.code === "unknown") {
        next.state = "removed";
      } else if (failure.code === "incompatible") {
        next.incompatibleMissionKeys = [
          ...new Set([...(next.incompatibleMissionKeys || []), missionKey]),
        ];
      } else if (failure.code === "not_ready_timed") {
        next.readyAt = Number(failure.readyAt) + this.readinessBufferMs;
        next.cooldownEndAt = Number(failure.readyAt);
        next.readinessSource = "assignment_response";
      } else if (failure.code === "cooldown_reset_unusable") {
        if (Number.isFinite(Number(failure.readyAt))) {
          next.readyAt = Number(failure.readyAt);
          next.cooldownEndAt = Number(failure.readyAt);
        }
        next.cooldownResetAttemptedGeneration = Number(current.generation || 0);
      } else if (failure.code === "not_ready_unknown") {
        next.readyAt = null;
        next.readinessSource = "assignment_unknown";
      } else if (failure.code === "network_ambiguous") {
        next.state = "ambiguous";
        next.inFlightMissionKey = missionKey;
        next.inFlightAt = found.inFlightAt || this.clock();
      }
      if (failure.cooldownResetSucceeded === true) {
        next.readyAt = this.clock();
        next.cooldownEndAt = null;
        next.readinessSource = "cooldown_reset_succeeded";
        next.cooldownResetAttemptedGeneration = Number(current.generation || 0);
      }
      candidates[index] = next;
      return {
        ...current,
        candidates,
        worker:
          failure.code === "rate_limit" || failure.code === "auth"
            ? {
                ...current.worker,
                assignmentRetryAt: Math.max(
                  Number(current.worker.assignmentRetryAt || 0),
                  Number(
                    failure.retryAt ||
                      (failure.code === "auth"
                        ? this.clock() + SEARCH_INTERVAL_MS
                        : 0),
                  ),
                ),
              }
            : current.worker,
      };
    });
  }

  async _releaseReservation(candidate) {
    await this._commit((current) => ({
      ...current,
      candidates: current.candidates.map((row) =>
        candidateIdentity(row) === candidateIdentity(candidate) &&
        row.state === "available"
          ? {
              ...row,
              inFlightMissionKey: null,
              inFlightAt: null,
            }
          : row,
      ),
    }));
  }

  async _consumeCandidate(candidate) {
    await this._commit((current) => {
      const identity = candidateIdentity(candidate);
      const candidates = current.candidates.filter(
        (row) => candidateIdentity(row) !== identity,
      );
      const tombstones = [
        ...(current.tombstones || []).filter(
          (row) => `${row.listingId}\u0000${row.nftAccount}` !== identity,
        ),
        {
          listingId: candidate.listingId,
          nftAccount: candidate.nftAccount,
          consumedAt: this.clock(),
          suppressThroughGeneration: Number(current.generation || 0) + 1,
        },
      ].slice(-MAX_SNAPSHOT_CANDIDATES);
      return { ...current, candidates, tombstones };
    });
  }

  async runAssignmentWorker(options = {}) {
    if (this.workerInflight) return this.workerInflight;
    this.workerInflight = this._runAssignmentWorker(options).finally(() => {
      this.workerInflight = null;
      this.schedule();
    });
    return this.workerInflight;
  }

  async _runAssignmentWorker(options) {
    const nowAtStart = this.clock();
    const allowCoolingReset = options.allowCoolingReset === true;
    if (
      allowCoolingReset &&
      (this.state.stale === true ||
        !Number(this.state.snapshotAt || 0) ||
        nowAtStart - Number(this.state.snapshotAt || 0) >= SEARCH_INTERVAL_MS)
    ) {
      return {
        attemptedDistinct: 0,
        dispatches: 0,
        successes: 0,
        reason: "cooldown_reset_snapshot_stale",
      };
    }
    if (
      !allowCoolingReset &&
      Number(this.state.worker.pausedGeneration || 0) ===
        Number(this.state.generation || 0) &&
      Number(this.state.generation || 0) > 0
    ) {
      return { attemptedDistinct: 0, dispatches: 0, reason: "snapshot_batch_complete" };
    }
    if (nowAtStart < Number(this.state.worker.assignmentRetryAt || 0)) {
      return { attemptedDistinct: 0, dispatches: 0, reason: "assignment_backoff" };
    }
    if (nowAtStart < Number(this.state.worker.continuationNotBefore || 0)) {
      return { attemptedDistinct: 0, dispatches: 0, reason: "continuation_wait" };
    }
    const suppliedMissions = Array.isArray(options.missions) ? options.missions : null;
    let missions = suppliedMissions || (await this.getMissionsNeedingRental());
    missions = Array.isArray(missions) ? missions.slice() : [];
    if (missions.length === 0) return { attemptedDistinct: 0, dispatches: 0, reason: "no_demand" };

    const attemptedIdentities = new Set();
    let dispatches = 0;
    let successes = 0;
    let extraBoundaryRetryUsed = false;
    let cursor = Math.max(0, Number(this.state.worker.missionCursor || 0)) % missions.length;
    let stopReason = null;
    let guard = 0;

    // Paid cooldown fallback walks the same bounded cached working set as the
    // ready-rental worker. If the cheapest/earliest reset is unusable or over
    // the configured max, continue to the next cached rental without issuing
    // another search.
    const attemptLimit = this.attemptsPerWake;
    while (attemptedIdentities.size < attemptLimit && guard < 100) {
      guard += 1;
      let selection = null;
      for (let offset = 0; offset < missions.length; offset += 1) {
        const index = (cursor + offset) % missions.length;
        const mission = missions[index];
        const missionKey = missionKeyOf(mission, index);
        if (!(await this.missionStillNeedsRental(missionKey, mission))) continue;
        const candidate = this._candidateForMission(
          missionKey,
          attemptedIdentities,
          this.clock(),
          { allowCoolingReset },
        );
        if (candidate) {
          selection = { mission, missionKey, candidate, index };
          break;
        }
      }
      if (!selection) {
        stopReason = "no_due_candidate";
        break;
      }
      cursor = (selection.index + 1) % missions.length;
      const identity = candidateIdentity(selection.candidate);
      const reserved = await this._reserveCandidate(
        selection.candidate,
        selection.missionKey,
      );
      if (!reserved) continue;
      let capacity;
      try {
        capacity = budgetAdmission(
          await this.reserveAssignmentBudget({
            toolName: "assign_nft_to_mission",
            source: "rental",
            missionKey: selection.missionKey,
            listingId: selection.candidate.listingId,
          }),
        );
      } catch (error) {
        await this._releaseReservation(reserved);
        throw error;
      }
      if (!capacity.admitted) {
        await this._releaseReservation(reserved);
        stopReason = "shared_budget";
        if (capacity.nextAvailableAt) {
          await this._commit((current) => ({
            ...current,
            worker: {
              ...current.worker,
              assignmentRetryAt: Math.max(
                Number(current.worker.assignmentRetryAt || 0),
                capacity.nextAvailableAt,
              ),
            },
          }));
        }
        break;
      }
      attemptedIdentities.add(identity);
      dispatches += 1;

      let result;
      let failure = null;
      const cooldownResetRequested =
        allowCoolingReset &&
        Number.isFinite(selection.candidate.readyAt) &&
        selection.candidate.readyAt > this.clock();
      try {
        result = await this.assignCandidate({
          mission: selection.mission,
          missionKey: selection.missionKey,
          candidate: {
            ...reserved,
            cooldownResetRequested,
          },
          boundaryRetry: false,
          assignmentBudgetReservation: capacity.raw,
          assignmentBudgetToken: capacity.token,
        });
        if (result?.success === false) {
          failure = classifyRentalAssignmentFailure(result, { now: this.clock() });
          failure.cooldownResetSucceeded =
            result?.cooldownResetSucceeded === true;
        }
      } catch (error) {
        failure = classifyRentalAssignmentFailure(error, { now: this.clock() });
        failure.cooldownResetSucceeded =
          error?.cooldownResetSucceeded === true;
        result = { error };
      }

      if (!failure) {
        successes += 1;
        await this._consumeCandidate(reserved);
        continue;
      }

      const boundaryDelay =
        failure.code === "not_ready_timed" && Number.isFinite(failure.readyAt)
          ? failure.readyAt + this.readinessBufferMs - this.clock()
          : Infinity;
      const qualifiesForBoundaryRetry =
        !extraBoundaryRetryUsed &&
        boundaryDelay >= 0 &&
        boundaryDelay <= this.boundaryRetryWindowMs;

      if (qualifiesForBoundaryRetry) {
        await this._releaseWithFailure(reserved, selection.missionKey, failure);
        await this.sleep(boundaryDelay);
        if (await this.missionStillNeedsRental(selection.missionKey, selection.mission)) {
          const currentCandidate = this.state.candidates.find(
            (row) => candidateIdentity(row) === identity,
          );
          const retryReserved = currentCandidate
            ? await this._reserveCandidate(currentCandidate, selection.missionKey)
            : null;
          if (retryReserved) {
            let retryCapacity;
            try {
              retryCapacity = budgetAdmission(
                await this.reserveAssignmentBudget({
                  toolName: "assign_nft_to_mission",
                  source: "rental_boundary_retry",
                  missionKey: selection.missionKey,
                  listingId: reserved.listingId,
                }),
              );
            } catch (error) {
              await this._releaseReservation(retryReserved);
              throw error;
            }
            if (retryCapacity.admitted) {
              extraBoundaryRetryUsed = true;
              dispatches += 1;
              try {
                const retryResult = await this.assignCandidate({
                  mission: selection.mission,
                  missionKey: selection.missionKey,
                  candidate: retryReserved,
                  boundaryRetry: true,
                  assignmentBudgetReservation: retryCapacity.raw,
                  assignmentBudgetToken: retryCapacity.token,
                });
                if (retryResult?.success === false) {
                  const retryFailure = classifyRentalAssignmentFailure(retryResult, {
                    now: this.clock(),
                  });
                  await this._releaseWithFailure(
                    retryReserved,
                    selection.missionKey,
                    retryFailure,
                  );
                  if (retryFailure.code === "rate_limit") {
                    stopReason = "rate_limit";
                    break;
                  }
                } else {
                  successes += 1;
                  await this._consumeCandidate(retryReserved);
                }
                continue;
              } catch (retryError) {
                const retryFailure = classifyRentalAssignmentFailure(retryError, {
                  now: this.clock(),
                });
                await this._releaseWithFailure(
                  retryReserved,
                  selection.missionKey,
                  retryFailure,
                );
                if (retryFailure.code === "rate_limit") {
                  stopReason = "rate_limit";
                  break;
                }
                continue;
              }
            } else {
              await this._releaseReservation(retryReserved);
            }
            if (retryCapacity.nextAvailableAt) {
              await this._commit((current) => ({
                ...current,
                worker: {
                  ...current.worker,
                  assignmentRetryAt: Math.max(
                    Number(current.worker.assignmentRetryAt || 0),
                    retryCapacity.nextAvailableAt,
                  ),
                },
              }));
            }
          }
        }
        continue;
      }

      await this._releaseWithFailure(reserved, selection.missionKey, failure);
      if (failure.code === "network_ambiguous" && this.reconcileAmbiguous) {
        const reconciliation = await this.reconcileAmbiguous({
          mission: selection.mission,
          missionKey: selection.missionKey,
          candidate: reserved,
        });
        if (reconciliation?.assigned === true) {
          successes += 1;
          await this._consumeCandidate(reserved);
        } else if (reconciliation?.safeToRelease === true) {
          await this._commit((current) => ({
            ...current,
            candidates: current.candidates.map((row) =>
              candidateIdentity(row) === identity
                ? {
                    ...row,
                    state: "available",
                    inFlightMissionKey: null,
                    inFlightAt: null,
                  }
                : row,
            ),
          }));
        }
      }
      if (failure.code === "rate_limit") {
        stopReason = "rate_limit";
        break;
      }
      if (failure.code === "auth") {
        stopReason = "auth";
        break;
      }
    }

    const capped = attemptedIdentities.size >= attemptLimit;
    const now = this.clock();
    const hasMoreDue = missions.some((mission, index) => {
      const key = missionKeyOf(mission, index);
      return Boolean(
        !allowCoolingReset &&
          this._candidateForMission(key, attemptedIdentities, now),
      );
    });
    await this._commit((current) => {
      const generation = Number(current.generation || 0);
      const continuationAlreadyUsed =
        Number(current.worker.continuationGeneration || 0) === generation;
      return {
        ...current,
        worker: {
          ...current.worker,
          missionCursor: cursor,
          continuationNotBefore:
            capped && hasMoreDue && !continuationAlreadyUsed
              ? now + this.continuationDelayMs
              : 0,
          continuationGeneration:
            capped && hasMoreDue && !continuationAlreadyUsed
              ? generation
              : Number(current.worker.continuationGeneration || 0),
          pausedGeneration:
            capped && hasMoreDue && continuationAlreadyUsed
              ? generation
              : Number(current.worker.pausedGeneration || 0),
        },
      };
    });
    return {
      attemptedDistinct: attemptedIdentities.size,
      dispatches,
      successes,
      boundaryRetryUsed: extraBoundaryRetryUsed,
      capped,
      hasMoreDue,
      stopReason,
      nextWakeAt: this._nextWakeAt(),
    };
  }

  _nextWakeAt() {
    if (!this.demand || this.closed) return null;
    const now = this.clock();
    const times = [];
    const continuation = Number(this.state.worker.continuationNotBefore || 0);
    const assignmentRetry = Number(this.state.worker.assignmentRetryAt || 0);
    const pausedForSnapshot =
      Number(this.state.worker.pausedGeneration || 0) ===
        Number(this.state.generation || 0) &&
      Number(this.state.generation || 0) > 0;
    if (continuation > now) times.push(continuation);
    if (assignmentRetry > now) times.push(assignmentRetry);
    const selectable = rankRentalCandidates(this.state.candidates, {
      now,
      limit: MAX_WORKING_QUEUE,
    });
    const dueExists = selectable.some(
      (row) => Number.isFinite(row.readyAt) && row.readyAt <= now,
    );
    if (
      dueExists &&
      !pausedForSnapshot &&
      continuation <= now &&
      assignmentRetry <= now
    ) {
      times.push(now);
    }
    for (const row of selectable) {
      if (Number.isFinite(row.readyAt) && row.readyAt > now) {
        times.push(row.readyAt + this.readinessBufferMs);
        break;
      }
    }
    const snapshotRefreshAt = this.state.snapshotAt
      ? Number(this.state.snapshotAt) + SEARCH_INTERVAL_MS
      : now;
    times.push(
      Math.max(
        now,
        snapshotRefreshAt,
        Number(this.state.search.nextAllowedAt || 0),
      ),
    );
    return times.length ? Math.min(...times) : null;
  }

  schedule() {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
      this.timerAt = 0;
    }
    const wakeAt = this._nextWakeAt();
    if (wakeAt === null) return null;
    this.timerAt = wakeAt;
    this.timer = this.setTimer(async () => {
      this.timer = null;
      this.timerAt = 0;
      if (this.closed || !this.demand) return;
      try {
        if (this.onScheduledWake) {
          const result = await this.onScheduledWake({ reason: "rental_scheduled" });
          const retryAfterMs = Number(result?.retryAfterMs || 0);
          if (retryAfterMs > 0) {
            await this._commit((current) => ({
              ...current,
              worker: {
                ...current.worker,
                assignmentRetryAt: Math.max(
                  Number(current.worker.assignmentRetryAt || 0),
                  this.clock() + retryAfterMs,
                ),
              },
            }));
          }
          return;
        }
        const now = this.clock();
        const searchDue =
          (!this.state.snapshotAt ||
            now - Number(this.state.snapshotAt) >= SEARCH_INTERVAL_MS) &&
          now >= Number(this.state.search.nextAllowedAt || 0);
        if (searchDue) {
          await this.requestSearch({ reason: "scheduled", rentalsNeeded: true });
        }
        const worker = await this.runAssignmentWorker({ reason: "scheduled" });
        if (worker?.reason === "no_demand") {
          this.setDemand(false, { reason: "mission_demand_cleared" });
          return;
        }
        if (
          (!searchDue && worker?.stopReason === "no_due_candidate") ||
          (!searchDue && worker?.attemptedDistinct === 0)
        ) {
          await this.requestSearch({ reason: "scheduled", rentalsNeeded: true });
        }
      } finally {
        this.schedule();
      }
    }, Math.max(0, wakeAt - this.clock()));
    if (typeof this.timer?.unref === "function") this.timer.unref();
    return wakeAt;
  }
}

function createRentalCoordinator(options) {
  return new RentalCoordinator(options);
}

module.exports = {
  SNAPSHOT_VERSION,
  SEARCH_INTERVAL_MS,
  MAX_SNAPSHOT_CANDIDATES,
  MAX_WORKING_QUEUE,
  DEFAULT_ATTEMPTS_PER_WAKE,
  DEFAULT_CONTINUATION_DELAY_SECONDS,
  SEARCH_ARGS,
  clampRentalAttemptsPerWake,
  clampContinuationDelaySeconds,
  timestampMs,
  normalizeRentalCandidate,
  normalizeRentalSnapshot,
  rankRentalCandidates,
  classifyRentalAssignmentFailure,
  createEmptyState,
  sanitizePersistedState,
  RentalSnapshotStore,
  RentalCoordinator,
  createRentalCoordinator,
};
