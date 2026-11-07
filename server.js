// wasmer-probe-node: minimal Node.js probe for Wasmer Edge.
// Purpose: verify two gateway facts, nothing else. No VLESS, no secrets.
//   GET /                          -> 200 "ok"
//   GET /ws                        -> WebSocket upgrade, echo frames back
//   GET /dial?host=H&port=P        -> outbound net.connect + minimal HTTP GET, plain-text report
//
// Zero dependencies: only Node built-ins (http, net, crypto, dns).
// Mirrors the endpoint behaviour of the Rust probe in ../wasmer-probe/src/main.rs.

'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const dns = require('dns');

const READ_TIMEOUT_MS = 15000;
const DIAL_TIMEOUT_MS = 5000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const port = parsePort(process.env.PORT) || 80;

function parsePort(v) {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function sendText(res, status, body) {
  const reason = { 200: 'OK', 400: 'Bad Request', 404: 'Not Found', 405: 'Method Not Allowed' }[status] || 'OK';
  res.writeHead(status, {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(body),
    'Connection': 'close',
  });
  res.end(body);
}

function validHost(host) {
  if (!host || host.length > 253) return false;
  return /^[A-Za-z0-9.-]+$/.test(host)
    && !host.startsWith('.') && !host.startsWith('-')
    && !host.endsWith('.') && !host.endsWith('-')
    && !host.includes('..');
}

function handleDial(req, res, query) {
  const host = query.get('host') || '';
  const portRaw = query.get('port') || '';
  const dialPort = Number(portRaw);
  if (!Number.isInteger(dialPort) || dialPort < 1 || dialPort > 65535) {
    sendText(res, 400, 'bad port: must be 1-65535\n');
    return;
  }
  if (!validHost(host)) {
    sendText(res, 400, 'bad host: only domain names or IPv4 allowed\n');
    return;
  }
  let report = `host: ${host}\nport: ${dialPort}\n`;
  dns.lookup(host, (dnsErr, address) => {
    if (dnsErr || !address) {
      report += `dial: error\nerror: dns resolve failed: ${dnsErr ? dnsErr.message : 'no address'}\n`;
      sendText(res, 200, report);
      return;
    }
    report += `resolved: ${address}\n`;
    const start = Date.now();
    const sock = net.connect({ host: address, port: dialPort, timeout: DIAL_TIMEOUT_MS });
    let settled = false;
    const finish = (text) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      sendText(res, 200, text);
    };
    sock.on('timeout', () => {
      report += `dial: error\nconnect_ms: ${Date.now() - start}\nerror: connect timeout after ${DIAL_TIMEOUT_MS}ms\n`;
      finish(report);
    });
    sock.on('error', (err) => {
      report += `dial: error\nconnect_ms: ${Date.now() - start}\nerror: ${err.message}\n`;
      finish(report);
    });
    sock.on('connect', () => {
      report += `dial: ok\nconnect_ms: ${Date.now() - start}\n`;
      sock.setTimeout(DIAL_TIMEOUT_MS);
      const httpReq = `GET / HTTP/1.0\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
      sock.write(httpReq, (writeErr) => {
        if (writeErr) {
          report += `http_write_error: ${writeErr.message}\n`;
          finish(report);
        }
      });
    });
    sock.once('data', (chunk) => {
      const buf = chunk.slice(0, 2048);
      const text = buf.toString('utf8');
      const firstLine = text.split('\n')[0].replace(/\r$/, '');
      report += `http_read_bytes: ${buf.length}\nhttp_first_line: ${firstLine}\n`;
      finish(report);
    });
    sock.once('end', () => {
      if (!settled && !report.includes('http_read_bytes')) {
        report += 'http_read_bytes: 0\n';
      }
      finish(report);
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method !== 'GET') {
    sendText(res, 405, 'method not allowed\n');
    return;
  }
  switch (url.pathname) {
    case '/':
      sendText(res, 200, 'ok\n');
      break;
    case '/dial':
      handleDial(req, res, url.searchParams);
      break;
    case '/ws':
      // Upgrade requests never reach here; they are handled by the 'upgrade'
      // event. A plain GET /ws without upgrade headers gets a 400.
      sendText(res, 400, 'missing Upgrade: websocket header\n');
      break;
    default:
      sendText(res, 404, 'not found\n');
      break;
  }
});

// --- WebSocket upgrade handling (RFC 6455) ---------------------------------

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 10\r\n\r\nnot found\n');
    socket.destroy();
    return;
  }
  const upgrade = (req.headers.upgrade || '').toLowerCase();
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (upgrade !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 33\r\n\r\nmissing Upgrade: websocket header\n');
    socket.destroy();
    return;
  }
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 35\r\n\r\nmissing Sec-WebSocket-Key header\n');
    socket.destroy();
    return;
  }
  if (version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 43\r\n\r\nunsupported Sec-WebSocket-Version (need 13)\n');
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  console.error('ws: handshake ok, echoing frames');
  wsEchoLoop(socket, head);
});

// Buffered frame reader: head may already contain frame bytes.
function wsEchoLoop(socket, head) {
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let msg = Buffer.alloc(0);
  let msgOpcode = 0;
  let destroyed = false;

  socket.setTimeout(READ_TIMEOUT_MS);
  socket.on('timeout', () => socket.destroy());
  socket.on('error', () => { destroyed = true; });
  socket.on('close', () => { destroyed = true; });

  function sendFrame(fin, opcode, payload) {
    if (destroyed) return false;
    const header = [];
    header.push((fin ? 0x80 : 0x00) | (opcode & 0x0f));
    const len = payload.length;
    if (len < 126) {
      header.push(len);
    } else if (len <= 0xffff) {
      header.push(126, (len >> 8) & 0xff, len & 0xff);
    } else {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(len));
      header.push(127, ...b);
    }
    try {
      socket.write(Buffer.concat([Buffer.from(header), payload]));
      return true;
    } catch (_) {
      return false;
    }
  }

  function pump() {
    if (destroyed) return;
    while (true) {
      if (buf.length < 2) return; // need more data
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > MAX_FRAME_BYTES) { socket.destroy(); return; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return; // need more data
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buf = buf.subarray(off + maskLen + len);

      if (opcode === 8) {
        sendFrame(true, 8, payload);
        socket.end();
        return;
      } else if (opcode === 9) {
        if (!sendFrame(true, 10, payload)) return;
      } else if (opcode === 10) {
        // pong: ignore
      } else if (opcode === 1 || opcode === 2) {
        if (msg.length === 0) msgOpcode = opcode;
        msg = Buffer.concat([msg, payload]);
        if (fin) {
          if (!sendFrame(true, msgOpcode, msg)) return;
          msg = Buffer.alloc(0);
        }
      } else if (opcode === 0) {
        msg = Buffer.concat([msg, payload]);
        if (fin) {
          if (!sendFrame(true, msgOpcode, msg)) return;
          msg = Buffer.alloc(0);
        }
      } else {
        socket.destroy();
        return;
      }
    }
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });
  pump();
}

server.on('error', (err) => {
  console.error('server error:', err);
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  console.error(`wasmer-probe-node listening on 0.0.0.0:${port}`);
});
