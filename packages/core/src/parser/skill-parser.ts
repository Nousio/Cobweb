import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { sha256 } from "../hash.js";
import type { ParsedResource, ParsedSection, ParsedSkill } from "../types.js";

interface MarkdownNode {
  type: string;
  depth?: number;
  value?: string;
  url?: string;
  lang?: string;
  children?: MarkdownNode[];
}

export async function parseSkillDirectory(rootPath: string): Promise<ParsedSkill> {
  const skillPath = resolve(rootPath, "SKILL.md");
  const content = await readFile(skillPath, "utf8");
  return parseSkillMarkdown(rootPath, content);
}

export function parseSkillMarkdown(rootPath: string, content: string): ParsedSkill {
  const warnings: string[] = [];
  const parsed = matter(content);
  const frontmatter = parsed.data as Record<string, unknown>;
  const markdown = parsed.content;
  const tree = unified().use(remarkParse).parse(markdown) as MarkdownNode;

  const name = readString(frontmatter.name);
  const description = readString(frontmatter.description);

  if (!name) {
    warnings.push("missing frontmatter.name");
  }
  if (!description) {
    warnings.push("missing frontmatter.description");
  }

  const sections = extractSections(tree);
  const resources = extractResources(rootPath, tree, frontmatter);

  return {
    name: name || fallbackName(rootPath),
    description,
    rootPath,
    frontmatter,
    rawFrontmatter: parsed.matter ?? "",
    sections,
    resources,
    policy: {
      implicitInvocation: readBoolean(frontmatter["implicit-invocation"] ?? frontmatter.implicitInvocation),
      selfContained: readBoolean(frontmatter["self-contained"] ?? frontmatter.selfContained),
    },
    contentHash: sha256(content),
    warnings,
  };
}

function extractSections(root: MarkdownNode): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  for (const node of root.children ?? []) {
    if (node.type === "heading") {
      if (current) {
        sections.push(current);
      }
      current = {
        title: textContent(node),
        depth: node.depth ?? 1,
        content: "",
      };
      continue;
    }

    const text = textContent(node).trim();
    if (text) {
      current ??= {
        title: "root",
        depth: 0,
        content: "",
      };
      current.content += current.content ? `\n${text}` : text;
    }
  }

  if (current) {
    sections.push(current);
  }

  return sections;
}

function extractResources(
  rootPath: string,
  root: MarkdownNode,
  frontmatter: Record<string, unknown>,
): ParsedResource[] {
  const resources: ParsedResource[] = [];

  walk(root, (node) => {
    if ((node.type === "link" || node.type === "image") && node.url) {
      resources.push(resourceFromPath(rootPath, node.url, node.type === "image" ? "image" : "markdown-link"));
    }

    if (node.type === "code" && node.lang && ["bash", "sh", "shell", "python", "js", "ts"].includes(node.lang)) {
      for (const candidate of extractPathLikeTokens(node.value ?? "")) {
        resources.push(resourceFromPath(rootPath, candidate, "script-reference"));
      }
    }
  });

  for (const value of Object.values(frontmatter)) {
    if (typeof value === "string" && looksLikeLocalPath(value)) {
      resources.push(resourceFromPath(rootPath, value, "frontmatter"));
    }
  }

  return dedupeResources(resources);
}

function resourceFromPath(rootPath: string, value: string, mentionedBy: ParsedResource["mentionedBy"]): ParsedResource {
  const isExternal = /^[a-z][a-z0-9+.-]*:/i.test(value);
  const absolute = isAbsolute(value);
  const normalized = isExternal ? value : normalize(value);
  const resolved = absolute ? normalize(value) : resolve(rootPath, normalized);
  const rel = relative(rootPath, resolved);

  return {
    path: value,
    isExternal,
    isAbsolute: absolute,
    escapesRoot: !isExternal && (rel.startsWith("..") || absolute),
    mentionedBy,
  };
}

function dedupeResources(resources: ParsedResource[]): ParsedResource[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = `${resource.path}:${resource.mentionedBy}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function extractPathLikeTokens(text: string): string[] {
  const matches = text.matchAll(/(?:^|[\s'"`])((?:\.{1,2}\/|\/(?!\/))[^\s'"`]+)/g);
  return Array.from(matches, (match) => match[1]!).filter((token) => !/^[a-z][a-z0-9+.-]*:/i.test(token));
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    walk(child, visit);
  }
}

function textContent(node: MarkdownNode): string {
  if (typeof node.value === "string") {
    return node.value;
  }
  return (node.children ?? []).map(textContent).join("");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function fallbackName(rootPath: string): string {
  return rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "unknown";
}

function looksLikeLocalPath(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../") || value.startsWith("/");
}
