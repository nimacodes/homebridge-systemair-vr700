# homebridge-systemair-vr700

Homebridge plugin for a Systemair/Villavent **VR-700** (DCV series) residential
ventilation unit, controlled via the reverse-engineered CD panel protocol –
**not Modbus**.

It connects through an RS485↔WiFi adapter (e.g. **Elfin EW11/EW11A**) wired
directly to the wall-panel terminals (12V / GND / Hi / Lo) of the ventilation
wall box – effectively replacing a defective or missing wall controller.

> **Status:** works reliably in day-to-day use for fan speed (4 levels) and
> temperature level (6 levels), each operated individually. See the
> [safety note](#safety-note-important) below before you tinker with the
> protocol code.
>
> **Since 0.5.0:** a [learn mode](#learn-mode-recommended) that records the
> correct control frames directly from your own unit (instead of using the
> bundled frames), much lower bus load via a closed control loop, automatic
> bus-jam detection with a recovery pause – and the deliberately removed manual
> frame injection.

## Prerequisite: EW11 configuration

In the EW11 web interface (default IP `10.10.100.254` as shipped):

- **Serial Port Settings**: Baud Rate `57600`, Data Bit `8`, Stop Bit `1`,
  Parity `None`, **Protocol: `None`** (transparent – **not** "Modbus", the unit
  does not speak Modbus on this bus)
- **Communication Settings**: Protocol `TCP Server`, Local Port `502`, Route
  `Uart`
- Connect WiFi in STA mode to your home network
- **A static IP is strongly recommended** (DHCP reservation in the router) – a
  wandering IP is the most common cause of "the plugin no longer connects"

## Installation

Via npm:

```bash
npm install -g homebridge-systemair-vr700
```

Or locally from source, e.g. on a Raspberry Pi setup with the official
Homebridge image (`hb-service`):

```bash
git clone https://github.com/nimacodes/homebridge-systemair-vr700.git
sudo cp -r homebridge-systemair-vr700 /var/lib/homebridge/node_modules/homebridge-systemair-vr700
sudo chown -R homebridge:homebridge /var/lib/homebridge/node_modules/homebridge-systemair-vr700
sudo systemctl restart homebridge
```

> **Note for hb-service installations:** do **not** install via
> `npm install <local-path>` from a directory like `/home/<user>/...` or
> `/tmp/...` – that often only creates a **symlink**. If the symlink points to
> `/tmp/...`, the plugin disappears on the next reboot (Linux clears `/tmp` on
> every reboot). Copy the folder directly and completely into
> `/var/lib/homebridge/node_modules/` as shown above instead.

## Configuration

In the Homebridge `config.json` (or via Config UI X, `config.schema.json` is
included):

```json
{
  "platforms": [
    {
      "platform": "SystemairVR700",
      "name": "Ventilation",
      "ip": "192.168.0.125",
      "port": 502
    }
  ]
}
```

The plugin automatically creates two accessories:

- **"\<Name> Speed"** – fan accessory, speed in 4 levels (off/low/normal/high,
  0/33/66/100 %)
- **"\<Name> Temperature"** – lightbulb accessory (brightness slider), maps the
  6-level temperature setting (0–100 % in 20 % steps)

A lightbulb was chosen for the temperature level because HomeKit has no generic
6-step control without a unit, and a slider in the Home app UI is the closest
match to the physical dial.

Optionally, [learn mode](#learn-mode-recommended) can be enabled with
`"learn": true` – strongly recommended if setting values isn't reliable for you
(see below).

## How it works (in brief)

The panel protocol uses 280-byte frames with header `55 AA` and a CRC-8 checksum
(polynomial `0x8D`, no init, no reflection). The controller periodically sends
state broadcasts (frame type `0x0a`); a panel command (frame type `0x01`) is
sent right after a `0x02` frame from the controller (the panel's "send slot").
The plugin reads the broadcasts for status display and, when setting a value,
sends a valid, **exactly recorded** command frame for the target level –
preferring one recorded from your own unit via learn mode, otherwise the bundled
template (`lib/protocol.js`).

**Closed loop instead of blind repeating (bus load!):** a command is only sent
in the slot after a `0x02` and is **stopped immediately as soon as the next
broadcast confirms the target value**. In the normal case a single write
suffices instead of the former six. Several hard brakes also apply
(`lib/connection.js`):

- **Minimum interval** between two writes (500 ms),
- **Repeat cap** per command (max. 3 attempts),
- **Per-minute budget** as an absolute ceiling (max. 40 writes/minute, no matter
  what else happens – a safety net against any conceivable bug),
- **Bus-jam detection** (see below).

After sending, the plugin additionally checks after 5 seconds whether the
reported value matches the target. If it doesn't, it simply **resends the exact
frame once more** (no reconnect, no disconnect – the closed-loop send already
retried within its window, so there is nothing a reconnect would fix) and then
stops quietly; the unit's next state broadcast keeps HomeKit in sync. A
generation counter per control prevents fast slider dragging in the Home app
from producing conflicting, mutually overtaking checks.

### Bus-jam detection (against the "freeze")

It has been observed that the unit sometimes blocks communication – only garbage
arrives, and only a **power-cycle of the EW11** helps. Two automatics in the
watchdog counter this:

- **Link dead** (no bytes at all for 15 s): forced reconnect with an
  exponentially growing pause (capped at 60 s), so that repeated
  connecting/disconnecting doesn't itself become bus load.
- **Bus jam** (bytes do arrive, but **not a single valid frame** for ~12 s):
  typical for collisions/garbage on the half-duplex bus. The plugin then **stops
  all sending for ~30 s** (quiet mode) and reconnects once so the bus can settle
  – instead of writing against it. This is the software equivalent of "briefly
  taking your hands off the bus". If it doesn't help long-term, only the physical
  EW11 power-cycle remains.

## Debug mode

For targeted debugging (e.g. "why is nothing coming through right now") you can
set `"debug": true` in the config. The plugin then logs **every** received and
sent byte in plain hex, plus a statistic after each data chunk noting when no
valid frames were found in it - this cleanly distinguishes two very different
failure modes:

- **No bytes arrive at all** → electrical/cabling problem, WiFi problem, or the
  EW11 itself isn't responding.
- **Bytes arrive, but 0 valid frames** → garbage/collisions on the bus, or an
  unknown frame type our parser doesn't (yet) recognize.

```json
{
  "platform": "SystemairVR700",
  "ip": "192.168.0.125",
  "debug": true
}
```

**Important:** debug mode produces a lot of log lines - set it back to `false`
(or remove the field) after debugging.

## Learn mode (recommended)

**For context:** the bundled command frames are **real frames recorded via
reverse engineering** – the closest thing to the actual panel communication
there is, and the trusted default basis of this plugin. They remain the default;
learn mode is **optional** and changes nothing unless you run it.

Still, such a frame is a complete 280-byte snapshot of which only a few bytes are
decoded. Because of this, setting a value can occasionally fail to take
immediately – e.g. because a frame always carries *both* values (fan and
temperature) and two quickly successive commands overwrite each other, or
because embedded counter/timestamp bytes in the snapshot are stale. Learn mode
helps here by recording **fresh frames directly from your running unit** – useful
to refresh the templates, fill in missing levels, or measure a different/new
device. It's not a "replacement for wrong" frames, but a way to keep the set
current from the same real source.

**How it works:** with `"learn": true` the plugin enters a **purely passive**
capture mode. It **sends nothing** to the unit (so it's completely harmless to
the bus) and only listens: you step through all levels on the **original wall
panel**, one by one, and the plugin maps each stable state to the corresponding
real panel command frame and stores it as an exact, unmodified template.

```json
{
  "platform": "SystemairVR700",
  "ip": "192.168.0.125",
  "learn": true
}
```

Procedure:

1. Set `"learn": true`, restart Homebridge. A learn banner appears in the log.
2. Step through, one by one, on the **original wall panel**:
   - Fan: **off → low → normal → high**
   - Temperature: **all 6 levels**
   - stay on each level for ~5 seconds.
3. After each captured level the log shows progress (`fan 3/4, temperature 5/6`)
   and which levels are still missing. Once all are captured it says so
   explicitly.
4. Set `"learn": false` (or remove the field), restart Homebridge. From now on
   the plugin **prefers** the learned frames of your unit; for levels not yet
   learned it falls back to the bundled templates.

The learned frames are stored per unit (by IP) persistently in the Homebridge
storage (`systemair-vr700-learned-<ip>.json`) and survive restarts and plugin
updates.

> **Requirement:** learning needs an **original wall panel that stays connected
> in parallel on the bus** – only that produces the command frames (type `0x01`)
> to learn from. If the EW11 replaces a *missing* panel, there is no such source;
> the plugin then says so clearly in the log and keeps using the default frames.

## Safety note (important!)

**Only exact, unmodified command frames** are ever sent – either the bundled
templates or the ones recorded via learn mode. A **dynamically assembled frame**
is **never** produced.

Earlier versions contained a function `commandForState(fanLevel, tempLevel)` that
assembled a frame from a temperature template with overwritten fan bytes (a
"Frankenstein" frame). Using it brought the real unit's **controller to a
freeze/reset** – a power-cycle was required. That function and the earlier manual
frame injection (`manualFrames`) were **removed entirely** so the footgun isn't
even reachable.

**If you extend the protocol:** send only frames that are either unchanged from a
real capture (see learn mode) or whose effect on all 280 bytes is fully
understood – not just the few bytes you currently care about. **Never change
individual bytes** of a frame while all 280 are not understood.

## Alternative: Modbus

The VR-700 DCV can also speak **Modbus RTU** (RS-485) on a separate connector –
which most other integrations build on (e.g.
[BeamCtrl/Airiana](https://github.com/BeamCtrl/Airiana), various Home Assistant
projects). That is considerably more robust than replaying panel frames, **but
requires the Modbus terminals**, not the wall-panel terminals. This plugin
deliberately takes the panel-protocol route (it sits on the panel bus and
replaces/supplements the wall panel). If you can reach the Modbus terminals and
want full sensors/control, a Modbus solution may serve you better.

## Known limitations

- No true dynamic writing of arbitrary field combinations (see above) – only the
  four fan levels and six temperature levels as exactly recorded target values
  (bundled or [learned](#learn-mode-recommended)).
- If you set fan speed and temperature in quick succession, the respective other
  value can briefly jump back to its last recorded state until the verify/resend
  reconciles it (a few seconds' delay, no data loss). Learn mode reduces this,
  because both values then come from the same real recorded panel reality.
- The EW11 responded to enabled TCP keepalive probes with periodic `ECONNRESET`
  in testing – the plugin therefore deliberately uses **no** TCP keepalive, but
  its own data-based watchdog (reconnect when no broadcasts arrive for 15
  seconds, with an exponentially growing pause on repeated failed reconnects,
  capped at 60 s - prevents repeated connecting/disconnecting from becoming bus
  load itself).
- **Observed, not fully explained:** when the ventilation unit reports a sensor
  fault due to overtemperature (normal behavior in itself), the display on the
  physical wall panel disappears once the EW11 is connected to the bus - and the
  EW11 itself then also seems to receive no more data. Disconnecting the EW11
  again, the panel works normally. This points more to an electrical interaction
  (bus loading/termination of the EW11, possibly aggravated by reduced noise
  immunity of the controller in the fault state) than to a pure software bug -
  `debug` mode (see above) helps observe this in detail (do any bytes arrive, and
  if so how many valid frames).
- Untested: behavior over very long runtimes (weeks/months), and behavior when a
  second physical wall controller is actively operated at the same time.

## Contributing

Issues and pull requests welcome – especially on the question of which of the
still-unknown frame fields are actually safety-relevant (see the safety note
above). For PRs that introduce new command frames or change existing ones, please
briefly describe how/where they were tested.

## License

MIT, see [LICENSE](./LICENSE).
