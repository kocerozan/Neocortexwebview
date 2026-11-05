// Native (iOS WKWebView / Android WebView) köprüsü.
//
// Web → Native mesajları (hepsi düz JSON nesnesi):
//   { type: 'ready', version }
//   { type: 'file.begin', id, kind: 'image'|'video', mimeType, size, chunks, meta }
//   { type: 'file.chunk', id, index, data }          // data = base64, her parça bağımsız çözülür
//   { type: 'file.end',   id }
//   { type: 'result.complete', imageId, videoId, clips }
//   { type: 'close' }
// iOS:     window.webkit.messageHandlers.neocortex.postMessage(obj)
// Android: window.NeoCortexAndroid.postMessage(JSON.stringify(obj))
//
// Native → Web: window.NeoCortex.reset(), window.NeoCortex.setInfo({ title, hint })

const CHUNK_BYTES = 3 * 64 * 1024; // 192 KB — 3'ün katı, base64 parçaları bağımsız çözülür

const ios = () => window.webkit?.messageHandlers?.neocortex;
const android = () => window.NeoCortexAndroid;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

let seq = 0;

export const bridge = {
  get available() {
    return !!(ios() || android()?.postMessage);
  },
  get platform() {
    if (ios()) return 'ios';
    if (android()?.postMessage) return 'android';
    return 'web';
  },
  post(msg) {
    if (ios()) ios().postMessage(msg);
    else if (android()?.postMessage) android().postMessage(JSON.stringify(msg));
    window.dispatchEvent(new CustomEvent('neocortex:message', { detail: msg }));
  },
  async sendBlob(kind, blob, meta = {}, onProgress = () => {}) {
    const id = `${kind}-${Date.now()}-${++seq}`;
    const chunks = Math.max(1, Math.ceil(blob.size / CHUNK_BYTES));
    this.post({ type: 'file.begin', id, kind, mimeType: blob.type, size: blob.size, chunks, meta });
    for (let i = 0; i < chunks; i++) {
      const data = await blobToBase64(blob.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
      this.post({ type: 'file.chunk', id, index: i, data });
      onProgress((i + 1) / chunks);
      if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
    }
    this.post({ type: 'file.end', id });
    return id;
  },
};
