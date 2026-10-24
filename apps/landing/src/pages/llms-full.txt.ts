import { docMarkdown, docs } from "../lib/docs";
import { SUMMARY } from "../lib/llms";

export const GET = (): Response =>
  new Response(
    [`# OpenBus\n\n> ${SUMMARY}\n`, ...docs.map(docMarkdown)].join("\n---\n\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
