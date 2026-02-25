/**
 * FastDrop — P2P File Transfer
 * Signaling: Trystero (free Nostr relays + BitTorrent DHT fallback)
 * Transfer:  WebRTC RTCDataChannel — 256 KB chunks, ordered, event-driven
 * Cost:      $0 — no accounts, no servers, no limits
 */

// ─── Trystero config ─────────────────────────────────────────
// App ID must be unique to your app — change this string to anything you like.
// It namespaces your rooms so they don't collide with other Trystero apps.
const APP_ID = 'fastdrop-v1';

// ─── Transfer config ─────────────────────────────────────────
const CHUNK_SIZE = 256 * 1024;   // 256 KB — optimal LAN DataChannel throughput
const BUFFER_LOW = 1 * 1024 * 1024;   // 1 MB — fire backpressure event at this level
const BUFFER_HIGH = 8 * 1024 * 1024;   // 8 MB — pause sending above this

// ─────────────────────────────────────────────────────────────
// Trystero is loaded as an ES module from a CDN.
// It handles WebRTC offer/answer/ICE automatically using free
// public Nostr relay servers. No accounts. No API keys. $0.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// RoomManager
// ─────────────────────────────────────────────────────────────
class RoomManager {
    static generate() {
        const arr = new Uint32Array(1);
        crypto.getRandomValues(arr);
        return String(arr[0] % 900000 + 100000);
    }
    static fromUrl() {
        return new URLSearchParams(location.search).get('room');
    }
}

// ─────────────────────────────────────────────────────────────
// FileTransferEngine — 256 KB ordered chunks, event backpressure
// ─────────────────────────────────────────────────────────────
class FileTransferEngine {
    constructor(sendBinary, sendMeta, onProgress) {
        this._sendBinary = sendBinary;   // Trystero binary action sender
        this._sendMeta = sendMeta;     // Trystero JSON action sender
        this.onProgress = onProgress;
        this._incoming = {};
        this._dc = null;         // raw DataChannel reference for backpressure
    }

    setDataChannel(dc) {
        this._dc = dc;
        this._dc.bufferedAmountLowThreshold = BUFFER_LOW;
    }

    // ── SEND ──────────────────────────────────────────────────
    async sendFile(file, transferId) {
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const ext = file.name.split('.').pop() || '';

        // Send metadata first (JSON action)
        this._sendMeta({
            type: 'meta', id: transferId,
            name: file.name, size: file.size,
            totalChunks, ext,
        });

        const buffer = await file.arrayBuffer();
        let sent = 0;
        const startTime = Date.now();

        for (let i = 0; i < totalChunks; i++) {
            const slice = buffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);

            // ── Event-driven backpressure (no CPU-wasting poll) ──
            if (this._dc && this._dc.bufferedAmount > BUFFER_HIGH) {
                await new Promise(resolve =>
                    this._dc.addEventListener('bufferedamountlow', resolve, { once: true })
                );
            }

            // Binary header: 4 bytes chunkIndex + 8 bytes transferId
            const header = new Uint8Array(12);
            new DataView(header.buffer).setUint32(0, i);
            for (let c = 0; c < 8; c++) header[4 + c] = transferId.charCodeAt(c) || 0;

            const chunk = new Uint8Array(header.byteLength + slice.byteLength);
            chunk.set(header, 0);
            chunk.set(new Uint8Array(slice), header.byteLength);

            this._sendBinary(chunk.buffer);

            sent += slice.byteLength;
            const elapsed = (Date.now() - startTime) / 1000 || 0.001;
            this.onProgress(transferId, {
                pct: Math.round((i + 1) / totalChunks * 100),
                speed: sent / elapsed,
                sent,
                total: file.size,
                done: false,
                name: file.name,
                direction: 'send',
            });
        }

