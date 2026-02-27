/**
 * FastDrop — P2P File Transfer (v4)
 * Signaling: Trystero (Nostr relays)
 * Transfer:  WebRTC RTCDataChannel — 256 KB chunks, streamed
 * v4: Clean rewrite — streaming reads, chunk-count tracking, INP fixes
 */

const APP_VERSION = 'v5';
const APP_ID = 'fastdrop-v1';
const CHUNK_SIZE = 64 * 1024; // 64 KB — safe across all browsers, 4× less overhead than 16 KB
const UI_HZ = 60;

let trysteroModule = null;
async function preloadTrystero() {
    try { trysteroModule = await import('https://esm.sh/trystero/nostr'); }
    catch (e) { console.warn('Trystero preload failed:', e); }
}
preloadTrystero();

// ─────────────────────────────────────────────────────────────
// RoomManager
// ─────────────────────────────────────────────────────────────
class RoomManager {
    static generate() {
        const a = new Uint32Array(1);
        crypto.getRandomValues(a);
        return String(a[0] % 900000 + 100000);
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
        this._lastUI = {};
    }

    _ui(id, info) {
        const now = Date.now();
        if (!info.done && (now - (this._lastUI[id] || 0)) < UI_HZ) return;
        this._lastUI[id] = now;
        this.onProgress(id, info);
    }

    // ── SEND ─────────────────────────────────────────────────
    async sendFile(file, transferId) {
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        this._sendMeta({ type: 'meta', id: transferId, name: file.name, size: file.size, totalChunks });

        let sent = 0;
        const startTime = Date.now();

        for (let i = 0; i < totalChunks; i++) {
            // Stream each chunk — NO full file.arrayBuffer() — avoids 600ms INP block
            const slice = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
            const buffer = await slice.arrayBuffer();

            // 12-byte header: [chunkIndex u32 (4)] + [transferId chars (8)]
            const pkt = new Uint8Array(12 + buffer.byteLength);
            const view = new DataView(pkt.buffer);
            view.setUint32(0, i);
            for (let c = 0; c < 8; c++) pkt[4 + c] = transferId.charCodeAt(c) || 0;
            pkt.set(new Uint8Array(buffer), 12);

            this._sendBinary(pkt.buffer);
            sent += buffer.byteLength;

            const elapsed = (Date.now() - startTime) / 1000 || 0.001;
            const speed = sent / elapsed;

            this._ui(transferId, {
                pct: Math.round((i + 1) / totalChunks * 100),
                speed, sent, total: file.size,
                eta: (file.size - sent) / speed,
                done: false, name: file.name, direction: 'send',
            });

            // Yield to event loop every 128 chunks (~8 MB) to prevent UI freeze without
            // adding any artificial sleep — maximises throughput on fast networks
            if (i % 128 === 0) await new Promise(r => setTimeout(r, 0));
        }

        this._sendMeta({ type: 'done', id: transferId });
        this.onProgress(transferId, {
            pct: 100, speed: 0, sent: file.size,
            total: file.size, done: true,
            name: file.name, direction: 'send',
        });
    }

    // ── RECEIVE binary ────────────────────────────────────────
    onReceiveBinary(data) {
        if (!(data instanceof ArrayBuffer)) return;

        const view = new DataView(data);
        const index = view.getUint32(0);
        const idArr = new Uint8Array(data, 4, 8);
        const id = String.fromCharCode(...idArr).replace(/\0/g, '');
        const chunk = data.slice(12);

        const st = this._incoming[id];
        if (!st) return;

        // Store chunk & track count (not bytes — safer for race conditions)
        if (st.chunks[index] === undefined) {
            st.chunks[index] = chunk;
            st.received++;
            st.bytes += chunk.byteLength;
        }

        const elapsed = (Date.now() - st.startTime) / 1000 || 0.001;
        const speed = st.bytes / elapsed;

        this._ui(id, {
            pct: Math.round(st.received / st.meta.totalChunks * 100),
            speed, sent: st.bytes, total: st.meta.size,
            eta: (st.meta.size - st.bytes) / speed,
            done: false, name: st.meta.name, direction: 'recv',
        });

        // Assembly triggered exactly when chunk count matches — no race
        if (st.received === st.meta.totalChunks && !st.assembled) {
            st.assembled = true;
            this._finalize(id, st);
        }
    }

    _finalize(id, st) {
        const parts = st.chunks.map(c => c ? new Uint8Array(c) : new Uint8Array(0));
        const blob = new Blob(parts);
        const url = URL.createObjectURL(blob);

        // Auto-download
        const a = document.createElement('a');
        a.href = url;
        a.download = st.meta.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // Ping sender
        this._sendMeta({ type: 'downloaded', id });

        this.onProgress(id, {
            pct: 100, speed: 0, sent: st.meta.size,
            total: st.meta.size, done: true,
            name: st.meta.name, direction: 'recv', url,
        });
        delete this._incoming[id];
    }

