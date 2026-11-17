import { defineConfig } from "wxt";
import { resolve } from "node:path";

export default defineConfig({
  modules: ["@wxt-dev/module-svelte"],
  srcDir: "src",
  browser: "firefox",
  manifestVersion: 2,
  hooks: {
    "vite:build:extendConfig": (entrypoints, config) => {
      const group = entrypoints
        .map((entry) => entry.name)
        .sort()
        .join("-");
      config.build = { ...config.build, license: { fileName: `licenses/${group}.md` } };
    },
    "build:publicAssets": (wxt, files) => {
      for (const name of ["LICENSE-MIT", "LICENSE-APACHE"]) {
        files.push({ absoluteSrc: resolve(wxt.config.root, name), relativeDest: name });
      }
    },
  },
  zip: {
    dotSources: true,
    includeSources: [
      "src/**",
      "public/**",
      "scripts/**",
      "docs/decisions/**",
      "docs/amo-reviewer-notes.md",
      "docs/privacy.md",
      "docs/page-agent-architecture.md",
      "changelog/**",
      "changelog.md",
      "README.md",
      "LICENSE-*",
      "package.json",
      "pnpm-lock.yaml",
      "*.config.ts",
      "tsconfig.json",
      "test.html",
      ".prettierrc.json",
      ".prettierignore",
      ".oxlintrc.json",
      ".editorconfig",
      ".gitattributes",
    ],
  },
  manifest: {
    name: "Translmate",
    homepage_url: "https://github.com/sftblw/translmate",
    description: "Translate the page you are reading with your chosen language model.",
    permissions: ["activeTab", "tabs", "storage", "webNavigation", "<all_urls>"],
    icons: {
      "16": "icon.svg",
      "32": "icon.svg",
      "48": "icon.svg",
      "96": "icon.svg",
      "128": "icon.svg",
    },
    host_permissions: ["<all_urls>"],
    browser_specific_settings: {
      gecko: {
        strict_min_version: "140.0",
        id: "translmate@sftblw.moe",
        data_collection_permissions: {
          required: ["websiteContent", "personalCommunications", "browsingActivity", "authenticationInfo"],
        },
      },
      gecko_android: { strict_min_version: "142.0" },
    },
  },
});
