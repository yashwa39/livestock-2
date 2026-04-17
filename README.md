# Smart Animal Shed Monitoring Dashboard (Demo UI)

Premium, presentation-ready dashboard UI for a **Smart Livestock Shed Monitoring System**.

Includes:
- **Environmental monitoring**: Temperature (DHT11-style), humidity, gas/air-quality (MQ-style)
- **Shed health scoring**: comfort score ring + shed health %
- **RFID animal tracking**: scan input, history, animal profile cards, live zone map
- **Alerts & notifications**: animated warning cards
- **Analytics**: elegant animated charts + activity heatmap
- **Camera section**: live feed placeholder + snapshots + activity timeline

## Run

Open `index.html` directly in a browser.

If you want a local server (recommended for development), run:

```bash
python3 -m http.server 5173
```

Then open `http://localhost:5173`.

## Data source (ThingSpeak only)

This dashboard uses **ThingSpeak ONLY** (no fake/demo sensor data).

### Configure

Open the site and click **ThingSpeak Settings** in the top-right.

You need:
- **Channel ID**
- **Read API Key** (optional if your channel is public)

### Field mapping

The default mapping is in `script.js` under `DEFAULT_TS.fields`:
- `field1`: temperature (°C)
- `field2`: humidity (%)
- `field3`: gas (ppm)
- `field4`: RFID tag

Optional (if you add extra fields later):
- airflow (%)
- RFID zone/location
- occupancy (%)
- RFID scans today (count)

If your channel uses different fields, update that mapping.

