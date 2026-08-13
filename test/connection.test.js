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

// Starts a loopback server that hands each client connection to the test. The
// test controls which frames "the controller" sends, and counts which command
// frames the client (the plugin) writes back.
function withServer(fn) {
  return new Promise((resolve, reject) => {
    const received = []; // 280-byte frames written by the client
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
        minSendIntervalMs: 0, // disable the timing gate in the test
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

test('sends a command only after a 0x02 poll', async () => {
  await withServer(async ({ conn, received, send }) => {
    conn.sendCommand(command(2, 3), (st) => st.fanSpeed === 2);
    await delay(50);
    assert.strictEqual(received.length, 0, 'nothing may be sent without a poll');
    send(poll());
    await delay(50);
    assert.strictEqual(received.length, 1, 'exactly one frame after the poll');
  });
});

test('closed loop: stops sending once the broadcast confirms the target', async () => {
  await withServer(async ({ conn, received, send }) => {
    conn.sendCommand(command(2, 3), (st) => st.fanSpeed === 2);
    send(poll());
    await delay(30);
    assert.strictEqual(received.length, 1);

    // Controller confirms the target value -> another poll must NOT send again.
    send(broadcast(2, 3));
    await delay(30);
    send(poll());
    await delay(30);
    assert.strictEqual(received.length, 1, 'no repeat after confirmation');
  });
});

test('without confirmation it repeats up to sendRepeat, then stops', async () => {
  await withServer(async ({ conn, received, send }) => {
    conn.sendCommand(command(2, 3), (st) => st.fanSpeed === 2);
    // Many polls, but the broadcast stays at the old value (1) -> never
    // confirmed. Expectation: at most sendRepeat (default 3) sends.
    for (let i = 0; i < 8; i++) { send(poll()); await delay(15); send(broadcast(1, 3)); await delay(15); }
    assert.ok(received.length <= 3, `at most 3 repeats, were ${received.length}`);
    assert.ok(received.length >= 1);
  });
});

test('emits "command" for observed 0x01 frames (basis of learn mode)', async () => {
  await withServer(async ({ conn, send }) => {
    const seen = [];
    conn.on('command', (f) => seen.push(f));
    send(command(3, 4));
    await delay(50);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(proto.frameType(seen[0]), proto.FRAME_TYPE.COMMAND);
  });
});

test('emits "state" only on an actual change', async () => {
  await withServer(async ({ conn, send }) => {
    const states = [];
    conn.on('state', (st) => states.push(st));
    send(broadcast(1, 2));
    await delay(30);
    send(broadcast(1, 2)); // same -> no event
    await delay(30);
    send(broadcast(2, 2)); // changed -> event
    await delay(30);
    assert.strictEqual(states.length, 2);
    assert.deepStrictEqual(states[1], { fanSpeed: 2, tempLevel: 2 });
  });
});
