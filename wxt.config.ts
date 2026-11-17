import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-svelte"],
  srcDir: "src",
  browser: "firefox",
  manifestVersion: 2,
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
        id: "translmate@sftbl.local",
        data_collection_permissions: {
          required: ["websiteContent", "personalCommunications", "browsingActivity", "authenticationInfo"],
        },
      },
      gecko_android: { strict_min_version: "142.0" },
    },
  },
});
