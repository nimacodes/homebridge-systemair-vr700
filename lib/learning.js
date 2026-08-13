'use strict';

const fs = require('fs');
const path = require('path');
const proto = require('./protocol');

const FAN_LEVELS = [0, 1, 2, 3];
const TEMP_LEVELS = [0, 1, 2, 3, 4, 5];

// How long a state must stay stable before we record its command frame as
// "learned" (prevents capturing transient states while the user is still
// turning the dial on the panel).
const STABLE_MS = 4000;

// How old the last-seen panel command frame may be to still be associated with
// a currently-stable state.
const CMD_FRESH_MS = 10000;

// How long without a single panel command frame (type 0x01) may pass before we
// warn the user that learning cannot work this way.
const NO_CMD_WARN_MS = 25000;

// Persists the command frames recorded from the user's own unit as JSON in the
// Homebridge storage. One file per EW11 host so multiple units do not clash.
class FrameStore {
  constructor({ dir, host, log }) {
    this.log = log || console;
    const safeHost = String(host || 'default').replace(/[^\w.-]/g, '_');
    this.file = path.join(dir || '.', `systemair-vr700-learned-${safeHost}.json`);
    this.data = { fan: {}, temp: {} };
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        this.data.fan = parsed.fan || {};
        this.data.temp = parsed.temp || {};
      }
      if (this.count() > 0) {
        this.log.info(`[systemair] loaded learned frames: ${this.count()} level(s) from ${this.file}`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log.warn(`[systemair] could not load learned frames (${this.file}): ${err.message}`);
      }
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      this.log.error(`[systemair] could not save learned frames (${this.file}): ${err.message}`);
    }
  }

  _get(kind, level) {
    const entry = this.data[kind][level];
    if (!entry || !entry.hex) return null;
    try {
      const buf = Buffer.from(entry.hex, 'hex');
      // Safety net: only use stored frames that still qualify as a valid command
      // frame (length + CRC + type 0x01).
      return proto.isCommandFrame(buf) ? buf : null;
    } catch (e) {
      return null;
    }
  }

  getFan(level) { return this._get('fan', level); }
  getTemp(level) { return this._get('temp', level); }

  hasFan(level) { return !!this.getFan(level); }
  hasTemp(level) { return !!this.getTemp(level); }

  setFan(level, buf, observed) {
    this.data.fan[level] = { hex: Buffer.from(buf).toString('hex'), observed, ts: Date.now() };
    this._save();
  }

  setTemp(level, buf, observed) {
    this.data.temp[level] = { hex: Buffer.from(buf).toString('hex'), observed, ts: Date.now() };
    this._save();
  }

  count() {
    return FAN_LEVELS.filter((l) => this.hasFan(l)).length + TEMP_LEVELS.filter((l) => this.hasTemp(l)).length;
  }

  isComplete() {
    return FAN_LEVELS.every((l) => this.hasFan(l)) && TEMP_LEVELS.every((l) => this.hasTemp(l));
  }
}

// Passive learn mode: listens on the bus, maps stable actual states to the
// last-seen real panel command frame, and stores that as an exact, unmodified
// set frame for the respective level.
//
// IMPORTANT: learn mode SENDS NOTHING. It only listens, so it is completely
// harmless to the bus. It does, however, need the ORIGINAL wall panel connected
// in parallel on the bus, whose buttons the user presses - only that produces
// the type-0x01 command frames to learn from. If the EW11 replaces a missing
// panel, there is no such source and learn mode can capture nothing (it says so
// clearly).
class Learner {
  constructor({ conn, store, log }) {
    this.conn = conn;
    this.store = store;
    this.log = log || console;
    this._lastCmd = null;
    this._lastCmdAt = 0;
    this._cur = null;
    this._stableTimer = null;
    this._noCmdWarned = false;
    this._commandSeen = false;
    this._noCmdTimer = null;
    this._onCommand = null;
    this._onState = null;
  }

  start() {
    this._banner();
    this._cur = this.conn.getState();

    this._onCommand = (frame) => {
      this._lastCmd = Buffer.from(frame);
      this._lastCmdAt = Date.now();
      this._commandSeen = true;
    };
    this._onState = (st) => {
      this._cur = st;
      this._scheduleCapture();
    };

    this.conn.on('command', this._onCommand);
    this.conn.on('state', this._onState);

    this._scheduleCapture();
    this._noCmdTimer = setTimeout(() => {
      if (!this._commandSeen) this._warnNoCommand();
    }, NO_CMD_WARN_MS);
  }

