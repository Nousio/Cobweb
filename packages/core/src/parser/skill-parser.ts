import fg from "fast-glob";
import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { sha256 } from "../hash.js";
import type { ParsedMethodSummary, ParsedResource, ParsedSection, ParsedSkill } from "../types.js";

interface MarkdownNode {
  type: string;
  depth?: number;
  value?: string;
  url?: string;
  lang?: string;
  children?: MarkdownNode[];
}

export interface ParsedSkillGraphEntry {
  name: string;
  resources: ParsedResource[];
}

export async function parseSkillDirectory(rootPath: string): Promise<ParsedSkill> {
  const skillPath = resolve(rootPath, "SKILL.md");
  const content = await readFile(skillPath, "utf8");
  const parsed = parseSkillMarkdown(rootPath, content);
  return {
    ...parsed,
    resources: dedupeResources([...parsed.resources, ...(await standardDirectoryResources(rootPath))]),
  };
}

export async function parseSkillGraphEntry(rootPath: string): Promise<ParsedSkillGraphEntry> {
  const skillPath = resolve(rootPath, "SKILL.md");
  const content = await readFile(skillPath, "utf8");
  const parsed = matter(content);
  const frontmatter = parsed.data as Record<string, unknown>;
  const tree = unified().use(remarkParse).parse(parsed.content) as MarkdownNode;
  const name = readString(frontmatter.name) || fallbackName(rootPath);
  return {
    name,
    resources: dedupeResources([...extractResources(rootPath, tree, frontmatter), ...(await standardDirectoryResources(rootPath))]),
  };
}

