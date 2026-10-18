const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

// Reports are untrusted text. Support the report's Markdown blocks without
// interpreting raw HTML, links, images, or executable markup.
export function renderReportMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (/^```/.test(line)) {
      const code = [];
      while (++index < lines.length && !/^```/.test(lines[index])) code.push(lines[index]);
      html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    } else if (line.includes('|') && lines[index + 1]?.includes('|') && cells(lines[index + 1]).every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const headers = cells(line);
      index++;
      const rows = [];
      while (lines[index + 1]?.trim().startsWith('|')) rows.push(cells(lines[++index]));
      html.push(`<div class="report-table"><table><thead><tr>${headers.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (/^#{1,6} /.test(line)) {
      const [, marks, title] = line.match(/^(#{1,6}) (.*)$/);
      const level = Math.min(marks.length + 1, 6);
      html.push(`<h${level}>${escapeHtml(title)}</h${level}>`);
    } else if (line.startsWith('> ')) {
      html.push(`<blockquote>${escapeHtml(line.slice(2))}</blockquote>`);
    } else if (line.startsWith('- ')) {
      const items = [line.slice(2)];
      while (lines[index + 1]?.startsWith('- ')) items.push(lines[++index].slice(2));
      html.push(`<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`);
    } else {
      html.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  return html.join('\n');
}
