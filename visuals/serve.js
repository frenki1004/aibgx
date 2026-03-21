// Simple static file server for the frontend (use instead of Live Server)
// Usage: node visuals/serve.js [port]

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || 3000;
const ROOT = path.join(__dirname, '..'); // project root (serves visuals/ and docs/)

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown',
};

http
  .createServer((req, res) => {
    let url = req.url.split('?')[0];
    if (url === '/') {
      res.writeHead(302, { Location: '/visuals/index.html' });
      res.end();
      return;
    }
    const file = path.join(ROOT, url);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`Server:  http://localhost:${PORT}`);
    console.log(`Game:    http://localhost:${PORT}/visuals/index.html`);
    console.log(`Docs:    http://localhost:${PORT}/docs/index.html`);
  });
