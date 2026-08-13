'use strict';

const SystemairConnection = require('./connection');
const proto = require('./protocol');
const { FrameStore, Learner } = require('./learning');

const PLUGIN_NAME = 'homebridge-systemair-vr700';
const PLATFORM_NAME = 'SystemairVR700';

// Delay after the last slider movement before we actually send (see
// _scheduleSet).
const SET_DEBOUNCE_MS = 600;

// Fan level (0..3) <-> HomeKit RotationSpeed (0..100)
const FAN_STEP_PCT = [0, 33, 66, 100];
function fanLevelToPercent(level) {
  return FAN_STEP_PCT[level] ?? 0;
}
function percentToFanLevel(pct) {
  if (pct <= 0) return 0;
  if (pct <= 33) return 1;
  if (pct <= 66) return 2;
  return 3;
}

// Temperature level (0..5) <-> HomeKit Brightness (0..100 in steps of 20)
function tempLevelToPercent(level) {
  return Math.round((level ?? 0) * 20);
}
function percentToTempLevel(pct) {
  return Math.max(0, Math.min(5, Math.round(pct / 20)));
}

class SystemairPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.accessories = [];

    if (!this.config.ip) {
      this.log.error('[systemair] no "ip" set in the configuration - plugin stays inactive.');
      return;
    }

    this.name = this.config.name || 'Ventilation';
    this._fanGen = 0;
    this._tempGen = 0;
    this._setTimers = { fan: null, temp: null };
    this._debug = !!this.config.debug;
    this._learnMode = !!this.config.learn;

    this.conn = new SystemairConnection({
      host: this.config.ip,
      port: this.config.port || 502,
      log: this.log,
      debug: this._debug,
    });

    // Command frames learned from the user's own unit (if any). Preferred over
    // the bundled default frames in normal operation - see _fanFrame()/
    // _tempFrame(). The storage path comes from Homebridge; falls back to the
    // current directory if unavailable.
    let storageDir = '.';
    try {
      if (this.api && this.api.user && typeof this.api.user.storagePath === 'function') {
        storageDir = this.api.user.storagePath();
      }
    } catch (e) { /* fall back to '.' */ }
    this.store = new FrameStore({ dir: storageDir, host: this.config.ip, log: this.log });

    if (this._debug) {
      this.log.warn(
        '[systemair] debug mode active - every received and sent byte is logged. ' +
        'Disable again for normal operation (config: "debug": false).'
      );
      this.conn.on('raw', (evt) => {
        const dir = { rx: 'RX', tx: 'TX' }[evt.direction] || evt.direction;
        this.log.info(`[systemair][debug] ${dir} (${evt.length} bytes): ${evt.hex}`);
      });
      this.conn.on('debugStats', (s) => {
        if (s.framesInChunk === 0 && s.chunkLength > 0) {
          this.log.info(
            `[systemair][debug] ${s.chunkLength} bytes received, 0 valid frames in them ` +
            `(${s.skippedInChunk} discarded start positions) - totals since connect: ` +
            `${s.totals.bytesReceived} bytes received, ${s.totals.validFrames} valid frames, ` +
            `${s.totals.skippedBytes} discarded start positions`
          );
        }
      });
    }

    this.api.on('didFinishLaunching', () => {
      this._setupAccessories();
      if (this._learnMode) {
        this.learner = new Learner({ conn: this.conn, store: this.store, log: this.log });
        this.learner.start();
      } else if (this.store.count() > 0) {
        this.log.info(
          `[systemair] using ${this.store.count()} learned frame(s) from this unit ` +
          `(remainder via bundled default frames)`
        );
      }
    });

    if (this.api && typeof this.api.on === 'function') {
      this.api.on('shutdown', () => {
        if (this.learner) this.learner.stop();
        if (this.conn) this.conn.close();
      });
    }
  }

  // Called by Homebridge for every accessory restored from cache, before
  // didFinishLaunching fires.
  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  _setupAccessories() {
    this._setupFanAccessory();
    this._setupTempAccessory();
  }

  _getOrCreate(displayName, category) {
    const uuid = this.api.hap.uuid.generate(PLUGIN_NAME + ':' + displayName);
    let accessory = this.accessories.find((a) => a.UUID === uuid);
    if (!accessory) {
      const PlatformAccessory = this.api.platformAccessory;
      accessory = new PlatformAccessory(displayName, uuid, category);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
      this.log.info(`[systemair] accessory created: ${displayName}`);
    }
    return accessory;
  }

  _setupFanAccessory() {
    const accessory = this._getOrCreate(
      `${this.name} Speed`,
      this.api.hap.Categories.FAN
    );
    const service =
      accessory.getService(this.Service.Fanv2) ||
      accessory.addService(this.Service.Fanv2, `${this.name} Speed`);

    service
      .getCharacteristic(this.Characteristic.Active)
      .onGet(() => {
        const lvl = this.conn.getState().fanSpeed;
        return lvl > 0 ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE;
      })
      .onSet((value) => {
        if (value === this.Characteristic.Active.INACTIVE) {
          this._setFanLevel(0);
        } else {
          const cur = this.conn.getState().fanSpeed;
          this._setFanLevel(cur > 0 ? cur : 2); // default "normal" when previously off
        }
      });

    service
      .getCharacteristic(this.Characteristic.RotationSpeed)
      .setProps({ minStep: 33 })
      .onGet(() => fanLevelToPercent(this.conn.getState().fanSpeed))
      .onSet((pct) => this._setFanLevel(percentToFanLevel(pct)));

    this.conn.on('state', (st) => {
      service.updateCharacteristic(
        this.Characteristic.Active,
        st.fanSpeed > 0 ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE
      );
      service.updateCharacteristic(this.Characteristic.RotationSpeed, fanLevelToPercent(st.fanSpeed));
    });

    this.fanService = service;
  }

  _setupTempAccessory() {
    const accessory = this._getOrCreate(
      `${this.name} Temperature`,
      this.api.hap.Categories.LIGHTBULB
    );
    const service =
      accessory.getService(this.Service.Lightbulb) ||
      accessory.addService(this.Service.Lightbulb, `${this.name} Temperature`);

    service
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.conn.getState().tempLevel > 0)
      .onSet((on) => {
        if (!on) {
          this._setTempLevel(0);
        } else {
          const cur = this.conn.getState().tempLevel;
          this._setTempLevel(cur > 0 ? cur : 3);
        }
      });

    service
      .getCharacteristic(this.Characteristic.Brightness)
      .setProps({ minStep: 20 })
      .onGet(() => tempLevelToPercent(this.conn.getState().tempLevel))
      .onSet((pct) => this._setTempLevel(percentToTempLevel(pct)));

    this.conn.on('state', (st) => {
      service.updateCharacteristic(this.Characteristic.On, st.tempLevel > 0);
      service.updateCharacteristic(this.Characteristic.Brightness, tempLevelToPercent(st.tempLevel));
    });

    this.tempService = service;
  }

  // Returns the command frame to send for a fan/temperature level. Prefers a
  // frame learned from the user's own unit (learn mode), otherwise falls back to
  // the bundled, recorded default template. In both cases an EXACT, unmodified
  // frame is sent - never a dynamically assembled one.
  _fanFrame(level) {
    const learned = this.store.getFan(level);
    if (learned) return learned;
    return proto.commandForFanSpeed(level);
  }

  _tempFrame(level) {
    const learned = this.store.getTemp(level);
    if (learned) return learned;
    return proto.commandForTempLevel(level);
  }

  // Debounces the actual send by SET_DEBOUNCE_MS. Dragging a slider in the Home
  // app fires several onSet() calls within milliseconds - without debouncing,
  // EACH would trigger its own send burst on the half-duplex bus. So we only
  // send the last chosen value, after the user releases the slider.
  _scheduleSet(kind, level) {
    const timers = this._setTimers;
    if (timers[kind]) clearTimeout(timers[kind]);
    timers[kind] = setTimeout(() => {
      timers[kind] = null;
      if (kind === 'fan') this._doSetFanLevel(level);
      else this._doSetTempLevel(level);
    }, SET_DEBOUNCE_MS);
  }

  _setFanLevel(level) {
    this._scheduleSet('fan', level);
  }

  _setTempLevel(level) {
    this._scheduleSet('temp', level);
  }

  _doSetFanLevel(level) {
    if (this._learnMode) {
      this.log.info('[systemair] learn mode active - fan command NOT sent (listening only).');
      return;
    }
    const current = this.conn.getState().fanSpeed;
    if (current === level) {
      this.log.info(`[systemair] fan level already at ${level} - no send needed`);
      return;
    }
    let frame;
    try {
      frame = this._fanFrame(level);
    } catch (err) {
      this.log.error(`[systemair] no frame available for fan level ${level}: ${err.message}`);
      return;
    }
    const myGen = ++this._fanGen;
    this.log.info(`[systemair] setting fan level -> ${level}`);
    // Only an EXACT, unmodified command frame is ever sent (learned or default
    // template) - never a dynamically assembled one that could crash the
    // controller. The target predicate makes sending stop as soon as a broadcast
    // confirms the target level (closed loop, minimal bus load).
    const send = () => this.conn.sendCommand(frame, (st) => st.fanSpeed === level);
    send();
    this._verifyLater({
      label: 'fan level',
      target: level,
      readActual: () => this.conn.getState().fanSpeed,
      sendFn: send,
      myGen,
      currentGen: () => this._fanGen,
    });
  }

  _doSetTempLevel(level) {
    if (this._learnMode) {
      this.log.info('[systemair] learn mode active - temperature command NOT sent (listening only).');
      return;
    }
    const current = this.conn.getState().tempLevel;
    if (current === level) {
      this.log.info(`[systemair] temperature level already at ${level} - no send needed`);
      return;
    }
    let frame;
    try {
      frame = this._tempFrame(level);
    } catch (err) {
      this.log.error(`[systemair] no frame available for temperature level ${level}: ${err.message}`);
      return;
    }
    const myGen = ++this._tempGen;
    this.log.info(`[systemair] setting temperature level -> ${level}`);
    // See comment in _doSetFanLevel - exact frame + closed-loop target.
    const send = () => this.conn.sendCommand(frame, (st) => st.tempLevel === level);
    send();
    this._verifyLater({
      label: 'temperature level',
      target: level,
      readActual: () => this.conn.getState().tempLevel,
      sendFn: send,
      myGen,
      currentGen: () => this._tempGen,
    });
  }

  // After a short delay, checks whether the reported value matches the target.
  // First checks whether a NEWER command for the same control has been issued in
  // the meantime (e.g. dragging the slider in the Home app produces several
  // onSet() calls within fractions of a second) - if so, this stale check is
  // dropped silently instead of re-imposing an outdated target.
  //
  // If it still doesn't match, we simply resend the exact frame ONCE more (no
  // reconnect, no disconnect) - the closed-loop send already retried within its
  // window, so there's nothing a reconnect would fix. After that we stop
  // quietly; the unit's next state broadcast keeps HomeKit in sync.
  _verifyLater({ label, target, readActual, sendFn, myGen, currentGen, attempt = 1 }) {
    setTimeout(() => {
      if (myGen !== currentGen()) {
        return; // superseded by a newer command - nothing to do
      }
      const actual = readActual();
      if (actual === target) {
        this.log.info(`[systemair] ${label} confirmed: actual=${actual} matches target=${target}`);
        return;
      }
      if (attempt >= 2) {
        this.log.warn(
          `[systemair] ${label} still reads ${actual} (requested ${target}); leaving it - ` +
          `HomeKit will reflect whatever the unit reports next`
        );
        return;
      }
      this.log.warn(`[systemair] ${label} not applied yet (actual=${actual}, target=${target}); resending once`);
      sendFn();
      this._verifyLater({ label, target, readActual, sendFn, myGen, currentGen, attempt: attempt + 1 });
    }, 5000);
  }
}

module.exports = { SystemairPlatform, PLUGIN_NAME, PLATFORM_NAME };
