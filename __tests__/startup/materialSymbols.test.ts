import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, 'public/fonts/material-symbols-manifest.json'), 'utf8')) as {
  file: string; sha256: string; bytes: number; icons: string[];
};

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? componentFiles(file) : entry.name.endsWith('.tsx') ? [file] : [];
  });
}

function referencedIcons(): Set<string> {
  const names = new Set<string>();
  const collectValue = (node?: ts.Node): void => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (/^[a-z0-9_]+$/.test(node.text)) names.add(node.text);
    } else if (ts.isConditionalExpression(node)) {
      collectValue(node.whenTrue);
      collectValue(node.whenFalse);
    } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      collectValue(node.left);
      collectValue(node.right);
    } else if (ts.isParenthesizedExpression(node)) collectValue(node.expression);
  };
  for (const file of [path.join(root, 'App.tsx'), ...componentFiles(path.join(root, 'components'))]) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) && node.openingElement.attributes.getText(source).includes('material-symbols-outlined')) {
        for (const child of node.children) {
          if (ts.isJsxText(child) && child.text.trim()) names.add(child.text.trim());
          else if (ts.isJsxExpression(child)) collectValue(child.expression);
        }
      }
      if (ts.isPropertyAssignment(node) && /^(icon|categoryIcon)$/.test(node.name.getText(source))) collectValue(node.initializer);
      if (ts.isVariableDeclaration(node) && /Icon$/.test(node.name.getText(source))) collectValue(node.initializer);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && /Icon$/.test(node.left.getText(source))) collectValue(node.right);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  // The champion banner also accepts icons produced by the deployed SQL API.
  const migrations = path.join(root, 'supabase/migrations');
  for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql'))) {
    const source = readFileSync(path.join(migrations, file), 'utf8');
    for (const match of source.matchAll(/'([a-z0-9_]+)'::TEXT\s+AS category_icon/gi)) names.add(match[1]);
  }
  return names;
}

test('the local icon subset covers static, conditional, picker and leaderboard icons', () => {
  const available = new Set(manifest.icons);
  const missing = [...referencedIcons()].filter(icon => !available.has(icon));
  assert.deepEqual(missing, [], 'Update the Material Symbols subset when adding icons; see public/fonts/README.md');
});

test('the small licensed font has an immutable fingerprint and one same-origin preload', () => {
  const font = readFileSync(path.join(root, 'public/fonts', manifest.file));
  assert.equal(font.subarray(0, 4).toString('ascii'), 'wOF2');
  assert.equal(createHash('sha256').update(font).digest('hex'), manifest.sha256);
  assert.equal(font.length, manifest.bytes);
  assert.ok(font.length < 50_000, 'Ship a subset, not the complete Material Symbols font');
  assert.match(readFileSync(path.join(root, 'public/fonts/MaterialSymbols-LICENSE.txt'), 'utf8'), /Apache License/);
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = readFileSync(path.join(root, 'styles/global.css'), 'utf8');
  assert.ok(html.includes(`href="/fonts/${manifest.file}"`));
  assert.ok(css.includes(`url('/fonts/${manifest.file}')`));
  assert.ok(!html.includes('family=Material+Symbols'));
});
