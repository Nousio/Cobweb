import {
  findSkillDirectories,
  parseSkillDirectory,
  sha256,
  toErrorMessage,
  type IndexFreshness,
  type ParsedSkill
} from "@cobweb/core";
import { watch } from "chokidar";
import { access, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AppState, IndexRootRuntimeState, RootManifest, RootStatSignature } from "../app-state/app-state.js";
import type { DaemonIndexStatus } from "../ipc/protocol.js";

const INDEX_ROOTS_KEY = "index.roots.v1";
const INDEX_ROOTS_VERSION = 1;
const TRAILING_DEBOUNCE_MS = 250;
const MAX_DEBOUNCE_WAIT_MS = 2_000;
const RECENT_INDEX_TASK_LIMIT = 10;
const WATCH_WRITE_POLL_INTERVAL_MS = 100;
const SKILL_FILE_NAME = "SKILL.md";
const WATCH_IGNORED_SEGMENTS = new Set(["node_modules", ".git", ".codegraph", "dist"]);

interface IndexRootLedger {
  version: 1;
  roots: Array<{
    root: string;
    lastIndexedAt: string | null;
    lastError: string | null;
  }>;
}

interface DiskSkill {
  rootPath: string;
  contentHash: string;
  signature: RootStatSignature;
}

interface DiskSkillHashSnapshot {
  skills: DiskSkill[];
  unreadableSkillPaths: string[];
  manifest: RootManifest;
}

interface ParsedSkillRecord {
  skill: ParsedSkill;
}

export async function initializeIndexCoordinator(state: AppState): Promise<void> {
  const ledger = readIndexLedger(state);
  if (!ledger) {
    return;
  }

  let changed = false;
  for (const root of ledger.roots) {
    if (!(await pathExists(root.root))) {
      changed = true;
      continue;
    }
    setRootState(state, root.root, {
      root: root.root,
      state: "degraded",
      reason: "restored_needs_reconcile",
      lastIndexedAt: root.lastIndexedAt,
      lastIndexError: root.lastError,
      lastCheckedAt: null,
      lastVerifiedAt: null,
      lastFullReconcileAt: null,
      lastEventAt: null,
      lastCheckKind: null,
      pending: false,
      watching: false,
      watcherState: "starting",
      dirty: false,
    });
    rememberIndexedSkillFileWatcher(state, root.root, { persist: false, reason: "restored_watch_root" });
  }

  if (changed) {
    await state.writer.enqueue("PersistIndexRoots", async () => {
      writeIndexLedger(state);
    });
  }
  refreshGlobalFreshness(state);
}

export async function ensureIndexedRoot(state: AppState, root: string): Promise<string[]> {
  const resolvedRoot = resolve(root);
  const rootState = state.indexRoots.get(resolvedRoot);
  const manifest = state.rootManifests.get(resolvedRoot);
  if (!rootState || !manifest || mustFullReconcile(state, resolvedRoot, rootState)) {
    const warnings = await indexRoot(state, resolvedRoot, "query_reconcile");
    rememberIndexedSkillFileWatcher(state, resolvedRoot, { persist: true, reason: "query_registered_root" });
    return warnings;
  }

  const now = Date.now();
  const lastVerifiedAt = rootState.lastVerifiedAt ? Date.parse(rootState.lastVerifiedAt) : 0;
  if (!lastVerifiedAt || now - lastVerifiedAt > state.maxStalenessMs) {
    const warnings: string[] = [];
    const currentManifest = await readRootManifestSignature(resolvedRoot, warnings);
    if (!currentManifest || !sameManifestSignature(manifest, currentManifest)) {
      const reconcileWarnings = await indexRoot(state, resolvedRoot, "signature_changed");
      rememberIndexedSkillFileWatcher(state, resolvedRoot, { persist: true, reason: "query_registered_root" });
      return reconcileWarnings;
    }
    updateRootState(state, resolvedRoot, {
      lastCheckedAt: new Date(now).toISOString(),
      lastVerifiedAt: new Date(now).toISOString(),
      lastCheckKind: "signature_check",
      lastIndexError: rootState.lastIndexError,
    });
    rememberIndexedSkillFileWatcher(state, resolvedRoot, { persist: true, reason: "query_registered_root" });
    return warnings;
  }

  updateRootState(state, resolvedRoot, {
    lastCheckedAt: new Date(now).toISOString(),
    lastCheckKind: "fast_path",
  });
  rememberIndexedSkillFileWatcher(state, resolvedRoot, { persist: true, reason: "query_registered_root" });
  return [];
}

