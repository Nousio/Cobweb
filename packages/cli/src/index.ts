#!/usr/bin/env node
import {
  auditParsedSkill,
  createMergePlan,
  createVendorPlan,
  dedupSkills,
  defaultRuntimePaths,
  lintSkillDirectory,
  parseSkillDirectory,
  scanSkills,
} from "@cobweb/core";
import type { DaemonMethods } from "@cobweb/daemon";
import { callDaemon } from "@cobweb/daemon/client";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatDaemonStatus, formatDoctorResult, printText } from "./output/human.js";
import { printError, printJson } from "./output/json.js";

const program = new Command();

program
  .name("cobweb")
  .alias("cw")
  .description("Local governance kernel for agent skills")
  .version("0.2.0");

program
  .command("scan")
  .argument("[path]", "directory to scan", ".")
  .action(async (path: string) => {
    printJson(await scanSkills(path));
  });

program
  .command("lint")
  .argument("[skill]", "skill root directory", ".")
  .option("--fix", "apply safe automatic fixes")
  .action(async (skill: string, options: { fix?: boolean }) => {
    const result = await lintSkillDirectory(skill);
    printJson({ ...result, fixed: options.fix ? false : undefined });
    if (!result.valid) {
      process.exitCode = 1;
    }
  });

program
  .command("audit")
  .argument("<skill>", "skill root directory")
  .option("--strict", "exit non-zero for high or blocked risk")
  .action(async (skill: string, options: { strict?: boolean }) => {
    const result = auditParsedSkill(await parseSkillDirectory(skill));
    printJson(result);
    if (options.strict && ["high", "blocked"].includes(result.riskLevel)) {
      process.exitCode = 2;
    }
  });

program
  .command("import")
  .argument("<path>", "skill root directory")
  .option("--dry-run", "preview import without writing", true)
  .option("--write", "write through daemon Writer Queue")
  .option("--canonical <path>", "canonical store path reserved for phase-one import")
  .action(async (path: string, options: { write?: boolean; canonical?: string }) => {
    if (!options.write) {
      const parsed = await parseSkillDirectory(path);
      const audit = auditParsedSkill(parsed);
      printJson({
        dryRun: true,
        candidate: {
          name: parsed.name,
          description: parsed.description,
          rootPath: parsed.rootPath,
          contentHash: parsed.contentHash,
          resources: parsed.resources,
          warnings: parsed.warnings,
        },
        audit,
        canonical: options.canonical ?? null,
      });
      return;
    }

    printJson(await callDaemonWithLazyStart("importSkill", { path, canonicalDir: options.canonical }));
  });

program
  .command("dedup")
  .argument("[path]", "directory to scan", ".")
  .option("--threshold <number>", "similarity threshold", Number.parseFloat)
  .action(async (path: string, options: { threshold?: number }) => {
    const scan = await scanSkills(path);
    const parsed = await Promise.all(scan.candidates.map((candidate) => parseSkillDirectory(candidate.path)));
    printJson(dedupSkills(parsed, { threshold: options.threshold }));
  });

program
  .command("sync")
  .option("--target <providers>", "comma-separated providers: agents,cursor,claude,codex")
  .option("--link", "project providers using symlinks")
  .option("--copy", "project providers using copies")
  .option("--dry-run", "preview projection without writing", true)
  .option("--write", "execute projection through daemon Writer Queue")
  .action(async (options: { target?: string; link?: boolean; copy?: boolean; write?: boolean }) => {
    const strategy = options.copy ? "copy" : "link";
    printJson(
      await callDaemonWithLazyStart("sync", {
        projectRoot: process.cwd(),
        target: options.target ? options.target.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
        strategy,
        dryRun: !options.write,
      }),
    );
  });

const policy = program.command("policy").description("Check or update skill policy");

policy
  .argument("[skill]", "skill root directory")
  .option("--implicit <on|off>", "set implicit invocation")
  .option("--self-contained <on|off>", "set self-contained policy")
  .action(async (skill: string | undefined, options: { implicit?: string; selfContained?: string }) => {
    if (options.implicit || options.selfContained) {
      if (!skill) {
        throw new Error("policy update requires a skill path.");
      }
      printJson(
        await callDaemonWithLazyStart("updatePolicy", {
          path: skill,
          implicitInvocation: parseOnOff(options.implicit),
          selfContained: parseOnOff(options.selfContained),
        }),
      );
      return;
    }

    printJson(await callDaemonWithLazyStart("policyCheck", skill ? { path: skill } : {}));
  });

