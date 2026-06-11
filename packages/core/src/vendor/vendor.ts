import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { sha256 } from "../hash.js";
import { parseSkillDirectory } from "../parser/skill-parser.js";
import type { ParsedResource, VendorAction, VendorPlan } from "../types.js";

export async function createVendorPlan(skillRoot: string, dryRun = true): Promise<VendorPlan> {
  const root = resolve(skillRoot);
  const skill = await parseSkillDirectory(root);
  const actions: VendorAction[] = [];
  const warnings: string[] = [];
  const usedNames = new Set<string>();

  for (const resource of skill.resources) {
    if (resource.isExternal) {
      warnings.push(`External resource requires manual vendoring: ${resource.path}`);
      continue;
    }
    if (resource.isAbsolute) {
      warnings.push(`Absolute resource requires manual review before vendoring: ${resource.path}`);
      continue;
    }
    if (!resource.escapesRoot && !resource.isAbsolute) {
      continue;
    }

    const sourcePath = resolveResource(root, resource);
    const vendorName = uniqueVendorName(sourcePath, usedNames);
    const targetPath = join(root, "resources", "vendor", vendorName);
    actions.push({
      sourcePath,
      targetPath,
      rewriteFrom: resource.path,
      rewriteTo: `./resources/vendor/${vendorName}`,
      exists: await pathExists(sourcePath),
    });
  }

  return { skillPath: root, dryRun, actions, warnings };
}

export async function applyVendorPlan(plan: VendorPlan): Promise<VendorPlan> {
  for (const action of plan.actions) {
    if (!action.exists) {
      continue;
    }
    await mkdir(dirname(action.targetPath), { recursive: true });
    await copyFile(action.sourcePath, action.targetPath);
  }

  const skillPath = join(plan.skillPath, "SKILL.md");
  let content = await readFile(skillPath, "utf8");
  for (const action of plan.actions) {
    if (action.exists) {
      content = rewriteResourceToken(content, action);
    }
  }
  await writeFile(skillPath, content, "utf8");

  return { ...plan, dryRun: false };
}

function resolveResource(skillRoot: string, resource: ParsedResource): string {
  return resource.isAbsolute ? resource.path : resolve(skillRoot, resource.path);
}

function uniqueVendorName(sourcePath: string, usedNames: Set<string>): string {
  const original = basename(sourcePath);
  if (!usedNames.has(original)) {
    usedNames.add(original);
    return original;
  }

  const ext = extname(original);
  const stem = ext ? original.slice(0, -ext.length) : original;
  const unique = `${stem}-${sha256(sourcePath).slice(0, 8)}${ext}`;
  usedNames.add(unique);
  return unique;
}

function rewriteResourceToken(content: string, action: VendorAction): string {
  const escaped = escapeRegExp(action.rewriteFrom);
  const replacement = action.rewriteTo.replace(/\$/g, "$$$$");
  const markdownUrl = new RegExp(`(\\]\\(\\s*)${escaped}(\\s*(?:["'][^)]*)?\\))`, "g");
  const pathToken = new RegExp(`(^|[\\s'"\\\`])${escaped}(?=$|[\\s'"\\\`)])`, "gm");
  return content
    .replace(markdownUrl, `$1${replacement}$2`)
    .replace(pathToken, `$1${replacement}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
