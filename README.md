# geojson-3d-viewer
Self-hosted 3D browser-based GeoJSON viewer built on CesiumJS.

## Quick start
1. Serve the folder with a static web server (recommended), or open `viewer.html` directly.
2. In the UI, paste a GeoJSON URL or use **Browse…** to load a local file.

Tip: if you load GeoJSON from another domain, the host must allow CORS.

## URL parameters
You can configure the viewer via query parameters on `viewer.html`.

Example:
```
viewer.html?data=geo3d_test.geojson&z=depth_km&view=space&grid=1&grid_on=1&alpha=0.18&fly=1
```

Parameters:
- `data`: GeoJSON URL or relative path (e.g. `geo3d_test.geojson`)
- `z`: Z convention for input coordinates
  - `depth_km` (default)
  - `depth_m`
  - `elevation_m`
- `view`: `space` (globe hidden) or `translucent` (globe visible)
- `grid`: grid spacing in degrees (number, default `1`)
- `grid_on`: `1` to show graticule, `0` to hide
- `alpha`: globe translucency (0..1, default `0.18`)
- `fly`: `1` to auto fly-to on load, `0` to disable

## Embedding in another page
`viewer.js` is standalone but expects specific DOM elements to exist (IDs used by the UI).
You can embed the viewer by copying the HTML structure from `viewer.html` or by providing
your own markup with matching IDs.

Minimum includes:
- Cesium CSS and JS (same versions as `viewer.html` or your preferred pinned version)
- `viewer.js`
- A container element with id `cesiumContainer`
- UI elements with the same IDs used in the script

Example skeleton:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Embedded GeoJSON Viewer</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/cesium/1.133.1/Widgets/widgets.css" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/cesium/1.133.1/Cesium.js"></script>
  <style>
    html, body, #cesiumContainer { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; }
  </style>
</head>
<body>
  <div id="cesiumContainer"></div>
  <!-- Copy the UI block from viewer.html, or provide matching IDs -->
  <div id="ui">…</div>

  <script src="viewer.js" defer></script>
</body>
</html>
```

If you want a custom UI, keep the following element IDs (or update `viewer.js` to match):
`dataUrl`, `loadBtn`, `browseBtn`, `resetViewBtn`, `fileInput`, `zMode`, `viewMode`,
`gridDeg`, `gridEnable`, `globeAlpha`, `globeAlphaVal`, `flyTo`, `copyLinkBtn`, `status`, `hint`.

## Notes
- For local testing without CORS issues, use a local server (e.g. `python -m http.server`).
- The bundled `geo3d_test.geojson` file is a quick sanity check for the viewer.