export async function indexRoot(state: AppState, root: string, reason = "manual_reconcile"): Promise<string[]> {
  const resolvedRoot = resolve(root);
  const existing = state.indexInFlight.get(resolvedRoot);
  if (existing) {
    if (reason !== "query_reconcile") {
      existing.rerunRequested = true;
      existing.rerunReason = reason;
      updateRootState(state, resolvedRoot, {
        dirty: true,
        lastEventAt: new Date().toISOString(),
      });
    }
    return existing.promise;
  }

  const entry = {
    promise: Promise.resolve([] as string[]),
    rerunRequested: false,
    rerunReason: reason,
  };
  entry.promise = (async () => {
    const warnings = await performIndexRoot(state, resolvedRoot, reason);
    if (entry.rerunRequested && !state.stopping) {
      const rerunReason = entry.rerunReason;
      state.indexInFlight.delete(resolvedRoot);
      entry.rerunRequested = false;
      return indexRoot(state, resolvedRoot, rerunReason);
    }
    return warnings;
  })().finally(() => {
    if (state.indexInFlight.get(resolvedRoot) === entry) {
      state.indexInFlight.delete(resolvedRoot);
    }
    refreshGlobalFreshness(state);
  });
  state.indexInFlight.set(resolvedRoot, entry);
  return entry.promise;
}

async function performIndexRoot(state: AppState, root: string, reason: string): Promise<string[]> {
  clearPendingTimer(state, root);
  updateRootState(state, root, {
    state: "rebuilding",
    reason,
    pending: false,
  });
  pushRecentIndexTask(state, root, "rebuilding", reason);
  refreshGlobalFreshness(state);

  const warnings: string[] = [];
  try {
    const diskSnapshot = await readDiskSkillHashes(root, warnings);
    const diskSkills = diskSnapshot.skills;
    const currentSkillPaths = [...diskSkills.map((skill) => skill.rootPath), ...diskSnapshot.unreadableSkillPaths];
    const diskPathSet = new Set(currentSkillPaths);
    const existingRecords = state.db.listSkillContentHashesUnderRoot(root);
    const existing = new Map(existingRecords.map((record) => [record.path, record.contentHash]));
    const changed = diskSkills.filter((skill) => existing.get(skill.rootPath) !== skill.contentHash);
    const staleCount = existingRecords.filter((record) => !diskPathSet.has(record.path)).length;

    if (changed.length === 0 && staleCount === 0) {
      const hadFailures = warnings.length > 0;
      const indexedAt = new Date().toISOString();
      await state.writer.enqueue("PersistIndexRootLedger", async () => {
        state.rootManifests.set(root, { ...diskSnapshot.manifest, lastFullReconcileAt: indexedAt });
        updateRootState(state, root, {
          state: hadFailures ? "degraded" : "fresh",
          reason: hadFailures ? "partial_reconcile" : "content_hash_unchanged",
          lastIndexedAt: indexedAt,
          lastIndexError: hadFailures ? warnings.join("; ") : null,
          lastCheckedAt: indexedAt,
          lastVerifiedAt: indexedAt,
          lastFullReconcileAt: indexedAt,
          lastCheckKind: "full_reconcile",
          pending: false,
          dirty: false,
        });
        state.indexedRoots.add(root);
        writeIndexLedger(state);
        refreshGlobalFreshness(state);
      });
      pushRecentIndexTask(state, root, hadFailures ? "degraded" : "fresh", hadFailures ? "partial_reconcile" : "content_hash_unchanged");
      return warnings;
    }

    const parsedRecords = await parseChangedSkills(changed, warnings);
    const stableRecords = await state.writer.enqueue("IndexSkillRoot", async () => {
      const stable = await filterStableRecords(parsedRecords, warnings);
      const result = state.db.reconcileSkillRoot(root, stable.map((record) => record.skill), currentSkillPaths);
      const hadFailures = warnings.length > 0;
      const indexedAt = new Date().toISOString();
      state.rootManifests.set(root, { ...diskSnapshot.manifest, lastFullReconcileAt: indexedAt });
      updateRootState(state, root, {
        state: hadFailures ? "degraded" : "fresh",
        reason: hadFailures ? "partial_reconcile" : "content_hash_reconciled",
        lastIndexedAt: indexedAt,
        lastIndexError: hadFailures ? warnings.join("; ") : null,
        lastCheckedAt: indexedAt,
        lastVerifiedAt: indexedAt,
        lastFullReconcileAt: indexedAt,
        lastCheckKind: "full_reconcile",
        pending: false,
        dirty: false,
      });
      state.indexedRoots.add(root);
      writeIndexLedger(state);
      refreshGlobalFreshness(state);
      return result.imported;
    });

    pushRecentIndexTask(
      state,
      root,
      warnings.length > 0 ? "degraded" : "fresh",
      `reconciled ${stableRecords.length} changed skill(s)`,
    );
    if (warnings.some((warning) => warning.includes("queued for reconcile"))) {
      scheduleIndexRoot(state, root, "content_hash_conflict");
    }
    return warnings;
  } catch (error) {
    const message = toErrorMessage(error);
    updateRootState(state, root, {
      state: "degraded",
      reason: "index_failed",
      lastIndexError: message,
      pending: false,
    });
    state.lastError = message;
    pushRecentIndexTask(state, root, "degraded", "index_failed");
    refreshGlobalFreshness(state);
    throw error;
  }
}

