'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const proto = require('../lib/protocol');
const SystemairConnection = require('../lib/connection');

const silentLog = { info() {}, warn() {}, error() {} };

function frame(type, mutate) {
  const f = Buffer.alloc(proto.FRAME_LEN);
  f[0] = 0x55; f[1] = 0xaa; f[2] = type;
  if (mutate) mutate(f);
  f[proto.FRAME_LEN - 1] = proto.crc8(f.subarray(0, proto.FRAME_LEN - 1));
  return f;
}

const broadcast = (fan, temp) => frame(proto.FRAME_TYPE.BROADCAST, (f) => { f[42] = fan; f[95] = temp; });
const poll = () => frame(proto.FRAME_TYPE.POLL);
const command = (fan, temp) => frame(proto.FRAME_TYPE.COMMAND, (f) => { f[42] = fan; f[95] = temp; });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Startet einen loopback-Server, der jede Client-Verbindung an den Test
// weiterreicht. Der Test steuert, welche Frames "die Regelung" sendet, und
// zaehlt, welche Kommandoframes der Client (das Plugin) zurueckschreibt.
function withServer(fn) {
  return new Promise((resolve, reject) => {
    const received = []; // vom Client geschriebene 280-Byte-Frames
    let sock = null;
    const server = net.createServer((s) => {
      sock = s;
      let buf = Buffer.alloc(0);
      s.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        while (buf.length >= proto.FRAME_LEN) {
          received.push(buf.subarray(0, proto.FRAME_LEN));
          buf = buf.subarray(proto.FRAME_LEN);
        }
      });
    });
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const conn = new SystemairConnection({
        host: '127.0.0.1', port, log: silentLog,
        minSendIntervalMs: 0, // Timing-Gate im Test ausschalten
      });
      try {
        await new Promise((r) => conn.once('connected', r));
        await fn({ conn, received, send: (b) => sock && sock.write(b) });
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        conn.close();
        server.close();
      }
    });
  });
}

test('sendet ein Kommando erst nach einem 0x02-Poll', async () => {
  await withServer(async ({ conn, received, send }) => {
    conn.sendCommand(command(2, 3), (st) => st.fanSpeed === 2);
    await delay(50);
    assert.strictEqual(received.length, 0, 'ohne Poll darf nichts gesendet werden');
    send(poll());
    await delay(50);
    assert.strictEqual(received.length, 1, 'nach dem Poll genau ein Frame');
  });
});

test('Closed-Loop: hoert auf zu senden, sobald der Broadcast das Ziel bestaetigt', async () => {
  await withServer(async ({ conn, received, send }) => {
    conn.sendCommand(command(2, 3), (st) => st.fanSpeed === 2);
    send(poll());
    await delay(30);
    assert.strictEqual(received.length, 1);

    // Regelung bestaetigt den Zielwert -> weiterer Poll darf NICHT mehr senden.
    send(broadcast(2, 3));
    await delay(30);
    send(poll());
    await delay(30);
    assert.strictEqual(received.length, 1, 'nach Bestaetigung keine Wiederholung mehr');
  });
});

test('ohne Bestaetigung wird bis sendRepeat wiederholt, dann Schluss', async () => {
  await withServer(async ({ conn, received, send }) => {
    conn.sendCommand(command(2, 3), (st) => st.fanSpeed === 2);
    // Viele Polls, aber der Broadcast bleibt beim alten Wert (1) -> nie
    // bestaetigt. Erwartung: hoechstens sendRepeat (Default 3) Sendungen.
    for (let i = 0; i < 8; i++) { send(poll()); await delay(15); send(broadcast(1, 3)); await delay(15); }
    assert.ok(received.length <= 3, `hoechstens 3 Wiederholungen, waren ${received.length}`);
    assert.ok(received.length >= 1);
  });
});

test('emittiert "command" fuer beobachtete 0x01-Frames (Basis des Lernmodus)', async () => {
  await withServer(async ({ conn, send }) => {
    const seen = [];
    conn.on('command', (f) => seen.push(f));
    send(command(3, 4));
    await delay(50);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(proto.frameType(seen[0]), proto.FRAME_TYPE.COMMAND);
  });
});

test('emittiert "state" nur bei tatsaechlicher Aenderung', async () => {
  await withServer(async ({ conn, send }) => {
    const states = [];
    conn.on('state', (st) => states.push(st));
    send(broadcast(1, 2));
    await delay(30);
    send(broadcast(1, 2)); // gleich -> kein Event
    await delay(30);
    send(broadcast(2, 2)); // geaendert -> Event
    await delay(30);
    assert.strictEqual(states.length, 2);
    assert.deepStrictEqual(states[1], { fanSpeed: 2, tempLevel: 2 });
  });
});
