
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;
let serverInstance = null;

app.get('/', (req, res) => {
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.json({
    status: 'Bot is alive!',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    requests: req.get('X-Requested-With') || 'unknown'
  });
});

app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memory: {
      used: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
      external: Math.round(memUsage.external / 1024 / 1024) + 'MB'
    },
    timestamp: new Date().toISOString(),
    pid: process.pid,
    platform: process.platform
  });
});

app.get('/ping', (req, res) => {
  res.set({
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  res.status(200).send('pong');
});

app.get('/keepalive', (req, res) => {
  res.set({
    'Cache-Control': 'no-cache',
    'Keep-Alive': 'timeout=5, max=1000',
    'Connection': 'keep-alive'
  });
  res.json({
    alive: true,
    time: Date.now(),
    uptime: Math.floor(process.uptime())
  });
});

function startServer() {
  if (serverInstance) {
    console.log('✅ HTTP server already running on port', port);
    return serverInstance;
  }

  serverInstance = app.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Keep-alive server running on port ${port}`);
  });
  
  return serverInstance;
}

function stopServer() {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
    console.log('🛑 HTTP server stopped');
  }
}

module.exports = { startServer, stopServer };
