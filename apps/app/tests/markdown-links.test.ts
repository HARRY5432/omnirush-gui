import { describe, expect, test } from "bun:test";

import { renderMarkdownHtml } from "../src/components/markdown/markdown-primitive";

function hrefs(html: string): string[] {
  return [...html.matchAll(/<a [^>]*?href="([^"]*)"/g)].map((match) => match[1] ?? "");
}

describe("markdown link targets", () => {
  test("network paths never become clickable links", () => {
    // Markdown source; after its backslash unescaping each href starts with
    // two slashes or backslashes (`\\\\` in the source is `\\` in the href).
    for (const target of ["//attacker.example/share/setup.exe", "\\\\\\\\attacker.example\\share\\setup.exe", "/\\\\attacker.example/x.exe", "\\\\/attacker.example/x.exe", "/\t/attacker.example/x.exe"]) {
      const html = renderMarkdownHtml(`[report](<${target}>)`);
      expect(hrefs(html)).toEqual(["#"]);
      const image = renderMarkdownHtml(`![chart](<${target}>)`);
      expect(image).not.toContain("attacker.example/share");
    }
  });

  test("web, mail and local relative links keep working", () => {
    expect(hrefs(renderMarkdownHtml("[site](https://example.com/a?b=1)"))).toEqual(["https://example.com/a?b=1"]);
    expect(hrefs(renderMarkdownHtml("[mail](mailto:team@example.com)"))).toEqual(["mailto:team@example.com"]);
    expect(hrefs(renderMarkdownHtml("[notes](./docs/notes.md)"))).toEqual(["./docs/notes.md"]);
    expect(hrefs(renderMarkdownHtml("[abs](/docs/notes.md)"))).toEqual(["/docs/notes.md"]);
    expect(hrefs(renderMarkdownHtml("[anchor](#section)"))).toEqual(["#section"]);
    expect(hrefs(renderMarkdownHtml("[script](javascript:alert(1))"))).toEqual(["#"]);
  });
});
