'use strict';

// Reverse-engineered Systemair/Villavent CD panel protocol (VR-700 DCV and
// similar). Runs over an RS485<->WiFi adapter (e.g. Elfin EW11) wired to the
// wall-panel terminals (12V/GND/Hi/Lo). The EW11 must be set to 57600 baud,
// 8N1, "Protocol: None" (transparent) and "TCP Server" on port 502 - NOT
// "Modbus"; the unit does not speak Modbus on this bus.
//
// Frame format: 280 bytes, header 0x55 0xAA, byte[2] = frame type, last byte =
// CRC-8 (polynomial 0x8D, init 0, no reflection) over byte[0..278].
//
// Byte 42  = fan level (0=off, 1=low, 2=normal, 3=high)
// Byte 95  = temperature level (0..5, six-step manual dial)
// Frame type 0x0a = periodic state broadcast from the controller
// Frame type 0x01 = panel command (sent right after a 0x02 from the controller)

const HEADER = Buffer.from([0x55, 0xaa]);
const FRAME_LEN = 280;

// Known frame types (byte[2]).
const FRAME_TYPE = {
  COMMAND: 0x01,   // panel command (follows a 0x02 from the controller)
  POLL: 0x02,      // controller hands the panel its send slot
  BROADCAST: 0x0a, // periodic state broadcast from the controller
};

function crc8(buf, poly = 0x8d) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ poly) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function verifyFrame(frame) {
  if (frame.length !== FRAME_LEN) return false;
  if (frame[0] !== 0x55 || frame[1] !== 0xaa) return false;
  return crc8(frame.subarray(0, FRAME_LEN - 1)) === frame[FRAME_LEN - 1];
}

// Splits an incoming byte stream into complete, CRC-valid 280-byte frames.
// Returns {frames, rest, skipped}; `rest` is the buffer that must be prepended
// on the next call. `skipped` counts bytes discarded because a header appeared
// at that position but its CRC did not match (noise/collision on the bus, or an
// unknown/other frame type) - useful to tell a disturbed line from a silent one.
//
// Important: the header byte sequence 55 AA can also occur by chance INSIDE a
// frame's payload. A naive split "between two occurrences of 55 AA" would
// produce bogus short frames. Therefore the CRC over the full 280 bytes is
// checked at every header position; only on a valid CRC is the frame accepted
// and the offset advanced by FRAME_LEN. On an invalid CRC (false positive) the
// offset advances by only 1 byte and the search for the next header continues.
function splitFrames(buffer) {
  const frames = [];
  let offset = 0;
  let skipped = 0;

  while (true) {
    const idx = buffer.indexOf(HEADER, offset);
    if (idx === -1) {
      offset = buffer.length;
      break;
    }
    if (idx + FRAME_LEN > buffer.length) {
      offset = idx;
      break;
    }
    const candidate = buffer.subarray(idx, idx + FRAME_LEN);
    if (verifyFrame(candidate)) {
      frames.push(Buffer.from(candidate));
      offset = idx + FRAME_LEN;
    } else {
      skipped += 1;
      offset = idx + 1;
    }
  }

  return { frames, rest: Buffer.from(buffer.subarray(offset)), skipped };
}

// Builds a frame from a hex string. If fixCrc=true, the last byte is set to the
// correct CRC instead of using the given value. Kept as a small utility (used
// by the learned-frame store to parse/validate persisted frames).
function frameFromHex(hex, { fixCrc = false } = {}) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error('Hex string has an odd number of characters');
  }
  const frame = Buffer.from(clean, 'hex');
  if (frame.length !== FRAME_LEN) {
    throw new Error(`Frame is ${frame.length} bytes, expected ${FRAME_LEN}`);
  }
  if (fixCrc) {
    frame[FRAME_LEN - 1] = crc8(frame.subarray(0, FRAME_LEN - 1));
  }
  return frame;
}

function frameType(frame) {
  if (!frame || frame.length < 3) return null;
  return frame[2];
}

function isCommandFrame(frame) {
  return verifyFrame(frame) && frame[2] === FRAME_TYPE.COMMAND;
}

