#!/usr/bin/env node
/**
 * 紋理壓縮設定檢查：meta 開了 useCompressTexture，就必須指向專案 builder.json 裡存在的 userPreset。
 *
 * 為什麼要擋：presetId 缺漏或指到不存在的 preset 時，Cocos 不會報錯，而是退回內建預設 preset，
 * 產出 astc/pkm/pvr 等原生格式。web 上會造成支援 ASTC 的裝置（Apple Silicon Safari）載入失敗、
 * 前載容量暴增，而且只在特定裝置＋語系才會發作，極難從錯誤訊息追回來（99934 tch 圖集事件）。
 *
 * Usage: node check-texture-compress.js <project-dir>
 * Exit code: 0 = 通過，1 = 有違規或無法讀取 builder.json
 */

const fs = require('fs');
const path = require('path');

const projectDir = path.resolve(process.argv[2] || '.');
const assetsDir = path.join(projectDir, 'assets');
const builderJsonPath = path.join(projectDir, 'settings', 'v2', 'packages', 'builder.json');

// Cocos 產生的 json 常帶 UTF-8 BOM，JSON.parse 不吃
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
}

function walkMetaFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMetaFiles(fullPath, out);
    else if (entry.name.endsWith('.meta')) out.push(fullPath);
  }
  return out;
}

// compressSettings 可能出現在頂層 userData，也可能在 subMetas 裡，全部遞迴找出來
function collectCompressSettings(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectCompressSettings(item, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'compressSettings' && value && typeof value === 'object') out.push(value);
      else collectCompressSettings(value, out);
    }
  }
  return out;
}

function annotate(level, relativePath, message) {
  // GitHub Actions annotation：會直接顯示在 run 摘要頁
  console.log(`::${level} file=${relativePath.replace(/\\/g, '/')}::${message}`);
}

function main() {
  console.log(`Texture compress check: ${projectDir}`);

  if (!fs.existsSync(assetsDir)) {
    console.log('  assets/ not found, skipping');
    return 0;
  }

  let userPreset;
  try {
    userPreset = readJson(builderJsonPath).textureCompressConfig?.userPreset || {};
  } catch (error) {
    console.log(`::error::無法讀取 ${builderJsonPath}：${error.message}`);
    return 1;
  }

  const presetNames = Object.fromEntries(Object.entries(userPreset).map(([id, preset]) => [id, preset?.name || id]));
  console.log(`  presets: ${Object.entries(presetNames).map(([id, name]) => `${name}(${id})`).join(', ') || '(none)'}`);

  const violations = [];
  let checkedCount = 0;

  for (const metaPath of walkMetaFiles(assetsDir, [])) {
    const relativePath = path.relative(projectDir, metaPath);
    let meta;
    try {
      meta = readJson(metaPath);
    } catch (error) {
      annotate('warning', relativePath, `meta 解析失敗，略過：${error.message}`);
      continue;
    }

    for (const settings of collectCompressSettings(meta, [])) {
      if (settings.useCompressTexture !== true) continue;
      checkedCount++;
      const presetId = settings.presetId;
      if (!presetId) {
        violations.push({ relativePath, message: '開啟壓縮但未指定 presetId（會退回內建 preset，產出 astc/pkm/pvr）' });
      } else if (!(presetId in userPreset)) {
        violations.push({
          relativePath,
          message: `presetId "${presetId}" 不存在於 settings/v2/packages/builder.json 的 userPreset`,
        });
      }
    }
  }

  console.log(`  checked ${checkedCount} compressed assets`);

  if (violations.length === 0) {
    console.log('  ✓ all compress settings point to an existing preset');
    return 0;
  }

  for (const { relativePath, message } of violations) annotate('error', relativePath, message);
  console.log(`\n  ✗ ${violations.length} 個資源的壓縮設定有問題，請在編輯器重新選擇壓縮 preset 後再 build`);
  return 1;
}

process.exit(main());
