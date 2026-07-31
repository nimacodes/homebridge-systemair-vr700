# homebridge-systemair-vr700

Homebridge-Plugin für eine Systemair/Villavent **VR-700** (DCV-Reihe) Wohnraumlüftung,
gesteuert über das reverse-engineerte CD-Panel-Protokoll – **kein Modbus**.

Angebunden wird ein RS485↔WLAN-Adapter (z. B. **Elfin EW11/EW11A**), der direkt an den
Bedienteil-Klemmen (12V / GND / Hi / Lo) der Lüftungs-Wanddose angeschlossen ist – er
ersetzt faktisch ein defektes oder fehlendes Wandbedienteil.

> **Status:** funktioniert im Alltag zuverlässig für Lüftergeschwindigkeit (4 Stufen) und
> Temperaturstufe (6 Stufen), jeweils einzeln bedient. Siehe [Sicherheitshinweis](#sicherheitshinweis-wichtig)
> unten, bevor du am Protokoll-Code herumbastelst.

## Voraussetzungen: EW11-Konfiguration

Im Webinterface des EW11 (Standard-IP `10.10.100.254` im Auslieferungszustand):

- **Serial Port Settings**: Baud Rate `57600`, Data Bit `8`, Stop Bit `1`, Parity `None`,
  **Protocol: `None`** (transparent – **nicht** „Modbus", das Gerät spricht kein Modbus)
- **Communication Settings**: Protocol `TCP Server`, Local Port `502`, Route `Uart`
- WLAN im STA-Modus mit deinem Heimnetz verbinden
- **Feste IP dringend empfohlen** (DHCP-Reservierung im Router) – eine wandernde IP ist die
  häufigste Ursache für „Plugin verbindet sich nicht mehr"

## Installation

Über npm (sobald veröffentlicht):

```bash
npm install -g homebridge-systemair-vr700
```

Oder lokal aus dem Quellcode, z. B. auf einem Raspberry-Pi-Setup mit dem offiziellen
Homebridge-Image (`hb-service`):

```bash
git clone https://github.com/<dein-github-user>/homebridge-systemair-vr700.git
sudo cp -r homebridge-systemair-vr700 /var/lib/homebridge/node_modules/homebridge-systemair-vr700
sudo chown -R homebridge:homebridge /var/lib/homebridge/node_modules/homebridge-systemair-vr700
sudo systemctl restart homebridge
```

> **Hinweis für hb-service-Installationen:** Installiere **nicht** per `npm install <lokaler-pfad>`
> aus einem Verzeichnis wie `/home/<user>/...` oder `/tmp/...` – das legt oft nur einen
> **Symlink** an. Zeigt der Symlink auf `/tmp/...`, verschwindet das Plugin beim nächsten
> Neustart (Linux leert `/tmp` bei jedem Reboot). Kopiere den Ordner stattdessen wie oben
> direkt und vollständig nach `/var/lib/homebridge/node_modules/`.

## Konfiguration

In der Homebridge `config.json` (oder über Config UI X, `config.schema.json` liegt bei):

```json
{
  "platforms": [
    {
      "platform": "SystemairVR700",
      "name": "Lüftung",
      "ip": "192.168.0.125",
      "port": 502
    }
  ]
}
```

Das Plugin legt automatisch zwei Zubehörteile an:

- **„\<Name> Geschwindigkeit"** – Fan-Zubehör, Drehzahl in 4 Stufen (Aus/Niedrig/Normal/Hoch,
  0/33/66/100 %)
- **„\<Name> Temperatur"** – Lightbulb-Zubehör (Helligkeits-Slider), bildet die 6-stufige
  Temperatureinstellung ab (0–100 % in 20-%-Schritten)

Ein Lightbulb wurde für die Temperaturstufe gewählt, weil HomeKit keinen generischen
6-stufigen Regler ohne Einheit kennt und ein Slider im Home-App-UI am nächsten an der
physischen Bedienung liegt.

## Funktionsweise (kurz)

Das Panel-Protokoll verwendet 280-Byte-Frames mit Header `55 AA` und einer CRC-8-Prüfsumme
(Polynom `0x8D`, kein Init, keine Reflektion). Die Regelung sendet periodisch
Zustands-Broadcasts (Frame-Typ `0x0a`); ein Panel-Kommando (Frame-Typ `0x01`) wird direkt im
Anschluss an ein `0x02`-Frame der Regelung gesendet. Das Plugin liest die Broadcasts zur
Zustandsanzeige und sendet beim Setzen eines Werts ein zuvor real aufgezeichnetes, gültiges
Kommandoframe für die Zielstufe (`lib/protocol.js`).

Nach dem Senden prüft das Plugin nach 5 Sekunden, ob der gemeldete Ist-Wert dem gesendeten
Soll-Wert entspricht. Bei Abweichung wird **einmal** automatisch die Verbindung neu
aufgebaut und das Kommando erneut gesendet, bevor endgültig ein Fehler geloggt wird
(`lib/platform.js`, `_verifyLater`). Ein Generationszähler pro Regler verhindert dabei, dass
schnelles Ziehen eines Reglers in der Home-App (mehrere Befehle binnen Millisekunden) zu
widersprüchlichen, sich gegenseitig überholenden Prüfungen führt.

## Debug-Modus

Für gezieltes Debugging (z. B. "warum kommt gerade nichts an") kann in der Config
`"debug": true` gesetzt werden. Danach loggt das Plugin **jedes** empfangene und
gesendete Byte im Klartext (Hex) sowie nach jedem Datenpaket eine Statistik, wann keine
gültigen Frames darin gefunden wurden - das unterscheidet sauber zwei ganz verschiedene
Störungsbilder:

- **Gar keine Bytes kommen an** → elektrisches/Verkabelungsproblem, WLAN-Problem, oder der
  EW11 selbst reagiert nicht.
- **Bytes kommen an, aber 0 gültige Frames** → Datenmüll/Kollisionen auf dem Bus, oder ein
  unbekannter Frame-Typ, der von unserem Parser (noch) nicht erkannt wird.

```json
{
  "platform": "SystemairVR700",
  "ip": "192.168.0.125",
  "debug": true
}
```

**Wichtig:** Debug-Modus erzeugt sehr viele Log-Zeilen - nach dem Debuggen wieder auf
`false` stellen (oder das Feld entfernen).

## Manuelle Debug-Frames

Für Reverse-Engineering-Zwecke kann man in der Config unter `manualFrames` eigene
Hex-Frames hinterlegen. Für jeden Eintrag legt das Plugin einen HomeKit-Schalter an, der
beim Einschalten das Frame **einmalig und ungeprüft** sendet (kein `sendRepeat`, keine
Wiederholung) und sich danach selbst wieder ausschaltet:

```json
{
  "platform": "SystemairVR700",
  "ip": "192.168.0.125",
  "manualFrames": [
    { "name": "Test A", "hex": "55aa...", "fixCrc": false },
    { "name": "Test B (CRC automatisch)", "hex": "55aa...", "fixCrc": true }
  ]
}
```

> **Sicherheitshinweis:** Diese Funktion sendet exakt das eingegebene Frame ohne
> inhaltliche Prüfung. Ein früherer Versuch, selbst zusammengesetzte Frames zu senden
> (`commandForState`, siehe unten), hat auf der echten Anlage zu einem Einfrieren der
> Panel-Bus-Kommunikation geführt. `manualFrames` bewusst nur eintragen, wenn du genau
> weißt, was du testest, und idealerweise nicht auf einer Anlage, deren Neustart schwer
> erreichbar ist.

## Sicherheitshinweis (wichtig!)

`lib/protocol.js` enthält eine Funktion `commandForState(fanLevel, tempLevel)`, die versucht,
Lüfterstufe und Temperaturstufe **in einem gemeinsamen, dynamisch zusammengesetzten Frame**
zu setzen (statt zweier unabhängiger, exakt aufgezeichneter Templates). Der Einsatz dieser
Funktion hat in der Praxis dazu geführt, dass die Regelung der Lüftungsanlage die
Kommunikation über den Panel-Bus komplett eingefroren hat – weder das physische Wandpanel
noch das Plugin konnten die Anlage danach noch steuern (die Grundfunktion/Lüftung selbst lief
unbeeinträchtigt weiter). Ein Stromreset der Lüftungseinheit war nötig, um das zu beheben.

**`commandForState()` wird im aktuellen Code nirgends aufgerufen** und ist im Quelltext
deutlich als „nicht verwenden" markiert. Der Grund für das Einfrieren ist nicht abschließend
geklärt (vermutlich verletzt das Mischen zweier verschiedener Frame-Snapshots eine interne,
nie entschlüsselte Konsistenzprüfung der Regelungsfirmware). Nur `commandForFanSpeed()` und
`commandForTempLevel()` – unveränderte, exakt aufgezeichnete Kommandoframes – gelten als
sicher getestet.

**Wenn du das Protokoll erweiterst:** Sende ausschließlich Frames, die entweder unverändert
aus einem echten Mitschnitt stammen, oder deren Auswirkung auf alle 280 Byte vollständig
verstanden ist – nicht nur auf die paar Bytes, die dich gerade interessieren. Teste
Änderungen erst mit einem physisch leicht erreichbaren Gerät, falls möglich.

## Bekannte Einschränkungen

- Kein echtes, dynamisches Schreiben beliebiger Feldkombinationen (siehe oben) – nur die vier
  Lüfterstufen und sechs Temperaturstufen als vorab aufgezeichnete Zielwerte.
- Setzt man Lüftergeschwindigkeit und Temperatur kurz hintereinander, kann kurzzeitig der
  jeweils andere Wert auf seinen zuletzt aufgezeichneten Stand zurückspringen, bis der
  automatische Verify/Retry-Mechanismus ihn korrigiert (ein paar Sekunden Verzögerung, kein
  Datenverlust).
- Der EW11 hat in Tests auf aktivierte TCP-Keepalive-Probes mit periodischen `ECONNRESET`
  reagiert – das Plugin nutzt deshalb bewusst **kein** TCP-Keepalive, sondern einen eigenen,
  datenbasierten Watchdog (Neuverbindung, wenn 15 Sekunden lang keine Broadcasts ankommen,
  mit exponentiell wachsender Pause bei wiederholten erfolglosen Reconnects, gedeckelt auf
  60s - verhindert, dass wiederholtes Auf-/Abbauen der Verbindung selbst zur Buslast wird).
- **Beobachtet, noch nicht abschließend geklärt:** Wenn das Lüftungsgerät wegen Übertemperatur
  einen Sensorfehler meldet (an sich normales Verhalten), verschwindet die Anzeige auf dem
  physischen Wandpanel, sobald der EW11 am Bus angeschlossen ist - und der EW11 selbst scheint
  dann auch keine Daten mehr zu empfangen. Trennt man den EW11 wieder ab, funktioniert das
  Panel normal. Das deutet eher auf eine elektrische Wechselwirkung (Busbelastung/Terminierung
  des EW11, evtl. verschärft durch reduzierte Störfestigkeit der Regelung im Fehlerzustand) als
  auf einen reinen Software-Bug - der `debug`-Modus (siehe oben) hilft, das im Detail zu
  beobachten (kommen überhaupt Bytes an, wenn ja wie viele gültige Frames).
- Ungetestet: Verhalten über sehr lange Laufzeiten (Wochen/Monate) sowie Verhalten, wenn ein
  zweites physisches Bedienteil gleichzeitig aktiv bedient wird.

## Mitwirken

Issues und Pull Requests willkommen – besonders zur Frage, welche der bislang unbekannten
Frame-Felder tatsächlich sicherheitsrelevant sind (siehe Sicherheitshinweis oben). Bitte bei
PRs, die neue Kommandoframes einführen oder bestehende verändern, kurz beschreiben, wie/wo
getestet wurde.

## Lizenz

MIT, siehe [LICENSE](./LICENSE).