function isBroadcastFrame(frame) {
  return verifyFrame(frame) && frame[2] === FRAME_TYPE.BROADCAST;
}

function parseState(frame) {
  if (!verifyFrame(frame) || frame[2] !== FRAME_TYPE.BROADCAST) return null;
  return {
    fanSpeed: frame[42],       // 0..3
    tempLevel: frame[95],      // 0..5
  };
}

// Known, real recorded type-0x01 command frames (valid CRC). Each frame sets ONE
// of the two controls; the other value in the frame reflects the state at
// recording time but is apparently not treated as a conflict by the controller
// - only the intended target value (byte 42 or 95) is applied.
const FAN_SPEED_CMD = {
  0: '55aa01020101330514214a47000b02f000e600ed0000080064642d2c00000000000094fb0a0093fb0a000000000000000000000607121600000000000000000000000000000000090a0c010006450000003c00dc0000071111000116071a000000005f07001f1f323264640023dc00020100000000000404130800000100000001000046e30000000000005a64005a64008c0200006400bef3e4e2dafd0000010200000000000000000000000000006aff38ff38ff06ffceff3200b004580200000000000000000000000000000000000000000000000000000000000000000000000002007bf72000000000000201000000000100000101d600c11a5325dc02b602030400000000000000000000000000000000000000b5',
  1: '55aa01020101330514214a47000b02f000e600ed00000800646424240000000000009ffc0a009efc0a000100000000000000000607121600000000000000000000000000000000090a0c010006450000003c00dc0000071111000116071a00003c3c5f07051f1f323264640023dc00020100000000000404280800000100000001000046e30000000000005a64005a64008c0200006400bef3e4e2dafd0000010200000000000000000000000000006aff38ff38ff06ffceff3200b0045802000000000000000000000000000000000000000000000000000000000000000000000000020095f72000000000000201000000000100000102d6005d1b7025f002b60204010000000000000000000000000000000000000002',
  2: '55aa01020101330514214a47000b02f000e600ed0000080064641f1c0000000000000dfd0a000cfd0a000200000000000000000607121600000000000000000000000000000000090a0c010006450000003c00dc0000071111000116071a000069695f070a1f1f323264640023dc00020100000000000404310800000100000001000046df0000000000005a64005a64008c0200006400bef3e4e2dafd0000010200000000000000000000000000006aff38ff38ff06ffceff3200b00458020000000000000000000000000000000000000000000000000000000000000000000000000200a0f72000000000000201000000000100000101d600c11a5325dc02b6020206000000000000000000000000000000000000008b',
  3: '55aa01020101330514214a47000b02f000e600ed0000080064642a28000000000000cafb0a00c9fb0a000300000000000000000607121600000000000000000000000000000000090a0c010006450000003c00dc0000071111000116071a0000dcdc5f070f1f1f323264640023dc00020100000000000404160800000100000001000046e20000000000005a64005a64008c0200006400bef3e4e2dafd0000010200000000000000000000000000006aff38ff38ff06ffceff3200b0045802000000000000000000000000000000000000000000000000000000000000000000000000020080f72000000000000201000000000100000100d600c01a7025c002b6020026000000000000000000000000000000000000004e',
};