policy.command("check").argument("[skill]", "skill root directory").action(async (skill: string | undefined) => {
  printJson(await callDaemonWithLazyStart("policyCheck", skill ? { path: skill } : {}));
});

program
  .command("vendor")
  .argument("<skill>", "skill root directory")
  .option("--dry-run", "preview vendoring without writing", true)
  .option("--write", "copy local resources and rewrite SKILL.md through daemon Writer Queue")
  .action(async (skill: string, options: { write?: boolean }) => {
    if (!options.write) {
      printJson(await createVendorPlan(skill, true));
      return;
    }
    printJson(await callDaemonWithLazyStart("vendor", { path: skill, dryRun: false }));
  });

program
  .command("merge")
  .argument("<source-skill>", "source skill root directory")
  .argument("<target-skill>", "target skill root directory")
  .option("--dry-run", "only print the merge plan", true)
  .action(async (sourceSkill: string, targetSkill: string) => {
    printJson(await createMergePlan(sourceSkill, targetSkill));
  });

program
  .command("status")
  .option("--readonly", "do not require daemon")
  .action(async (options: { readonly?: boolean }) => {
    if (!options.readonly) {
      try {
        printJson(await callDaemon("status", undefined));
        return;
      } catch (error) {
        printError(error);
      }
    }

    const paths = defaultRuntimePaths();
    printJson({
      db: { freshness: "degraded", path: paths.dbPath },
      daemon: { running: false },
      skills: [],
    });
  });

const daemon = program.command("daemon").description("Manage the local cobwebd daemon");

daemon.command("start").action(async () => {
  try {
    const status = await callDaemon("status", undefined);
    printJson({ started: false, alreadyRunning: true, status });
    return;
  } catch {
    // A failed status check means the daemon is not reachable; start below.
  }

  const pid = spawnDaemonProcess();
  if (pid === null) {
    throw new Error("Cannot find built cobwebd entrypoint. Run `npm run build` first or start `npm run dev:daemon`.");
  }

  printJson({ started: true, pid });
});

daemon.command("status").option("--json", "output JSON").action(async (options: { json?: boolean }) => {
  const status = await callDaemon("status", undefined);
  if (options.json) {
    printJson(status);
    return;
  }
  printText(formatDaemonStatus(status));
});

daemon.command("doctor").option("--json", "output JSON").action(async (options: { json?: boolean }) => {
  const result = await callDaemon("doctor", undefined);
  if (options.json) {
    printJson(result);
    return;
  }
  printText(formatDoctorResult(result));
});

daemon.command("stop").action(async () => {
  printJson(await callDaemon("stop", undefined));
});

daemon.command("repair").description("Rebuild the SQLite index from the lockfile").action(async () => {
  printJson(await callDaemonWithLazyStart("rebuildFromLockfile", {}));
});

async function callDaemonWithLazyStart<K extends keyof DaemonMethods>(
  method: K,
  params: DaemonMethods[K]["params"],
): Promise<DaemonMethods[K]["result"]> {
  try {
    return await callDaemon(method, params);
  } catch (firstError) {
    await startDaemonForLazyWrite(firstError);
    return callDaemon(method, params);
  }
}

async function startDaemonForLazyWrite(cause: unknown): Promise<void> {
  const pid = spawnDaemonProcess();
  if (pid === null) {
    throw new Error(
      `Daemon is not reachable and no built cobwebd entrypoint was found. Run \`npm run build\` or set COBWEBD_BIN. Cause: ${cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      await callDaemon("status", undefined);
      return;
    } catch {
      // Keep waiting for the daemon socket to become ready.
    }
  }

  throw new Error("Daemon lazy start timed out before the socket became ready.");
}

function parseOnOff(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "on") {
    return true;
  }
  if (value === "off") {
    return false;
  }
  throw new Error("Expected on or off.");
}

function resolveDaemonEntrypoint(): string | null {
  if (process.env.COBWEBD_BIN) {
    return process.env.COBWEBD_BIN;
  }

  const built = fileURLToPath(new URL("../../daemon/dist/index.js", import.meta.url));
  return existsSync(built) ? built : null;
}

function spawnDaemonProcess(): number | null {
  const entrypoint = resolveDaemonEntrypoint();
  if (!entrypoint) {
    return null;
  }

  const child = spawn(process.execPath, [entrypoint], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? null;
}

program.parseAsync(process.argv).catch((error) => {
  printError(error);
  process.exitCode = 1;
});
