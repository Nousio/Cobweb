#!/usr/bin/env node
import {
  auditParsedSkill,
  dedupSkills,
  defaultRuntimePaths,
  parseSkillDirectory,
  scanSkills,
} from "@cobweb/core";
import { callDaemon } from "@cobweb/daemon/client";
import { Command } from "commander";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { printError, printJson } from "./output/json.js";

const program = new Command();

program
  .name("cobweb")
  .alias("cw")
  .description("Local governance kernel for agent skills")
  .version("0.1.0");

program
  .command("scan")
  .argument("[path]", "directory to scan", ".")
  .option("--record", "record scan result through daemon")
  .action(async (path: string, options: { record?: boolean }) => {
    if (options.record) {
      printJson(await callDaemon("scan", { path }));
      return;
    }
    printJson(await scanSkills(path));
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

    printJson(await callDaemon("importSkill", { path }));
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

  const entrypoint = resolveDaemonEntrypoint();
  if (!entrypoint) {
    throw new Error("Cannot find built cobwebd entrypoint. Run `npm run build` first or start `npm run dev:daemon`.");
  }

  const child = spawn(process.execPath, [entrypoint], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  printJson({ started: true, pid: child.pid });
});

daemon.command("status").option("--json", "output JSON").action(async () => {
  printJson(await callDaemon("status", undefined));
});

daemon.command("doctor").action(async () => {
  printJson(await callDaemon("doctor", undefined));
});

daemon.command("stop").action(async () => {
  printJson(await callDaemon("stop", undefined));
});

for (const commandName of ["sync", "policy", "vendor", "install"]) {
  program.command(commandName).allowUnknownOption(true).action(() => {
    throw new Error(`${commandName} is a write command and must be implemented through daemon Writer Queue.`);
  });
}

function resolveDaemonEntrypoint(): string | null {
  if (process.env.COBWEBD_BIN) {
    return process.env.COBWEBD_BIN;
  }

  const built = fileURLToPath(new URL("../../daemon/dist/index.js", import.meta.url));
  return existsSync(built) ? built : null;
}

program.parseAsync(process.argv).catch((error) => {
  printError(error);
  process.exitCode = 1;
});
