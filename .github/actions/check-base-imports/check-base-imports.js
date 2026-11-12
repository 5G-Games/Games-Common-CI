#!/usr/bin/env node
/**
 * 相依方向檢查：assets/base（共用 submodule）不可 import assets/game（各遊戲自己的程式）。
 *
 * 為什麼要擋：base 是所有遊戲共用的，一旦反向依賴某款遊戲的檔案，換到別款遊戲就會因路徑／匯出
 * 不存在而編譯失敗或執行期 undefined；且 base 在遊戲專案內是唯讀的，問題只會在升級 base 時才爆。
 *
 * 會檢查的寫法（.ts/.js）：
 *   import x from '...'、import '...'、export ... from '...'、import('...')、require('...')
 * 路徑解析：相對路徑以檔案所在目錄解析；db://assets/... 以專案 assets/ 解析。
 *
 * Usage: node check-base-imports.js <project-dir>
 * Exit code: 0 = 通過（或沒有 assets/base），1 = 有違規
 */

const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(process.argv[2] || '.');
const assetsDir = path.join(projectDir, 'assets');
const baseDir = path.join(assetsDir, 'base');
const gameDir = path.join(assetsDir, 'game');

const SOURCE_EXTS = new Set(['.ts', '.js', '.mjs', '.cjs']);

function walkSourceFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(fullPath, out);
    else if (SOURCE_EXTS.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) out.push(fullPath);
  }
  return out;
}

// 把註解換成空白（保留換行與長度），註解掉的 import 不算違規，且 match index 仍能換算回正確行號。
// 會追蹤字串狀態，避免把 'db://...' 裡的 // 當成註解。
function blankComments(src) {
  const chars = src.split('');
  let i = 0;
  let quote = null;
  while (i < chars.length) {
    const c = chars[i];
    const next = chars[i + 1];
    if (quote) {
      if (c === '\\') i += 2;
      else {
        if (c === quote) quote = null;
        i++;
      }
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
      i++;
    } else if (c === '/' && next === '/') {
      while (i < chars.length && chars[i] !== '\n') chars[i++] = ' ';
    } else if (c === '/' && next === '*') {
      chars[i++] = ' ';
      chars[i++] = ' ';
      while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        if (chars[i] !== '\n') chars[i] = ' ';
        i++;
      }
      if (i < chars.length) {
        chars[i++] = ' ';
        chars[i++] = ' ';
      }
    } else {
      i++;
    }
  }
  return chars.join('');
}

const IMPORT_PATTERNS = [
  /\b(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g, // import x from '...' / export { x } from '...'
  /\bimport\s*['"]([^'"]+)['"]/g, // import '...'
  /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('...') / require('...')
];

function resolveSpecifier(fromFile, specifier) {
  if (specifier.startsWith('db://assets/')) return path.join(assetsDir, specifier.slice('db://assets/'.length));
  if (specifier.startsWith('.')) return path.resolve(path.dirname(fromFile), specifier);
  return null; // 'cc'、npm 套件等不在檢查範圍
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function main() {
  console.log(`Base import check: ${projectDir}`);

  if (!fs.existsSync(baseDir)) {
    console.log('  assets/base not found, skipping');
    return 0;
  }

  const files = walkSourceFiles(baseDir, []);
  const violations = [];

  for (const file of files) {
    const code = blankComments(fs.readFileSync(file, 'utf8'));
    const seen = new Set();
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(code))) {
        const specifier = match[1];
        const resolved = resolveSpecifier(file, specifier);
        if (!resolved || !isInside(resolved, gameDir)) continue;
        const line = lineOf(code, match.index + match[0].indexOf(specifier));
        const key = `${line}:${specifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({ relativePath: path.relative(projectDir, file).replace(/\\/g, '/'), line, specifier });
      }
    }
  }

  console.log(`  scanned ${files.length} source files under assets/base`);

  if (violations.length === 0) {
    console.log('  ✓ assets/base does not import assets/game');
    return 0;
  }

  for (const { relativePath, line, specifier } of violations) {
    console.log(`::error file=${relativePath},line=${line}::assets/base 不可 import assets/game：'${specifier}'`);
  }

  console.log('\n  違規的 import：');
  for (const { relativePath, line, specifier } of violations) {
    console.log(`    ${relativePath}:${line}  ->  ${specifier}`);
  }
  console.log(
    `\n  ✗ ${violations.length} 處 assets/base 反向依賴 assets/game。` +
      '請改由 game 端注入／註冊（例如 base 定義介面或事件，game 實作），並修正在 base repo 而非遊戲專案內。'
  );
  return 1;
}

process.exit(main());
