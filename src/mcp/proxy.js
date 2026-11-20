/**
 * Proxy-dışı bağlantı katmanı.
 *
 * VT bağlantıları HER ZAMAN doğrudan TCP ile kurulur. Bağlantı anında
 * proxy ile ilgili ortam değişkenleri geçici olarak kaldırılır, işlem
 * bitince geri yüklenir. Bu katman ek kesinlik sağlar:
 *   - pg (Node) raw socket kullanır, proxy env'yi okumaz; yine de temizleriz.
 *   - node-sybase (Java subprocess) parent env'yi miras alır; Java/TDS de
 *     HTTP proxy kullanmaz, ama yine de ortamı temizleyerek kesinlik veririz.
 */

export const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
];

/**
 * Verilen async fonksiyonu, proxy env değişkenleri temizli ortamda çalıştırır.
 * @param {Function} fn - () => Promise
 * @returns {Promise}
 */
export async function withNoProxy(fn) {
  const saved = {};
  let hadVar = false;
  for (const v of PROXY_VARS) {
    if (process.env[v] !== undefined) {
      saved[v] = process.env[v];
      hadVar = true;
    }
    delete process.env[v];
  }
  try {
    return await fn();
  } finally {
    if (hadVar) {
      for (const v of PROXY_VARS) {
        if (saved[v] !== undefined) process.env[v] = saved[v];
        else delete process.env[v];
      }
    }
  }
}