export function scheduleIndexRoot(state: AppState, root: string, reason = "watch_event"): void {
  const resolvedRoot = resolve(root);
  const now = Date.now();
  const existing = state.indexTimers.get(resolvedRoot);
  const firstScheduledAt = existing?.firstScheduledAt ?? now;
  if (existing) {
    clearTimeout(existing.timer);
  }

  updateRootState(state, resolvedRoot, {
    state: "degraded",
    reason,
    pending: true,
    dirty: true,
    lastEventAt: new Date(now).toISOString(),
  });
  refreshGlobalFreshness(state);

  const delay = now - firstScheduledAt >= MAX_DEBOUNCE_WAIT_MS ? 0 : TRAILING_DEBOUNCE_MS;
  const timer = setTimeout(() => {
    state.indexTimers.delete(resolvedRoot);
    updateRootState(state, resolvedRoot, { pending: false });
    void indexRoot(state, resolvedRoot, reason).catch(() => {
      // indexRoot records state and lastError for status.
    });
  }, delay);
  timer.unref();
  state.indexTimers.set(resolvedRoot, { timer, firstScheduledAt });
}

export function rememberIndexedSkillFileWatcher(
  state: AppState,
  root: string,
  options: { persist?: boolean; reason?: string } = {},
): void {
  const resolvedRoot = resolve(root);
  const existingRoot = state.indexRoots.get(resolvedRoot);
  if (existingRoot?.watcherState === "unavailable") {
    return;
  }
  if (state.watchers.has(resolvedRoot)) {
    updateRootState(state, resolvedRoot, { watching: true });
    return;
  }

  const skillRoots = state.rootManifests.get(resolvedRoot)?.skillRoots
    ?? state.db.listSkillContentHashesUnderRoot(resolvedRoot).map((record) => record.path).sort();
  const watchPaths = skillRoots.map((skillRoot) => join(skillRoot, SKILL_FILE_NAME));

  if (watchPaths.length === 0) {
    updateRootState(state, resolvedRoot, {
      reason: options.reason ?? "query_registered_root",
      watching: false,
      watcherState: "ready",
    });
    state.watchRoots.add(resolvedRoot);
    if (options.persist ?? true) {
      void state.writer.enqueue("PersistIndexRoots", async () => {
        writeIndexLedger(state);
      });
    }
    return;
  }

  try {
    updateRootState(state, resolvedRoot, {
      reason: options.reason ?? "query_registered_root",
      watching: true,
      watcherState: "starting",
    });
    const watcher = watch(watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: watchStabilityThreshold(state),
        pollInterval: WATCH_WRITE_POLL_INTERVAL_MS,
      },
      atomic: true,
      ignored: (path) => isIgnoredWatchPath(path),
    });
    watcher.on("ready", () => {
      updateRootState(state, resolvedRoot, {
        reason: options.reason ?? "query_registered_root",
        watching: true,
        watcherState: "ready",
      });
      refreshGlobalFreshness(state);
    });
    watcher.on("all", (_event, eventPath) => {
      if (typeof eventPath === "string" && !isSkillFilePath(eventPath)) {
        return;
      }
      scheduleIndexRoot(state, resolvedRoot, "watch_event");
    });
    watcher.on("error", (error) => {
      markWatcherUnavailable(state, resolvedRoot, toErrorMessage(error));
    });
    state.watchers.set(resolvedRoot, watcher);
    state.watchRoots.add(resolvedRoot);
    if (options.persist ?? true) {
      void state.writer.enqueue("PersistIndexRoots", async () => {
        writeIndexLedger(state);
      });
    }
  } catch (error) {
    markWatcherUnavailable(state, resolvedRoot, toErrorMessage(error));
  }
}