  _scheduleCapture() {
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = setTimeout(() => this._capture(), STABLE_MS);
  }

  _capture() {
    const st = this._cur;
    if (!st || st.fanSpeed == null || st.tempLevel == null) return;
    if (!this._lastCmd || Date.now() - this._lastCmdAt > CMD_FRESH_MS) {
      if (!this._commandSeen) this._warnNoCommand();
      return;
    }

    // The same panel command frame encodes BOTH fan and temperature level. A
    // stable state therefore potentially yields both at once: a valid set frame
    // for this fan level and for this temperature level.
    let learned = false;
    if (!this.store.hasFan(st.fanSpeed)) {
      this.store.setFan(st.fanSpeed, this._lastCmd, { fan: st.fanSpeed, temp: st.tempLevel });
      this.log.warn(`[systemair][learn] captured fan level ${st.fanSpeed} (at temperature level ${st.tempLevel}).`);
      learned = true;
    }
    if (!this.store.hasTemp(st.tempLevel)) {
      this.store.setTemp(st.tempLevel, this._lastCmd, { fan: st.fanSpeed, temp: st.tempLevel });
      this.log.warn(`[systemair][learn] captured temperature level ${st.tempLevel} (at fan level ${st.fanSpeed}).`);
      learned = true;
    }
    if (learned) this._progress();
  }

  _progress() {
    const missingFan = FAN_LEVELS.filter((l) => !this.store.hasFan(l));
    const missingTemp = TEMP_LEVELS.filter((l) => !this.store.hasTemp(l));
    const fanDone = FAN_LEVELS.length - missingFan.length;
    const tempDone = TEMP_LEVELS.length - missingTemp.length;
    this.log.warn(`[systemair][learn] progress: fan ${fanDone}/4, temperature ${tempDone}/6.`);

    if (this.store.isComplete()) {
      this.log.warn(
        '[systemair][learn] ==> ALL levels captured! Set "learn": false in the config ' +
        '(or remove the field) and restart Homebridge. The plugin will then use only the ' +
        'frames recorded from your own unit.'
      );
    } else {
      this.log.warn(
        `[systemair][learn] still open -> fan levels: [${missingFan.join(', ')}], ` +
        `temperature levels: [${missingTemp.join(', ')}]. Select these on the wall panel and hold ~5s each.`
      );
    }
  }

  _banner() {
    this.log.warn('====================================================================');
    this.log.warn('[systemair][learn] LEARN MODE ACTIVE - nothing is sent to the unit (listening only).');
    this.log.warn('[systemair][learn] Requirement: the ORIGINAL wall panel is connected in parallel on the bus.');
    this.log.warn('[systemair][learn] Please step through ALL levels on the wall panel, one by one:');
    this.log.warn('[systemair][learn]   - fan: off / low / normal / high');
    this.log.warn('[systemair][learn]   - temperature: all 6 levels');
    this.log.warn('[systemair][learn] Stay on each level ~5s so it can be captured.');
    this.log.warn('[systemair][learn] Progress and missing levels appear here in the log.');
    this.log.warn('====================================================================');
  }

  _warnNoCommand() {
    if (this._noCmdWarned) return;
    this._noCmdWarned = true;
    this.log.error(
      '[systemair][learn] No panel command frames (type 0x01) seen on the bus yet. ' +
      'Learning needs the original wall panel connected in parallel on the bus, whose buttons ' +
      'you press. If the EW11 replaces a missing panel, learning is not possible - the bundled ' +
      'default frames will keep being used.'
    );
  }

  stop() {
    if (this._onCommand) this.conn.removeListener('command', this._onCommand);
    if (this._onState) this.conn.removeListener('state', this._onState);
    if (this._stableTimer) clearTimeout(this._stableTimer);
    if (this._noCmdTimer) clearTimeout(this._noCmdTimer);
    this._onCommand = null;
    this._onState = null;
  }
}

module.exports = { FrameStore, Learner, FAN_LEVELS, TEMP_LEVELS };
