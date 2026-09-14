// Renders docs/LEIDBEININGAR.md (with screenshots) to a PDF using Electron's printToPDF.
// Usage: xvfb-run -a npx electron scripts/guide-pdf.mjs
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function esc(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]) }
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
}
function mdToHtml(md) {
  const lines = md.split(/\r?\n/)
  const out = []
  let i = 0
  const flushPara = (buf) => { if (buf.length) { out.push(`<p>${inline(buf.join(' '))}</p>`); buf.length = 0 } }
  const buf = []
  while (i < lines.length) {
    const l = lines[i]
    if (/^```/.test(l)) { flushPara(buf); const code = []; i++; while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]); out.push(`<pre>${esc(code.join('\n'))}</pre>`); i++; continue }
    if (/^---+$/.test(l)) { flushPara(buf); out.push('<hr>'); i++; continue }
    const h = l.match(/^(#{1,3})\s+(.*)$/)
    if (h) { flushPara(buf); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue }
    if (/^>\s?/.test(l)) { flushPara(buf); const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, '')); out.push(`<blockquote>${inline(q.join(' '))}</blockquote>`); continue }
    if (/^\|/.test(l)) { flushPara(buf); const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]); const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()); const head = cells(rows[0]); const body = rows.slice(2).map(cells); out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`); continue }
    const ol = l.match(/^(\d+)\.\s+(.*)$/)
    const ul = l.match(/^[-*]\s+(.*)$/)
    if (ol || ul) { flushPara(buf); const tag = ol ? 'ol' : 'ul'; const items = []; while (i < lines.length) { const m = lines[i].match(ol ? /^\d+\.\s+(.*)$/ : /^[-*]\s+(.*)$/); if (!m) { if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue } break } items.push(m[1]); i++ } out.push(`<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${tag}>`); continue }
    if (!l.trim()) { flushPara(buf); i++; continue }
    buf.push(l); i++
  }
  flushPara(buf)
  return out.join('\n')
}

const mdPath = resolve('docs/LEIDBEININGAR.md')
const md = readFileSync(mdPath, 'utf8')
const html = `<!doctype html><html lang="is"><head><meta charset="utf-8"><title>Fundarritari – leiðbeiningar</title>
<style>
body{font-family:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;font-size:11.5pt;line-height:1.5;color:#111;max-width:760px;margin:0 auto;padding:0 8px}
h1{font-size:24pt;margin:0 0 6px;color:#1f4fd8}h2{font-size:16pt;margin:26px 0 8px;border-bottom:2px solid #1f4fd8;padding-bottom:3px;page-break-after:avoid}h3{font-size:13pt;margin:18px 0 6px}
p{margin:6px 0}code{background:#eef1f7;padding:1px 4px;border-radius:3px;font-size:10.5pt}pre{background:#eef1f7;padding:8px 10px;border-radius:6px;font-size:10.5pt}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:10.5pt;page-break-inside:auto}th,td{border:1px solid #cfd5e3;padding:6px 8px;vertical-align:top;text-align:left}th{background:#e6ecfb}tr{page-break-inside:avoid}
img{max-width:100%;border:1px solid #cfd5e3;border-radius:6px;margin:6px 0 10px;page-break-inside:avoid}blockquote{border-left:4px solid #1f4fd8;background:#f1f3f9;margin:8px 0;padding:6px 12px}
hr{border:0;border-top:1px solid #cfd5e3;margin:20px 0}li{margin:3px 0}
</style></head><body>${mdToHtml(md)}</body></html>`
writeFileSync(resolve('docs/LEIDBEININGAR.html'), html)

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL(pathToFileURL(resolve('docs/LEIDBEININGAR.html')).toString())
  await new Promise((r) => setTimeout(r, 1500))
  const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } })
  writeFileSync(resolve('docs/Fundarritari-leidbeiningar.pdf'), pdf)
  console.log('pdf written', pdf.length)
  app.exit(0)
})
