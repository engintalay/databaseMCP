'use strict';

/**
 * Dosya G/Ç katmanı.
 *
 * - Dışa aktarım dosyaları proje içi `output/` klasörüne yazılır.
 * - Yol güvenliği: çıktı dosyası `output/` dışına çıkamaz (path traversal engeli).
 * - İçe aktarım: kullanıcı dosya yolu kabul edilir; mutlak yol ya da
 *   `output/` altında aranır. Travalsion engellenir.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'output');

/**
 * Çıktı klasörünü (ve üst klasörleri) oluşturur.
 * @param {string} [outputDir]
 */
function ensureOutputDir(outputDir = DEFAULT_OUTPUT_DIR) {
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

/**
 * Güvenli çıktı dosya yolu kurar: basename temizlenir, output/ altına sabitlenir.
 * @param {string} filename
 * @param {string} [outputDir]
 * @returns {string} mutlak yol
 */
function safeOutputPath(filename, outputDir = DEFAULT_OUTPUT_DIR) {
  const base = path.basename(filename); // üst dizin bileşenlerini at
  if (!base || base === '.' || base === '..') {
    throw new Error('Geçersiz dosya adı.');
  }
  const full = path.resolve(path.join(outputDir, base));
  const root = path.resolve(outputDir);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('Çıktı yolu output/ klasörünün dışına çıkamaz.');
  }
  return full;
}

/**
 * İçe aktarım dosya yolu: mutlak ya da output/ altında aranır.
 * @param {string} filePath
 * @param {string} [outputDir]
 * @returns {string} mutlak yol
 */
function resolveInputPath(filePath, outputDir = DEFAULT_OUTPUT_DIR) {
  if (!filePath || !filePath.trim()) {
    throw new Error('Dosya yolu boş olamaz.');
  }
  const candidate = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(outputDir, filePath);
  const root = path.resolve(outputDir);
  if (!candidate.startsWith(root + path.sep) && candidate !== root) {
    throw new Error('İçe aktarım dosyası output/ klasörünün dışına çıkamaz.');
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`Dosya bulunamadı: ${candidate}`);
  }
  if (!fs.statSync(candidate).isFile()) {
    throw new Error(`Bir dosya belirtilmeli: ${candidate}`);
  }
  return candidate;
}

/**
 * Uzantıdan dosya türünü belirler.
 * @param {string} filename
 * @returns {'xlsx'|'csv'|null}
 */
function detectFormat(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') return 'xlsx';
  if (ext === '.csv') return 'csv';
  return null;
}

module.exports = {
  PROJECT_ROOT,
  DEFAULT_OUTPUT_DIR,
  ensureOutputDir,
  safeOutputPath,
  resolveInputPath,
  detectFormat,
};
