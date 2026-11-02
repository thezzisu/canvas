import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPasteParts, type PastePart } from "./paste.ts";

test("mixed paste keeps text, images, files and repeated references in their original positions", () => {
  const parts: PastePart[] = ["Compare **before**\n", { file: 0, format: "markdown", image: true, label: "before.png" },
    "\nWith ", { file: 1, format: "markdown", label: "Report.pdf" }, "\ncat ", { file: 1, format: "path" }, "\n"];
  const preview = renderPasteParts(parts, ["/uploaded/before.png", "/uploaded/Report.pdf"]);
  assert.equal(preview, "Compare **before**\n![before.png](/uploaded/before.png)\nWith [Report.pdf](/uploaded/Report.pdf)\ncat '/uploaded/Report.pdf'\n");
  assert.equal(renderPasteParts(parts, ["/inbox/a_before.png", "/inbox/b_Report.pdf"]),
    preview.replaceAll("/uploaded/before.png", "/inbox/a_before.png").replaceAll("/uploaded/Report.pdf", "/inbox/b_Report.pdf"));
});

test("Markdown escapes filenames without losing readable Unicode or interpreting destination syntax", () => {
  const filename = "风景 [1] O'Brien (2)%#?.png";
  assert.equal(renderPasteParts([{ file: 0, format: "markdown", image: true, label: filename }], [`/uploaded/${filename}`]),
    "![风景 \\[1\\] O'Brien (2)%#?.png](/uploaded/风景%20%5B1%5D%20O%27Brien%20%282%29%25%23%3F.png)");
  assert.equal(renderPasteParts([{ file: 0, format: "markdown", label: "\\_*`<&>\r\nnext" }], ["/a\\b[c]\td"]),
    "[\\\\\\_\\*\\`\\<\\&\\> next](/a%5Cb%5Bc%5D%09d)");
  assert.equal(renderPasteParts([{ file: 0, format: "markdown", label: "copyright" }], ["/uploaded/&copy;.txt"]),
    "[copyright](/uploaded/%26copy;.txt)");
});

test("path format quotes apostrophes and keeps filenames literal", () => {
  assert.equal(renderPasteParts(["cat ", { file: 0, format: "path" }], ["/uploaded/O'Brien $price.txt"]),
    "cat '/uploaded/O'\\''Brien $price.txt'");
  assert.throws(() => renderPasteParts([{ file: 1, format: "path" }], ["/file"]), /Invalid paste file reference/u);
  assert.throws(() => renderPasteParts([{ file: 0, format: "markdown" }], ["/file\0"]), /Invalid paste file reference/u);
});