        // Done signal
        this._sendMeta({ type: 'done', id: transferId });
        this.onProgress(transferId, {
            pct: 100, speed: 0, sent: file.size,
            total: file.size, done: true, name: file.name, direction: 'send',
        });
    }

    // ── RECEIVE (called by Trystero binary action) ────────────
    onReceiveBinary(data) {
        const view = new DataView(data);
        const index = view.getUint32(0);
        const idArr = new Uint8Array(data, 4, 8);
        const id = String.fromCharCode(...idArr).replace(/\0/g, '');
        const chunk = data.slice(12);

        const st = this._incoming[id];
        if (!st) return;

        st.chunks[index] = chunk;
        st.received += chunk.byteLength;

        const elapsed = (Date.now() - st.startTime) / 1000 || 0.001;
        this.onProgress(id, {
            pct: Math.round(st.received / st.meta.size * 100),
            speed: st.received / elapsed,
            sent: st.received,
            total: st.meta.size,
            done: false,
            name: st.meta.name,
            direction: 'recv',
        });
    }

    // ── RECEIVE (called by Trystero meta action) ──────────────
    onReceiveMeta(msg) {
        if (msg.type === 'meta') {
            this._incoming[msg.id] = {
                meta: msg,
                chunks: new Array(msg.totalChunks),
                received: 0,
                startTime: Date.now(),
            };
            this.onProgress(msg.id, {
                pct: 0, speed: 0, sent: 0, total: msg.size,
                done: false, name: msg.name, direction: 'recv',
            });
        }

        if (msg.type === 'done') {
            const st = this._incoming[msg.id];
            if (!st) return;

            const blob = new Blob(st.chunks.map(c => new Uint8Array(c)));
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = st.meta.name;
            document.body.appendChild(a); a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 3000);

            this.onProgress(msg.id, {
                pct: 100, speed: 0, sent: st.meta.size,
                total: st.meta.size, done: true, name: st.meta.name, direction: 'recv',
            });
            delete this._incoming[msg.id];
        }
    }
}

// ─────────────────────────────────────────────────────────────
// App State
// ─────────────────────────────────────────────────────────────
let trysteroRoom = null;
let fileEngine = null;
let fileQueue = [];
let transfers = {};
let isConnected = false;

// ─────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────
function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
}
function fmtSpeed(bps) { return bps === 0 ? '—' : fmtBytes(bps) + '/s'; }
function genId(n = 8) { return Math.random().toString(36).slice(2, 2 + n).padEnd(n, '0'); }

