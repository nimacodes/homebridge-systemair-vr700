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
// schreiben, teilt sich die Leitung mit dem echten Wandpanel und der Regelung.
// Schreiben wir zu viel oder zum falschen Zeitpunkt, kollidieren die Signale,
// es entsteht Datenmuell auf dem Draht, und die Regelung kann ihre
// Frame-Synchronisation verlieren (beobachtetes Symptom: Panel-Bus friert ein,
// nur ein Stromreset des Geraets hilft). Deshalb hier bewusst mehrere Bremsen:
// Mindestabstand zwischen Schreibvorgaengen, harte Obergrenze pro Auftrag,
// Verwerfen alter Auftraege bei Verbindungsabbruch.
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

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.reconnectDelay = 2000;
    this.state = { fanSpeed: null, tempLevel: null };
    this._pending = null; // {command, remaining, deadline}
    this._closed = false;
    this._lastFrameAt = Date.now();
    this._lastSendAt = 0;
    this._resendHandler = null; // genau EIN ausstehender Resend, nie mehrere

    this._connect();
    this._watchdog = setInterval(() => this._checkStale(), 5000);
  }

  _checkStale() {
    if (this._closed || !this.socket) return;
    if (Date.now() - this._lastFrameAt > this.staleMs) {
      this.log.warn(
        `[systemair] seit ${this.staleMs / 1000}s keine Daten mehr erhalten - ` +
        `Verbindung vermutlich still gestorben, erzwinge Neuverbindung`
      );
      this._lastFrameAt = Date.now(); // verhindert sofortiges erneutes Ansprechen
      this.socket.destroy(); // loest 'close' aus, das den Reconnect anstoesst
    }
  }

  _connect() {
    if (this._closed) return;

    // Alten Socket sauber abhaengen, damit keine verwaisten Handler eines
    // vorherigen Sockets weiterlaufen und Daten doppelt verarbeiten.
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
      // Auftraege der alten Verbindung verwerfen - sonst sendet die frische
      // Verbindung noch Reste des alten Bursts zusaetzlich zum neuen Kommando.
      this._pending = null;
      setTimeout(() => this._connect(), this.reconnectDelay);
    });
  }

  _onData(chunk) {
    this._lastFrameAt = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Notbremse: sollte der Puffer wider Erwarten anwachsen (Dauer-Muell auf
    // der Leitung, nie eine gueltige CRC), nicht unbegrenzt Speicher belegen.
    if (this.buffer.length > this.maxBufferBytes) {
      this.log.warn(
        `[systemair] Empfangspuffer ueber ${this.maxBufferBytes} Byte gewachsen - ` +
        `verwerfe aeltere Daten und synchronisiere neu`
      );
      this.buffer = this.buffer.subarray(this.buffer.length - proto.FRAME_LEN);
    }

    const { frames, rest } = proto.splitFrames(this.buffer);
    this.buffer = rest;

    for (const frame of frames) {
      const type = frame[2];

      if (type === 0x0a) {
        const st = proto.parseState(frame);
        if (st) {
          const changed = st.fanSpeed !== this.state.fanSpeed || st.tempLevel !== this.state.tempLevel;
          this.state = st;
          if (changed) this.emit('state', st);
        }
      }

      // Direkt nach einem 0x02-Frame der Regelung antwortet normalerweise
      // das Panel - das ist der Zeitpunkt, an dem wir ein anstehendes
      // Kommando einschieben.
      if (type === 0x02 && this._pending && this._pending.remaining > 0) {
        this._trySend();
      }
    }

    if (this._pending && Date.now() > this._pending.deadline) {
      this._pending = null;
    }
  }

  _trySend() {
    if (!this._pending || !this.socket || this.socket.destroyed) return;

    // Mindestabstand einhalten: nicht bei jedem 0x02 sofort feuern, sonst
    // stapeln sich die Schreibvorgaenge und der EW11 blaest sie in einem
    // Schwall auf den Halbduplex-Bus (Kollisionsrisiko mit dem echten Panel).
    const now = Date.now();
    if (now - this._lastSendAt < this.minSendIntervalMs) return;

    this.socket.write(this._pending.command);
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

  // Erzwingt eine sofortige Neuverbindung (z.B. wenn ein gesendetes Kommando
  // nachweislich nicht angekommen ist). Loest ueber den bestehenden
  // 'close'-Handler den normalen Reconnect-Ablauf aus.
  forceReconnect() {
    if (this._closed || !this.socket) return;
    this.log.warn('[systemair] erzwinge Neuverbindung');
    this._lastFrameAt = Date.now();
    this.socket.destroy();
  }

  // Baut die Verbindung neu auf und ruft sendFn() erst auf, sobald die neue
  // Verbindung steht. Es ist immer nur EIN solcher Auftrag registriert: ein
  // frueher registrierter, noch nicht ausgeloester Handler wird verworfen.
  // Ohne diese Absicherung sammeln sich bei fehlschlagenden Reconnects
  // mehrere 'connected'-Handler an, die beim naechsten erfolgreichen Verbinden
  // ALLE gleichzeitig feuern - aus einem Kommando wuerden mehrere Bursts.
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
