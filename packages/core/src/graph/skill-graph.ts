import { access } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { sha256 } from "../hash.js";
import { parseSkillDirectory } from "../parser/skill-parser.js";
import { findSkillDirectories } from "../scan/scan.js";
import type {
  ParsedResource,
  ParsedSkill,
  SkillGraphEdge,
  SkillGraphNode,
  SkillGraphPath,
  SkillGraphResult
} from "../types.js";

export interface SkillGraphOptions {
  maxDepth?: number;
  includeExternal?: boolean;
}

interface ParsedGraphSkill {
  rootPath: string;
  relativePath: string;
  depth: number;
  skill: ParsedSkill;
}

const DEFAULT_MAX_DEPTH = 32;

export async function buildSkillGraph(scanRoot: string, options: SkillGraphOptions = {}): Promise<SkillGraphResult> {
  const root = resolve(scanRoot);
  const maxDepth = normalizeMaxDepth(options.maxDepth);
  const includeExternal = options.includeExternal ?? true;
  const warnings: string[] = [];
  const nodes = new Map<string, SkillGraphNode>();
  const edges: SkillGraphEdge[] = [];

  const skillRoots = await findSkillDirectories(root);
  const parsedSkills = await parseSkills(root, skillRoots, warnings);
  const skillByRoot = new Map(parsedSkills.map((entry) => [normalizePath(entry.rootPath), entry]));
  const scanRootSkill = skillByRoot.get(normalizePath(root));
  const rootId = scanRootSkill ? skillId(scanRootSkill.rootPath) : `scan_root:${sha256(root)}`;

  nodes.set(rootId, {
    id: rootId,
    kind: scanRootSkill ? "skill" : "scan_root",
    path: root,
    relativePath: ".",
    depth: 0,
    name: scanRootSkill?.skill.name,
  });

  for (const entry of parsedSkills) {
    const id = skillId(entry.rootPath);
    if (id === rootId) {
      continue;
    }
    nodes.set(id, skillNode(entry));
  }

  addHierarchyEdges(rootId, parsedSkills, skillByRoot, edges);

  for (const entry of parsedSkills) {
    await addResourceEdges(root, entry, parsedSkills, nodes, edges, warnings, includeExternal);
  }

  const enumeration = enumeratePaths(rootId, nodes, edges, maxDepth, warnings);
  const sortedNodes = Array.from(nodes.values()).sort(compareNodes);

  return {
    root,
    scanRootIsSkill: Boolean(scanRootSkill),
    nodes: sortedNodes,
    edges: sortEdges(edges, nodes),
    paths: enumeration.paths,
    warnings,
    truncated: enumeration.truncated,
  };
}

