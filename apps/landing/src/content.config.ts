import { defineCollection } from "astro:content";
import type { Loader } from "astro/loaders";
import { z } from "astro/zod";
import { docs as all } from "./lib/docs";

// Renders the docs that lib/docs reads (setup.md from docs/install plus
// src/content/docs), so the HTML pages and llms.txt share one source.
const docsLoader: Loader = {
  name: "docs",
  async load(ctx) {
    ctx.store.clear();
    for (const d of all) {
      ctx.store.set({
        id: d.id,
        data: { title: d.title, description: d.description, order: d.order },
        body: d.body,
        rendered: await ctx.renderMarkdown(d.body),
      });
    }
  },
};

const docs = defineCollection({
  loader: docsLoader,
  schema: z.object({
    title: z.string(),
    description: z.string(),
    order: z.number(),
  }),
});

export const collections = { docs };
