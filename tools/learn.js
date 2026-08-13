#!/usr/bin/env node
'use strict';

// Interactive frame-learning wizard for the Systemair VR-700 plugin.
//
// It connects to your EW11 over TCP and LISTENS ONLY - it never sends anything
// to the unit, so it is completely safe for the bus. While you step through the
// levels on your ORIGINAL wall panel, it records the exact command frames your
// unit uses and writes them to the same JSON file the plugin reads.
//
// Usage:
//   node tools/learn.js --ip 192.168.0.125 [--port 502] [--out <dir>]
//
// Requirement: the original wall panel must stay connected in parallel on the
// bus (it is what emits the command frames we learn from). If the EW11 replaced
// a missing panel, there is nothing to learn from and the wizard will say so.

const path = require('path');
const readline = require('readline');
const SystemairConnection = require('../lib/connection');
const { FrameStore, Learner, FAN_LEVELS, TEMP_LEVELS } = require('../lib/learning');

// ---- args -------------------------------------------------------------------
function parseArgs(argv) {
  const args = { port: 502, out: process.cwd() };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ip' || a === '-i') args.ip = argv[++i];
    else if (a === '--port' || a === '-p') args.port = parseInt(argv[++i], 10);
    else if (a === '--out' || a === '-o') args.out = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!args.ip && !a.startsWith('-')) args.ip = a; // positional IP
  }
  return args;
}

const args = parseArgs(process.argv);

if (args.help || !args.ip) {
  process.stdout.write(
    'Systemair VR-700 - frame learning wizard\n\n' +
    'Usage: node tools/learn.js --ip <EW11-ip> [--port 502] [--out <dir>]\n\n' +
    '  --ip,   -i   IP address of the EW11 (required)\n' +
    '  --port, -p   TCP port (default 502)\n' +
    '  --out,  -o   directory to write the learned-frames file (default: current dir)\n' +
    '  --help, -h   show this help\n\n' +
    'The wizard only listens; it never sends anything to the unit.\n'
  );
  process.exit(args.help ? 0 : 1);
}

// ---- console helpers --------------------------------------------------------
const isTTY = !!process.stdout.isTTY;
let statusLine = '';

// Print a message on its own line, keeping the live status line (if any) at the
// bottom so log lines and the status don't clobber each other.
function log(msg) {
  if (isTTY && statusLine) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
  process.stdout.write(msg + '\n');
  if (isTTY && statusLine) process.stdout.write(statusLine);
}

function drawStatus(line) {
  statusLine = line;
  if (!isTTY) return;
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(line);
}

const FAN_NAMES = ['off', 'low', 'normal', 'high'];
function checklist(store) {
  const fan = FAN_LEVELS.map((l) => `${store.hasFan(l) ? '✓' : ' '}${FAN_NAMES[l]}`).join('  ');
  const temp = TEMP_LEVELS.map((l) => `${store.hasTemp(l) ? '✓' : ' '}${l}`).join('  ');
  return { fan, temp };
}

// A logger for the connection/learner. Learner already prints good English
// progress messages; route them through our status-aware printer.
const routedLog = { info: (m) => log(m), warn: (m) => log(m), error: (m) => log(m) };

// ---- wire it up -------------------------------------------------------------
const store = new FrameStore({ dir: args.out, host: args.ip, log: routedLog });

log('');
log('  Systemair VR-700 - frame learning wizard');
log(`  Connecting to ${args.ip}:${args.port} ...  (listening only - nothing is ever sent)`);
log('');

const conn = new SystemairConnection({
  host: args.ip,
  port: args.port,
  log: routedLog,
});

let commandsSeen = 0;
conn.on('command', () => { commandsSeen += 1; });

const learner = new Learner({ conn, store, log: routedLog });
learner.start();

let done = false;

// Live status line, refreshed periodically.
const statusTimer = setInterval(() => {
  if (done) return;
  const st = conn.getState();
  const stats = conn.getStats();
  const fanDone = FAN_LEVELS.filter((l) => store.hasFan(l)).length;
  const tempDone = TEMP_LEVELS.filter((l) => store.hasTemp(l)).length;
  const cur = st && st.fanSpeed != null
    ? `fan=${FAN_NAMES[st.fanSpeed] ?? st.fanSpeed} temp=${st.tempLevel}`
    : 'waiting for data…';
  drawStatus(
    `  [${cur}]  panel cmds: ${commandsSeen}  valid frames: ${stats.validFrames}  ` +
    `learned: fan ${fanDone}/4, temp ${tempDone}/6`
  );

  if (store.isComplete()) finish(true);
}, 1500);

function finish(complete) {
  if (done) return;
  done = true;
  clearInterval(statusTimer);
  learner.stop();
  conn.close();

  const { fan, temp } = checklist(store);
  log('');
  log('  ─────────────────────────────────────────────────────────────');
  if (complete) {
    log('  All levels captured!  🎉');
  } else {
    log('  Stopped. Captured so far:');
  }
  log(`    Fan:         ${fan}`);
  log(`    Temperature: ${temp}`);
  log('');
  log(`  Saved to: ${store.file}`);
  log('');
  log('  Next steps:');
  log('    1. Copy that file into your Homebridge storage directory');
  log('       (the folder that contains config.json).');
  log('    2. Make sure "learn" is false (or absent) in the plugin config.');
  log('    3. Restart Homebridge - the plugin will now prefer your unit\'s');
  log('       own frames for the levels it has learned.');
  log('');
  process.exit(complete ? 0 : 0);
}

log('  Now step through EVERY position on your wall panel, pausing ~5s on each:');
log('    Fan:         off → low → normal → high');
log('    Temperature: 0 → 1 → 2 → 3 → 4 → 5');
log('  Progress appears below. Press Ctrl-C when done (progress is saved as you go).');
log('');

process.on('SIGINT', () => { log(''); finish(store.isComplete()); });
