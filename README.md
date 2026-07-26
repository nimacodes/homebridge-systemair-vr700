# homebridge-systemair-vr700

Homebridge-Plugin für eine Systemair/Villavent **VR-700** (DCV-Reihe) Wohnraumlüftung,
gesteuert über das reverse-engineerte CD-Panel-Protokoll – **kein Modbus**.

Angebunden wird ein RS485↔WLAN-Adapter (z. B. **Elfin EW11/EW11A**), der direkt an den
Bedienteil-Klemmen (12V / GND / Hi / Lo) der Lüftungs-Wanddose angeschlossen ist.

## Voraussetzungen: EW11-Konfiguration

Im Webinterface des EW11:

- **Serial Port Settings**: Baud Rate `57600`, Data Bit `8`, Stop Bit `1`, Parity `None`,
  **Protocol: `None`** (transparent – **nicht** „Modbus“, das Gerät spricht kein Modbus)
- **Communication Settings**: Protocol `TCP Server`, Local Port `502`, Route `Uart`
- Feste IP empfohlen (DHCP-Reservierung im Router)

## Installation

```bash
cd /var/lib/homebridge   # oder wo dein Homebridge-Node-Modules liegen
npm install /pfad/zu/homebridge-systemair-vr700
```

Oder das Verzeichnis direkt in `node_modules/homebridge-systemair-vr700` ablegen.

## Konfiguration

In der Homebridge `config.json` (oder über Config UI X, `config.schema.json` liegt bei):

```json
{
  "platforms": [
    {
      "platform": "SystemairVR700",
      "name": "Lüftung",
      "ip": "xxx.xxx.xxx.xxx",
      "port": 502
    }
  ]
}
```

Das Plugin legt automatisch zwei Zubehörteile an:

- **„Lüftung Geschwindigkeit“** – Fan-Zubehör, Drehzahl in 3 Stufen (Aus/Niedrig/Normal/Hoch,
  0/33/66/100 %)
- **„Lüftung Temperatur“** – Lightbulb-Zubehör (Helligkeits-Slider), bildet die 6-stufige
  Temperatureinstellung ab (0–100 % in 20-%-Schritten)

Ein Lightbulb wurde für die Temperaturstufe gewählt, weil HomeKit keinen generischen
6-stufigen Regler ohne Einheit kennt und ein Slider im Home-App-UI am nächsten an der
physischen Bedienung liegt. Wenn eine andere Darstellung (z. B. ebenfalls als Fan, oder ein
Dummy-Thermostat) gewünscht ist, lässt sich das in `lib/platform.js` anpassen.

## Funktionsweise (kurz)

Das Panel-Protokoll verwendet 280-Byte-Frames mit Header `55 AA` und einer CRC-8-Prüfsumme
(Polynom `0x8D`). Die Regelung sendet periodisch Zustands-Broadcasts (Frame-Typ `0x0a`); ein
Panel-Kommando (Frame-Typ `0x01`) wird direkt im Anschluss an ein `0x02`-Frame der Regelung
gesendet. Das Plugin liest die Broadcasts zur Zustandsanzeige und sendet beim Setzen eines
Werts ein zuvor aufgezeichnetes, gültiges Kommandoframe für die Zielstufe.

**Bekannte Einschränkung:** Die Kommandoframes sind aus echten Mitschnitten übernommene
Vorlagen (mit korrekter CRC), keine dynamisch aus dem aktuellen Zustand generierten Frames.
Das hat sich im Test als zuverlässig erwiesen, ist aber kein vollständig freies Schreiben
beliebiger Feldkombinationen.

## Status

Funktioniert im Test zuverlässig für alle 4 Geschwindigkeits- und alle 6 Temperaturstufen.
Ungetestet: Verhalten über sehr lange Laufzeiten, Verhalten bei parallelem Bedienen des
zweiten, physischen Bedienteils während ein Kommando gesendet wird.