export function markRootFresh(state: AppState, root: string, reason: string): void {
  updateRootState(state, resolve(root), {
    state: "fresh",
    reason,
    lastIndexedAt: new Date().toISOString(),
    lastIndexError: null,
    lastVerifiedAt: new Date().toISOString(),
    pending: false,
  });
  state.indexedRoots.add(resolve(root));
  refreshGlobalFreshness(state);
}

export function markRootDegraded(state: AppState, root: string, reason: string, error: string | null = null): void {
  updateRootState(state, resolve(root), {
    state: "degraded",
    reason,
    lastIndexError: error,
  });
  refreshGlobalFreshness(state);
}

export function indexStatusSnapshot(state: AppState): DaemonIndexStatus {
  const roots = Array.from(state.indexRoots.values())
    .map((root) => {
      const pending = root.pending || state.indexTimers.has(root.root);
      return {
        ...root,
        pending,
        watching: state.watchers.has(root.root) && root.watcherState !== "unavailable",
        fastPathEligible: isFastPathEligible(state, root.root, root),
        inFlight: state.indexInFlight.has(root.root),
        stalenessBudgetMs: state.maxStalenessMs,
      };
    })
    .sort((left, right) => left.root.localeCompare(right.root));

  return {
    roots,
    watchRoots: Array.from(state.watchRoots).sort(),
    indexedRoots: Array.from(state.indexedRoots).sort(),
    pendingRoots: Array.from(state.indexTimers.keys()).sort(),
    recent: [...state.recentIndexTasks],
  };
}

export function overallFreshness(state: AppState): IndexFreshness {
  if (
    state.indexInFlight.size > 0 ||
    state.indexTimers.size > 0 ||
    Array.from(state.indexRoots.values()).some((root) => root.state === "rebuilding" || root.pending)
  ) {
    return "rebuilding";
  }
  if (Array.from(state.indexRoots.values()).some((root) => root.state === "degraded")) {
    return "degraded";
  }
  return "fresh";
}

export function rootFreshness(state: AppState, root: string): IndexFreshness {
  const resolvedRoot = resolve(root);
  const rootState = state.indexRoots.get(resolvedRoot);
  if (!rootState) {
    return overallFreshness(state);
  }
  if (state.indexInFlight.has(resolvedRoot) || state.indexTimers.has(resolvedRoot) || rootState.pending || rootState.state === "rebuilding") {
    return "rebuilding";
  }
  return rootState.state;
}

function readIndexLedger(state: AppState): IndexRootLedger | null {
  try {
    const value = state.db.getRuntimeState<IndexRootLedger>(INDEX_ROOTS_KEY);
    if (!value || value.version !== INDEX_ROOTS_VERSION || !Array.isArray(value.roots)) {
      return null;
    }
    return value;
  } catch (error) {
    state.lastError = `Cannot read index root ledger: ${toErrorMessage(error)}`;
    return null;
  }
}

