'use strict';

/**
 * Excel (.xlsx/.xls) dosya G/Ç katmanı (exceljs).
 *
 * - export: {rows, columns} -> xlsx (sütun başlıkları + veri)
 * - import: xlsx -> {headers, rows} (headers ilk satırdan)
 *
 * Çıktı dosyası her zaman output/ klasörüne yazılır (io.safeOutputPath).
 */

const path = require('node:path');
const fs = require('node:fs');
const ExcelJS = require('exceljs');
const { ensureOutputDir, safeOutputPath } = require('./io');

/**
 * Veriyi Excel dosyasına yazar.
 * @param {Array<object>} rows
 * @param {Array<string>} columns
 * @param {string} filename
 * @param {string} [outputDir]
 * @returns {Promise<{path: string, rowCount: number}>}
 */
async function exportTo(rows, columns, filename, outputDir) {
  const outPath = safeOutputPath(filename, outputDir);
  ensureOutputDir(path.dirname(outPath));

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'databaseMCP';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Sheet1');

  // Başlık satırı (kalın + renkli).
  const headerRow = sheet.addRow(columns);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: 'solid', fgColor: { argb: 'FFD9E1F2' } };
  });

  // Veri satırları (sadece tanımlı sütunlar).
  for (const row of rows) {
    sheet.addRow(columns.map((c) => row[c]));
  }

  // Sütun genişliklerini içeriğe göre ayarla.
  for (let i = 0; i < columns.length; i++) {
    let max = columns[i].length;
    for (const row of rows) {
      const v = row[columns[i]];
      if (v !== undefined && v !== null) {
        const len = String(v).length;
        if (len > max) max = len;
      }
    }
    sheet.getColumn(i + 1).width = Math.min(Math.max(max + 2, 10), 80);
  }

  await workbook.writeFile(outPath);
  return { path: outPath, rowCount: rows.length };
}

/**
 * Excel dosyasını oku -> {headers, rows}.
 * @param {string} filePath mutlak yol
 * @returns {Promise<{headers: string[], rows: Array<object>}>}
 */
async function importFrom(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Excel dosyasında çalışma sayfası yok.');

  const rowsData = sheet.getRows(1) || [];
  const headers = rowsData[0]
    ? rowsData[0].map((c) => (c.value === null || c.value === undefined ? '' : String(c.value)))
    : [];

  const records = [];
  for (let i = 1; i < rowsData.length; i++) {
    const cells = rowsData[i];
    const allEmpty = !cells || cells.every((c) => c.value === null || c.value === undefined);
    if (allEmpty) continue;
    const obj = {};
    headers.forEach((h, idx) => {
      const val = cells[idx] ? cells[idx].value : null;
      obj[h] = val === null || val === undefined ? null : val;
    });
    records.push(obj);
  }

  return { headers, rows: records };
}

module.exports = { exportTo, importFrom };
