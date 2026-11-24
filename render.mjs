import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const chromePath = '/opt/meta-chromium/chrome';
const webglPolicy = '/var/lib/hatch-browser/rootfs-base/usr/share/hatch/chromium/webgl-allowed-domains.txt';
const webglPolicySha256 = '8097045f0459c96c4cdc76e3a1af4e0f43f640b4b59c43d6db35e3641c0264c6';
const pagePath = fileURLToPath(new URL('./index.html', import.meta.url));
const outputPath = fileURLToPath(new URL('./entry.png', import.meta.url));

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForDebugEndpoint(url, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chromium exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch { /* Chromium is still starting. */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('Timed out waiting for Chromium remote debugging endpoint');
}

function connectCdp(wsUrl) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener('open', () => resolveSocket({
      socket,
      send(method, params = {}) {
        const id = ++nextId;
        return new Promise((resolveResult, rejectResult) => {
          pending.set(id, { resolve: resolveResult, reject: rejectResult });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      on(method, callback) {
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          if (message.method === method) callback(message.params);
        });
      },
    }));
    socket.addEventListener('error', () => reject(new Error('Could not connect to Chromium DevTools')));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  });
}

const port = await availablePort();
const profile = await mkdtemp(join(tmpdir(), 'world-ledger-chrome-'));
const child = spawn(chromePath, [
  '--headless', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=1024,1024',
  `--hatch-webgl-allowed-domains-file=${webglPolicy}`,
  `--hatch-webgl-allowed-domains-sha256=${webglPolicySha256}`,
  `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

try {
  const version = await waitForDebugEndpoint(`http://127.0.0.1:${port}/json/version`, child);
  const cdp = await connectCdp(version.webSocketDebuggerUrl);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const pageTarget = targets.find((target) => target.type === 'page');
  if (!pageTarget) throw new Error('Chromium did not expose a page target');
  cdp.socket.close();
  const page = await connectCdp(pageTarget.webSocketDebuggerUrl);
  const loaded = new Promise((resolveLoad) => page.on('Page.loadEventFired', resolveLoad));
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1024, height: 1024, deviceScaleFactor: 1, mobile: false,
  });
  await page.send('Page.navigate', { url: pathToFileURL(pagePath).href });
  await loaded;
  const screenshot = await page.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: false,
  });
  await writeFile(outputPath, Buffer.from(screenshot.data, 'base64'));
  page.socket.close();
  process.stdout.write(`Wrote ${outputPath}\n`);
} finally {
  child.kill('SIGTERM');
  await rm(profile, { recursive: true, force: true });
}
