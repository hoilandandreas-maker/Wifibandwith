# WiFi Survey

A phone-friendly web app for surveying WiFi coverage on site — built for offshore
installations, but useful anywhere. It measures **bandwidth, latency and jitter**, logs
**signal strength and position** with every measurement, and plots the results on a
**deck/site plan** or a **GPS scatter map**. Everything runs locally in the browser and is
stored on the device; nothing is uploaded anywhere.

It is a plain static site (no build step) designed to be hosted on **GitHub Pages** and
installed to the phone's home screen as a PWA, so it keeps working offline.

## Features

- **Speed test** — download, upload, ping and jitter against Cloudflare's speed-test
  endpoints (default) or a custom/local server, with live readout and adaptive test sizes.
- **Signal strength** — entered manually in dBm (browsers expose no RSSI API; see
  *Limitations*), plus the browser's own connection estimate (Network Information API)
  recorded automatically where available.
- **Measurement log** — every run is saved locally with timestamp, label, notes, position
  and all measured values. Export as **CSV** or **JSON**, import JSON from another device.
- **Locations** — two complementary ways:
  - **Site plan**: upload a deck plan / layout image, tap your position before each
    measurement, and see all points plotted on the plan, colour-coded by download speed,
    upload speed, ping or signal.
  - **GPS**: each measurement can record a GPS fix (works offshore — GPS needs no
    internet). The GPS view plots points to scale with a distance bar and north arrow.
- **Offline-first PWA** — after the first visit the app loads with no connectivity; only
  the speed test itself needs a reachable server.

## Hosting on GitHub Pages

1. Merge this repository's contents to the `main` branch.
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The included workflow (`.github/workflows/pages.yml`) deploys on every push to `main`.
4. Open `https://<user>.github.io/<repo>/` on the phone and **Add to Home Screen**.

## Measuring pure WiFi throughput (offshore use)

With the default internet server, offshore results are limited by the shore/VSAT link —
which is often exactly what you want to know at each location. To measure the **WiFi link
only**, run a server on a laptop on the same network:

```sh
# create a 200 MB test file and serve it with CORS enabled
dd if=/dev/urandom of=test.bin bs=1M count=200
npx http-server -p 8080 --cors
```

Then in the app: **Settings → Test server → Custom**, download URL
`http://<laptop-ip>:8080/test.bin`.

> **Mixed-content caveat:** a page loaded over HTTPS (GitHub Pages) is not allowed to
> fetch plain `http://` LAN URLs. For LAN-only testing, serve the app itself from the
> laptop instead — it is fully static:
>
> ```sh
> git clone <this repo> && cd <repo>
> npx http-server -p 8080
> # open http://<laptop-ip>:8080 on the phone
> ```
>
> Served over plain HTTP, the browser disables the service worker (no offline install)
> and geolocation (no GPS) — the log and site-plan features still work.

## Limitations (honest notes)

- **No RSSI API in browsers.** No web app can read WiFi signal strength, channel, or AP
  BSSID — that requires a native app. Here dBm is typed in manually (Android shows it
  under the WiFi network's details; any WiFi-analyzer app shows it live). The browser's
  rough connection estimate (`navigator.connection`) is logged automatically when present.
- **Speed test measures the path to the chosen server.** Internet server → includes the
  satellite/shore link; LAN server → WiFi link only.
- **iOS Safari** does not implement the Network Information API; the browser-estimate
  fields will be empty there. Everything else works.

## Data & privacy

All measurements, settings and the site-plan image are stored in the browser's local
storage/IndexedDB on the device. Export from the **Log** tab produces a CSV (one row per
measurement: time, label, download/upload Mbit/s, ping/jitter ms, signal dBm, GPS
lat/lon/accuracy, plan x/y, server, browser estimates, notes) or a JSON backup that can
be imported on another device.

## Development

No build step, no dependencies: edit and open `index.html`. For a local preview with the
service worker active, serve over localhost:

```sh
npx http-server -p 8080
```

The map's colour ramps are sequential blue ramps validated for both light and dark
surfaces (contrast and colour-vision-deficiency checks).
