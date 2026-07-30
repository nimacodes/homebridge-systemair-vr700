'use strict';

const SystemairConnection = require('./connection');
const proto = require('./protocol');

const PLUGIN_NAME = 'homebridge-systemair-vr700';
const PLATFORM_NAME = 'SystemairVR700';

// Wartezeit nach der letzten Regler-Bewegung, bevor tatsaechlich gesendet
// wird (siehe _scheduleSet).
const SET_DEBOUNCE_MS = 600;

// Luefterstufe (0..3) <-> HomeKit RotationSpeed (0..100)
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

// Temperaturstufe (0..5) <-> HomeKit Brightness (0..100 in 20er-Schritten)
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
      this.log.error('[systemair] Keine "ip" in der Konfiguration gesetzt - Plugin bleibt inaktiv.');
      return;
    }

    this.name = this.config.name || 'Lüftung';
    this._fanGen = 0;
    this._tempGen = 0;
    this._setTimers = { fan: null, temp: null };
    this.conn = new SystemairConnection({
      host: this.config.ip,
      port: this.config.port || 502,
      log: this.log,
    });

    this.api.on('didFinishLaunching', () => this._setupAccessories());
  }

  // Wird von Homebridge fuer jedes aus dem Cache wiederhergestellte
  // Zubehoer aufgerufen, bevor didFinishLaunching feuert.
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
      this.log.info(`[systemair] Zubehoer angelegt: ${displayName}`);
    }
    return accessory;
  }

  _setupFanAccessory() {
    const accessory = this._getOrCreate(
      `${this.name} Geschwindigkeit`,
      this.api.hap.Categories.FAN
    );
    const service =
      accessory.getService(this.Service.Fanv2) ||
      accessory.addService(this.Service.Fanv2, `${this.name} Geschwindigkeit`);

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
          this._setFanLevel(cur > 0 ? cur : 2); // Default "Normal", wenn vorher aus
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
      `${this.name} Temperatur`,
      this.api.hap.Categories.LIGHTBULB
    );
    const service =
      accessory.getService(this.Service.Lightbulb) ||
      accessory.addService(this.Service.Lightbulb, `${this.name} Temperatur`);

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

  // Verzoegert das tatsaechliche Senden um SET_DEBOUNCE_MS. Zieht man in der
  // Home-App am Regler, feuert HomeKit mehrere onSet()-Aufrufe binnen
  // Millisekunden - ohne Debounce loeste JEDER davon sofort einen eigenen
  // Sende-Burst auf dem Halbduplex-Bus aus. Gesendet wird deshalb erst der
  // zuletzt gewaehlte Wert, nachdem der Nutzer den Regler losgelassen hat.
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
    const myGen = ++this._fanGen;
    this.log.info(`[systemair] setze Luefterstufe -> ${level}`);
    // Sicherheitsrollback: NICHT proto.commandForState() verwenden (baut
    // "Frankenstein"-Frames aus gemischten Templates mit teils unbekannten
    // Feldern - hat auf der echten Anlage zu einem Absturz der Regelung
    // gefuehrt). Stattdessen ausschliesslich exakte, unveraendert
    // aufgezeichnete Kommandoframes senden - das ist der einzige Weg, der in
    // vielen Tests nachweislich nie zu Problemen gefuehrt hat.
    const send = () => this.conn.sendCommand(proto.commandForFanSpeed(level));
    send();
    this._verifyLater({
      label: 'Luefterstufe',
      soll: level,
      readIst: () => this.conn.getState().fanSpeed,
      sendFn: send,
      myGen,
      currentGen: () => this._fanGen,
    });
  }

  _doSetTempLevel(level) {
    const myGen = ++this._tempGen;
    this.log.info(`[systemair] setze Temperaturstufe -> ${level}`);
    // Siehe Kommentar in _doSetFanLevel - bewusst exaktes Template statt
    // proto.commandForState().
    const send = () => this.conn.sendCommand(proto.commandForTempLevel(level));
    send();
    this._verifyLater({
      label: 'Temperaturstufe',
      soll: level,
      readIst: () => this.conn.getState().tempLevel,
      sendFn: send,
      myGen,
      currentGen: () => this._tempGen,
    });
  }

  // Prueft nach einer Verzoegerung, ob der Ist-Wert dem gesendeten Soll-Wert
  // entspricht. Bevor gehandelt wird, wird zuerst geprueft, ob inzwischen ein
  // NEUERER Befehl fuer denselben Regler ausgeloest wurde (z.B. durch
  // schnelles Ziehen des Reglers in der Home-App, das mehrere onSet()-Aufrufe
  // binnen Sekundenbruchteilen erzeugt) - falls ja, wird diese veraltete
  // Pruefung stillschweigend verworfen, statt einen ueberholten Zielwert
  // erneut durchzusetzen und damit einen zwischenzeitlich schon korrekt
  // gesetzten neueren Wert wieder zu ueberschreiben.
  _verifyLater({ label, soll, readIst, sendFn, myGen, currentGen, attempt = 1 }) {
    setTimeout(() => {
      if (myGen !== currentGen()) {
        return; // durch neueren Befehl ueberholt - nichts mehr zu tun
      }
      const ist = readIst();
      if (ist === soll) {
        this.log.info(`[systemair] ${label} bestaetigt: Ist=${ist} entspricht Soll=${soll}`);
        return;
      }
      this.log.warn(`[systemair] ${label} weicht ab: Ist=${ist}, Soll=${soll} (nach 5s, Versuch ${attempt})`);
      if (attempt >= 2) {
        this.log.error(
          `[systemair] ${label} bleibt nach Neuverbindung und erneutem Senden abweichend ` +
          `(Ist=${ist}, Soll=${soll}) - gebe auf`
        );
        return;
      }
      this.log.warn(`[systemair] baue Verbindung neu auf und sende ${label} erneut`);
      this.conn.reconnectAndResend(sendFn, () => {
        if (myGen !== currentGen()) return; // waehrend des Reconnects ueberholt
        this._verifyLater({ label, soll, readIst, sendFn, myGen, currentGen, attempt: attempt + 1 });
      });
    }, 5000);
  }
}

module.exports = { SystemairPlatform, PLUGIN_NAME, PLATFORM_NAME };
