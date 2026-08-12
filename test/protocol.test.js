'use strict';

// Leichtgewichtige Tests ohne externe Abhaengigkeiten (Node's eingebauter
// Test-Runner). Ausfuehren mit:  npm test   (bzw.  node --test)
const { test } = require('node:test');
const assert = require('node:assert');

const proto = require('../lib/protocol');

// Baut ein gueltiges Frame eines bestimmten Typs mit korrekter CRC.
function makeFrame(type, mutate) {
  const frame = Buffer.alloc(proto.FRAME_LEN);
  frame[0] = 0x55;
  frame[1] = 0xaa;
  frame[2] = type;
  if (mutate) mutate(frame);
  frame[proto.FRAME_LEN - 1] = proto.crc8(frame.subarray(0, proto.FRAME_LEN - 1));
  return frame;
}

test('crc8 ist deterministisch und byteweit', () => {
  const a = proto.crc8(Buffer.from([0x55, 0xaa, 0x0a]));
  const b = proto.crc8(Buffer.from([0x55, 0xaa, 0x0a]));
  assert.strictEqual(a, b);
  assert.ok(a >= 0 && a <= 255);
});

test('verifyFrame akzeptiert nur korrekte Laenge, Header und CRC', () => {
  const good = makeFrame(proto.FRAME_TYPE.BROADCAST);
  assert.strictEqual(proto.verifyFrame(good), true);

  const badCrc = Buffer.from(good);
  badCrc[proto.FRAME_LEN - 1] ^= 0xff;
  assert.strictEqual(proto.verifyFrame(badCrc), false);

  const badHeader = Buffer.from(good);
  badHeader[0] = 0x00;
  assert.strictEqual(proto.verifyFrame(badHeader), false);

  const badLen = good.subarray(0, proto.FRAME_LEN - 1);
  assert.strictEqual(proto.verifyFrame(badLen), false);
});

test('parseState liest Luefter-/Temperaturstufe nur aus 0x0a-Frames', () => {
  const bc = makeFrame(proto.FRAME_TYPE.BROADCAST, (f) => { f[42] = 3; f[95] = 5; });
  assert.deepStrictEqual(proto.parseState(bc), { fanSpeed: 3, tempLevel: 5 });

  const cmd = makeFrame(proto.FRAME_TYPE.COMMAND, (f) => { f[42] = 3; f[95] = 5; });
  assert.strictEqual(proto.parseState(cmd), null);
});

test('isCommandFrame / isBroadcastFrame unterscheiden die Typen', () => {
  assert.strictEqual(proto.isCommandFrame(makeFrame(proto.FRAME_TYPE.COMMAND)), true);
  assert.strictEqual(proto.isCommandFrame(makeFrame(proto.FRAME_TYPE.BROADCAST)), false);
  assert.strictEqual(proto.isBroadcastFrame(makeFrame(proto.FRAME_TYPE.BROADCAST)), true);
  assert.strictEqual(proto.isBroadcastFrame(makeFrame(proto.FRAME_TYPE.COMMAND)), false);
});

test('splitFrames extrahiert vollstaendige Frames und behaelt den Rest', () => {
  const f1 = makeFrame(proto.FRAME_TYPE.BROADCAST, (f) => { f[42] = 1; });
  const f2 = makeFrame(proto.FRAME_TYPE.COMMAND);
  const partial = f1.subarray(0, 10);
  const stream = Buffer.concat([f1, f2, partial]);

  const { frames, rest, skipped } = proto.splitFrames(stream);
  assert.strictEqual(frames.length, 2);
  assert.strictEqual(skipped, 0);
  assert.strictEqual(rest.length, 10);
  assert.strictEqual(proto.parseState(frames[0]).fanSpeed, 1);
});

test('splitFrames erkennt sich nach einem falschen 55AA-Header wieder', () => {
  // Muell mit einem falschen 55AA-Header (ohne gueltige CRC ueber 280 Byte)
  // VOR einem echten Frame. Ein naiver Parser wuerde hier verrutschen; unserer
  // prueft an jeder Header-Position die CRC, verwirft den Fehltreffer (zaehlt
  // ihn als skipped) und findet das echte Frame trotzdem.
  const noise = Buffer.alloc(300, 0x00);
  noise[0] = 0x55; noise[1] = 0xaa; // falscher Header
  const real = makeFrame(proto.FRAME_TYPE.BROADCAST, (frame) => { frame[42] = 2; });
  const stream = Buffer.concat([noise, real]);

  const { frames, skipped } = proto.splitFrames(stream);
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(proto.parseState(frames[0]).fanSpeed, 2);
  assert.ok(skipped >= 1);
});

test('mitgelieferte Standard-Kommandoframes sind gueltige 0x01-Frames', () => {
  for (const level of [0, 1, 2, 3]) {
    const frame = proto.commandForFanSpeed(level);
    assert.strictEqual(frame.length, proto.FRAME_LEN);
    assert.strictEqual(proto.isCommandFrame(frame), true, `Luefterstufe ${level}`);
  }
  for (const level of [0, 1, 2, 3, 4, 5]) {
    const frame = proto.commandForTempLevel(level);
    assert.strictEqual(frame.length, proto.FRAME_LEN);
    assert.strictEqual(proto.isCommandFrame(frame), true, `Temperaturstufe ${level}`);
  }
});

test('commandForState wurde entfernt (Sicherheits-Footgun)', () => {
  assert.strictEqual(proto.commandForState, undefined);
});

test('frameFromHex erzwingt Laenge und kann die CRC korrigieren', () => {
  const good = makeFrame(proto.FRAME_TYPE.COMMAND);
  const hex = good.toString('hex');
  const parsed = proto.frameFromHex(hex);
  assert.ok(parsed.equals(good));

  // Falsche CRC + fixCrc -> wird korrigiert und gilt anschliessend.
  const brokenHex = hex.slice(0, -2) + '00';
  const fixed = proto.frameFromHex(brokenHex, { fixCrc: true });
  assert.strictEqual(proto.verifyFrame(fixed), true);

  assert.throws(() => proto.frameFromHex('55aa01'), /Byte/);
});
