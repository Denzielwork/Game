'use strict';
const { createApp } = require('./app.js');

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

const app = createApp({
  trustProxyHops: Number(process.env.TRUST_PROXY) || 0,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  maxRooms: Number(process.env.MAX_ROOMS) || 300,
});

app.listen(port, host).then((addr) => {
  console.log(`Coin Scramble running on http://${addr.address === '0.0.0.0' ? 'localhost' : addr.address}:${addr.port}`);
});

function shutdown() {
  console.log('Shutting down...');
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
