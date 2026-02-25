/**
 * FastDrop — P2P File Transfer
 * Signaling: Trystero (free Nostr relays)
 * Transfer:  WebRTC RTCDataChannel — 256 KB chunks
 * Cost:      $0 — no accounts, no servers
 *
 * FIXES in this version:
 *  1. Peer disconnect grace period (10s before resetting — handles relay blips)
 *  2. Speed display: throttled UI updates so % and MB/s always show
 *  3. Folder upload support (webkitdirectory)
 *  4. ETA shown during transfer
 *  5. QR code = auto-join when scanned
 *  6. Multiple file queue with remove-individual support
 *  7. Clipboard paste (Ctrl+V image/file support)
 *  8. Transfer history preserved after done
 */

const APP_ID = 'fastdrop-v1';
const CHUNK_SIZE = 256 * 1024;  // 256 KB
const UI_THROTTLE_MS = 120;     // max UI update rate per transfer

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
// FileTransferEngine
// ─────────────────────────────────────────────────────────────
class FileTransferEngine {
    constructor(sendBinary, sendMeta, onProgress) {
        this._sendBinary = sendBinary;
        this._sendMeta = sendMeta;
        this.onProgress = onProgress;
        this._incoming = {};
        this._lastUI = {};   // throttle: last UI update time per transferId
    }

    _throttledProgress(id, info) {
        const now = Date.now();
        if (!info.done && (now - (this._lastUI[id] || 0)) < UI_THROTTLE_MS) return;
        this._lastUI[id] = now;
        this.onProgress(id, info);
    }

    // ── SEND ──────────────────────────────────────────────────
    async sendFile(file, transferId) {
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        this._sendMeta({
            type: 'meta', id: transferId,
            name: file.name, size: file.size,
            totalChunks,
        });

        const buffer = await file.arrayBuffer();
        let sent = 0;
        const startTime = Date.now();

        for (let i = 0; i < totalChunks; i++) {
            const slice = buffer.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);

            // 12-byte header: [chunkIndex(4)] + [transferId(8)]
            const header = new Uint8Array(12);
            new DataView(header.buffer).setUint32(0, i);
            for (let c = 0; c < 8; c++) header[4 + c] = transferId.charCodeAt(c) || 0;

            const chunk = new Uint8Array(header.byteLength + slice.byteLength);
            chunk.set(header, 0);
            chunk.set(new Uint8Array(slice), header.byteLength);

            this._sendBinary(chunk.buffer);

            sent += slice.byteLength;
            const elapsed = (Date.now() - startTime) / 1000 || 0.001;
            const speed = sent / elapsed;
            const remaining = (file.size - sent) / (speed || 1);

            this._throttledProgress(transferId, {
                pct: Math.round((i + 1) / totalChunks * 100),
                speed, sent, total: file.size,
                eta: remaining, done: false,
                name: file.name, direction: 'send',
            });

            // Tiny yield every 64 chunks so UI can paint
            if (i % 64 === 0) await new Promise(r => setTimeout(r, 0));
        }

