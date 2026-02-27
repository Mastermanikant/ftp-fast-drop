/**
 * FastDrop Local Server
 * - Serves static files (index.html, app.js, style.css …)
 * - WebSocket signaling relay for WebRTC peer connection
 * - 100% offline — works on any hotspot or LAN, no internet needed
 *
 * Usage:  node server.js
 * Then open the URL shown in the terminal on BOTH devices.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

// ── Config ────────────────────────────────────────────────────
const PORT = 3000;
const DIR = __dirname;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json',
};

// ── Local IP ──────────────────────────────────────────────────
function getLocalIP() {
    for (const nets of Object.values(os.networkInterfaces())) {
        for (const net of nets) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return 'localhost';
}

// ── HTTP — serve static files ─────────────────────────────────
const server = http.createServer((req, res) => {
    // Strip query string, decode URI
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    let filePath = path.join(DIR, urlPath);

    // Unknown path → serve index.html (for ?room= deep-links)
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        });
        res.end(data);
    });
});

// ── WebSocket — signaling relay ───────────────────────────────
// rooms: Map<roomCode, Set<WebSocket>>
const rooms = new Map();
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
    let roomCode = null;

    ws.on('message', raw => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === 'join') {
            roomCode = String(msg.room);
            if (!rooms.has(roomCode)) rooms.set(roomCode, new Set());
            rooms.get(roomCode).add(ws);
            // Tell existing peers that someone new joined
            broadcast(roomCode, ws, { type: 'peer-joined' });
            const count = rooms.get(roomCode).size;
            console.log(`[room ${roomCode}] peer joined — ${count} peer(s) in room`);
        } else {
            // Relay offer / answer / ice-candidate to other peers
            broadcast(roomCode, ws, msg);
        }
    });

    ws.on('close', () => {
        if (!roomCode || !rooms.has(roomCode)) return;
        rooms.get(roomCode).delete(ws);
        broadcast(roomCode, ws, { type: 'peer-left' });
        console.log(`[room ${roomCode}] peer left — ${rooms.get(roomCode).size} remaining`);
        if (rooms.get(roomCode).size === 0) rooms.delete(roomCode);
    });
});

function broadcast(room, sender, msg) {
    if (!room || !rooms.has(room)) return;
    const payload = JSON.stringify(msg);
    for (const client of rooms.get(room)) {
        if (client !== sender && client.readyState === 1 /* OPEN */) {
            client.send(payload);
        }
    }
}

// ── Start ─────────────────────────────────────────────────────
const localIP = getLocalIP();
server.listen(PORT, '0.0.0.0', () => {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║       🚀  FastDrop Local Server              ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  This device  →  http://localhost:${PORT}       ║`);
    console.log(`║  Other device →  http://${localIP}:${PORT}  ║`);
    console.log('╠══════════════════════════════════════════════╣');
    console.log('║  Share the second URL with nearby devices.   ║');
    console.log('║  No internet needed — hotspot/LAN only.      ║');
    console.log('║  Press Ctrl+C to stop the server.            ║');
    console.log('╚══════════════════════════════════════════════╝\n');
});
