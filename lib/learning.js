'use strict';

const fs = require('fs');
const path = require('path');
const proto = require('./protocol');

const FAN_LEVELS = [0, 1, 2, 3];
const TEMP_LEVELS = [0, 1, 2, 3, 4, 5];

// Wie lange ein Zustand stabil sein muss, bevor wir das zugehoerige
// Kommandoframe als "gelernt" verbuchen (verhindert das Erfassen von
// Zwischenzustaenden waehrend der Nutzer noch am Panel dreht).
const STABLE_MS = 4000;

// Wie alt das zuletzt gesehene Panel-Kommandoframe hoechstens sein darf, damit
// wir es einem gerade stabilen Zustand zuordnen.
const CMD_FRESH_MS = 10000;

// Wie lange ohne ein einziges Panel-Kommandoframe (Typ 0x01) vergehen darf,
// bevor wir den Nutzer warnen, dass Lernen so nicht funktionieren kann.
const NO_CMD_WARN_MS = 25000;

// Persistiert die von der eigenen Anlage aufgezeichneten Kommandoframes als
// JSON im Homebridge-Storage. Pro EW11-Host eine eigene Datei, damit mehrere
// Anlagen sich nicht in die Quere kommen.
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
        this.log.info(`[systemair] gelernte Frames geladen: ${this.count()} Stufe(n) aus ${this.file}`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.log.warn(`[systemair] konnte gelernte Frames nicht laden (${this.file}): ${err.message}`);
      }
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      this.log.error(`[systemair] konnte gelernte Frames nicht speichern (${this.file}): ${err.message}`);
    }
  }

  _get(kind, level) {
    const entry = this.data[kind][level];
    if (!entry || !entry.hex) return null;
    try {
      const buf = Buffer.from(entry.hex, 'hex');
      // Sicherheitsnetz: nur gespeicherte Frames verwenden, die noch als
      // gueltiges Kommandoframe durchgehen (Laenge + CRC + Typ 0x01).
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

// Passiver Lernmodus: hoert am Bus mit, ordnet stabile Ist-Zustaende dem
// zuletzt gesehenen echten Panel-Kommandoframe zu und speichert dieses als
// exaktes, unveraendertes Setz-Frame fuer die jeweilige Stufe.
//
// WICHTIG: Der Lernmodus SENDET NICHTS. Er liest ausschliesslich mit. Damit
// ist er fuer den Bus voellig ungefaehrlich. Er benoetigt aber das ORIGINALE
// Wandpanel, das parallel am Bus haengt und dessen Tasten der Nutzer
// betaetigt - nur dieses erzeugt die Typ-0x01-Kommandoframes, aus denen
// gelernt wird. Ersetzt der EW11 ein fehlendes Panel, gibt es keine solche
// Quelle und der Lernmodus kann nichts erfassen (er sagt das dann klar).
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

    // Dasselbe Panel-Kommandoframe kodiert Luefter- UND Temperaturstufe. Ein
    // stabiler Zustand liefert daher potenziell beides gleichzeitig: ein
    // gueltiges Setz-Frame fuer diese Luefterstufe und fuer diese
    // Temperaturstufe.
    let learned = false;
    if (!this.store.hasFan(st.fanSpeed)) {
      this.store.setFan(st.fanSpeed, this._lastCmd, { fan: st.fanSpeed, temp: st.tempLevel });
      this.log.warn(`[systemair][lernen] Luefterstufe ${st.fanSpeed} erfasst (bei Temperaturstufe ${st.tempLevel}).`);
      learned = true;
    }
    if (!this.store.hasTemp(st.tempLevel)) {
      this.store.setTemp(st.tempLevel, this._lastCmd, { fan: st.fanSpeed, temp: st.tempLevel });
      this.log.warn(`[systemair][lernen] Temperaturstufe ${st.tempLevel} erfasst (bei Luefterstufe ${st.fanSpeed}).`);
      learned = true;
    }
    if (learned) this._progress();
  }

  _progress() {
    const missingFan = FAN_LEVELS.filter((l) => !this.store.hasFan(l));
    const missingTemp = TEMP_LEVELS.filter((l) => !this.store.hasTemp(l));
    const fanDone = FAN_LEVELS.length - missingFan.length;
    const tempDone = TEMP_LEVELS.length - missingTemp.length;
    this.log.warn(`[systemair][lernen] Fortschritt: Luefter ${fanDone}/4, Temperatur ${tempDone}/6.`);

    if (this.store.isComplete()) {
      this.log.warn(
        '[systemair][lernen] ==> ALLE Stufen erfasst! Setze in der Config "learn": false ' +
        '(oder entferne das Feld) und starte Homebridge neu. Das Plugin verwendet dann ' +
        'ausschliesslich die von deiner eigenen Anlage aufgezeichneten Frames.'
      );
    } else {
      this.log.warn(
        `[systemair][lernen] Noch offen -> Luefterstufen: [${missingFan.join(', ')}], ` +
        `Temperaturstufen: [${missingTemp.join(', ')}]. Diese am Wandpanel einstellen und je ~5s halten.`
      );
    }
  }

  _banner() {
    this.log.warn('====================================================================');
    this.log.warn('[systemair][lernen] LERNMODUS AKTIV - es wird NICHTS an die Anlage gesendet (nur Mithoeren).');
    this.log.warn('[systemair][lernen] Voraussetzung: das ORIGINALE Wandpanel haengt parallel am Bus.');
    this.log.warn('[systemair][lernen] Bitte am Wandpanel nacheinander ALLE Stufen durchschalten:');
    this.log.warn('[systemair][lernen]   - Luefter: Aus / Niedrig / Normal / Hoch');
    this.log.warn('[systemair][lernen]   - Temperatur: alle 6 Stufen');
    this.log.warn('[systemair][lernen] Auf jeder Stufe ~5s stehen bleiben, damit ich sie erfassen kann.');
    this.log.warn('[systemair][lernen] Fortschritt und fehlende Stufen erscheinen hier im Log.');
    this.log.warn('====================================================================');
  }

  _warnNoCommand() {
    if (this._noCmdWarned) return;
    this._noCmdWarned = true;
    this.log.error(
      '[systemair][lernen] Bisher KEINE Panel-Kommandoframes (Typ 0x01) auf dem Bus gesehen. ' +
      'Lernen benoetigt das originale Wandpanel, das parallel am Bus angeschlossen bleibt und ' +
      'dessen Tasten du betaetigst. Ersetzt der EW11 ein fehlendes Panel, ist Lernen nicht ' +
      'moeglich - dann werden weiterhin die mitgelieferten Standard-Frames verwendet.'
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
