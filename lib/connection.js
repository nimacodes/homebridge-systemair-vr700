'use strict';

const net = require('net');
const EventEmitter = require('events');
const proto = require('./protocol');

// Haelt eine dauerhafte TCP-Verbindung zum EW11 (RS485<->WLAN-Adapter),
// verbindet bei Abbruch automatisch neu, parst eingehende Zustands-Broadcasts
// und sendet Kommandoframes zum richtigen Zeitpunkt (direkt nach einem
// Frame-Typ 0x02 der Regelung - das ist der Moment, in dem das echte Panel
// antwortet).
//
// WICHTIG - Bus-Hygiene: Der Panel-Bus ist RS485-HALBDUPLEX. Alles, was wir
// schreiben, teilt sich die Leitung mit dem echten Wandpanel und der
// Regelung. Schreiben wir zu viel oder zum falschen Zeitpunkt, kollidieren
// die Signale, es entsteht Datenmuell auf dem Draht, und die Regelung kann
// ihre Frame-Synchronisation verlieren (beobachtet: die Anlage "blockiert"
// dann die Kommunikation, bis der EW11 stromlos gemacht wird). Deshalb hier
// bewusst mehrere unabhaengige Bremsen:
//
//   1. Slot-Timing        - gesendet wird NUR unmittelbar nach einem 0x02.
//   2. Closed-Loop        - sobald der Broadcast den Zielwert bestaetigt,
//                           wird sofort aufgehoert zu senden (kein blindes
//                           Wiederholen bis zum Fensterende).
//   3. Mindestabstand     - minSendIntervalMs zwischen zwei Schreibvorgaengen.
//   4. Wiederhol-Deckel   - hoechstens sendRepeat Versuche pro Auftrag.
//   5. Minuten-Budget     - harte Obergrenze an Schreibvorgaengen pro Minute,
//                           unabhaengig von allem anderen (Schutz vor Bugs).
//   6. Stau-Erkennung     - kommen laengere Zeit nur ungueltige Bytes an
//                           (Kollision/Muell), stoppt das Plugin JEDES Senden
//                           fuer eine Beruhigungsphase (Quiet-Mode) und baut
//                           die Verbindung einmal neu auf, statt weiter gegen
//                           den gestoerten Bus zu schreiben.
class SystemairConnection extends EventEmitter {
  constructor({
    host,
    port = 502,
    log,
    sendWindowMs = 8000,
    sendRepeat = 3,
    staleMs = 15000,
    minSendIntervalMs = 500,
    maxBufferBytes = 8192,
    maxSendsPerMinute = 40,
    jamMs = 12000,
    busRecoveryMs = 30000,
    debug = false,
  } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.log = log || console;
    this.sendWindowMs = sendWindowMs;
    this.sendRepeat = sendRepeat;
    this.staleMs = staleMs;
    this.minSendIntervalMs = minSendIntervalMs;
    this.maxBufferBytes = maxBufferBytes;
    this.maxSendsPerMinute = maxSendsPerMinute;
    this.jamMs = jamMs;
    this.busRecoveryMs = busRecoveryMs;
    this.debug = debug;

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.reconnectDelay = 2000;
    this.state = { fanSpeed: null, tempLevel: null };
    this._pending = null; // {command, remaining, deadline, target}
    this._closed = false;

    const now = Date.now();
    this._lastFrameAt = now;      // letzter Zeitpunkt, an dem IRGENDWELCHE Bytes kamen
    this._lastValidFrameAt = now; // letzter Zeitpunkt, an dem ein GUELTIGES Frame kam
    this._lastSendAt = 0;
    this._sendTimes = [];         // Zeitstempel der letzten Schreibvorgaenge (Minuten-Budget)
    this._quietUntil = 0;         // bis hierhin wird bewusst NICHT gesendet (Bus-Stau)
    this._resendHandler = null;   // genau EIN ausstehender Resend, nie mehrere

    // Reconnect-Bremse: je mehr staleMs-getriebene Reconnects in Folge ohne
    // zwischenzeitlich ein gueltiges Frame gesehen zu haben, desto laenger
    // die Pause bis zum naechsten erzwungenen Reconnect (Exponential-Backoff,
    // Obergrenze 60s). Wird auf 0 zurueckgesetzt, sobald wieder ein
    // gueltiges Frame ankommt.
    this._consecutiveStaleReconnects = 0;

    // Statistik seit dem letzten erfolgreichen Verbindungsaufbau - hilft,
    // "keine Bytes kommen an" (elektrisches/Kabelproblem) von "Bytes kommen
    // an, aber nie ein gueltiges Frame" (Rauschen/Kollision) zu unterscheiden.
    this.stats = { bytesReceived: 0, validFrames: 0, skippedBytes: 0 };

    this._connect();
    this._watchdog = setInterval(() => this._tick(), 5000);
  }

  _emitRaw(direction, data) {
    if (!this.debug) return;
    this.emit('raw', { direction, hex: Buffer.from(data).toString('hex'), length: data.length, ts: Date.now() });
  }

