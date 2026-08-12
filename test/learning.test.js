'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const proto = require('../lib/protocol');
const { FrameStore } = require('../lib/learning');

const silentLog = { info() {}, warn() {}, error() {} };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vr700-'));
}

function cmdFrame(fan, temp) {
  const f = Buffer.alloc(proto.FRAME_LEN);
  f[0] = 0x55; f[1] = 0xaa; f[2] = proto.FRAME_TYPE.COMMAND;
  f[42] = fan; f[95] = temp;
  f[proto.FRAME_LEN - 1] = proto.crc8(f.subarray(0, proto.FRAME_LEN - 1));
  return f;
}

test('FrameStore speichert und laedt gelernte Frames', () => {
  const dir = tmpDir();
  const store = new FrameStore({ dir, host: '10.0.0.5', log: silentLog });
  assert.strictEqual(store.count(), 0);

  const frame = cmdFrame(2, 3);
  store.setFan(2, frame, { fan: 2, temp: 3 });
  assert.ok(store.getFan(2).equals(frame));
  assert.strictEqual(store.hasFan(2), true);
  assert.strictEqual(store.hasFan(1), false);

  // Neue Instanz mit demselben Pfad/Host laedt das Gespeicherte.
  const reloaded = new FrameStore({ dir, host: '10.0.0.5', log: silentLog });
  assert.ok(reloaded.getFan(2).equals(frame));
});

test('FrameStore trennt verschiedene Hosts', () => {
  const dir = tmpDir();
  const a = new FrameStore({ dir, host: '10.0.0.5', log: silentLog });
  a.setTemp(1, cmdFrame(0, 1), { fan: 0, temp: 1 });
  const b = new FrameStore({ dir, host: '10.0.0.6', log: silentLog });
  assert.strictEqual(b.hasTemp(1), false);
});

test('FrameStore weist gespeicherte Frames mit kaputter CRC ab', () => {
  const dir = tmpDir();
  const store = new FrameStore({ dir, host: 'x', log: silentLog });
  const broken = cmdFrame(1, 1);
  broken[proto.FRAME_LEN - 1] ^= 0xff; // CRC zerstoeren
  store.setFan(1, broken, {});
  assert.strictEqual(store.getFan(1), null); // wird nicht als gueltig herausgegeben
});

test('FrameStore.isComplete erst bei allen 4 Luefter- und 6 Temperaturstufen', () => {
  const dir = tmpDir();
  const store = new FrameStore({ dir, host: 'x', log: silentLog });
  for (const l of [0, 1, 2, 3]) store.setFan(l, cmdFrame(l, 0), {});
  for (const l of [0, 1, 2, 3, 4]) store.setTemp(l, cmdFrame(0, l), {});
  assert.strictEqual(store.isComplete(), false);
  store.setTemp(5, cmdFrame(0, 5), {});
  assert.strictEqual(store.isComplete(), true);
  assert.strictEqual(store.count(), 10);
});
