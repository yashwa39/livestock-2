# Smart Animal Shed Monitoring Dashboard (Demo UI)

Premium, presentation-ready dashboard UI for a **Smart Livestock Shed Monitoring System**.

Includes:
- **Environmental monitoring**: Temperature (DHT11-style), humidity, gas/air-quality (MQ-style)
- **Shed health scoring**: comfort score ring + shed health %
- **RFID animal tracking**: scan input, history, animal profile cards, live zone map
- **Alerts & notifications**: animated warning cards
- **Analytics**: elegant animated charts + activity heatmap
- **Camera section**: live feed + snapshots + activity timeline

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

## Camera stream setup

The dashboard camera panel now supports:
- live stream URL
- capture photo to local gallery
- persistent snapshots via browser localStorage
- configurable camera URL from the **Camera URL** button

### Important for GitHub Pages / HTTPS

If your dashboard is on `https://` and camera is `http://10.x.x.x`, browsers block it (mixed content).

Use an HTTPS proxy URL in **Camera URL** settings.

### Optional local proxy (Node.js)

Use `camera-proxy-server.js` to proxy your camera stream:

```bash
CAMERA_URL="http://10.144.9.139" node camera-proxy-server.js
```

Proxy endpoints:
- `http://localhost:8787/camera-proxy`
- `http://localhost:8787/health`

Then set **Camera URL** in dashboard to your proxy URL (for example `http://localhost:8787/camera-proxy` for local testing, or your deployed HTTPS proxy URL for production).

