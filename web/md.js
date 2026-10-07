// Tiny Markdown renderer for task notes: headings, lists (nested, ordered, task lists), quotes, code blocks,
// tables, links, bare URLs, Windows paths, images, **bold**, *italic*, ~~strike~~, ==highlight==, `code`.
// Raw HTML is always escaped. Task-list checkboxes carry data-line (source line) so the app can toggle them.
(function () {
  'use strict';

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function safeUrl(u) {
    u = u.trim();
    if (/^(https?:|mailto:|file:)/i.test(u) || u.startsWith('/files/') || /^[a-zA-Z]:\\/.test(u) || u.startsWith('\\\\')) return u;
    if (/^www\./i.test(u)) return 'https://' + u;
    return null;
  }

  function link(url, label) {
    const safe = safeUrl(url);
    if (!safe) return label;
    const kind = /^(https?:|mailto:)/i.test(safe) ? 'web' : safe.startsWith('/files/') ? 'file' : 'path';
    return `<a href="${esc(safe)}" data-href="${esc(safe)}" class="md-link md-${kind}" title="${esc(safe)}">${label}</a>`;
  }

  function shortUrl(u) {
    const s = u.replace(/^https?:\/\/(www\.)?/i, '');
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
  }

  function inline(src) {
    const slots = [];
    const hold = html => '\u0000' + (slots.push(html) - 1) + '\u0000';
    let s = src;

    s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
    s = s.replace(/<((?:https?:|mailto:|file:)[^>\s]+|[a-zA-Z]:\\[^>]+|\\\\[^>]+)>/g, (_, u) => hold(link(u, esc(u))));
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, u) => {
      const safe = safeUrl(u);
      return safe ? hold(`<img src="${esc(safe)}" alt="${esc(alt)}" loading="lazy" data-href="${esc(safe)}">`) : m;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)]+?)\)/g, (m, text, u) => (safeUrl(u) ? hold(link(u, inline(text))) : m));
    s = s.replace(/\b(https?:\/\/[^\s<>"'\u0000]+|www\.[^\s<>"'\u0000]+)/gi, u => {
      const trail = (u.match(/[.,;:!?)\]]+$/) || [''])[0];
      const core = trail ? u.slice(0, -trail.length) : u;
      return hold(link(core, esc(shortUrl(core)))) + trail;
    });
    s = s.replace(/(^|[\s(])((?:[a-zA-Z]:\\|\\\\)[^\s<>"|?*\u0000]+)/g, (_, pre, p) => {
      const trail = (p.match(/[.,;:!)]+$/) || [''])[0];
      const core = trail ? p.slice(0, -trail.length) : p;
      return pre + hold(link(core, esc(core))) + trail;
    });

    s = esc(s)
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
      .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      .replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');

    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
  }

  const RE = {
    fence: /^\s*(```|~~~)\s*([\w+-]*)\s*$/,
    heading: /^(#{1,6})\s+(.*?)\s*#*\s*$/,
    hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
    quote: /^\s*>\s?/,
    item: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
    tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
  };

  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));

  function startsBlock(lines, i) {
    const l = lines[i];
    return RE.fence.test(l) || RE.heading.test(l) || RE.hr.test(l) || RE.quote.test(l) || RE.item.test(l) ||
      (l.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]));
  }

  // `base` is the line number of lines[0] in the original text, so checkboxes know their source line.
  function blocks(lines, base, toggleable) {
    let out = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let m;

      if (!line.trim()) { i++; continue; }

      if ((m = line.match(RE.fence))) {
        const fence = m[1], lang = m[2];
        const code = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
        i++;
        out += `<div class="md-code"><button class="md-copy" type="button" title="Copy">Copy</button>` +
          `<pre><code${lang ? ` data-lang="${esc(lang)}"` : ''}>${esc(code.join('\n'))}</code></pre></div>`;
        continue;
      }

      if ((m = line.match(RE.heading))) {
        const n = m[1].length;
        out += `<h${n}>${inline(m[2])}</h${n}>`;
        i++;
        continue;
      }

      if (RE.hr.test(line)) { out += '<hr>'; i++; continue; }

      if (RE.quote.test(line)) {
        const start = i;
        const inner = [];
        while (i < lines.length && RE.quote.test(lines[i])) inner.push(lines[i++].replace(RE.quote, ''));
        out += `<blockquote>${blocks(inner, base + start, false)}</blockquote>`;
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
        const head = cells(line);
        const align = cells(lines[i + 1]).map(c => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
        i += 2;
        let rows = '';
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          const r = cells(lines[i++]);
          rows += '<tr>' + head.map((_, k) => `<td${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(r[k] || '')}</td>`).join('') + '</tr>';
        }
        out += `<div class="md-table"><table><thead><tr>${head.map((h, k) => `<th${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
        continue;
      }

      if (RE.item.test(line)) {
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          const im = l.match(RE.item);
          if (im) {
            items.push({ indent: im[1].replace(/\t/g, '    ').length, ordered: /\d/.test(im[2]), num: parseInt(im[2], 10), text: im[3], line: base + i });
            i++;
          } else if (l.trim() && /^\s+/.test(l) && items.length) {
            items[items.length - 1].text += '\n' + l.trim();
            i++;
          } else break;
        }
        out += list(items, toggleable);
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim() && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++]);
      out += `<p>${para.map(inline).join('<br>')}</p>`;
    }
    return out;
  }

  function list(items, toggleable) {
    let html = '';
    const stack = [];
    for (const it of items) {
      while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
      const top = stack[stack.length - 1];
      if (!top || it.indent > top.indent) {
        const tag = it.ordered ? 'ol' : 'ul';
        html += `<${tag}${it.ordered && it.num !== 1 ? ` start="${it.num}"` : ''}>`;
        stack.push({ indent: it.indent, tag });
      } else html += '</li>';

      const task = it.text.match(/^\[([ xX])\]\s*([\s\S]*)$/);
      const body = (task ? task[2] : it.text).split('\n').map(inline).join('<br>');
      if (task) {
        const done = task[1] !== ' ';
        html += `<li class="md-task${done ? ' done' : ''}"><label><input type="checkbox"${done ? ' checked' : ''}` +
          `${toggleable ? ` data-line="${it.line}"` : ' disabled'}><span>${body}</span></label>`;
      } else html += `<li>${body}`;
    }
    while (stack.length) html += `</li></${stack.pop().tag}>`;
    return html;
  }

  function render(src) {
    return blocks(String(src || '').replace(/\r\n?/g, '\n').split('\n'), 0, true);
  }

  // Flips the checkbox on a given source line: "- [ ] x" <-> "- [x] x".
  function toggleLine(src, line) {
    const lines = src.split('\n');
    if (lines[line] == null) return src;
    lines[line] = lines[line].replace(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\]/, (_, pre, c) => pre + (c === ' ' ? '[x]' : '[ ]'));
    return lines.join('\n');
  }

  function checklist(src) {
    let total = 0, done = 0;
    for (const l of String(src || '').split('\n')) {
      const m = l.match(/^\s*(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]/);
      if (m) { total++; if (m[1] !== ' ') done++; }
    }
    return { total, done };
  }

  // Plain-text excerpt for cards and search results.
  function excerpt(src, max) {
    const text = String(src || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+(\[[ xX]\]\s*)?/gm, '')
      .replace(/[*_`~=|]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  window.MD = { render, toggleLine, checklist, excerpt, esc };
})();
