# FastDrop — P2P File Transfer

Private AirDrop for any device. Files travel **directly** over your LAN via WebRTC.  
**No accounts. No API keys. $0 forever.**

---

## Setup — Zero Config Required

No Supabase. No Firebase. Nothing to sign up for.

Just open `index.html` or deploy to Vercel — it works immediately.

Signaling uses **free public Nostr relay servers** via [Trystero](https://github.com/dmotz/trystero).

---

## Deploy to Vercel

1. Push this folder to a GitHub repo
2. Import at [vercel.com](https://vercel.com) → Deploy
3. Share the URL

---

## Local Testing (no install)

```bash
npx serve .
```

Open two browser tabs → Tab A creates room → Tab B joins.

---

## Usage

| Action | How |
|--------|-----|
| Create room | Click **New Room** → share 6-digit code or QR |
| Join via code | Type code → **Join** |
| Join via URL | `https://your-app.vercel.app/?room=123456` |
| Send files | Drag-drop or click drop zone → **Send All** |
| Receive | Files auto-download in browser |

---

## How It Works

```
Device A ──[SDP Offer via Nostr relay]──► Device B
Device A ◄─[SDP Answer]─────────────── Device B
         ↓ Relay drops out instantly
Device A ◄══════ WebRTC DataChannel ══════► Device B
          256 KB chunks · LAN direct path
```

**Speed on gigabit LAN: 300–900 Mbps typical**