function writeIndexLedger(state: AppState): void {
  const roots = Array.from(state.indexRoots.values())
    .filter((root) => state.watchRoots.has(root.root) || state.indexedRoots.has(root.root))
    .map((root) => ({
      root: root.root,
      lastIndexedAt: root.lastIndexedAt,
      lastError: root.lastIndexError,
    }));
  state.db.setRuntimeState(INDEX_ROOTS_KEY, { version: INDEX_ROOTS_VERSION, roots });
}

function setRootState(state: AppState, root: string, value: IndexRootRuntimeState): void {
  state.indexRoots.set(root, value);
}

function updateRootState(state: AppState, root: string, patch: Partial<Omit<IndexRootRuntimeState, "root">>): void {
  const current = state.indexRoots.get(root) ?? {
    root,
    state: "fresh" as IndexFreshness,
    reason: "not_indexed",
    lastIndexedAt: null,
    lastIndexError: null,
    lastCheckedAt: null,
    lastVerifiedAt: null,
    lastFullReconcileAt: null,
    lastEventAt: null,
    lastCheckKind: null,
    pending: false,
    watching: false,
    watcherState: "starting",
    dirty: false,
  };
  state.indexRoots.set(root, { ...current, ...patch, root });
}

function refreshGlobalFreshness(state: AppState): void {
  state.freshness = overallFreshness(state);
}

function pushRecentIndexTask(state: AppState, root: string, stateValue: IndexFreshness, reason: string): void {
  state.recentIndexTasks.unshift({
    root,
    state: stateValue,
    reason,
    at: new Date().toISOString(),
  });
  state.recentIndexTasks.splice(RECENT_INDEX_TASK_LIMIT);
}

function clearPendingTimer(state: AppState, root: string): void {
  const pending = state.indexTimers.get(root);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  state.indexTimers.delete(root);
}

async function readDiskSkillHashes(root: string, warnings: string[]): Promise<DiskSkillHashSnapshot> {
  const skillRoots = await findSkillDirectories(root);
  const results = await Promise.allSettled(
    skillRoots.map(async (skillRoot) => {
      const skillFile = join(skillRoot, "SKILL.md");
      const before = signatureFromStats(await stat(skillFile));
      const content = await readFile(skillFile, "utf8");
      const after = signatureFromStats(await stat(skillFile));
      if (!sameSignature(before, after)) {
        throw new Error("SKILL.md changed while hashing; queued for reconcile");
      }
      return {
        rootPath: skillRoot,
        contentHash: sha256(content),
        signature: after,
      };
    }),
  );
  const skills: DiskSkill[] = [];
  const unreadableSkillPaths: string[] = [];
  const signatures: Record<string, RootStatSignature> = {};
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      skills.push(result.value);
      signatures[result.value.rootPath] = result.value.signature;
      return;
    }
    const skillRoot = skillRoots[index];
    warnings.push(`${skillRoot}: ${toErrorMessage(result.reason)}`);
    if (skillRoot && !isMissingSkillFileError(result.reason)) {
      unreadableSkillPaths.push(skillRoot);
    }
  });
  return {
    skills,
    unreadableSkillPaths,
    manifest: {
      skillRoots: [...skillRoots],
      signatures,
      lastFullReconcileAt: new Date().toISOString(),
    },
  };
}

async function parseChangedSkills(changed: DiskSkill[], warnings: string[]): Promise<ParsedSkillRecord[]> {
  const results = await Promise.allSettled(
    changed.map(async (skill) => {
      const parsed = await parseSkillDirectory(skill.rootPath);
      return { skill: parsed };
    }),
  );
  const records: ParsedSkillRecord[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      records.push(result.value);
      return;
    }
    warnings.push(`${changed[index]?.rootPath ?? "unknown"}: ${toErrorMessage(result.reason)}`);
  });
  return records;
}