export function parseSkillMarkdown(rootPath: string, content: string): ParsedSkill {
  const warnings: string[] = [];
  const parsed = matter(content);
  const frontmatter = parsed.data as Record<string, unknown>;
  const markdown = parsed.content;
  const tree = unified().use(remarkParse).parse(markdown) as MarkdownNode;

  const name = readString(frontmatter.name);
  const frontmatterDescription = readString(frontmatter.description);

  if (!name) {
    warnings.push("missing frontmatter.name");
  }
  warnings.push(...extensionFieldWarnings(frontmatter));

  const sections = extractSections(tree);
  const description = frontmatterDescription || fallbackDescription(sections);
  const resources = extractResources(rootPath, tree, frontmatter);
  const methodSummaries = extractMethodSummaries(sections);

  return {
    name: name || fallbackName(rootPath),
    description,
    rootPath,
    frontmatter,
    rawFrontmatter: parsed.matter ?? "",
    body: markdown,
    sections,
    methodSummaries,
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

function extractMethodSummaries(sections: ParsedSection[]): ParsedMethodSummary[] {
  const summaries: ParsedMethodSummary[] = [];
  const actionableSections = sections.filter((section) => section.content && isActionableHeading(section.title));
  const sourceSections = actionableSections.length > 0 ? actionableSections : sections.filter((section) => section.content).slice(0, 1);
  const seenSummaries = new Set<string>();

  sourceSections.forEach((section) => {
    const index = sections.indexOf(section);
    if (!section.content && section.title === "root") {
      return;
    }

    const summary = summarizeSection(section);
    if (!summary) {
      return;
    }
    const summaryKey = summary.toLowerCase();
    if (seenSummaries.has(summaryKey)) {
      return;
    }
    seenSummaries.add(summaryKey);

    summaries.push({
      methodName: methodName(section.title, index),
      summary,
      triggerTerms: triggerTerms(`${section.title} ${summary}`),
      inputs: labeledValues(section.content, ["input", "inputs", "requires", "requirements", "输入", "需要"]),
      outputs: labeledValues(section.content, ["output", "outputs", "result", "returns", "输出", "结果"]),
      requiredTools: requiredTools(section.content),
      sourceSectionRange: {
        startSection: index,
        endSection: index,
      },
      extractionConfidence: extractionConfidence(section),
    });
  });

  return summaries.slice(0, 8);
}

function isActionableHeading(title: string): boolean {
  return /\b(?:method|instructions?|when to use|use when|trigger(?:s| scenarios?)?|scenarios?|guardrails?|workflow|decision workflow|review checklist|checklists?|procedure|steps?|usage|examples?|inputs?|outputs?|tools?|run|invoke|command)\b|方法|说明|何时使用|使用时机|触发场景|场景|护栏|流程|决策流程|检查清单|步骤|使用|示例|输入|输出|工具|执行/iu.test(title);
}

function summarizeSection(section: ParsedSection): string {
  const content = section.content
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim())
    .find(Boolean);

  return truncateAtSentence(content ?? section.title, 220);
}

function fallbackDescription(sections: ParsedSection[]): string {
  const firstContentSection = sections.find((section) => section.content.trim());
  return firstContentSection ? summarizeSection(firstContentSection) : "";
}

function methodName(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `method-${index + 1}`;
}

function triggerTerms(input: string): string[] {
  const stopWords = new Set([
    "and",
    "for",
    "the",
    "this",
    "that",
    "with",
    "from",
    "into",
    "not",
    "when",
    "then",
    "your",
    "without",
    "skill",
    "method",
  ]);

  return Array.from(
    new Set(
      input
        .toLowerCase()
        .split(/[^a-z0-9\u4e00-\u9fff]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3 && !stopWords.has(token)),
    ),
  ).slice(0, 8);
}

function labeledValues(content: string, labels: string[]): string[] {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:${escaped})\\s*[:：]\\s*(.+)`, "giu");
  return Array.from(content.matchAll(pattern), (match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .slice(0, 6);
}

function requiredTools(content: string): string[] {
  const values = labeledValues(content, ["tool", "tools", "required tools", "commands", "工具", "命令"]);
  const inlineTools = Array.from(content.matchAll(/`([a-z][a-z0-9_-]{2,})`/gi))
    .filter((match) => {
      const start = match.index ?? 0;
      const context = content.slice(Math.max(0, start - 40), start + match[0].length + 40);
      return /(?:tool|command|cli|mcp|工具|命令)/i.test(context);
    })
    .map((match) => match[1]!);
  return Array.from(new Set([...values.flatMap(splitCsv), ...inlineTools])).slice(0, 8);
}

function splitCsv(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractionConfidence(section: ParsedSection): number {
  if (isActionableHeading(section.title)) {
    return 0.85;
  }
  return section.content.length > 120 ? 0.65 : 0.5;
}

function truncateAtSentence(input: string, maxLength: number): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const sentenceEnd = normalized.slice(0, maxLength).search(/[.!?。！？](?=\s|$)/u);
  if (sentenceEnd >= 80) {
    return normalized.slice(0, sentenceEnd + 1);
  }

  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
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

async function standardDirectoryResources(rootPath: string): Promise<ParsedResource[]> {
  const files = await fg(["scripts/**", "references/**", "assets/**"], {
    cwd: rootPath,
    absolute: false,
    dot: true,
    onlyFiles: true,
  });

  return files.sort().map((file) => resourceFromPath(rootPath, `.${sep}${file}`.replace(/\\/g, "/"), "standard-resource"));
}

function extensionFieldWarnings(frontmatter: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const booleanFields = ["disable-model-invocation", "user-invokable", "user-invocable"];
  const arrayFields = ["allowed-tools", "paths", "context", "compatibility"];
  const objectFields = ["metadata"];
  const stringFields = ["license"];

  for (const field of booleanFields) {
    if (field in frontmatter && typeof frontmatter[field] !== "boolean") {
      warnings.push(`frontmatter.${field} should be boolean when provided`);
    }
  }
  for (const field of arrayFields) {
    if (field in frontmatter && !Array.isArray(frontmatter[field])) {
      warnings.push(`frontmatter.${field} should be an array when provided`);
    }
  }
  for (const field of objectFields) {
    const value = frontmatter[field];
    if (field in frontmatter && (!value || typeof value !== "object" || Array.isArray(value))) {
      warnings.push(`frontmatter.${field} should be an object when provided`);
    }
  }
  for (const field of stringFields) {
    if (field in frontmatter && typeof frontmatter[field] !== "string") {
      warnings.push(`frontmatter.${field} should be string when provided`);
    }
  }

  return warnings;
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
