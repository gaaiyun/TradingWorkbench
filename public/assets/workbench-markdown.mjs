function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeUrl(value, baseUrl) {
  try {
    const url = new URL(String(value || ""), baseUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function inlineMarkdown(raw, baseUrl) {
  const tokens = [];
  const stash = (html) => {
    const token = `\u0000M${tokens.length}\u0000`;
    tokens.push(html);
    return token;
  };
  let text = String(raw || "")
    .replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${escapeHtml(code)}</code>`))
    .replace(/\[([^\]]+)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label, href) => {
      const url = safeUrl(href, baseUrl);
      return url
        ? stash(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`)
        : escapeHtml(label);
    })
    .replace(/https?:\/\/[^\s<>"'\]\u0000]+/g, (candidate) => {
      const trailing = /[),.;，。！？!?]+$/.exec(candidate)?.[0] || "";
      const href = candidate.slice(0, candidate.length - trailing.length);
      const url = safeUrl(href, baseUrl);
      return url
        ? `${stash(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>`)}${trailing}`
        : candidate;
    });
  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,，。])/g, "$1<em>$2</em>");
  tokens.forEach((html, index) => {
    text = text.replace(`\u0000M${index}\u0000`, html);
  });
  return text;
}

function tableCells(line) {
  const trimmed = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableDivider(line) {
  const cells = tableCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function renderMarkdown(markdown, {
  baseUrl = "https://tradingagents-board.pages.dev/",
} = {}) {
  const lines = String(markdown || "").replaceAll("\r\n", "\n").split("\n");
  const output = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      output.push(`<p>${inlineMarkdown(paragraph.join(" "), baseUrl)}</p>`);
    }
    paragraph = [];
  };
  const closeList = () => {
    if (list) output.push(`</${list}>`);
    list = null;
  };
  const flushBlocks = () => {
    flushParagraph();
    closeList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    const fence = /^```([A-Za-z0-9_-]*)\s*$/.exec(trimmed);
    if (fence) {
      flushBlocks();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1].toLowerCase())}"` : "";
      output.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (!trimmed) {
      flushBlocks();
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushBlocks();
      output.push("<hr>");
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushBlocks();
      const level = Math.min(heading[1].length, 4);
      output.push(`<h${level}>${inlineMarkdown(heading[2], baseUrl)}</h${level}>`);
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      flushBlocks();
      const headers = tableCells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      output.push(
        `<div class="markdown-table-wrap"><table><thead><tr>${
          headers.map((cell) => `<th>${inlineMarkdown(cell, baseUrl)}</th>`).join("")
        }</tr></thead><tbody>${
          rows.map((row) => `<tr>${headers.map((_, cellIndex) =>
            `<td>${inlineMarkdown(row[cellIndex] || "", baseUrl)}</td>`).join("")}</tr>`).join("")
        }</tbody></table></div>`,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushBlocks();
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      index -= 1;
      output.push(`<blockquote>${quote.map((part) => inlineMarkdown(part, baseUrl)).join("<br>")}</blockquote>`);
      continue;
    }

    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const nextList = ordered ? "ol" : "ul";
      if (list !== nextList) {
        closeList();
        output.push(`<${nextList}>`);
        list = nextList;
      }
      output.push(`<li>${inlineMarkdown((unordered || ordered)[1], baseUrl)}</li>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushBlocks();
  return output.join("");
}