async function parseSkills(root: string, skillRoots: string[], warnings: string[]): Promise<ParsedGraphSkill[]> {
  const results = await Promise.allSettled(
    skillRoots.map(async (skillRoot) => {
      const resolvedRoot = resolve(skillRoot);
      const skill = await parseSkillDirectory(resolvedRoot);
      const rel = relativePath(root, resolvedRoot);
      return {
        rootPath: resolvedRoot,
        relativePath: rel,
        depth: pathDepth(rel),
        skill,
      };
    }),
  );

  const parsed: ParsedGraphSkill[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      parsed.push(result.value);
      return;
    }
    warnings.push(`${skillRoots[index] ?? "unknown"}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  });
  return parsed.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function addHierarchyEdges(
  rootId: string,
  parsedSkills: ParsedGraphSkill[],
  skillByRoot: Map<string, ParsedGraphSkill>,
  edges: SkillGraphEdge[],
): void {
  for (const entry of parsedSkills) {
    const id = skillId(entry.rootPath);
    if (id === rootId) {
      continue;
    }
    const parent = nearestSkillAncestor(entry.rootPath, skillByRoot);
    edges.push({
      from: parent ? skillId(parent.rootPath) : rootId,
      to: id,
      kind: "contains",
    });
  }
}

async function addResourceEdges(
  root: string,
  entry: ParsedGraphSkill,
  parsedSkills: ParsedGraphSkill[],
  nodes: Map<string, SkillGraphNode>,
  edges: SkillGraphEdge[],
  warnings: string[],
  includeExternal: boolean,
): Promise<void> {
  const from = skillId(entry.rootPath);
  for (const resource of entry.skill.resources) {
    if (resource.isExternal) {
      if (!includeExternal) {
        continue;
      }
      const id = `external:${sha256(resource.path)}`;
      nodes.set(id, {
        id,
        kind: "external",
        path: resource.path,
        relativePath: resource.path,
        depth: entry.depth + 1,
      });
      edges.push({
        from,
        to: id,
        kind: "references",
        via: resource.mentionedBy,
        rawPath: resource.path,
        resolvedPath: resource.path,
        external: true,
      });
      continue;
    }

    const resolvedPath = resolveLocalResource(entry.rootPath, resource);
    const targetSkill = referencedSkill(resolvedPath, parsedSkills);
    if (targetSkill && normalizePath(targetSkill.rootPath) !== normalizePath(entry.rootPath)) {
      edges.push({
        from,
        to: skillId(targetSkill.rootPath),
        kind: "references_skill",
        via: resource.mentionedBy,
        rawPath: resource.path,
        resolvedPath,
      });
      continue;
    }

    const id = `resource:${sha256(resolvedPath)}`;
    nodes.set(id, {
      id,
      kind: "resource",
      path: resolvedPath,
      relativePath: relativePath(root, resolvedPath),
      depth: pathDepth(relativePath(root, resolvedPath)),
      name: resourceName(resolvedPath),
    });
    const edge: SkillGraphEdge = {
      from,
      to: id,
      kind: "references",
      via: resource.mentionedBy,
      rawPath: resource.path,
      resolvedPath,
      unresolved: false,
    };
    await markUnresolved(resolvedPath, edge, warnings);
    edges.push(edge);
  }
}

function nearestSkillAncestor(skillRoot: string, skillByRoot: Map<string, ParsedGraphSkill>): ParsedGraphSkill | null {
  let current = dirname(skillRoot);
  for (; ;) {
    const parent = skillByRoot.get(normalizePath(current));
    if (parent) {
      return parent;
    }
    const next = dirname(current);
    if (next === current) {
      return null;
    }
    current = next;
  }
}

function referencedSkill(resolvedPath: string, parsedSkills: ParsedGraphSkill[]): ParsedGraphSkill | null {
  const normalized = normalizePath(resolvedPath);
  const matches = parsedSkills
    .filter((entry) => {
      const root = normalizePath(entry.rootPath);
      const skillFile = normalizePath(join(entry.rootPath, "SKILL.md"));
      return normalized === root || normalized === skillFile || normalized.startsWith(`${root}/`);
    })
    .sort((left, right) => right.rootPath.length - left.rootPath.length);
  return matches[0] ?? null;
}

function enumeratePaths(
  rootId: string,
  nodes: Map<string, SkillGraphNode>,
  edges: SkillGraphEdge[],
  maxDepth: number,
  warnings: string[],
): { paths: SkillGraphPath[]; truncated: boolean } {
  const byFrom = new Map<string, SkillGraphEdge[]>();
  for (const edge of edges) {
    const list = byFrom.get(edge.from) ?? [];
    list.push(edge);
    byFrom.set(edge.from, list);
  }
  for (const list of byFrom.values()) {
    list.sort((left, right) => (nodes.get(left.to)?.relativePath ?? left.to).localeCompare(nodes.get(right.to)?.relativePath ?? right.to));
  }

  const paths: SkillGraphPath[] = [];
  let truncated = false;
  const visit = (id: string, trail: string[], seen: Set<string>): void => {
    const next = byFrom.get(id) ?? [];
    if (trail.length - 1 >= maxDepth) {
      truncated ||= next.length > 0;
      paths.push({ nodes: trail, leafKind: nodes.get(id)?.kind ?? "resource" });
      return;
    }
    if (next.length === 0) {
      paths.push({ nodes: trail, leafKind: nodes.get(id)?.kind ?? "resource" });
      return;
    }
    for (const edge of next) {
      if (seen.has(edge.to)) {
        warnings.push(`cycle detected at ${nodes.get(edge.to)?.path ?? edge.to}`);
        paths.push({ nodes: [...trail, edge.to], leafKind: nodes.get(edge.to)?.kind ?? "resource" });
        continue;
      }
      visit(edge.to, [...trail, edge.to], new Set([...seen, edge.to]));
    }
  };
  visit(rootId, [rootId], new Set([rootId]));
  return { paths, truncated };
}

function skillNode(entry: ParsedGraphSkill): SkillGraphNode {
  return {
    id: skillId(entry.rootPath),
    kind: "skill",
    path: entry.rootPath,
    relativePath: entry.relativePath,
    depth: entry.depth,
    name: entry.skill.name,
  };
}

function skillId(path: string): string {
  return sha256(path);
}

function normalizeMaxDepth(value: number | undefined): number {
  // Guard against NaN/Infinity from CLI parsing so depth truncation stays effective.
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_DEPTH;
  }
  return Math.max(1, Math.floor(value));
}

function resolveLocalResource(skillRoot: string, resource: ParsedResource): string {
  return resource.isAbsolute ? normalize(resource.path) : resolve(skillRoot, resource.path);
}

async function markUnresolved(path: string, edge: SkillGraphEdge, warnings: string[]): Promise<void> {
  try {
    await access(path);
  } catch {
    edge.unresolved = true;
    warnings.push(`${path}: referenced path does not exist`);
  }
}

function relativePath(root: string, path: string): string {
  const rel = relative(root, path).replace(/\\/g, "/");
  return rel || ".";
}

function pathDepth(path: string): number {
  if (path === ".") {
    return 0;
  }
  return path.split("/").filter(Boolean).length;
}

function resourceName(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return path;
  }
  return path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path;
}

function normalizePath(path: string): string {
  return normalize(path).replace(/\\/g, "/");
}

function compareNodes(left: SkillGraphNode, right: SkillGraphNode): number {
  const path = left.relativePath.localeCompare(right.relativePath);
  if (path !== 0) {
    return path;
  }
  return left.kind.localeCompare(right.kind);
}

function sortEdges(edges: SkillGraphEdge[], nodes: Map<string, SkillGraphNode>): SkillGraphEdge[] {
  return [...edges].sort((left, right) => {
    const from = (nodes.get(left.from)?.relativePath ?? left.from).localeCompare(nodes.get(right.from)?.relativePath ?? right.from);
    if (from !== 0) {
      return from;
    }
    return (nodes.get(left.to)?.relativePath ?? left.to).localeCompare(nodes.get(right.to)?.relativePath ?? right.to);
  });
}
