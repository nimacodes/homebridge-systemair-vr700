'use strict';

const net = require('net');
const EventEmitter = require('events');
const proto = require('./protocol');

// Keeps a persistent TCP connection to the EW11 (RS485<->WiFi adapter),
// reconnects automatically on drop, parses incoming state broadcasts and sends
// command frames at the right moment (right after a type-0x02 frame from the
// controller - the moment the real panel would answer).
//
// IMPORTANT - bus hygiene: the panel bus is RS485 HALF-DUPLEX. Everything we
// write shares the line with the real wall panel and the controller. Writing
// too much or at the wrong time makes the signals collide, produces garbage on
// the wire, and the controller can lose frame sync (observed: the unit then
// "blocks" communication until the EW11 is power-cycled). Hence several
// independent brakes here:
//
//   1. Slot timing     - we only send right after a 0x02.
//   2. Closed loop      - as soon as a broadcast confirms the target value, we
//                         stop sending immediately (no blind repeating until the
//                         window ends).
//   3. Min interval     - minSendIntervalMs between two writes.
//   4. Repeat cap       - at most sendRepeat attempts per command.
//   5. Per-minute budget- a hard cap on writes per minute, independent of
//                         everything else (guards against bugs).
//   6. Jam detection    - if only invalid bytes arrive for a while
//                         (collision/garbage), the plugin stops ALL sending for
//                         a recovery window (quiet mode) and reconnects once,
//                         instead of writing against a disturbed bus.
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
    this._lastFrameAt = now;      // last time ANY bytes arrived
    this._lastValidFrameAt = now; // last time a VALID frame arrived
    this._lastSendAt = 0;
    this._sendTimes = [];         // timestamps of recent writes (per-minute budget)
    this._quietUntil = 0;         // do not send until this time (bus jam recovery)

    // Reconnect brake: the more staleMs-driven reconnects happen in a row
    // without seeing a valid frame in between, the longer the pause before the
    // next forced reconnect (exponential backoff, capped at 60s). Reset to 0 as
    // soon as a valid frame arrives again.
    this._consecutiveStaleReconnects = 0;

    // Stats since the last successful connect - helps tell "no bytes arrive"
    // (electrical/cabling problem) from "bytes arrive but never a valid frame"
    // (noise/collision).
    this.stats = { bytesReceived: 0, validFrames: 0, skippedBytes: 0 };

    this._connect();
    this._watchdog = setInterval(() => this._tick(), 5000);
  }

  _emitRaw(direction, data) {
    if (!this.debug) return;
    this.emit('raw', { direction, hex: Buffer.from(data).toString('hex'), length: data.length, ts: Date.now() });
  }

  // Runs every 5s: first checks for a silently dead link (no bytes at all), then
  // for a bus jam (bytes arrive, but only garbage).
  _tick() {
    if (this._closed || !this.socket) return;
    const now = Date.now();

    // (a) Link dead: no bytes at all for staleMs (with backoff).
    if (now - this._lastFrameAt > this._currentStaleThreshold()) {
      this._consecutiveStaleReconnects += 1;
      const backoffS = Math.min(60, this.staleMs / 1000 * Math.pow(2, this._consecutiveStaleReconnects - 1));
      this.log.warn(
        `[systemair] no data for ${(this.staleMs / 1000).toFixed(0)}s - connection likely died ` +
        `silently, forcing reconnect (attempt ${this._consecutiveStaleReconnects} in a row, ` +
        `next check no sooner than ~${backoffS.toFixed(0)}s)`
      );
      this._lastFrameAt = now;
      this.socket.destroy();
      return;
    }

    // (b) Bus jam: bytes still arrive (link alive) but no VALID frame for jamMs
    // - typical for collisions/garbage on the half-duplex bus. Sending more only
    // makes it worse. So: stop all sending for busRecoveryMs and reconnect once
    // (resets the EW11's serial buffer) so the bus can settle.
    if (now - this._lastValidFrameAt > this.jamMs && now - this._lastFrameAt < this.jamMs) {
      this._enterQuietMode('bus is delivering only invalid data (likely collisions/jam)');
      this._lastValidFrameAt = now; // don't re-trigger on every tick
      this._lastFrameAt = now;
      this.socket.destroy();
    }
  }

  _enterQuietMode(reason) {
    const secs = (this.busRecoveryMs / 1000).toFixed(0);
    this._quietUntil = Date.now() + this.busRecoveryMs;
    if (this._pending) {
      this.log.warn('[systemair] dropping the in-flight send job due to bus jam');
      this._pending = null;
    }
    this.log.error(
      `[systemair] ${reason} - stopping ALL sending for ~${secs}s (quiet mode) and reconnecting ` +
      `so the bus can settle. If this persists, only a power-cycle of the EW11 helps.`
    );
    this.emit('busJam', { until: this._quietUntil, reason });
  }

  // Backoff threshold: staleMs multiplied by 2^(consecutive failed reconnects),
  // capped at 60s. So we don't hammer every 15s against a problem that clearly
  // isn't fixed by reconnecting (e.g. an electrical bus fault).
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
      this.log.info(`[systemair] connected to ${this.host}:${this.port}`);
      const now = Date.now();
      this._lastFrameAt = now;
      this._lastValidFrameAt = now;
      this.emit('connected');
    });
    this.socket = socket;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      this.log.warn(`[systemair] connection error: ${err.message}`);
    });
    socket.on('close', () => {
      if (this._closed) return;
      if (this.socket !== socket) return; // stale socket, ignore
      this.log.warn(`[systemair] connection dropped, retrying in ${this.reconnectDelay / 1000}s`);
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
        `[systemair] receive buffer grew past ${this.maxBufferBytes} bytes - ` +
        `dropping older data and resyncing`
      );
      this.buffer = this.buffer.subarray(this.buffer.length - proto.FRAME_LEN);
    }

    const { frames, rest, skipped } = proto.splitFrames(this.buffer);
    this.buffer = rest;
    this.stats.skippedBytes += skipped;

    if (frames.length > 0) {
      this._lastValidFrameAt = Date.now();
      this._consecutiveStaleReconnects = 0; // bus delivers valid frames again
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
          // Closed loop: as soon as the confirmed state matches the running
          // job's target, stop sending immediately.
          if (this._pending && typeof this._pending.target === 'function' && this._pending.target(st)) {
            this._pending = null;
          }
        }
      } else if (type === proto.FRAME_TYPE.COMMAND) {
        // A command frame from the real wall panel (or from us). Relevant for
        // learn mode, which derives the unit's own frames from these.
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

  // Checks the per-minute budget (a hard cap on writes per rolling minute).
  // Prevents any bug anywhere in the plugin from ever flooding the bus.
  _budgetAllows() {
    const cutoff = Date.now() - 60000;
    this._sendTimes = this._sendTimes.filter((t) => t > cutoff);
    return this._sendTimes.length < this.maxSendsPerMinute;
  }

  _trySend() {
    if (!this._pending || !this.socket || this.socket.destroyed) return;

    const now = Date.now();
    if (now < this._quietUntil) return;                         // bus recovery in progress
    if (now - this._lastSendAt < this.minSendIntervalMs) return; // min interval
    if (!this._budgetAllows()) {
      this.log.warn(
        `[systemair] send budget (${this.maxSendsPerMinute}/min) reached - waiting so the ` +
        `bus is not overloaded`
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

  // Starts sending a command frame. It is sent into the gap after each 0x02 from
  // the controller (like a real panel would), until ONE of these happens: a
  // broadcast confirms the target value (target), sendRepeat is reached, or the
  // time window elapses. An already-running job is replaced, not added to - only
  // ONE command is ever in flight.
  //
  // target: optional function (state) => bool. When it returns true (the
  // reported state matches the goal), sending stops immediately.
  sendCommand(command, target = null) {
    if (Date.now() < this._quietUntil) {
      this.log.warn('[systemair] quiet mode active (bus recovery) - command is not being sent right now');
    }
    this._pending = {
      command,
      remaining: this.sendRepeat,
      deadline: Date.now() + this.sendWindowMs,
      target: typeof target === 'function' ? target : null,
    };
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
    this._pending = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

module.exports = SystemairConnection;
