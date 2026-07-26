'use strict';

const net = require('net');
const EventEmitter = require('events');
const proto = require('./protocol');

// Haelt eine dauerhafte TCP-Verbindung zum EW11 (RS485<->WLAN-Adapter),
// verbindet bei Abbruch automatisch neu, parst eingehende Zustands-Broadcasts
// und sendet Kommandoframes zum richtigen Zeitpunkt (direkt nach einem
// Frame-Typ 0x02 der Regelung - das ist der Moment, in dem das echte Panel
// antwortet).
class SystemairConnection extends EventEmitter {
  constructor({ host, port = 502, log, sendWindowMs = 15000, sendRepeat = 10, staleMs = 15000 }) {
    super();
    this.host = host;
    this.port = port;
    this.log = log || console;
    this.sendWindowMs = sendWindowMs;
    this.sendRepeat = sendRepeat;
    this.staleMs = staleMs;

    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.reconnectDelay = 2000;
    this.state = { fanSpeed: null, tempLevel: null };
    this._pending = null; // {command, remaining, deadline}
    this._closed = false;
    this._lastFrameAt = Date.now();

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
    this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
      this.log.info(`[systemair] verbunden mit ${this.host}:${this.port}`);
      this._lastFrameAt = Date.now();
      this.emit('connected');
    });
    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('error', (err) => {
      this.log.warn(`[systemair] Verbindungsfehler: ${err.message}`);
    });
    this.socket.on('close', () => {
      if (this._closed) return;
      this.log.warn(`[systemair] Verbindung getrennt, neuer Versuch in ${this.reconnectDelay / 1000}s`);
      this.buffer = Buffer.alloc(0);
      setTimeout(() => this._connect(), this.reconnectDelay);
    });
  }

  _onData(chunk) {
    this._lastFrameAt = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
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
    this.socket.write(this._pending.command);
    this._pending.remaining -= 1;
    if (this._pending.remaining <= 0) this._pending = null;
  }

  // Stoesst das Senden eines Kommandoframes an. Es wird mehrfach in die
  // Luecke nach jedem 0x02-Frame der Regelung gesendet (wie ein echtes
  // Panel es auch mehrfach probiert), bis sendRepeat erreicht oder das
  // Zeitfenster abgelaufen ist.
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
  // Verbindung steht - fuer den Fall, dass ein Kommando ueber eine still tote
  // Verbindung verloren gegangen sein koennte.
  reconnectAndResend(sendFn, afterSentCb) {
    this.once('connected', () => {
      sendFn();
      if (afterSentCb) afterSentCb();
    });
    this.forceReconnect();
  }

  getState() {
    return this.state;
  }

  close() {
    this._closed = true;
    if (this._watchdog) clearInterval(this._watchdog);
    if (this.socket) this.socket.destroy();
  }
}

module.exports = SystemairConnection;
