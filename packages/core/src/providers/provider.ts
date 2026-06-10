import { join } from "node:path";
import type { CanonicalSkill, ProjectionPlan, ProjectionTarget } from "../types.js";

export interface RuntimeContext {
  homeDir: string;
}

export interface PolicyMapping {
  implicitInvocationField?: string;
  sidecarPath?: string;
}

export interface Provider {
  name: string;
  supportsAgentsDir: boolean;
  policyMapping: PolicyMapping;
  detectGlobalPaths(ctx: RuntimeContext): string[];
  detectProjectPaths(projectRoot: string): string[];
  project(skill: CanonicalSkill, target: ProjectionTarget): ProjectionPlan;
}

export function builtinProviders(): Provider[] {
  return [
    createProvider("agents", [".agents/skills"], true),
    createProvider("cursor", [".cursor/skills", ".agents/skills"], true, {
      implicitInvocationField: "disable-model-invocation",
    }),
    createProvider("claude", [".claude/skills"], false),
    createProvider("codex", [".agents/skills"], true, {
      sidecarPath: "agents/openai.yaml",
    }),
  ];
}

function createProvider(
  name: string,
  projectPaths: string[],
  supportsAgentsDir: boolean,
  policyMapping: PolicyMapping = {},
): Provider {
  return {
    name,
    supportsAgentsDir,
    policyMapping,
    detectGlobalPaths(ctx) {
      if (name === "cursor") {
        return [join(ctx.homeDir, ".cursor", "skills")];
      }
      if (name === "claude") {
        return [join(ctx.homeDir, ".claude", "skills")];
      }
      return [];
    },
    detectProjectPaths(projectRoot) {
      return projectPaths.map((path) => join(projectRoot, path));
    },
    project(skill, target) {
      const installPath = join(target.projectRoot, providerInstallDir(name), skill.name);
      return {
        providerName: name,
        sourcePath: skill.canonicalPath ?? skill.rootPath,
        installPath,
        strategy: target.strategy,
        contentHash: skill.contentHash,
      };
    },
  };
}

function providerInstallDir(providerName: string): string {
  if (providerName === "cursor") {
    return ".cursor/skills";
  }
  if (providerName === "claude") {
    return ".claude/skills";
  }
  return ".agents/skills";
}
