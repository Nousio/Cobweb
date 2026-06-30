#!/usr/bin/env node
import { delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { runMcpServer, type McpServerOptions } from "./server/mcp-server.js";

export * from "./server/mcp-server.js";

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  void startMcpServerCli();
}

export async function startMcpServerCli(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let options: McpServerOptions;
  try {
    // Reject invalid startup options before connecting the server so a bad --path
    // fails fast for both terminal users and MCP clients instead of running degraded.
    options = parseMcpServerOptions(argv, env);
  } catch (error) {
    failFast(error);
    return;
  }

  try {
    await runMcpServer(options);
  } catch (error) {
    failFast(error);
  }
}

function failFast(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

export function parseMcpServerOptions(argv: string[], env: NodeJS.ProcessEnv = process.env): McpServerOptions {
  const skillRoots: string[] = [];

  appendEnvPaths(skillRoots, env.SKILLROUTE_SKILL_PATH);
  appendEnvPaths(skillRoots, env.SKILLROUTE_SKILL_PATHS);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--path") {
      // Accept one or more directories after a single --path (e.g. --path /a /b)
      // so the skill roots can be written as an array instead of repeating --path.
      const dirs: string[] = [];
      while (index + 1 < argv.length) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
          break;
        }
        dirs.push(next);
        index += 1;
      }
      if (dirs.length === 0) {
        throw new Error("skillroute-mcp --path requires a directory value.");
      }
      for (const dir of dirs) {
        skillRoots.push(requireNonEmptyPath(dir));
      }
      continue;
    }
    if (arg.startsWith("--path=")) {
      skillRoots.push(requireNonEmptyPath(arg.slice("--path=".length)));
      continue;
    }
    throw new Error(`Unknown skillroute-mcp option: ${arg}`);
  }

  return skillRoots.length > 0 ? { skillRoots } : {};
}

function requireNonEmptyPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new Error("skillroute-mcp --path requires a non-empty directory.");
  }
  return trimmed;
}

function appendEnvPaths(target: string[], value: string | undefined): void {
  if (!value) {
    return;
  }
  target.push(...value.split(delimiter).map((item) => item.trim()).filter(Boolean));
}