        this._sendMeta({ type: 'done', id: transferId });
        this.onProgress(transferId, {
            pct: 100, speed: 0, sent: file.size,
            total: file.size, done: true,
            name: file.name, direction: 'send',
        });
    }

    // ── RECEIVE binary chunk ───────────────────────────────────
    onReceiveBinary(data) {
        if (!(data instanceof ArrayBuffer)) return;
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
        const speed = st.received / elapsed;
        const remaining = (st.meta.size - st.received) / (speed || 1);

        this._throttledProgress(id, {
            pct: Math.round(st.received / st.meta.size * 100),
            speed, sent: st.received, total: st.meta.size,
            eta: remaining, done: false,
            name: st.meta.name, direction: 'recv',
        });
    }

    // ── RECEIVE meta / done ────────────────────────────────────
    onReceiveMeta(msg) {
        if (msg.type === 'meta') {
            this._incoming[msg.id] = {
                meta: msg, chunks: new Array(msg.totalChunks),
                received: 0, startTime: Date.now(),
            };
            this.onProgress(msg.id, {
                pct: 0, speed: 0, sent: 0, total: msg.size, eta: 0,
                done: false, name: msg.name, direction: 'recv',
            });
        }

        if (msg.type === 'done') {
            const st = this._incoming[msg.id];
            if (!st) return;

            // Reassemble — filter out any undefined slots (safety)
            const parts = st.chunks.map(c => c ? new Uint8Array(c) : new Uint8Array(0));
            const blob = new Blob(parts);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = st.meta.name;
            document.body.appendChild(a); a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);

            this.onProgress(msg.id, {
                pct: 100, speed: 0, sent: st.meta.size,
                total: st.meta.size, done: true,
                name: st.meta.name, direction: 'recv',
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
let fileQueue = [];    // Array of File objects
let transfers = {};
let isConnected = false;
let disconnectTimer = null;  // grace period timer

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
function fmtSpeed(bps) { return bps > 0 ? fmtBytes(bps) + '/s' : '—'; }
function fmtETA(sec) {
    if (!sec || sec > 3600) return '';
    if (sec < 60) return Math.round(sec) + 's left';
    return Math.round(sec / 60) + 'm left';
}
function genId(n = 8) { return Math.random().toString(36).slice(2, 2 + n).padEnd(n, '0'); }

function toast(msg, type = 'info') {
    const icons = { success: '✓', error: '✕', info: 'ℹ', warn: '⚠' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${msg}</span>`;
    $('toastContainer').appendChild(el);
    setTimeout(() => {
        el.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(() => el.remove(), 300);
    }, 4000);
}

function setStatus(state) {
    const labels = {
        disconnected: 'Disconnected', connecting: 'Connecting…',
        connected: 'Connected', transferring: 'Transferring',
        reconnecting: 'Reconnecting…',
    };
    $('badgeText').textContent = labels[state] || state;
    $('connectionBadge').className = 'header-badge ' + (
        state === 'connected' || state === 'transferring' ? 'connected' :
            state === 'connecting' || state === 'reconnecting' ? 'connecting' : ''
    );
}

// ─────────────────────────────────────────────────────────────
// Connect via Trystero
// ─────────────────────────────────────────────────────────────
async function joinRoom(code) {
    setStatus('connecting');
    toast('Connecting via Nostr relay…', 'info');

    const { joinRoom: trysteroJoin } = await import('https://esm.sh/trystero/nostr');

    trysteroRoom = trysteroJoin({ appId: APP_ID }, code);

    const [sendBinary, getBinary] = trysteroRoom.makeAction('bin');
    const [sendMeta, getMeta] = trysteroRoom.makeAction('meta');

    fileEngine = new FileTransferEngine(sendBinary, sendMeta, handleProgress);

    getBinary(data => fileEngine.onReceiveBinary(data));
    getMeta(data => fileEngine.onReceiveMeta(data));

    trysteroRoom.onPeerJoin(peerId => {
        // Cancel any pending disconnect reset
        if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
        isConnected = true;
        setStatus('connected');
        toast('Peer connected! Ready to transfer.', 'success');
        $('peerName').textContent = 'Peer — ' + peerId.slice(0, 8);
        $('peerRole').textContent = 'Direct P2P via WebRTC';
        showTransferScreen();
    });

    trysteroRoom.onPeerLeave(() => {
        isConnected = false;
        setStatus('reconnecting');
        // ── Grace period: relay blips don't immediately reset ──
        // If peer rejoins within 10s, everything continues normally
        toast('Peer signal lost — waiting 10s before reset…', 'warn');
        disconnectTimer = setTimeout(() => {
            toast('Peer disconnected.', 'error');
            resetToLobby();
        }, 10000);
    });
}

// ─────────────────────────────────────────────────────────────
// Progress
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
    const dir = info.direction === 'recv' ? 'recv' : 'send';
    const dirLabel = dir === 'recv' ? '↓ Receiving' : '↑ Sending';
    li.innerHTML = `
    <div class="transfer-item-header">
      <span class="transfer-name" title="${info.name || ''}">${info.name || ('File #' + id.slice(0, 4))}</span>
      <span class="transfer-direction ${dir}">${dirLabel}</span>
    </div>
    <div class="transfer-bar-bg">
      <div class="transfer-bar-fill" id="bar-${id}" style="width:0%"></div>
    </div>
    <div class="transfer-stats">
      <span id="spd-${id}">Starting…</span>
      <span id="eta-${id}" class="eta"></span>
      <span class="pct" id="pct-${id}">0%</span>
    </div>`;
    $('transferList').prepend(li);
}

function updateTransferItem(id, info) {
    const bar = $('bar-' + id);
    const pct = $('pct-' + id);
    const spd = $('spd-' + id);
    const eta = $('eta-' + id);
    const item = $('ti-' + id);
    if (!bar) return;

    bar.style.width = Math.min(info.pct, 100) + '%';
    pct.textContent = info.pct + '%';

    if (info.done) {
        spd.textContent = fmtBytes(info.total) + ' — Done ✓';
        eta.textContent = '';
        item.classList.add('done');
        transfers[id] = { ...transfers[id], done: true };
        const msg = info.direction === 'recv'
            ? `✓ Received: ${info.name}`
            : `✓ Sent: ${info.name}`;
        toast(msg, 'success');
    } else {
        spd.textContent = fmtSpeed(info.speed);
        eta.textContent = fmtETA(info.eta);
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
    if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
    trysteroRoom?.leave?.();
    trysteroRoom = null; fileEngine = null;
    fileQueue = []; transfers = {}; isConnected = false;
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
// File Queue — supports files + folders
// ─────────────────────────────────────────────────────────────
function addFilesToQueue(files) {
    for (const f of files) {
        // Skip hidden OS files
        if (f.name.startsWith('.') || f.size === 0) continue;
        const key = f.name + '_' + f.size;
        if (!fileQueue.find(q => q.name + '_' + q.size === key)) {
            fileQueue.push(f);
        }
    }
    renderQueue();
}

function removeFromQueue(index) {
    fileQueue.splice(index, 1);
    if (fileQueue.length === 0) {
        $('fileQueue').classList.add('hidden');
    } else {
        renderQueue();
    }
}

function renderQueue() {
    $('queueList').innerHTML = '';
    let totalSize = 0;
    fileQueue.forEach((f, i) => {
        totalSize += f.size;
        const ext = (f.name.split('.').pop() || 'file').slice(0, 4).toUpperCase();
        const li = document.createElement('li');
        li.className = 'queue-item';
        li.innerHTML = `
      <div class="queue-item-icon">${ext}</div>
      <span class="queue-item-name" title="${f.name}">${f.name}</span>
      <span class="queue-item-size">${fmtBytes(f.size)}</span>
      <button class="btn-remove-queue" data-idx="${i}" title="Remove" aria-label="Remove ${f.name}">✕</button>`;
        $('queueList').appendChild(li);
    });
    const count = fileQueue.length;
    $('queueCount').textContent =
        count + (count === 1 ? ' file' : ' files') + ' — ' + fmtBytes(totalSize) + ' total';
    $('fileQueue').classList.remove('hidden');
}

// Event delegation for remove buttons
$('queueList').addEventListener('click', e => {
    const btn = e.target.closest('.btn-remove-queue');
    if (btn) removeFromQueue(Number(btn.dataset.idx));
});

// ─────────────────────────────────────────────────────────────
// QR Code
// ─────────────────────────────────────────────────────────────
function generateQR(code) {
    const qrEl = $('qrcode');
    qrEl.innerHTML = '';
    const url = location.origin + location.pathname + '?room=' + code;
    new QRCode(qrEl, {
        text: url, width: 136, height: 136,
        colorDark: '#1a1a2e', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
    });
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
    catch (e) { toast('Connection failed. Check internet.', 'error'); console.error(e); }
});

// Join Room
$('btnJoin').addEventListener('click', doJoin);
$('roomCodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
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
        toast('Connection failed. Check internet.', 'error'); console.error(e);
    }
}

// Copy Code / Link
document.addEventListener('click', e => {
    if (e.target.closest('#btnCopyCode')) {
        navigator.clipboard?.writeText($('btnCopyCode').dataset.code)
            .then(() => toast('Code copied!', 'success'));
    }
    if (e.target.closest('#btnCopyLink')) {
        const url = location.origin + location.pathname + '?room=' + $('btnCopyLink').dataset.code;
        navigator.clipboard?.writeText(url).then(() => toast('Link copied!', 'success'));
    }
});

// Disconnect
$('btnDisconnect').addEventListener('click', () => { resetToLobby(); toast('Disconnected.', 'info'); });

// ── Drop Zone ──────────────────────────────────────────────
const dropZone = $('dropZone');
const fileInput = $('fileInput');
const folderInput = $('folderInput');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');

    // Handle both files and folder drops
    const items = [...(e.dataTransfer.items || [])];
    if (items.length && items[0].webkitGetAsEntry) {
        const allFiles = [];
        let pending = items.length;
        items.forEach(item => {
            const entry = item.webkitGetAsEntry();
            if (!entry) { pending--; return; }
            readEntry(entry, allFiles, () => {
                pending--;
                if (pending === 0) addFilesToQueue(allFiles);
            });
        });
    } else {
        addFilesToQueue([...e.dataTransfer.files]);
    }
});

function readEntry(entry, out, done) {
    if (entry.isFile) {
        entry.file(f => { out.push(f); done(); });
    } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () => reader.readEntries(entries => {
            if (!entries.length) { done(); return; }
            let pending = entries.length;
            entries.forEach(e => readEntry(e, out, () => { if (--pending === 0) readAll(); }));
        });
        readAll();
    } else { done(); }
}

fileInput.addEventListener('change', () => {
    addFilesToQueue([...fileInput.files]);
    fileInput.value = '';
});
folderInput.addEventListener('change', () => {
    addFilesToQueue([...folderInput.files]);
    folderInput.value = '';
});

// Folder button
$('btnFolder').addEventListener('click', () => folderInput.click());

// Clear Queue
$('btnClearQueue').addEventListener('click', () => {
    fileQueue = []; $('fileQueue').classList.add('hidden');
});

// Send Files
$('btnSend').addEventListener('click', async () => {
    if (!fileEngine) { toast('No peer connected.', 'error'); return; }
    if (!fileQueue.length) { toast('No files selected.', 'error'); return; }

    const batch = [...fileQueue];
    fileQueue = [];
    $('fileQueue').classList.add('hidden');

    toast(`Sending ${batch.length} file${batch.length > 1 ? 's' : ''}…`, 'info');

    for (const file of batch) {
        const id = genId(8);
        transfers[id] = { id, name: file.name, direction: 'send', done: false };
        $('noTransfers').classList.add('hidden');
        renderTransferItem(id, { name: file.name, direction: 'send', pct: 0 });
        // Send sequentially — wait for each before starting next
        await fileEngine.sendFile(file, id).catch(e => {
            toast('Error sending ' + file.name, 'error'); console.error(e);
        });
    }
});

// ── Clipboard Paste (Ctrl+V) ──────────────────────────────
document.addEventListener('paste', e => {
    if (!isConnected) return;
    const items = [...(e.clipboardData?.items || [])];
    const files = items
        .filter(i => i.kind === 'file')
        .map(i => i.getAsFile())
        .filter(Boolean);
    if (files.length) { addFilesToQueue(files); toast('File added from clipboard!', 'info'); }
});

// ─────────────────────────────────────────────────────────────
// Auto-join from URL (?room=XXXXXX)
// ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    const urlRoom = RoomManager.fromUrl();
    if (urlRoom && /^\d{6}$/.test(urlRoom)) {
        $('roomCodeInput').value = urlRoom;
        doJoin();
    }
});
