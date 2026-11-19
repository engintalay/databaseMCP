'use strict';

/**
 * CSV dosya G/Ç katmanı (csv-parse + csv-stringify).
 *
 * - export: {rows, columns} -> csv (başlıklı)
 * - import: csv -> {headers, rows}
 *
 * Çıktı dosyası her zaman output/ klasörüne yazılır (io.safeOutputPath).
 */

const path = require('node:path');
const fs = require('node:fs');
const { parse } = require('csv-parse');
const { stringify } = require('csv-stringify');
const { ensureOutputDir, safeOutputPath } = require('./io');

/**
 * Veriyi CSV dosyasına yazar.
 * @param {Array<object>} rows
 * @param {Array<string>} columns
 * @param {string} filename
 * @param {string} [outputDir]
 * @returns {Promise<{path: string, rowCount: number}>}
 */
async function exportTo(rows, columns, filename, outputDir) {
  const outPath = safeOutputPath(filename, outputDir);
  ensureOutputDir(path.dirname(outPath));

  const records = rows.map((row) =>
    columns.map((c) => {
      const v = row[c];
      return v === null || v === undefined ? '' : v;
    }),
  );

  return new Promise((resolve, reject) => {
    const output = stringify(records, { header: true, columns: columns });
    fs.writeFile(outPath, output, 'utf8', (err) => {
      if (err) return reject(err);
      resolve({ path: outPath, rowCount: rows.length });
    });
  });
}

/**
 * CSV dosyasını oku -> {headers, rows}.
 * @param {string} filePath mutlak yol
 * @returns {Promise<{headers: string[], rows: Array<object>}>}
 */
async function importFrom(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const records = await parse(content, {
    columns: true, // ilk satır başlık olarak kullanılır
    skip_empty_lines: true,
    trim: true,
  });
  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  return { headers, rows: records };
}

module.exports = { exportTo, importFrom };
