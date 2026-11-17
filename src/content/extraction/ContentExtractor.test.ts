import { describe, expect, test } from "vitest";
import {
  articlePageHtml,
  misleadingArticleCardPageHtml,
  richTextArticlePageHtml,
} from "../../test/fixtures/pages";
import { ContentExtractor } from "./ContentExtractor";

const parseDocument = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("ContentExtractor", () => {
  test("extracts article content and excludes navigation, footer, and sidebar chrome", () => {
    const result = new ContentExtractor().extract(parseDocument(articlePageHtml), {
      viewportHeight: 900,
    });

    const markdown = result.units.map((unit) => unit.markdown).join("\n");
    expect(markdown).toContain("Translation tools need to understand the main content");
    expect(markdown).toContain("a useful link");
    expect(markdown).not.toContain("Home");
    expect(markdown).not.toContain("Pricing");
    expect(markdown).not.toContain("Contact and legal links");
  });

  test("extracts rich text article title and Draft.js-style body blocks", () => {
    const result = new ContentExtractor().extract(parseDocument(richTextArticlePageHtml), {
      viewportHeight: 900,
    });

    const markdown = result.units.map((unit) => unit.markdown).join("\n");
    expect(markdown).toContain("Loop Engineering.");
    expect(markdown).toContain("Loop engineering is replacing yourself as the person who prompts the agent.");
    expect(markdown).toContain("You design the system that does it instead.");
    expect(markdown).not.toContain("Reply draft should not translate");
    expect(markdown).not.toContain("286");
  });

  test("ignores a small article card when a substantial prose body exists", () => {
    const result = new ContentExtractor().extract(parseDocument(misleadingArticleCardPageHtml), {
      viewportHeight: 900,
    });

    const markdown = result.units.map((unit) => unit.markdown).join("\n");
    expect(result.root).toMatchObject({
      className: "model-card-content prose",
    });
    expect(markdown).toContain("Model Introduction");
    expect(markdown).toContain("actual model card");
    expect(markdown).not.toContain("Small related collection card");
  });
});
