'use strict';
/**
 * RAPOR (prod) Sybase sunucusundaki EVDO_* veritabanlarında,
 * adında "TAKIP" geçen kullanıcı tablolarını (type='U') listeler.
 *
 * Not: Bu sürücüde (node-sybase/jconn3) USE+SELECT tek batch çalışmaz,
 * ayrı çağrılarda ise pool bağlantıyı her çağrıda bıraktığı için USE
 * kalıcı olmaz. Bu yüzden üç bölmeli isim (EVDO_XX.dbo.sysobjects) kullanılır;
 * login'in kullanıcı hesabı olmadığı veritabanlarında hata beklenir ve raporlanır.
 */
const config = require('/home/engin/projects/databaseMCP/src/config');
const { SybaseManager } = require('/home/engin/projects/databaseMCP/src/db/sybase');

(async () => {
  const { connections } = config.loadConfig();
  const resolved = config.resolveConnection(connections['RAPOR']);
  const mgr = new SybaseManager([{ name: 'RAPOR', ...resolved }]);

  const dbs = (await mgr.query('RAPOR',
    "SELECT name FROM master..sysdatabases WHERE name LIKE 'EVDO_%' ORDER BY name"
  )).rows.map((r) => r.name);
  console.log(`EVDO_* sayısı: ${dbs.length}`);

  const ok = [];
  const denied = [];
  for (const db of dbs) {
    try {
      const r = await mgr.query('RAPOR',
        `SELECT name FROM ${db}.dbo.sysobjects WHERE type='U' AND name LIKE '%TAKIP%' ORDER BY name`
      );
      ok.push({ db, tables: r.rows.map((x) => x.name) });
    } catch (e) {
      denied.push({ db, msg: String((e && e.message) || e).split('\n')[0] });
    }
  }

  console.log(`\n=== ERİŞİLEN (${ok.length}) ===`);
  let total = 0;
  for (const o of ok) {
    total += o.tables.length;
    console.log(`${o.db}: ${o.tables.length} -> ${o.tables.join(', ') || '(TAKIP tablosu yok)'}`);
  }
  console.log(`\n=== ERİŞİLEMEYEN (${denied.length}) ===`);
  for (const d of denied) console.log(`${d.db}: ${d.msg}`);
  console.log(`\nTOPLAM TAKIP TABLOSU (erişilenlerde): ${total}`);
  process.exit(0);
})();