    // ── RECEIVE meta ──────────────────────────────────────────
    onReceiveMeta(msg) {
        if (msg.type === 'meta') {
            this._incoming[msg.id] = {
                meta: msg,
                chunks: new Array(msg.totalChunks),
                received: 0, bytes: 0,
                startTime: Date.now(),
                assembled: false,
            };
            this.onProgress(msg.id, {
                pct: 0, speed: 0, sent: 0, total: msg.size, eta: 0,
                done: false, name: msg.name, direction: 'recv',
            });
        }

        if (msg.type === 'done') {
            // Fallback: If chunk count matched but 'done' arrives late, safe to ignore.
            // If chunks haven't arrived yet, wait — _finalize fires from onReceiveBinary.
            const st = this._incoming[msg.id];
            if (st && !st.assembled && st.received === st.meta.totalChunks) {
                st.assembled = true;
                this._finalize(msg.id, st);
            }
        }

        if (msg.type === 'downloaded') {
            const el = document.getElementById('spd-' + msg.id);
            if (el) el.textContent = '✓ Receiver Saved';
            toast('✓ Peer saved: ' + (transfers[msg.id]?.name || 'file'), 'success');
        }
    }
}

// ─────────────────────────────────────────────────────────────
// LocalRoom — Offline/LAN WebRTC with local WebSocket signaling
// Mirrors Trystero room API: makeAction / onPeerJoin / onPeerLeave / leave
// ─────────────────────────────────────────────────────────────
class LocalRoom {
    constructor(code, wsUrl) {
        this._code = code;
        this._pc = null;
        this._channels = {};           // name → RTCDataChannel
        this._handlers = {};           // name → receive handler
        this._onPeerJoin = null;
        this._onPeerLeave = null;
        this._openChannels = 0;
        this._CHANNEL_NAMES = ['bin', 'meta'];

        this._ws = new WebSocket(wsUrl);
        this._ws.onopen = () => this._ws.send(JSON.stringify({ type: 'join', room: code }));
        this._ws.onmessage = e => this._handleSignal(JSON.parse(e.data));
        this._ws.onerror = () => console.error('❌ Local signaling WS error');
    }

    makeAction(name) {
        const send = (data) => {
            const ch = this._channels[name];
            if (!ch || ch.readyState !== 'open') return;
            if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
                ch.send(data);
            } else {
                ch.send(JSON.stringify(data));
            }
        };
        const onReceive = (handler) => { this._handlers[name] = handler; };
        return [send, onReceive];
    }

    onPeerJoin(cb) { this._onPeerJoin = cb; }
    onPeerLeave(cb) { this._onPeerLeave = cb; }

    leave() {
        this._ws?.close();
        this._pc?.close();
    }

    async _initPC(initiator) {
        const pc = new RTCPeerConnection({ iceServers: [] }); // no STUN needed on LAN
        this._pc = pc;

        pc.onicecandidate = e => {
            if (e.candidate) this._signal({ type: 'ice', candidate: e.candidate });
        };
        pc.onconnectionstatechange = () => {
            const s = pc.connectionState;
            console.log('WebRTC state:', s);
            if (s === 'failed') this._onPeerLeave?.();
            // 'disconnected' can be transient — only treat 'failed' as real disconnect
        };

        if (initiator) {
            for (const name of this._CHANNEL_NAMES) {
                const ch = pc.createDataChannel(name, { ordered: true });
                ch.binaryType = 'arraybuffer';
                this._setupChannel(ch, name);
            }
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this._signal({ type: 'offer', sdp: pc.localDescription });
        } else {
            pc.ondatachannel = e => {
                e.channel.binaryType = 'arraybuffer';
                this._setupChannel(e.channel, e.channel.label);
            };
        }
    }

    _setupChannel(ch, name) {
        this._channels[name] = ch;
        ch.onopen = () => {
            this._openChannels++;
            if (this._openChannels === this._CHANNEL_NAMES.length)
                this._onPeerJoin?.('local-peer');
        };
        ch.onmessage = e => {
            const handler = this._handlers[name];
            if (!handler) return;
            if (e.data instanceof ArrayBuffer) {
                handler(e.data);
            } else {
                try { handler(JSON.parse(e.data)); } catch { handler(e.data); }
            }
        };
        // NOTE: do NOT hook ch.onclose here — a channel closing after transfer
        // completes is normal and must NOT trigger peer disconnect.
        // Disconnect is detected only via pc.onconnectionstatechange above.
    }

    _signal(msg) { this._ws.send(JSON.stringify(msg)); }

    async _handleSignal(msg) {
        if (msg.type === 'peer-joined') {
            await this._initPC(true);
        } else if (msg.type === 'offer') {
            await this._initPC(false);
            await this._pc.setRemoteDescription(msg.sdp);
            const answer = await this._pc.createAnswer();
            await this._pc.setLocalDescription(answer);
            this._signal({ type: 'answer', sdp: this._pc.localDescription });
        } else if (msg.type === 'answer') {
            await this._pc.setRemoteDescription(msg.sdp);
        } else if (msg.type === 'ice') {
            await this._pc.addIceCandidate(msg.candidate).catch(() => { });
        } else if (msg.type === 'peer-left') {
            this._onPeerLeave?.();
        }
    }
}

