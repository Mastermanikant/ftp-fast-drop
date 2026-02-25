# FastDrop 🚀

**The Fastest Free P2P File Transfer Web App**

FastDrop is an open-source, beautifully designed, and ultra-fast peer-to-peer (P2P) file transfer application. Built directly on top of **WebRTC**, it securely drops files directly between devices without ever routing your data through a cloud server.

🌍 **Live Demo:** [FastDrop on Vercel](https://ftp-fast-drop.vercel.app/)

## ✨ Why FastDrop is the Best?

* **Zero Clouds, Zero Limits:** Your files are transferred directly from device A to device B. There are no file size limits, no storage quotas, and zero privacy concerns.
* **Gigabit LAN Speeds:** If both devices are on the same Wi-Fi network, files transfer at the maximum speed of your router network (often reaching hundreds of Megabytes per second).
* **Hotspot Magic:** No Wi-Fi router? No problem. Turn on your mobile hotspot, connect the other device, and use FastDrop to transfer heavy files at maximum speed without consuming your internet data.
* **100% Free & No Registration:** We don't ask for your email, we don't ask for a login, and we'll never charge you.
* **Progressive Web App (PWA):** Install FastDrop directly to your home screen or PC desktop for a native-like experience.

## 📖 How to Use (English)

1. **Open FastDrop** on the Sender device.
2. Click **Create Room**. A 6-digit Code and QR Code will be generated.
3. **Open FastDrop** on the Receiver device (scanning the QR code opens the app automatically).
4. Join the room using the code or the built-in QR scanner.
5. Drag & drop files/folders, or use the **Add Folder** button.
6. Click **Send All** and watch your files whiz across the room instantly.

## 🇮🇳 कैसे उपयोग करें (Hindi)

1. भेजने वाले (Sender) डिवाइस पर **FastDrop खोलें**।
2. **Create Room** पर क्लिक करें। आपको 6-अंकों का कोड और एक QR कोड मिलेगा।
3. प्राप्त करने वाले (Receiver) डिवाइस पर **FastDrop खोलें** (QR कोड स्कैन करने से ऐप खुद-ब-खुद खुल जाएगा)।
4. कोड डालकर या QR स्कैनर से रूम में शामिल (Join) हों।
5. अपनी फ़ाइलें/फ़ोल्डर ड्रॉप करें या **Add Folder** चुनें।
6. **Send All** पर क्लिक करें और बिना इंटरनेट डेटा खर्च किए अपनी फ़ाइलें ट्रांसफर करें।

## 🛠️ Tech Stack & Architecture

FastDrop relies entirely on vanilla web technologies for lightning-fast performance:

* **Frontend:** HTML5, Vanilla JavaScript, CSS3
* **Signaling:** [Trystero](https://github.com/dmotz/trystero) (Using free public Nostr relays for the initial WebRTC SDP Offer/Answer handshake).
* **Data Transfer:** WebRTC `RTCDataChannel` customized to send **256KB chunks** in `ordered` mode, optimized specifically for high-throughput LAN transfers. Backpressure handling is event-driven to avoid CPU-wasting polling loops.
* **Libraries:** `qrcode.js` and `jsQR` for seamless camera pairing.

## 🏃 Build & Deploy

FastDrop has no build steps or bundlers. Running it is as simple as serving a static folder.

1. `git clone https://github.com/Mastermanikant/ftp-fast-drop.git`
2. `cd ftp-fast-drop`
3. Serve with any web server (e.g., `npx serve .` or Live Server in VS Code).
4. **Deploy:** Just drag and drop the folder into Vercel or Netlify.

---
Built with ❤️ using WebRTC. Star the repo if you found it fast!
