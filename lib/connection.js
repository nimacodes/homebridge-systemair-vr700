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
// ihre Frame-Synchronisation verlieren. Deshalb hier bewusst mehrere
// Bremsen: Mindestabstand zwischen Schreibvorgaengen, harte Obergrenze pro
// Auftrag, Verwerfen alter Auftraege bei Verbindungsabbruch, und eine
// Reconnect-Bremse (siehe _checkStale) - wiederholtes Auf-/Abbauen der
// TCP-Verbindung heisst auch wiederholtes Reset des EW11-Serial-Ports, was
// selbst zur Busstoerung beitragen kann, besonders wenn ohnehin schon ein
// Problem vorliegt (z.B. beobachtet: Regelung im Sensorfehler-Zustand).
class SystemairConnection extends EventEmitter {
  constructor({
    host,
    port = 502,
    log,
    sendWindowMs = 15000,
    sendRepeat = 6,
    staleMs = 15000,
    minSendIntervalMs = 400,
    maxBufferBytes = 8192,
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
    this.debug = debug;

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.reconnectDelay = 2000;
    this.state = { fanSpeed: null, tempLevel: null };
    this._pending = null; // {command, remaining, deadline}
    this._closed = false;
    this._lastFrameAt = Date.now();
    this._lastSendAt = 0;
    this._resendHandler = null; // genau EIN ausstehender Resend, nie mehrere

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
    this._watchdog = setInterval(() => this._checkStale(), 5000);
  }

  _emitRaw(direction, data) {
    if (!this.debug) return;
    this.emit('raw', { direction, hex: Buffer.from(data).toString('hex'), length: data.length, ts: Date.now() });
  }

  _checkStale() {
    if (this._closed || !this.socket) return;
    if (Date.now() - this._lastFrameAt > this._currentStaleThreshold()) {
      this._consecutiveStaleReconnects += 1;
      const backoffS = Math.min(60, this.staleMs / 1000 * Math.pow(2, this._consecutiveStaleReconnects - 1));
      this.log.warn(
        `[systemair] seit ${(this.staleMs / 1000).toFixed(0)}s keine Daten mehr erhalten - ` +
        `Verbindung vermutlich still gestorben, erzwinge Neuverbindung ` +
        `(Versuch ${this._consecutiveStaleReconnects} in Folge, naechste Pruefung fruehestens nach ~${backoffS.toFixed(0)}s)`
      );
      this._lastFrameAt = Date.now();
      this.socket.destroy();
    }
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
      this._lastFrameAt = Date.now();
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
      this._consecutiveStaleReconnects = 0; // Bus liefert wieder gueltige Frames
    }

    for (const frame of frames) {
      this.stats.validFrames += 1;
      const type = frame[2];

      if (type === 0x0a) {
        const st = proto.parseState(frame);
        if (st) {
          const changed = st.fanSpeed !== this.state.fanSpeed || st.tempLevel !== this.state.tempLevel;
          this.state = st;
          if (changed) this.emit('state', st);
        }
      }

      if (type === 0x02 && this._pending && this._pending.remaining > 0) {
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

  _trySend() {
    if (!this._pending || !this.socket || this.socket.destroyed) return;

    const now = Date.now();
    if (now - this._lastSendAt < this.minSendIntervalMs) return;

    this.socket.write(this._pending.command);
    this._emitRaw('tx', this._pending.command);
    this._lastSendAt = now;
    this._pending.remaining -= 1;
    if (this._pending.remaining <= 0) this._pending = null;
  }

  // Stoesst das Senden eines Kommandoframes an. Es wird mehrfach in die
  // Luecke nach jedem 0x02-Frame der Regelung gesendet (wie ein echtes
  // Panel es auch mehrfach probiert), bis sendRepeat erreicht oder das
  // Zeitfenster abgelaufen ist. Ein bereits laufender Auftrag wird ersetzt,
  // nicht ergaenzt - es ist immer nur EIN Kommando gleichzeitig unterwegs.
  sendCommand(command) {
    this._pending = {
      command,
      remaining: this.sendRepeat,
      deadline: Date.now() + this.sendWindowMs,
    };
  }

  // Sendet EIN einzelnes, vom Nutzer vorgegebenes Frame sofort (respektiert
  // weiterhin minSendIntervalMs), OHNE den normalen sendRepeat-Mechanismus.
  // Fuer den manuellen Debug-/Test-Versand gedacht (siehe README-Warnhinweis
  // zu Frames mit unbekannten Feldern).
  sendRaw(buffer) {
    if (!this.socket || this.socket.destroyed) {
      this.log.warn('[systemair] sendRaw: keine aktive Verbindung, Frame verworfen');
      return false;
    }
    const now = Date.now();
    if (now - this._lastSendAt < this.minSendIntervalMs) {
      this.log.warn('[systemair] sendRaw: Mindestabstand zum letzten Senden noch nicht erreicht, Frame verworfen');
      return false;
    }
    this.socket.write(buffer);
    this._emitRaw('tx-manual', buffer);
    this._lastSendAt = now;
    this.log.info(`[systemair] manuelles Frame gesendet (${buffer.length} Byte): ${buffer.toString('hex')}`);
    return true;
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
