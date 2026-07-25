import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdown } from "../public/assets/workbench-markdown.mjs";

test("report markdown renders GFM tables, quotes, rules, lists, and safe links", () => {
  const html = renderMarkdown(`
## 关键证据

> 只采用带时间戳的原始证据。

| 类别 | 来源 | 可靠性 |
| --- | --- | --- |
| 财报 | [SEC](https://www.sec.gov/filing) | 高 |

1. 核对原文
2. 检查反证

---

裸链接：https://example.com/report?id=7
`);

  assert.match(html, /<blockquote>/);
  assert.match(html, /class="markdown-table-wrap"/);
  assert.match(html, /<th>类别<\/th>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<hr>/);
  assert.match(html, /href="https:\/\/www\.sec\.gov\/filing"/);
  assert.match(html, /href="https:\/\/example\.com\/report\?id=7"/);
  assert.doesNotMatch(html, /javascript:/i);
});

test("report markdown escapes raw HTML and rejects unsafe link schemes", () => {
  const html = renderMarkdown(
    `<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n\`\`\`js\n<b>safe</b>\n\`\`\``,
  );

  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /<pre><code class="language-js">&lt;b&gt;safe&lt;\/b&gt;<\/code><\/pre>/);
});
