'use strict';
/**
 * RAPOR (prod) Sybase sunucusundaki EVDO_* veritabanlarındaki TAKIP tablolarının
 * boyut bilgilerini (sp_spaceused) toplar.
 *
 * Not: sp_spaceused bir stored procedure'dür; USE + EXEC tek batch olarak
 * çalıştırılmalı (noktalı virgül yok, satır sonu ile ayrılmış).
 */
const config = require('/home/engin/projects/databaseMCP/src/config');
const { SybaseManager } = require('/home/engin/projects/databaseMCP/src/db/sybase');

(async () => {
  const { connections } = config.loadConfig();
  const resolved = config.resolveConnection(connections['RAPOR']);
  const mgr = new SybaseManager([{ name: 'RAPOR', ...resolved }]);

  // Tüm EVDO_* veritabanlarını al
  const dbs = (await mgr.query('RAPOR',
    "SELECT name FROM master..sysdatabases WHERE name LIKE 'EVDO_%' ORDER BY name"
  )).rows.map((r) => r.name);

  // Erişilen ve TAKIP tablosu olan DB'leri bul
  const ok = [];
  for (const db of dbs) {
    try {
      const r = await mgr.query('RAPOR',
        `SELECT name FROM ${db}.dbo.sysobjects WHERE type='U' AND name LIKE '%TAKIP%' ORDER BY name`
      );
      if (r.rows.length > 0) {
        ok.push({ db, tables: r.rows.map((x) => x.name) });
      }
    } catch (e) {
      // Erişilemeyen DB'leri atla
    }
  }

  console.log(`Erişilen ve TAKIP tablosu olan DB sayısı: ${ok.length}`);

  // Her DB'deki her TAKIP tablosu için sp_spaceused çalıştır
  const results = [];
  for (const o of ok) {
    for (const tbl of o.tables) {
      try {
        // USE + EXEC tek batch (noktalı virgül yok)
        const r = await mgr.execRaw('RAPOR', `USE ${o.db}\nEXEC sp_spaceused ${tbl}`);
        // İlk result set'i al (array of rows)
        const row = Array.isArray(r) && r.length ? r[0] : null;
        if (row) {
          results.push({
            db: o.db,
            table: tbl,
            rows: row.rowtotal ? parseInt(row.rowtotal, 10) : null,
            reserved_kb: row.reserved ? parseInt(row.reserved, 10) : null,
            data_kb: row.data ? parseInt(row.data, 10) : null,
            index_size_kb: row.index_size ? parseInt(row.index_size, 10) : null,
            unused_kb: row.unused ? parseInt(row.unused, 10) : null,
          });
        } else {
          console.log(`${o.db}.${tbl}: sp_spaceused boş sonuç döndürdü`);
        }
      } catch (e) {
        console.log(`${o.db}.${tbl}: HATA -> ${String((e && e.message) || e).split('\n')[0]}`);
      }
    }
  }

  // Özet
  console.log(`\n=== TOPLAM TABLO BOYUTU (${results.length} tablo) ===`);
  let totalReserved = 0, totalData = 0, totalIndex = 0, totalUnused = 0, totalRows = 0;
  for (const r of results) {
    if (r.reserved_kb) totalReserved += r.reserved_kb;
    if (r.data_kb) totalData += r.data_kb;
    if (r.index_size_kb) totalIndex += r.index_size_kb;
    if (r.unused_kb) totalUnused += r.unused_kb;
    if (r.rows) totalRows += r.rows;
  }
  console.log(`Reserved: ${(totalReserved / 1024).toFixed(2)} MB`);
  console.log(`Data: ${(totalData / 1024).toFixed(2)} MB`);
  console.log(`Index: ${(totalIndex / 1024).toFixed(2)} MB`);
  console.log(`Unused: ${(totalUnused / 1024).toFixed(2)} MB`);
  console.log(`Toplam satır: ${totalRows.toLocaleString()}`);

  // Tablo bazlı özet (her DB için toplam)
  const byDb = {};
  for (const r of results) {
    if (!byDb[r.db]) byDb[r.db] = { tables: 0, reserved_kb: 0, data_kb: 0, rows: 0 };
    byDb[r.db].tables++;
    if (r.reserved_kb) byDb[r.db].reserved_kb += r.reserved_kb;
    if (r.data_kb) byDb[r.db].data_kb += r.data_kb;
    if (r.rows) byDb[r.db].rows += r.rows;
  }
  console.log(`\n=== DB BAZLI ÖZET ===`);
  for (const db of Object.keys(byDb).sort()) {
    console.log(`${db}: ${byDb[db].tables} tablo, ${(byDb[db].reserved_kb / 1024).toFixed(2)} MB reserved, ${(byDb[db].data_kb / 1024).toFixed(2)} MB data, ${byDb[db].rows.toLocaleString()} satır`);
  }

  // Tüm sonuçları CSV olarak yazdır (kopyalanabilir)
  console.log(`\n=== CSV (db,table,rows,reserved_kb,data_kb,index_size_kb,unused_kb) ===`);
  console.log('db,table,rows,reserved_kb,data_kb,index_size_kb,unused_kb');
  for (const r of results) {
    console.log(`${r.db},${r.table},${r.rows ?? ''},${r.reserved_kb ?? ''},${r.data_kb ?? ''},${r.index_size_kb ?? ''},${r.unused_kb ?? ''}`);
  }

  process.exit(0);
})();
