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
    `Skills: ${status.db.total} total, ${status.db.highRisk} high risk, ${status.db.blocked} blocked`,
    `Writer queue: ${status.writer.pending} pending${status.writer.running ? `, running ${status.writer.running.type}` : ""}`,
  ];

  if (status.lastError) {
    lines.push(`Last error: ${status.lastError}`);
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