function toast(msg, type = 'info') {
    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${msg}</span>`;
    $('toastContainer').appendChild(el);
    setTimeout(() => {
        el.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(() => el.remove(), 300);
    }, 3500);
}

function setStatus(state) {
    const labels = { disconnected: 'Disconnected', connecting: 'Connecting…', connected: 'Connected', transferring: 'Transferring' };
    $('badgeText').textContent = labels[state] || state;
    $('connectionBadge').className = 'header-badge ' +
        (state === 'connected' || state === 'transferring' ? 'connected' : state === 'connecting' ? 'connecting' : '');
}

// ─────────────────────────────────────────────────────────────
// Connect via Trystero
// ─────────────────────────────────────────────────────────────
async function joinRoom(code) {
    setStatus('connecting');
    toast('Connecting via Nostr relay…', 'info');

    // Dynamically import Trystero (no build step needed)
    const { joinRoom: trysteroJoin } = await import('https://esm.sh/trystero/nostr');

    trysteroRoom = trysteroJoin(
        { appId: APP_ID },  // namespaces all rooms under this app
        code                // room code = room name
    );

    // ── Define two Trystero actions ──────────────────────────
    // 1. Binary action — raw ArrayBuffer chunks
    const [sendBinary, getBinary] = trysteroRoom.makeAction('bin');
    // 2. Meta action — JSON metadata, done signals
    const [sendMeta, getMeta] = trysteroRoom.makeAction('meta');

    // ── Instantiate engine ───────────────────────────────────
    fileEngine = new FileTransferEngine(sendBinary, sendMeta, handleProgress);

    // ── Wire up receivers ────────────────────────────────────
    getBinary((data) => fileEngine.onReceiveBinary(data));
    getMeta((data) => fileEngine.onReceiveMeta(data));

    // ── Peer events ──────────────────────────────────────────
    trysteroRoom.onPeerJoin((peerId) => {
        isConnected = true;
        setStatus('connected');
        toast('Peer connected! Ready to transfer.', 'success');
        $('peerName').textContent = 'Peer — ' + peerId.slice(0, 8);
        $('peerRole').textContent = 'Connected via Nostr relay';
        showTransferScreen();
    });

    trysteroRoom.onPeerLeave(() => {
        isConnected = false;
        toast('Peer disconnected.', 'error');
        setStatus('disconnected');
        resetToLobby();
    });
}

// ─────────────────────────────────────────────────────────────
// Progress Tracking
// ─────────────────────────────────────────────────────────────
function handleProgress(id, info) {
    if (!transfers[id]) {
        transfers[id] = { id, ...info };
        $('noTransfers').classList.add('hidden');
        renderTransferItem(id, info);
    }
    updateTransferItem(id, info);
    const anyActive = Object.values(transfers).some(t => !t.done);
    setStatus(anyActive ? 'transferring' : 'connected');
}

function renderTransferItem(id, info) {
    const li = document.createElement('li');
    li.className = 'transfer-item';
    li.id = 'ti-' + id;
    li.innerHTML = `
    <div class="transfer-item-header">
      <span class="transfer-name" title="${info.name || ''}">${info.name || ('Transfer #' + id.slice(0, 4))}</span>
      <span class="transfer-direction ${info.direction === 'recv' ? 'recv' : 'send'}">${info.direction === 'recv' ? '↓ Recv' : '↑ Send'}</span>
    </div>
    <div class="transfer-bar-bg"><div class="transfer-bar-fill" id="bar-${id}" style="width:0%"></div></div>
    <div class="transfer-stats">
      <span id="spd-${id}">—</span>
      <span class="pct" id="pct-${id}">0%</span>
    </div>`;
    $('transferList').prepend(li);
}

function updateTransferItem(id, info) {
    const bar = $('bar-' + id);
    const pct = $('pct-' + id);
    const spd = $('spd-' + id);
    const item = $('ti-' + id);
    if (!bar) return;
    bar.style.width = info.pct + '%';
    pct.textContent = info.pct + '%';
    spd.textContent = info.done ? fmtBytes(info.total) : fmtSpeed(info.speed);
    if (info.done) {
        item.classList.add('done');
        transfers[id] = { ...transfers[id], done: true };
        if (info.direction !== 'recv') toast('Sent successfully!', 'success');
        else toast(info.name + ' received!', 'success');
    }
}

// ─────────────────────────────────────────────────────────────
// Screens
// ─────────────────────────────────────────────────────────────
function showTransferScreen() {
    $('screenPairing').classList.remove('active');
    $('screenPairing').classList.add('hidden');
    $('screenTransfer').classList.remove('hidden');
    $('screenTransfer').classList.add('active');
    $('peerAvatar').textContent = 'P';
}

function resetToLobby() {
    trysteroRoom?.leave?.();
    trysteroRoom = null; fileEngine = null; fileQueue = []; transfers = {}; isConnected = false;
    $('transferList').innerHTML = '';
    $('noTransfers').classList.remove('hidden');
    $('queueList').innerHTML = '';
    $('fileQueue').classList.add('hidden');
    $('roomPanel').classList.add('hidden');
    $('roomCodeInput').value = '';
    $('screenTransfer').classList.remove('active');
    $('screenTransfer').classList.add('hidden');
    $('screenPairing').classList.remove('hidden');
    $('screenPairing').classList.add('active');
    setStatus('disconnected');
}

// ─────────────────────────────────────────────────────────────
// File Queue
// ─────────────────────────────────────────────────────────────
function addFilesToQueue(files) {
    for (const f of files) {
        if (!fileQueue.find(q => q.name === f.name && q.size === f.size)) fileQueue.push(f);
    }
    renderQueue();
}

function renderQueue() {
    $('queueList').innerHTML = '';
    for (const f of fileQueue) {
        const ext = f.name.split('.').pop().slice(0, 4).toUpperCase() || 'FILE';
        const li = document.createElement('li');
        li.className = 'queue-item';
        li.innerHTML = `
      <div class="queue-item-icon">${ext}</div>
      <span class="queue-item-name" title="${f.name}">${f.name}</span>
      <span class="queue-item-size">${fmtBytes(f.size)}</span>`;
        $('queueList').appendChild(li);
    }
    $('queueCount').textContent = fileQueue.length + (fileQueue.length === 1 ? ' file selected' : ' files selected');
    $('fileQueue').classList.remove('hidden');
}

// ─────────────────────────────────────────────────────────────
// QR Code
// ─────────────────────────────────────────────────────────────
function generateQR(code) {
    const qrEl = $('qrcode');
    qrEl.innerHTML = '';
    const url = location.origin + location.pathname + '?room=' + code;
    new QRCode(qrEl, { text: url, width: 136, height: 136, colorDark: '#1a1a2e', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
}

// ─────────────────────────────────────────────────────────────
// Event Listeners
// ─────────────────────────────────────────────────────────────

// Create Room
$('btnCreate').addEventListener('click', async () => {
    const code = RoomManager.generate();
    $('roomCodeDisplay').textContent = code;
    $('roomPanel').classList.remove('hidden');
    generateQR(code);
    $('btnCopyCode').dataset.code = code;
    $('btnCopyLink').dataset.code = code;
    try { await joinRoom(code); }
    catch (e) { toast('Failed to connect. Check your internet connection.', 'error'); console.error(e); }
});

// Join Room
$('btnJoin').addEventListener('click', doJoin);
$('roomCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
$('roomCodeInput').addEventListener('input', () => {
    $('roomCodeInput').value = $('roomCodeInput').value.replace(/\D/g, '').slice(0, 6);
});

async function doJoin() {
    const code = $('roomCodeInput').value.trim();
    if (code.length !== 6) { toast('Enter a valid 6-digit code.', 'error'); return; }
    try {
        await joinRoom(code);
        toast('Joined room ' + code + '. Waiting for peer…', 'info');
    } catch (e) {
        toast('Failed to connect. Check your internet connection.', 'error');
        console.error(e);
    }
}

// Copy Code / Link
document.addEventListener('click', (e) => {
    if (e.target.closest('#btnCopyCode')) {
        navigator.clipboard?.writeText($('btnCopyCode').dataset.code).then(() => toast('Code copied!', 'success'));
    }
    if (e.target.closest('#btnCopyLink')) {
        const url = location.origin + location.pathname + '?room=' + $('btnCopyLink').dataset.code;
        navigator.clipboard?.writeText(url).then(() => toast('Link copied!', 'success'));
    }
});

// Disconnect
$('btnDisconnect').addEventListener('click', () => { resetToLobby(); toast('Disconnected.', 'info'); });

// Drop Zone
const dropZone = $('dropZone');
const fileInput = $('fileInput');
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    addFilesToQueue([...e.dataTransfer.files]);
});
fileInput.addEventListener('change', () => { addFilesToQueue([...fileInput.files]); fileInput.value = ''; });

// Clear Queue
$('btnClearQueue').addEventListener('click', () => { fileQueue = []; $('fileQueue').classList.add('hidden'); });

// Send Files
$('btnSend').addEventListener('click', async () => {
    if (!fileEngine) { toast('No peer connected.', 'error'); return; }
    if (!fileQueue.length) { toast('No files selected.', 'error'); return; }

    const batch = [...fileQueue];
    fileQueue = [];
    $('fileQueue').classList.add('hidden');

    for (const file of batch) {
        const id = genId(8);
        transfers[id] = { id, name: file.name, direction: 'send', done: false };
        $('noTransfers').classList.add('hidden');
        renderTransferItem(id, { name: file.name, direction: 'send', pct: 0 });
        fileEngine.sendFile(file, id).catch(e => {
            toast('Error sending ' + file.name, 'error'); console.error(e);
        });
    }
});

// ─────────────────────────────────────────────────────────────
// Auto-join from URL
// ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    const urlRoom = RoomManager.fromUrl();
    if (urlRoom && /^\d{6}$/.test(urlRoom)) {
        $('roomCodeInput').value = urlRoom;
        doJoin();
    }
});
