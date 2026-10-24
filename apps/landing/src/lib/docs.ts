// The docs, read once at build time as raw Markdown. Plain Vite imports (no
// astro:content) so llms.txt, the .md copies, the HTML pages and the tests all
// read the same files and cannot drift.
import setupMd from "../../../../docs/install/setup.md?raw";
import { REPO_URL, SITE_URL } from "../consts";

// The install procedure is Platform's docs/install/setup.md. It writes
// {REPO_URL} and {LATEST_RELEASE_API} so the repo URL lives only in @ob/shared.
const PLACEHOLDERS: Record<string, string> = {
  "{REPO_URL}": REPO_URL,
  "{LATEST_RELEASE_API}": `${REPO_URL.replace("https://github.com/", "https://api.github.com/repos/")}/releases/latest`,
};
const fill = (body: string) =>
  Object.entries(PLACEHOLDERS).reduce((b, [k, v]) => b.replaceAll(k, v), body);

export type Doc = {
  id: string;
  title: string;
  description: string;
  order: number;
  /** Markdown after the frontmatter, placeholders filled. */
  body: string;
};

function parse(id: string, raw: string): Doc {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) throw new Error(`${id}.md has no frontmatter`);
  const data: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) data[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const { title, description, order } = data;
  if (!title || !description || !order)
    throw new Error(`${id}.md needs title, description and order`);
  return {
    id,
    title,
    description,
    order: Number(order),
    body: fill(raw.slice(m[0].length)).trim(),
  };
}

const local = import.meta.glob<string>("../content/docs/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

export const docs: Doc[] = [
  parse("setup", setupMd),
  ...Object.entries(local).map(([path, raw]) =>
    parse(path.replace(/^.*\/|\.md$/g, ""), raw),
  ),
].sort((a, b) => a.order - b.order);

export function doc(id: string): Doc {
  const d = docs.find((x) => x.id === id);
  if (!d) throw new Error(`missing doc ${id}`);
  return d;
}

/** Drop HTML comments and point site links at the Markdown copies agents read. */
export function agentMarkdown(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->\n*/g, "")
    .replace(/\]\(\/docs\/([a-z-]+)\/\)/g, `](${SITE_URL}/docs/$1.md)`)
    .trim();
}

/** The body of a `## heading` section, up to the next `## ` heading. */
export function section(d: Doc, heading: string): string {
  const body = agentMarkdown(d.body);
  const start = body.indexOf(`\n## ${heading}\n`);
  if (start < 0) throw new Error(`${d.id}.md has no "## ${heading}"`);
  const rest = body.slice(start + heading.length + 5);
  const end = rest.search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/** A doc as one self-contained Markdown file. */
export const docMarkdown = (d: Doc): string =>
  `# ${d.title}\n\n> ${d.description}\n\n${agentMarkdown(d.body)}\n`;
