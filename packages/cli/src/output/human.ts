import type { DaemonMethods, DaemonStatus } from "@cobweb/daemon";

export function printText(value: string): void {
  process.stdout.write(`${value}\n`);
}

export function formatDaemonStatus(status: DaemonStatus): string {
  const lines = [
    "Cobweb daemon: running",
    `PID: ${status.pid}`,
    `Socket: ${status.socketPath}`,
    `Database: ${status.dbPath}`,
    `Index freshness: ${status.freshness}`,
    `Skills: ${status.db.total} total`,
    `Writer queue: ${status.writer.pending} pending${status.writer.running ? `, running ${status.writer.running.type}` : ""}`,
    `Watch roots: ${status.index.watchRoots.length}`,
    `Pending index roots: ${status.index.pendingRoots.length}`,
  ];

  if (status.lastError) {
    lines.push(`Last error: ${status.lastError}`);
  }

  for (const root of status.index.roots) {
    lines.push(
      [
        `Root: ${root.root} [${root.state}]`,
        `reason=${root.reason}`,
        `watcher=${root.watcherState}`,
        `dirty=${root.dirty ? "yes" : "no"}`,
        `pending=${root.pending ? "yes" : "no"}`,
        `inFlight=${root.inFlight ? "yes" : "no"}`,
        `fastPath=${root.fastPathEligible ? "eligible" : "blocked"}`,
      ].join(" "),
    );
    if (root.lastIndexedAt) {
      lines.push(`  Last indexed: ${root.lastIndexedAt}`);
    }
    if (root.lastCheckedAt) {
      lines.push(`  Last checked: ${root.lastCheckedAt}${root.lastCheckKind ? ` (${root.lastCheckKind})` : ""}`);
    }
    if (root.lastVerifiedAt) {
      lines.push(`  Last verified: ${root.lastVerifiedAt}`);
    }
    if (root.lastFullReconcileAt) {
      lines.push(`  Last full reconcile: ${root.lastFullReconcileAt}`);
    }
    if (root.lastEventAt) {
      lines.push(`  Last watcher event: ${root.lastEventAt}`);
    }
    lines.push(`  Staleness budget: ${root.stalenessBudgetMs}ms`);
    if (root.lastIndexError) {
      lines.push(`  Last index error: ${root.lastIndexError}`);
    }
  }

  return lines.join("\n");
}

export function formatDoctorResult(result: DaemonMethods["doctor"]["result"]): string {
  const lines = [`Cobweb doctor: ${result.ok ? "ok" : "issues found"}`];
  for (const check of result.checks) {
    lines.push(`${check.ok ? "OK" : "FAIL"} ${check.name}${check.message ? ` - ${check.message}` : ""}`);
  }
  return lines.join("\n");
}
