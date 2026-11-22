'use strict';
// Menjalankan backend yang sama (server/server.js) di Vercel (fungsi serverless).
// Di Vercel: lewat proxy HTTPS (TRUST_PROXY=1) dan halaman web tidak disajikan dari sini.
const { createServer, loadConfig } = require('../server/server.js');

const cfg = loadConfig({ ...process.env, TRUST_PROXY: '1', SERVE_WEB: '0' });
const server = createServer(cfg);

// pathOverride: Vercel memberi alamat /api/health, sedangkan server mengenal /health
module.exports = (pathOverride) => (req, res) => {
  if (pathOverride) req.url = pathOverride + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  server.emit('request', req, res);
};
