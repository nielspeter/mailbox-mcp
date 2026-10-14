import { describe, it, expect } from "vitest";
import { composeBody, plainTextToHtml } from "../../src/tools/body.js";

describe("composeBody", () => {
  it("defaults to HTML and keeps a body that is already HTML", () => {
    const body = "<p>Hej</p><ul><li><b>en</b></li></ul>";
    expect(composeBody(body, undefined)).toEqual({ body, html: true });
  });

  it("converts a plain-text body to paragraphs and line breaks", () => {
    expect(composeBody("Hej Niels-Peter\n\nTak.\nVenlig hilsen", undefined)).toEqual({
      body: "<p>Hej Niels-Peter</p>\n<p>Tak.<br>Venlig hilsen</p>",
      html: true,
    });
  });

  it("keeps text/plain when html is false", () => {
    expect(composeBody("a < b\n\nc", false)).toEqual({ body: "a < b\n\nc", html: false });
  });

  it("escapes markup-like text in a plain-text body", () => {
    expect(plainTextToHtml("1 < 2 & <script>")).toBe("<p>1 &lt; 2 &amp; &lt;script&gt;</p>");
  });

  it("does not mistake an address in angle brackets for HTML", () => {
    expect(composeBody("Skriv til <npr@xtelligent-data.dk>", undefined).body)
      .toBe("<p>Skriv til &lt;npr@xtelligent-data.dk&gt;</p>");
  });
});
