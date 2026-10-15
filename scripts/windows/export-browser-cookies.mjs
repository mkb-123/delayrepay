const [debugPort, domain, outputPath] = process.argv.slice(2);
if (!debugPort || !domain || !outputPath) {
  throw new Error("Usage: node export-browser-cookies.mjs PORT DOMAIN OUTPUT");
}

const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(response => response.json());
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, {once: true});
  socket.addEventListener("error", reject, {once: true});
});
socket.send(JSON.stringify({id: 1, method: "Network.getAllCookies"}));
const message = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Timed out reading browser cookies")), 10000);
  socket.addEventListener("message", event => {
    const value = JSON.parse(event.data);
    if (value.id !== 1) return;
    clearTimeout(timer);
    resolve(value);
  });
});
socket.close();
if (message.error) throw new Error(message.error.message);
const cookies = message.result.cookies
  .filter(cookie => cookie.domain === domain || cookie.domain.endsWith(`.${domain}`))
  .map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires > 0 ? cookie.expires : -1,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: ({Strict: "Strict", Lax: "Lax", None: "None"})[cookie.sameSite] || "Lax",
  }));
if (!cookies.length) throw new Error(`No cookies found for ${domain}; complete login before continuing.`);
await import("node:fs/promises").then(fs => fs.writeFile(outputPath, JSON.stringify(cookies), {mode: 0o600}));
console.log(`Captured ${cookies.length} session cookies for ${domain}.`);