  // Laeuft alle 5s: prueft zuerst auf einen still gestorbenen Link (gar keine
  // Bytes), dann auf einen Bus-Stau (Bytes kommen, aber nur Muell).
  _tick() {
    if (this._closed || !this.socket) return;
    const now = Date.now();

    // (a) Link tot: seit staleMs (mit Backoff) ueberhaupt keine Bytes mehr.
    if (now - this._lastFrameAt > this._currentStaleThreshold()) {
      this._consecutiveStaleReconnects += 1;
      const backoffS = Math.min(60, this.staleMs / 1000 * Math.pow(2, this._consecutiveStaleReconnects - 1));
      this.log.warn(
        `[systemair] seit ${(this.staleMs / 1000).toFixed(0)}s keine Daten mehr erhalten - ` +
        `Verbindung vermutlich still gestorben, erzwinge Neuverbindung ` +
        `(Versuch ${this._consecutiveStaleReconnects} in Folge, naechste Pruefung fruehestens nach ~${backoffS.toFixed(0)}s)`
      );
      this._lastFrameAt = now;
      this.socket.destroy();
      return;
    }

    // (b) Bus-Stau: es kommen zwar noch Bytes (Link lebt), aber seit jamMs
    // kein einziges GUELTIGES Frame mehr - typisch fuer Kollisionen/Muell auf
    // dem Halbduplex-Bus. Weiter zu senden macht es nur schlimmer. Also: alles
    // Senden fuer busRecoveryMs stoppen und die Verbindung einmal neu aufbauen
    // (setzt den seriellen Puffer des EW11 zurueck), damit sich der Bus
    // beruhigen kann.
    if (now - this._lastValidFrameAt > this.jamMs && now - this._lastFrameAt < this.jamMs) {
      this._enterQuietMode('Bus liefert nur noch ungueltige Daten (vermutlich Kollisionen/Stau)');
      this._lastValidFrameAt = now; // nicht bei jedem Tick erneut ausloesen
      this._lastFrameAt = now;
      this.socket.destroy();
    }
  }

  _enterQuietMode(reason) {
    const secs = (this.busRecoveryMs / 1000).toFixed(0);
    this._quietUntil = Date.now() + this.busRecoveryMs;
    if (this._pending) {
      this.log.warn('[systemair] laufender Sende-Auftrag wird wegen Bus-Stau verworfen');
      this._pending = null;
    }
    this.log.error(
      `[systemair] ${reason} - stoppe ALLES Senden fuer ~${secs}s (Quiet-Mode) und baue die ` +
      `Verbindung neu auf, damit sich der Bus beruhigen kann. ` +
      `Bleibt das dauerhaft, hilft nur ein Stromreset des EW11.`
    );
    this.emit('busJam', { until: this._quietUntil, reason });
  }

  // Backoff-Schwelle: staleMs, multipliziert mit 2^(Anzahl erfolgloser
  // Reconnects in Folge), gedeckelt auf 60s. So haemmern wir nicht alle 15s
  // gegen ein Problem an, das offensichtlich nicht durch Neuverbinden geloest
  // wird (z.B. eine elektrische Busstoerung).
  _currentStaleThreshold() {
    const factor = Math.pow(2, this._consecutiveStaleReconnects);
    return Math.min(60000, this.staleMs * factor);
  }