function isLocalNetwork() {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' ||
        /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

// ─────────────────────────────────────────────────────────────
// App State
// ─────────────────────────────────────────────────────────────
let trysteroRoom = null;
let fileEngine = null;
let fileQueue = [];
let transfers = {};
let isConnected = false;

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

    if (isLocalNetwork()) {
        // ── LOCAL MODE: WebSocket signaling on same LAN/hotspot, no internet needed
        toast('Connecting via local network…', 'info');
        trysteroRoom = new LocalRoom(code, `ws://${location.host}`);
    } else {
        // ── ONLINE MODE: Trystero via Nostr relay
        toast('Connecting via Nostr relay…', 'info');
        if (!trysteroModule) trysteroModule = await import('https://esm.sh/trystero/nostr');
        const { joinRoom: trysteroJoin } = trysteroModule;
        trysteroRoom = trysteroJoin({
            appId: APP_ID,
            rtcConfig: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun3.l.google.com:19302' },
                    { urls: 'stun:stun4.l.google.com:19302' }
                ]
            }
        }, code);
        if (trysteroRoom.on) {
            trysteroRoom.on('error', err => {
                console.error('❌ Connection error:', err);
                toast('❌ Connection error. Check your internet & firewall.', 'error');
                setStatus('disconnected');
            });
        }
    }

    const [sendBinary, getBinary] = trysteroRoom.makeAction('bin');
    const [sendMeta, getMeta] = trysteroRoom.makeAction('meta');

    fileEngine = new FileTransferEngine(sendBinary, sendMeta, handleProgress);
    getBinary(data => fileEngine.onReceiveBinary(data));
    getMeta(data => fileEngine.onReceiveMeta(data));

    trysteroRoom.onPeerJoin(peerId => {
        isConnected = true;
        setStatus('connected');
        toast('✓ Peer connected! Ready to transfer.', 'success');
        console.log('✓ Peer joined:', peerId);
        $('peerName').textContent = 'Peer — ' + String(peerId).slice(0, 8);
        $('peerRole').textContent = isLocalNetwork() ? '⚡ Local Network — Max Speed' : 'Direct P2P via WebRTC';
        showTransferScreen();
    });

    trysteroRoom.onPeerLeave(() => {
        isConnected = false;
        setStatus('reconnecting');
        toast('⚠ Peer disconnected — waiting to reconnect…', 'warn');
        console.log('⚠ Peer left, reconnecting…');
    });
}

// ─────────────────────────────────────────────────────────────
// Progress / UI
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
      <span class="transfer-name" id="tn-${id}" title="${info.name || ''}">${info.name || ('File #' + id.slice(0, 4))}</span>
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
        spd.textContent = fmtBytes(info.total) + (info.direction === 'recv' ? ' — Saved ✓' : ' — Sent ✓');
        eta.textContent = '';
        item.classList.add('done');
        transfers[id] = { ...transfers[id], ...info, done: true };

        if (info.direction === 'recv' && info.url) {
            const nameEl = $('tn-' + id);
            if (nameEl) {
                nameEl.innerHTML = `<a href="${info.url}" download="${info.name}" style="color:var(--accent);text-decoration:underline;">${info.name} ↓ Save Again</a>`;
            }
        }
        const msg = info.direction === 'recv' ? `✓ Received: ${info.name}` : `✓ Sent: ${info.name}`;
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
// File Queue
// ─────────────────────────────────────────────────────────────
function addFilesToQueue(files) {
    for (const f of files) {
        if (f.name.startsWith('.') || f.size === 0) continue;
        const key = f.name + '_' + f.size;
        if (!fileQueue.find(q => q.name + '_' + q.size === key)) fileQueue.push(f);
    }
    renderQueue();
}