const TEMP_LEVEL_CMD = {
  0: '55aa01020101330514214a48000b02f000e600ed000008756464323100780000000000000000630100000200000000000000000607121600000000000000000000000000000000090a0c010000450000003c00dc0000071111000116071a000069695f070a1f1f323264640023dc000201000000000004049d0800000200000002000046df0000000000005a64005a64006001348c6402bef3e4e2dafd0000010200000000000000000000000000006aff38ff38ff06ffceff3200b004580200000000000000000000000000000000000000000000000000000000000000000000000002007a3d2100000000000201630100000100000103d6005e1b53250c03b702040100000000000000000000000000000000000000f1',
  1: '55aa01020101330514214a48000b02f000e600ed000008756464323100910000000000000000610100000200000000000000000607121600000000000000000000000000000000090a0c010000450000003c00dc0000071111000116071a000169695f070a1f1f323264640023dc000201000000000004049a0800000200000002000046df0000000000005a64005a64002e01bc9f6402bef3e4e2dafd0000010200000000000000000000000000006aff38ff38ff06ffceff3200b004580200000000000000000000000000000000000000000000000000000000000000000000000002007a3d2100000000000201610100000100000102d6005d1b7025f002b7020304000000000000000000000000000000000000001e',
  2: '55aa01020101330514214a48000b02f000e600ed000008756464323100c300000000000000005f0100000200000000000000000607121600000000000000000000000000000000090a0c010000450000003c00dc0000071111000116071a000269695f070a1f1f323264640023dc00020100000000000404970800000200000002000046df0000000000005a64005a6400150180a96402bef3e4e2dafd0000010200000000000000000000000000006aff38ff38ff06ffceff3200b004580200000000000000000000000000000000000000000000000000000000000000000000000002007a3d21000000000002015f0100000100000101d600c11a5325dc02b702020600000000000000000000000000000000000000fb',
  3: '55aa01020101330514214a48000b02f000e600ed0000087564642d2c00910000000000000000410000000200000000000000000607121600000000000000000000000000000000090a0c010000450000003c00dc0000071111000116071a000369695f070a1f1f323264640023dc00020100000000000404a60800000200000002000046df0000000000005a64005a64006601dc896402bef3e4e2dafd0000010200000000000000000000000000006aff38ff38ff06ffceff3200b00458020000000000000000000000000000000000000000000000000000000000000000000000000200853d2100000000000201410000000100000100d600c01a7025c002b7020304000000000000000000000000000000000000002a',
  4: '55aa01020101330514214a48000b02f000e600ed000008756464323100dc00000000000000005d0100000200000000000000000607121600000000000000000000000000000000090a0c010000450000003c00dc0000071111000116071a000469695f070a1f1f323264640023dc00020100000000000404940800000200000002000046df0000000000005a64005a6400150180a96402bef3e4e2dafd0000010200000000000000000000000000006aff38ff38ff06ffceff3200b004580200000000000000000000000000000000000000000000000000000000000000000000000002007a3d21000000000002015d0100000100000100d600c01a7025c002b70201030000000000000000000000000000000000000018',
  5: '55aa01020101330514214a48000b02f000e600ed000008596464323100c30000000000000000850000000200000000000000000607121600000000000000000000000000000000090a0c010000450000003c00dc0000071111000116071a000569695f070a1f1f323264640023dc00020100000000000404ac0800000200000002000046de0000000000005a64005a64003401fd924c02bef3e4e2dafd0000010200000000000000000000000000006aff38ff38ff06ffceff3200b004580200000000000000000000000000000000000000000000000000000000000000000000000002008b3d2100000000000201850000000100000102d6005d1b7025f002b702030400000000000000000000000000000000000000ab',
};

function commandForFanSpeed(level) {
  const hex = FAN_SPEED_CMD[level];
  if (!hex) throw new Error(`Unknown fan level: ${level}`);
  return Buffer.from(hex, 'hex');
}

function commandForTempLevel(level) {
  const hex = TEMP_LEVEL_CMD[level];
  if (!hex) throw new Error(`Unknown temperature level: ${level}`);
  return Buffer.from(hex, 'hex');
}

// NOTE: an earlier commandForState() built a frame dynamically from a TEMP
// template with overwritten fan bytes ("Frankenstein" frame). Using it caused a
// crash/reset of the controller board on a real VR-700. It was deliberately
// removed for good: only exact, unmodified frames are ever sent - either the
// templates here, or the ones recorded from the user's own unit via learn mode
// (lib/learning.js). Anyone extending the protocol must NEVER change individual
// bytes of a frame while all 280 bytes are not fully understood.

module.exports = {
  HEADER,
  FRAME_LEN,
  FRAME_TYPE,
  crc8,
  verifyFrame,
  splitFrames,
  parseState,
  frameType,
  isCommandFrame,
  isBroadcastFrame,
  commandForFanSpeed,
  commandForTempLevel,
  frameFromHex,
};
