// Count the whole static import graph, so moving code into another eagerly
// loaded chunk cannot masquerade as an improvement to the initial download.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseAst } from 'rollup/parseAst';

const root = resolve(process.argv[2] || 'dist');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const localFile = (url, parent = resolve(root, 'index.html')) => {
  if (/^(?:https?:|data:|\/\/)/.test(url)) return null;
  const clean = url.split(/[?#]/)[0];
  const file = clean.startsWith('/') ? resolve(root, `.${clean}`) : resolve(dirname(parent), clean);
  if (relative(root, file).startsWith('..')) throw new Error('Build import escapes output directory');
  return file;
};
const initial = new Set();
function visit(file) {
  if (!file || initial.has(file)) return;
  initial.add(file);
  const ast = parseAst(readFileSync(file, 'utf8'));
  for (const item of ast.body) {
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(item.type) && item.source) {
      visit(localFile(item.source.value, file));
    }
  }
}
for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
  const text = tag[0];
  if (/type=["']module["']/.test(text) || /rel=["']modulepreload["']/.test(text)) {
    const url = text.match(/(?:src|href)=["']([^"']+)["']/)?.[1];
    if (url) visit(localFile(url));
  }
}
const stats = file => {
  const bytes = readFileSync(file);
  return { file: relative(root, file), bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
};
const walk = directory => readdirSync(directory).flatMap(name => {
  const file = resolve(directory, name);
  return statSync(file).isDirectory() ? walk(file) : [file];
});
const allJS = walk(resolve(root, 'assets')).filter(file => file.endsWith('.js')).map(stats);
const initialJS = [...initial].map(stats).sort((a, b) => b.bytes - a.bytes);
const css = new Set();
for (const tag of html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/g)) {
  const url = tag[0].match(/href=["']([^"']+)["']/)?.[1];
  if (url) { const file = localFile(url); if (file) css.add(file); }
}
const manifestPath = resolve(root, '.vite/manifest.json');
if (existsSync(manifestPath)) {
  for (const chunk of Object.values(JSON.parse(readFileSync(manifestPath, 'utf8')))) {
    if (initial.has(resolve(root, chunk.file))) {
      for (const file of chunk.css || []) css.add(resolve(root, file));
    }
  }
}
const total = files => files.reduce((sum, file) => ({ bytes: sum.bytes + file.bytes, gzipBytes: sum.gzipBytes + file.gzipBytes }), { bytes: 0, gzipBytes: 0 });
console.log(JSON.stringify({
  initialJS: { ...total(initialJS), files: initialJS },
  initialCSS: { ...total([...css].map(stats)), files: [...css].map(stats) },
  allJS: { ...total(allJS), fileCount: allJS.length },
  deferredJS: allJS.filter(file => !initial.has(resolve(root, file.file))).sort((a, b) => b.bytes - a.bytes),
  note: 'Local production assets; gzip per resource at Node default level; initial JS follows static imports, excluding dynamic imports. External resources are not counted.',
}, null, 2));