  _connect() {
    if (this._closed) return;

    if (this.socket) {
      this.socket.removeAllListeners();
      if (!this.socket.destroyed) this.socket.destroy();
      this.socket = null;
    }

    const socket = net.createConnection({ host: this.host, port: this.port }, () => {
      this.log.info(`[systemair] verbunden mit ${this.host}:${this.port}`);
      const now = Date.now();
      this._lastFrameAt = now;
      this._lastValidFrameAt = now;
      this.emit('connected');
    });
    this.socket = socket;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      this.log.warn(`[systemair] Verbindungsfehler: ${err.message}`);
    });
    socket.on('close', () => {
      if (this._closed) return;
      if (this.socket !== socket) return; // veralteter Socket, ignorieren
      this.log.warn(`[systemair] Verbindung getrennt, neuer Versuch in ${this.reconnectDelay / 1000}s`);
      this.buffer = Buffer.alloc(0);
      this._pending = null;
      setTimeout(() => this._connect(), this.reconnectDelay);
    });
  }

  _onData(chunk) {
    this._lastFrameAt = Date.now();
    this._emitRaw('rx', chunk);
    this.stats.bytesReceived += chunk.length;

    this.buffer = Buffer.concat([this.buffer, chunk]);

    if (this.buffer.length > this.maxBufferBytes) {
      this.log.warn(
        `[systemair] Empfangspuffer ueber ${this.maxBufferBytes} Byte gewachsen - ` +
        `verwerfe aeltere Daten und synchronisiere neu`
      );
      this.buffer = this.buffer.subarray(this.buffer.length - proto.FRAME_LEN);
    }

    const { frames, rest, skipped } = proto.splitFrames(this.buffer);
    this.buffer = rest;
    this.stats.skippedBytes += skipped;

    if (frames.length > 0) {
      this._lastValidFrameAt = Date.now();
      this._consecutiveStaleReconnects = 0; // Bus liefert wieder gueltige Frames
    }

    for (const frame of frames) {
      this.stats.validFrames += 1;
      const type = frame[2];

      if (type === proto.FRAME_TYPE.BROADCAST) {
        const st = proto.parseState(frame);
        if (st) {
          const changed = st.fanSpeed !== this.state.fanSpeed || st.tempLevel !== this.state.tempLevel;
          this.state = st;
          if (changed) this.emit('state', st);
          // Closed-Loop: sobald der bestaetigte Ist-Zustand dem Ziel des
          // laufenden Auftrags entspricht, sofort aufhoeren zu senden.
          if (this._pending && typeof this._pending.target === 'function' && this._pending.target(st)) {
            this._pending = null;
          }
        }
      } else if (type === proto.FRAME_TYPE.COMMAND) {
        // Ein Kommandoframe des echten Wandpanels (oder von uns). Fuer den
        // Lernmodus interessant, der daraus die eigenen Frames der Anlage
        // ableitet.
        this.emit('command', Buffer.from(frame));
      }

      if (type === proto.FRAME_TYPE.POLL && this._pending && this._pending.remaining > 0) {
        this._trySend();
      }
    }

    if (this.debug) {
      this.emit('debugStats', {
        chunkLength: chunk.length,
        framesInChunk: frames.length,
        skippedInChunk: skipped,
        totals: { ...this.stats },
      });
    }

    if (this._pending && Date.now() > this._pending.deadline) {
      this._pending = null;
    }
  }

  // Prueft das Minuten-Budget (harte Obergrenze an Schreibvorgaengen pro
  // rollender Minute). Verhindert, dass ein Fehler irgendwo im Plugin je den
  // Bus flutet, egal was sonst passiert.
  _budgetAllows() {
    const cutoff = Date.now() - 60000;
    this._sendTimes = this._sendTimes.filter((t) => t > cutoff);
    return this._sendTimes.length < this.maxSendsPerMinute;
  }

  _trySend() {
    if (!this._pending || !this.socket || this.socket.destroyed) return;

    const now = Date.now();
    if (now < this._quietUntil) return;                         // Bus-Beruhigung laeuft
    if (now - this._lastSendAt < this.minSendIntervalMs) return; // Mindestabstand
    if (!this._budgetAllows()) {
      this.log.warn(
        `[systemair] Sende-Budget (${this.maxSendsPerMinute}/min) erreicht - warte, ` +
        `um den Bus nicht zu ueberlasten`
      );
      return;
    }

    this.socket.write(this._pending.command);
    this._emitRaw('tx', this._pending.command);
    this._lastSendAt = now;
    this._sendTimes.push(now);
    this._pending.remaining -= 1;
    if (this._pending.remaining <= 0) this._pending = null;
  }

  // Stoesst das Senden eines Kommandoframes an. Es wird in die Luecke nach
  // jedem 0x02-Frame der Regelung gesendet (wie ein echtes Panel es auch tut),
  // bis EINES von diesen Dingen eintritt: der Broadcast bestaetigt den
  // Zielwert (target), sendRepeat ist erreicht, oder das Zeitfenster ist
  // abgelaufen. Ein bereits laufender Auftrag wird ersetzt, nicht ergaenzt -
  // es ist immer nur EIN Kommando gleichzeitig unterwegs.
  //
  // target: optionale Funktion (state) => bool. Liefert sie true, sobald der
  // gemeldete Zustand dem Ziel entspricht, wird sofort aufgehoert zu senden.
  sendCommand(command, target = null) {
    if (Date.now() < this._quietUntil) {
      this.log.warn('[systemair] Quiet-Mode aktiv (Bus-Beruhigung) - Kommando wird derzeit nicht gesendet');
    }
    this._pending = {
      command,
      remaining: this.sendRepeat,
      deadline: Date.now() + this.sendWindowMs,
      target: typeof target === 'function' ? target : null,
    };
  }

  forceReconnect() {
    if (this._closed || !this.socket) return;
    this.log.warn('[systemair] erzwinge Neuverbindung');
    this._lastFrameAt = Date.now();
    this.socket.destroy();
  }

  reconnectAndResend(sendFn, afterSentCb) {
    if (this._resendHandler) {
      this.removeListener('connected', this._resendHandler);
      this._resendHandler = null;
    }
    const handler = () => {
      this._resendHandler = null;
      sendFn();
      if (afterSentCb) afterSentCb();
    };
    this._resendHandler = handler;
    this.once('connected', handler);
    this.forceReconnect();
  }

  getState() {
    return this.state;
  }

  getStats() {
    return { ...this.stats };
  }

  close() {
    this._closed = true;
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._resendHandler) {
      this.removeListener('connected', this._resendHandler);
      this._resendHandler = null;
    }
    this._pending = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

module.exports = SystemairConnection;
