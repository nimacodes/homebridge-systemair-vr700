# homebridge-systemair-vr700

Homebridge-Plugin für eine Systemair/Villavent **VR-700** (DCV-Reihe) Wohnraumlüftung,
gesteuert über das reverse-engineerte CD-Panel-Protokoll – **kein Modbus**.

Angebunden wird ein RS485↔WLAN-Adapter (z. B. **Elfin EW11/EW11A**), der direkt an den
Bedienteil-Klemmen (12V / GND / Hi / Lo) der Lüftungs-Wanddose angeschlossen ist – er
ersetzt faktisch ein defektes oder fehlendes Wandbedienteil.

> **Status:** funktioniert im Alltag zuverlässig für Lüftergeschwindigkeit (4 Stufen) und
> Temperaturstufe (6 Stufen), jeweils einzeln bedient. Siehe [Sicherheitshinweis](#sicherheitshinweis-wichtig)
> unten, bevor du am Protokoll-Code herumbastelst.
>
> **Neu ab 0.5.0:** ein [Lernmodus](#lernmodus-empfohlen), der die korrekten Steuer-Frames
> direkt von deiner eigenen Anlage aufzeichnet (statt die mitgelieferten Frames zu verwenden),
> deutlich reduzierte Buslast durch geschlossenen Regelkreis, eine automatische
> Bus-Stau-Erkennung mit Beruhigungsphase – und der bewusst entfernte manuelle Frame-Versand.

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

Optional lässt sich der [Lernmodus](#lernmodus-empfohlen) mit `"learn": true` aktivieren –
dringend empfohlen, wenn Setzen bei dir nicht zuverlässig funktioniert (siehe unten).

## Funktionsweise (kurz)

Das Panel-Protokoll verwendet 280-Byte-Frames mit Header `55 AA` und einer CRC-8-Prüfsumme
(Polynom `0x8D`, kein Init, keine Reflektion). Die Regelung sendet periodisch
Zustands-Broadcasts (Frame-Typ `0x0a`); ein Panel-Kommando (Frame-Typ `0x01`) wird direkt im
Anschluss an ein `0x02`-Frame der Regelung gesendet (der „Sende-Slot" des Panels). Das Plugin
liest die Broadcasts zur Zustandsanzeige und sendet beim Setzen eines Werts ein gültiges,
**exakt aufgezeichnetes** Kommandoframe für die Zielstufe – bevorzugt eines, das per Lernmodus
von der eigenen Anlage stammt, sonst die mitgelieferte Vorlage (`lib/protocol.js`).

**Geschlossener Regelkreis statt blindem Wiederholen (Buslast!):** Ein Kommando wird immer nur
im Slot nach einem `0x02` gesendet und **sofort gestoppt, sobald der nächste Broadcast den
Zielwert bestätigt**. Im Normalfall genügt so ein einziger Schreibvorgang statt der früheren
sechs. Zusätzlich greifen mehrere harte Bremsen (`lib/connection.js`):

- **Mindestabstand** zwischen zwei Schreibvorgängen (500 ms),
- **Wiederhol-Deckel** pro Auftrag (max. 3 Versuche),
- **Minuten-Budget** als absolute Obergrenze (max. 40 Schreibvorgänge/Minute, egal was sonst
  passiert – ein Sicherheitsnetz gegen jeden denkbaren Bug),
- **Bus-Stau-Erkennung** (siehe unten).

Nach dem Senden prüft das Plugin nach 5 Sekunden zusätzlich, ob der gemeldete Ist-Wert dem
Soll-Wert entspricht. Bei Abweichung wird **einmal** automatisch die Verbindung neu aufgebaut
und das Kommando erneut gesendet, bevor endgültig ein Fehler geloggt wird (`_verifyLater`). Ein
Generationszähler pro Regler verhindert dabei, dass schnelles Ziehen eines Reglers in der
Home-App zu widersprüchlichen, sich gegenseitig überholenden Prüfungen führt.

### Bus-Stau-Erkennung (gegen das „Einfrieren")

Beobachtet wurde, dass die Anlage die Kommunikation manchmal blockiert – es kommt nur noch
Datenmüll, und erst ein **Stromreset des EW11** hilft. Dagegen zwei Automatiken im Watchdog:

- **Link tot** (gar keine Bytes mehr für 15 s): erzwungene Neuverbindung mit exponentiell
  wachsender Pause (gedeckelt auf 60 s), damit wiederholtes Auf-/Abbauen nicht selbst zur
  Buslast wird.
- **Bus-Stau** (es kommen zwar Bytes, aber über ~12 s **kein einziges gültiges Frame**):
  typisch für Kollisionen/Müll auf dem Halbduplex-Bus. Das Plugin **stoppt dann für ~30 s
  jegliches Senden** (Quiet-Mode) und baut die Verbindung einmal neu auf, damit sich der Bus
  beruhigen kann – statt weiter dagegen zu schreiben. Das ist das Software-Äquivalent zum
  „kurz die Finger vom Bus nehmen". Hilft das dauerhaft nicht, bleibt nur der physische
  EW11-Stromreset.

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

## Lernmodus (empfohlen)

**Das Problem:** Die mitgelieferten Kommandoframes wurden auf *einer bestimmten* VR-700
aufgezeichnet. So ein Frame ist ein kompletter 280-Byte-Schnappschuss, von dem nur wenige
Bytes entschlüsselt sind. Weicht deine Anlage in einem der vielen unbekannten Felder ab, kann
das Setzen **manchmal nicht greifen** – genau das Symptom „Fan/Temperatur wird nicht immer
korrekt übernommen". Die zuverlässige Lösung ist, die Frames **direkt von deiner eigenen
Anlage** zu lernen.

**So funktioniert's:** Mit `"learn": true` geht das Plugin in einen **rein passiven**
Mitschnitt-Modus. Es **sendet dabei nichts** an die Anlage (für den Bus also völlig
ungefährlich), sondern hört nur mit: Du schaltest am **originalen Wandpanel** nacheinander
alle Stufen durch, das Plugin ordnet jeden stabilen Zustand dem zugehörigen echten
Panel-Kommandoframe zu und speichert dieses als exakte, unveränderte Vorlage.

```json
{
  "platform": "SystemairVR700",
  "ip": "192.168.0.125",
  "learn": true
}
```

Ablauf:

1. `"learn": true` setzen, Homebridge neu starten. Im Log erscheint ein Lern-Banner.
2. Am **originalen Wandpanel** nacheinander durchschalten:
   - Lüfter: **Aus → Niedrig → Normal → Hoch**
   - Temperatur: **alle 6 Stufen**
   - auf jeder Stufe ~5 Sekunden stehen bleiben.
3. Das Log zeigt nach jeder erfassten Stufe den Fortschritt (`Lüfter 3/4, Temperatur 5/6`) und
   welche Stufen noch fehlen. Sind alle erfasst, meldet es das ausdrücklich.
4. `"learn": false` setzen (oder das Feld entfernen), Homebridge neu starten. Ab jetzt nutzt
   das Plugin **bevorzugt** die gelernten Frames deiner Anlage; für noch nicht gelernte Stufen
   fällt es auf die mitgelieferten Vorlagen zurück.

Die gelernten Frames werden pro Anlage (nach IP) dauerhaft im Homebridge-Storage abgelegt
(`systemair-vr700-learned-<ip>.json`) und überstehen Neustarts und Plugin-Updates.

> **Voraussetzung:** Lernen braucht ein **originales Wandpanel, das parallel am Bus
> angeschlossen bleibt** – nur dieses erzeugt die Kommandoframes (Typ `0x01`), aus denen
> gelernt wird. Ersetzt der EW11 ein *fehlendes* Panel, gibt es keine solche Quelle; das
> Plugin sagt das dann klar im Log und nutzt weiter die Standard-Frames.

## Sicherheitshinweis (wichtig!)

Es werden **ausschließlich exakte, unveränderte Kommandoframes** gesendet – entweder die
mitgelieferten Vorlagen oder die per Lernmodus aufgezeichneten. Es wird **nie ein dynamisch
zusammengesetztes Frame** erzeugt.

Frühere Versionen enthielten eine Funktion `commandForState(fanLevel, tempLevel)`, die ein
Frame aus einem Temperatur-Template mit überschriebenen Lüfter-Bytes zusammensetzte
(„Frankenstein"-Frame). Ihr Einsatz hat auf der echten Anlage die **Regelung zum
Einfrieren/Reset** gebracht – ein Stromreset war nötig. Diese Funktion und der frühere manuelle
Frame-Versand (`manualFrames`) wurden **vollständig entfernt**, um diesen Footgun gar nicht
erst zugänglich zu machen.

**Wenn du das Protokoll erweiterst:** Sende ausschließlich Frames, die entweder unverändert
aus einem echten Mitschnitt stammen (siehe Lernmodus), oder deren Auswirkung auf alle 280 Byte
vollständig verstanden ist – nicht nur auf die paar Bytes, die dich gerade interessieren.
Ändere **niemals einzelne Bytes** eines Frames, solange nicht alle 280 verstanden sind.

## Alternative: Modbus

Die VR-700 DCV kann auf einem separaten Anschluss auch **Modbus RTU** (RS-485) sprechen –
darauf setzen die meisten anderen Integrationen auf (z. B.
[BeamCtrl/Airiana](https://github.com/BeamCtrl/Airiana), diverse Home-Assistant-Projekte). Das
ist deutlich robuster als das Nachspielen von Panel-Frames, **erfordert aber die
Modbus-Klemmen**, nicht die Bedienteil-Klemmen. Dieses Plugin geht bewusst den
Panel-Protokoll-Weg (es hängt am Bedienteil-Bus und ersetzt/ergänzt das Wandpanel). Wer die
Modbus-Klemmen erreichen kann und volle Sensorik/Steuerung will, ist mit einer Modbus-Lösung
womöglich besser bedient.

## Bekannte Einschränkungen

- Kein echtes, dynamisches Schreiben beliebiger Feldkombinationen (siehe oben) – nur die vier
  Lüfterstufen und sechs Temperaturstufen als exakt aufgezeichnete Zielwerte (mitgeliefert
  oder [gelernt](#lernmodus-empfohlen)).
- Setzt man Lüftergeschwindigkeit und Temperatur kurz hintereinander, kann kurzzeitig der
  jeweils andere Wert auf seinen zuletzt aufgezeichneten Stand zurückspringen, bis der
  automatische Verify/Retry-Mechanismus ihn korrigiert (ein paar Sekunden Verzögerung, kein
  Datenverlust). Der Lernmodus mindert das, weil beide Werte dann aus derselben, real
  aufgezeichneten Panel-Realität stammen.
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