async function filterStableRecords(records: ParsedSkillRecord[], warnings: string[]): Promise<ParsedSkillRecord[]> {
  const results = await Promise.allSettled(
    records.map(async (record) => {
      const currentHash = sha256(await readFile(join(record.skill.rootPath, "SKILL.md"), "utf8"));
      return { record, currentHash };
    }),
  );
  const stable: ParsedSkillRecord[] = [];
  results.forEach((result, index) => {
    const record = records[index];
    if (!record) {
      return;
    }
    if (result.status === "rejected") {
      warnings.push(`${record.skill.rootPath}: ${toErrorMessage(result.reason)}; queued for reconcile`);
      return;
    }
    if (result.value.currentHash !== record.skill.contentHash) {
      warnings.push(`${record.skill.rootPath}: SKILL.md changed during indexing; queued for reconcile`);
      return;
    }
    stable.push(record);
  });
  return stable;
}

function mustFullReconcile(state: AppState, root: string, rootState: IndexRootRuntimeState): boolean {
  if (state.indexInFlight.has(root) || state.indexTimers.has(root) || rootState.pending || rootState.dirty) {
    return true;
  }
  return rootState.state !== "fresh" || rootState.watcherState !== "ready";
}

function isFastPathEligible(state: AppState, root: string, rootState: IndexRootRuntimeState): boolean {
  if (!state.rootManifests.has(root)) {
    return false;
  }
  if (state.indexInFlight.has(root) || state.indexTimers.has(root) || rootState.pending || rootState.dirty) {
    return false;
  }
  if (rootState.state !== "fresh" || rootState.watcherState !== "ready") {
    return false;
  }
  if (!rootState.lastVerifiedAt) {
    return false;
  }
  return Date.now() - Date.parse(rootState.lastVerifiedAt) <= state.maxStalenessMs;
}

async function readRootManifestSignature(root: string, warnings: string[]): Promise<RootManifest | null> {
  const skillRoots = await findSkillDirectories(root);
  const results = await Promise.allSettled(
    skillRoots.map(async (skillRoot) => ({
      rootPath: skillRoot,
      signature: signatureFromStats(await stat(join(skillRoot, "SKILL.md"))),
    })),
  );
  const signatures: Record<string, RootStatSignature> = {};
  let failed = false;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      signatures[result.value.rootPath] = result.value.signature;
      return;
    }
    failed = true;
    warnings.push(`${skillRoots[index] ?? "unknown"}: ${toErrorMessage(result.reason)}`);
  });
  if (failed) {
    return null;
  }
  return {
    skillRoots,
    signatures,
    lastFullReconcileAt: new Date().toISOString(),
  };
}

function sameManifestSignature(left: RootManifest, right: RootManifest): boolean {
  if (left.skillRoots.length !== right.skillRoots.length) {
    return false;
  }
  for (let index = 0; index < left.skillRoots.length; index += 1) {
    if (left.skillRoots[index] !== right.skillRoots[index]) {
      return false;
    }
  }
  for (const skillRoot of left.skillRoots) {
    const leftSignature = left.signatures[skillRoot];
    const rightSignature = right.signatures[skillRoot];
    if (!leftSignature || !rightSignature || !sameSignature(leftSignature, rightSignature)) {
      return false;
    }
  }
  return true;
}

function sameSignature(left: RootStatSignature, right: RootStatSignature): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function signatureFromStats(stats: { size: number; mtimeMs: number }): RootStatSignature {
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}

function markWatcherUnavailable(state: AppState, root: string, message: string): void {
  updateRootState(state, root, {
    state: "degraded",
    reason: "watch_unavailable",
    lastIndexError: message,
    watching: false,
    watcherState: "unavailable",
    dirty: true,
  });
  state.lastError = message;
  refreshGlobalFreshness(state);
}

function watchStabilityThreshold(state: AppState): number {
  return Math.min(500, Math.max(50, Math.floor(state.maxStalenessMs / 4)));
}

function isIgnoredWatchPath(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => WATCH_IGNORED_SEGMENTS.has(segment));
}

function isSkillFilePath(path: string): boolean {
  return path.split(/[\\/]+/).at(-1) === "SKILL.md";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isMissingSkillFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
