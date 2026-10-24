import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://open-bus.ai",
  output: "static",
  build: { format: "directory", inlineStylesheets: "always" },
  markdown: {
    shikiConfig: { themes: { light: "github-light", dark: "github-dark" } },
  },
});