function removeFromQueue(index) {
    fileQueue.splice(index, 1);
    if (fileQueue.length === 0) $('fileQueue').classList.add('hidden');
    else renderQueue();
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
    $('queueCount').textContent = count + (count === 1 ? ' file' : ' files') + ' — ' + fmtBytes(totalSize) + ' total';
    $('fileQueue').classList.remove('hidden');
}

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
    // Defer QR generation so the click handler returns fast (fixes INP)
    setTimeout(() => generateQR(code), 0);
    $('btnCopyCode').dataset.code = code;
    $('btnCopyLink').dataset.code = code;
    try {
        await joinRoom(code);
        console.log('✓ Room created:', code);
    } catch (e) {
        console.error('❌ Create room failed:', e);
        toast('❌ Failed to create room. Check your internet, firewall, or try again.', 'error');
    }
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
        toast('✓ Joined room. Waiting for peer to connect…', 'info');
        console.log('✓ Joined room:', code);
    } catch (e) {
        console.error('❌ Join failed:', code, e);
        toast('❌ Failed to join. Verify room code & check firewall/internet.', 'error');
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
    const items = [...(e.dataTransfer.items || [])];
    if (items.length && items[0].webkitGetAsEntry) {
        const allFiles = [];
        let pending = items.length;
        items.forEach(item => {
            const entry = item.webkitGetAsEntry();
            if (!entry) { pending--; return; }
            readEntry(entry, allFiles, () => {
                if (--pending === 0) addFilesToQueue(allFiles);
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

fileInput.addEventListener('change', () => { addFilesToQueue([...fileInput.files]); fileInput.value = ''; });
folderInput.addEventListener('change', () => { addFilesToQueue([...folderInput.files]); folderInput.value = ''; });

// Folder button
$('btnFolder').addEventListener('click', e => { e.stopPropagation(); folderInput.click(); });

// Clear Queue
$('btnClearQueue').addEventListener('click', () => { fileQueue = []; $('fileQueue').classList.add('hidden'); });

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
        await fileEngine.sendFile(file, id).catch(e => {
            toast('Error sending ' + file.name, 'error'); console.error(e);
        });
    }
});

// Clipboard Paste (Ctrl+V)
document.addEventListener('paste', e => {
    if (!isConnected) return;
    const files = [...(e.clipboardData?.items || [])]
        .filter(i => i.kind === 'file')
        .map(i => i.getAsFile())
        .filter(Boolean);
    if (files.length) { addFilesToQueue(files); toast('File added from clipboard!', 'info'); }
});

// ─────────────────────────────────────────────────────────────
// QR Scanner
// ─────────────────────────────────────────────────────────────
let scanStream = null;
let scanAnimFrame = null;

function openQRScanner() {
    $('qrScannerModal').classList.remove('hidden');
    const video = $('qrVideo');
    const canvas = $('qrCanvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const status = $('qrScanStatus');
    status.textContent = 'Starting camera…';

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(stream => {
            scanStream = stream;
            video.srcObject = stream;
            video.play();
            status.textContent = 'Point camera at the QR code…';

            function tick() {
                if (video.readyState === video.HAVE_ENOUGH_DATA) {
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    ctx.drawImage(video, 0, 0);
                    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const code = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
                    if (code) {
                        const match = code.data.match(/[?&]room=(\d{6})/);
                        if (match) {
                            closeQRScanner();
                            $('roomCodeInput').value = match[1];
                            doJoin();
                        }
                    }
                }
                scanAnimFrame = requestAnimationFrame(tick);
            }
            tick();
        })
        .catch(() => { status.textContent = 'Camera access denied.'; });
}

function closeQRScanner() {
    cancelAnimationFrame(scanAnimFrame);
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
    $('qrScannerModal').classList.add('hidden');
}

$('btnScan')?.addEventListener('click', openQRScanner);
$('btnCloseScan')?.addEventListener('click', closeQRScanner);

// ─────────────────────────────────────────────────────────────
// Guide Tab Toggle
// ─────────────────────────────────────────────────────────────
$('tab-en')?.addEventListener('click', () => {
    $('guide-en').classList.remove('hidden');
    $('guide-hi').classList.add('hidden');
    $('tab-en').classList.add('active');
    $('tab-hi').classList.remove('active');
});
$('tab-hi')?.addEventListener('click', () => {
    $('guide-hi').classList.remove('hidden');
    $('guide-en').classList.add('hidden');
    $('tab-hi').classList.add('active');
    $('tab-en').classList.remove('active');
});

// ─────────────────────────────────────────────────────────────
// Auto-join from URL ?room=XXXXXX
// ─────────────────────────────────────────────────────────────
const urlRoom = RoomManager.fromUrl();
if (urlRoom && urlRoom.length === 6) {
    $('roomCodeInput').value = urlRoom;
    doJoin();
}
