// --- Query-string helpers ---
function getParam(name, fallback = null) {
	const u = new URL(window.location.href);
	return u.searchParams.get(name) ?? fallback;
}
function setParam(name, value) {
	const u = new URL(window.location.href);
	if (value === null || value === undefined || value === "") u.searchParams.delete(name);
	else u.searchParams.set(name, value);
	window.history.replaceState({}, "", u.toString());
}

// --- Color helpers (simplestyle) ---
function cssColorToCesiumColor(css, alpha = 1.0) {
	try {
		// Cesium.Color.fromCssColorString accepts #RRGGBB and many CSS strings.
		const c = Cesium.Color.fromCssColorString(css);
		return new Cesium.Color(c.red, c.green, c.blue, alpha);
	} catch (e) {
		return new Cesium.Color(1, 1, 0, alpha); // fallback yellow
	}
}

// --- Depth conversion ---
// Convert GeoJSON z to Cesium "height in meters" based on convention.
function zToHeightMeters(z, zMode) {
	if (z === undefined || z === null || Number.isNaN(z)) return undefined;
	switch (zMode) {
		case "elevation_m": return z; // height above ellipsoid/surface (per GeoJSON spec)
		case "depth_m": return -z; // depth (m) -> negative height
		case "depth_km": return -z * 1000.0; // depth (km) -> negative height
		default: return -z * 1000.0;
	}
}

// Walk coordinate arrays of any GeoJSON geometry and apply a mapping function to (lon,lat,z?).
function mapCoordinates(coords, mapperFn) {
	if (!Array.isArray(coords)) return coords;
	if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
		return mapperFn(coords);
	}
	return coords.map(c => mapCoordinates(c, mapperFn));
}

// Compute lon/lat bbox from any GeoJSON geometry object.
function computeBbox(geojson) {
	let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
	function visitCoords(coords) {
		if (!Array.isArray(coords)) return;
		if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
			const lon = coords[0], lat = coords[1];
			if (lon < minLon) minLon = lon;
			if (lon > maxLon) maxLon = lon;
			if (lat < minLat) minLat = lat;
			if (lat > maxLat) maxLat = lat;
			return;
		}
		for (const c of coords) visitCoords(c);
	}
	if (geojson.type === "FeatureCollection") {
		for (const f of geojson.features || []) visitCoords((f.geometry || {}).coordinates);
	} else if (geojson.type === "Feature") {
		visitCoords((geojson.geometry || {}).coordinates);
	} else if (geojson.coordinates) {
		visitCoords(geojson.coordinates);
	}
	return { minLon, maxLon, minLat, maxLat };
}

// --- Graticule (degree grid) ---
function buildGraticule(viewer, bbox, gridDeg) {
	const lines = [];
	const addLine = (positions) => {
		lines.push(viewer.entities.add({
			polyline: {
				positions,
				width: 1.0,
				material: Cesium.Color.WHITE.withAlpha(0.25)
			}
		}));
	};

	// Pad the bbox for context
	const pad = Math.max(gridDeg, 1.0);
	const minLon = Math.max(-180, Math.floor((bbox.minLon - pad) / gridDeg) * gridDeg);
	const maxLon = Math.min(180, Math.ceil((bbox.maxLon + pad) / gridDeg) * gridDeg);
	const minLat = Math.max(-90, Math.floor((bbox.minLat - pad) / gridDeg) * gridDeg);
	const maxLat = Math.min(90, Math.ceil((bbox.maxLat + pad) / gridDeg) * gridDeg);

	// Sampling along lines: smaller for bigger regions to avoid too many points
	const lonSpan = Math.max(1e-6, maxLon - minLon);
	const latSpan = Math.max(1e-6, maxLat - minLat);
	const span = Math.max(lonSpan, latSpan);
	const step = Math.max(0.1, Math.min(1.0, span / 90.0)); // ~90 segments max-ish

	// Meridians (constant lon)
	for (let lon = minLon; lon <= maxLon + 1e-9; lon += gridDeg) {
		const positions = [];
		for (let lat = minLat; lat <= maxLat + 1e-9; lat += step) {
			positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, 0));
		}
		addLine(positions);
	}
	// Parallels (constant lat)
	for (let lat = minLat; lat <= maxLat + 1e-9; lat += gridDeg) {
		const positions = [];
		for (let lon = minLon; lon <= maxLon + 1e-9; lon += step) {
			positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, 0));
		}
		addLine(positions);
	}
	return lines;
}

function initViewer() {
	// --- Viewer setup ---
	const viewer = new Cesium.Viewer("cesiumContainer", {
		animation: false,
		timeline: false,
		baseLayerPicker: true,
		geocoder: false,
		homeButton: true,
		sceneModePicker: true,
		navigationHelpButton: false,
		fullscreenButton: true,
		infoBox: true,
		selectionIndicator: true,
		shouldAnimate: false
	});

	// Cleaner look by default
	viewer.scene.skyAtmosphere.show = false;
	viewer.scene.skyBox.show = false;

	// Capture the initial camera view so we can reset later (and override the Home button).
	const initialCamera = {
		destination: Cesium.Cartesian3.clone(viewer.camera.position),
		heading: viewer.camera.heading,
		pitch: viewer.camera.pitch,
		roll: viewer.camera.roll
	};

	function resetCameraView() {
		viewer.camera.setView({
			destination: Cesium.Cartesian3.clone(initialCamera.destination),
			orientation: {
				heading: initialCamera.heading,
				pitch: initialCamera.pitch,
				roll: initialCamera.roll
			}
		});
	}

	// Make the built-in Home button reset to our initial view.
	if (viewer.homeButton && viewer.homeButton.viewModel && viewer.homeButton.viewModel.command) {
		viewer.homeButton.viewModel.command.beforeExecute.addEventListener(function (e) {
			e.cancel = true;
			resetCameraView();
		});
	}

	// State
	let currentDataSource = null;
	let currentGridEntities = [];
	let currentBbox = null;

	function setStatus(msg) { document.getElementById("status").textContent = msg; }
	function setHint(msg) { document.getElementById("hint").textContent = msg; }

	function applyViewMode(mode, globeAlpha) {
		if (mode === "space") {
			viewer.scene.globe.show = false;
			viewer.scene.globe.translucency.enabled = false;
			setHint("Space view: globe hidden (no occlusion). Grid lines are drawn on the ellipsoid at height 0.");
		} else {
			viewer.scene.globe.show = true;
			// Translucency can help see subsurface content
			viewer.scene.globe.translucency.enabled = true;
			viewer.scene.globe.translucency.frontFaceAlphaByDistance = new Cesium.NearFarScalar(
				1.5e6, globeAlpha,   // near: somewhat transparent
				2.0e7, Math.min(0.6, globeAlpha + 0.25) // far: slightly less transparent (tweakable)
			);
			// Underground viewing tweak (may reduce clipping). Artifacts are possible near the surface.
			viewer.scene.globe.depthTestAgainstTerrain = false;
			setHint("Translucent view: globe shown with translucency. For underground geometry, depth testing vs terrain is disabled.");
		}
	}

	function clearCurrent() {
		if (currentDataSource) {
			viewer.dataSources.remove(currentDataSource, true);
			currentDataSource = null;
		}
		for (const e of currentGridEntities) viewer.entities.remove(e);
		currentGridEntities = [];
		currentBbox = null;
	}

	function applySimpleStyle(ds) {
		const entities = ds.entities.values;
		for (const e of entities) {
			const p = e.properties;
			// defaults
			let stroke = "#ffcc00";
			let strokeWidth = 2.0;
			let fillOpacity = 0.15;
			let markerColor = "#ffcc00";
			let markerSize = "medium";

			if (p) {
				if (p.stroke) stroke = p.stroke.getValue();
				if (p["stroke-width"]) strokeWidth = Number(p["stroke-width"].getValue());
				if (p["fill-opacity"]) fillOpacity = Number(p["fill-opacity"].getValue());
				if (p["marker-color"]) markerColor = p["marker-color"].getValue();
				if (p["marker-size"]) markerSize = p["marker-size"].getValue();
			}

			// LineString (polyline)
			if (e.polyline) {
				e.polyline.material = cssColorToCesiumColor(stroke, 1.0);
				e.polyline.width = strokeWidth;
			}

			// Polygon
			if (e.polygon) {
				// simplestyle uses 'fill' too, but your sample has fill-opacity only; use stroke as fill color
				e.polygon.material = cssColorToCesiumColor(stroke, isFinite(fillOpacity) ? fillOpacity : 0.15);
				e.polygon.outline = true;
				e.polygon.outlineColor = cssColorToCesiumColor(stroke, 1.0);
			}

			// Point
			if (e.point) {
				// Mapbox "marker-size": small/medium/large
				let px = 8;
				if (markerSize === "small") px = 6;
				else if (markerSize === "large") px = 12;

				e.point.pixelSize = px;
				e.point.color = cssColorToCesiumColor(markerColor, 1.0);
				e.point.outlineColor = Cesium.Color.BLACK.withAlpha(0.7);
				e.point.outlineWidth = 1;
			}
		}
	}

	async function loadGeoJSONFromObject(geojson, zMode, label) {
		clearCurrent();
		setStatus("Loading…" + (label ? " (" + label + ")" : ""));

		// Convert z to Cesium height meters, if present
		const converted = JSON.parse(JSON.stringify(geojson));
		if (converted.type === "FeatureCollection") {
			for (const f of converted.features || []) {
				if (!f.geometry) continue;
				f.geometry.coordinates = mapCoordinates(f.geometry.coordinates, (c) => {
					const z = (c.length >= 3) ? c[2] : undefined;
					const h = zToHeightMeters(z, zMode);
					return (h === undefined) ? [c[0], c[1]] : [c[0], c[1], h];
				});
			}
		} else if (converted.type === "Feature" && converted.geometry) {
			converted.geometry.coordinates = mapCoordinates(converted.geometry.coordinates, (c) => {
				const z = (c.length >= 3) ? c[2] : undefined;
				const h = zToHeightMeters(z, zMode);
				return (h === undefined) ? [c[0], c[1]] : [c[0], c[1], h];
			});
		}

		currentBbox = computeBbox(converted);

		// Load into Cesium (do NOT clamp to ground; we want 3D)
		const ds = await Cesium.GeoJsonDataSource.load(converted, {
			clampToGround: false
		});

		currentDataSource = ds;
		viewer.dataSources.add(ds);

		// Apply simplestyle-spec-derived styling
		applySimpleStyle(ds);

		setStatus("Loaded.");

		// Optional fly-to
		if (document.getElementById("flyTo").checked) {
			await viewer.zoomTo(ds);
		}

		// Grid
		rebuildGrid();
	}

	async function loadGeoJSON(url, zMode) {
		const resp = await fetch(url, { mode: "cors" });
		if (!resp.ok) throw new Error(`Fetch failed (${resp.status}): ${resp.statusText}`);
		const geojson = await resp.json();
		await loadGeoJSONFromObject(geojson, zMode, url);
	}

	function rebuildGrid() {
		for (const e of currentGridEntities) viewer.entities.remove(e);
		currentGridEntities = [];
		if (!currentBbox) return;

		const enabled = document.getElementById("gridEnable").checked;
		const gridDeg = Number(document.getElementById("gridDeg").value);
		if (!enabled || !isFinite(gridDeg) || gridDeg <= 0) return;

		currentGridEntities = buildGraticule(viewer, currentBbox, gridDeg);
	}

	// --- Wire up UI + initial state from URL ---
	const dataUrlInput = document.getElementById("dataUrl");
	const zModeSel = document.getElementById("zMode");
	const viewModeSel = document.getElementById("viewMode");
	const gridDegInput = document.getElementById("gridDeg");
	const gridEnableChk = document.getElementById("gridEnable");
	const globeAlpha = document.getElementById("globeAlpha");
	const globeAlphaVal = document.getElementById("globeAlphaVal");

	function syncFromParams() {
		const data = getParam("data", "");
		const z = getParam("z", "depth_km");
		const view = getParam("view", "space");
		const grid = getParam("grid", "1");
		const gridOn = getParam("grid_on", "1");
		const alpha = getParam("alpha", "0.18");
		const fly = getParam("fly", "1");

		dataUrlInput.value = data;
		zModeSel.value = ["depth_km", "depth_m", "elevation_m"].includes(z) ? z : "depth_km";
		viewModeSel.value = ["space", "translucent"].includes(view) ? view : "space";
		gridDegInput.value = (grid && isFinite(Number(grid))) ? grid : "1";
		gridEnableChk.checked = (gridOn !== "0");
		globeAlpha.value = (alpha && isFinite(Number(alpha))) ? alpha : "0.18";
		globeAlphaVal.textContent = Number(globeAlpha.value).toFixed(2);
		document.getElementById("flyTo").checked = (fly !== "0");
	}

	function syncToParams() {
		setParam("data", dataUrlInput.value.trim());
		setParam("z", zModeSel.value);
		setParam("view", viewModeSel.value);
		setParam("grid", gridDegInput.value);
		setParam("grid_on", gridEnableChk.checked ? "1" : "0");
		setParam("alpha", globeAlpha.value);
		setParam("fly", document.getElementById("flyTo").checked ? "1" : "0");
	}

	document.getElementById("loadBtn").addEventListener("click", async () => {
		try {
			const url = dataUrlInput.value.trim();
			if (!url) { setStatus("Enter a GeoJSON URL first."); return; }
			syncToParams();
			applyViewMode(viewModeSel.value, Number(globeAlpha.value));
			await loadGeoJSON(url, zModeSel.value);
		} catch (e) {
			console.error(e);
			setStatus(`Error: ${e.message}`);
		}
	});

	document.getElementById("browseBtn").addEventListener("click", () => {
		document.getElementById("fileInput").click();
	});

	document.getElementById("resetViewBtn").addEventListener("click", () => {
		resetCameraView();
	});

	document.getElementById("fileInput").addEventListener("change", async (ev) => {
		const files = ev.target.files;
		if (!files || files.length === 0) return;
		const file = files[0];

		try {
			applyViewMode(viewModeSel.value, Number(globeAlpha.value));

			const text = await file.text();
			const geojson = JSON.parse(text);

			// Local files can't be deep-linked via ?data=..., so clear the data param but keep settings.
			dataUrlInput.value = "";
			syncToParams();

			await loadGeoJSONFromObject(geojson, zModeSel.value, file.name);
		} catch (e) {
			console.error(e);
			setStatus(`Error: ${e.message}`);
		} finally {
			// allow re-selecting the same file
			ev.target.value = "";
		}
	});

	zModeSel.addEventListener("change", () => syncToParams());
	viewModeSel.addEventListener("change", () => {
		syncToParams();
		applyViewMode(viewModeSel.value, Number(globeAlpha.value));
	});
	gridDegInput.addEventListener("change", () => { syncToParams(); rebuildGrid(); });
	gridEnableChk.addEventListener("change", () => { syncToParams(); rebuildGrid(); });
	globeAlpha.addEventListener("input", () => {
		const a = Number(globeAlpha.value);
		globeAlphaVal.textContent = a.toFixed(2);
		syncToParams();
		if (viewModeSel.value === "translucent") applyViewMode("translucent", a);
	});

	document.getElementById("copyLinkBtn").addEventListener("click", async () => {
		syncToParams();
		try {
			await navigator.clipboard.writeText(window.location.href);
			setStatus("Link copied to clipboard.");
		} catch (e) {
			setStatus("Could not copy automatically (clipboard permission).");
		}
	});

	// Initialize from params and auto-load if data is provided
	syncFromParams();
	applyViewMode(viewModeSel.value, Number(globeAlpha.value));

	(async () => {
		const url = dataUrlInput.value.trim();
		if (url) {
			try {
				await loadGeoJSON(url, zModeSel.value);
			} catch (e) {
				console.error(e);
				setStatus(`Error: ${e.message}`);
			}
		} else {
			setStatus("Ready. Provide ?data=... or paste a GeoJSON URL and click Load.");
			setHint("Example: viewer.html?data=geo3d_test.geojson&z=depth_km&view=space&grid=1 (or use Browse…)");
		}
	})();
}

window.addEventListener("DOMContentLoaded", () => {
	try {
		initViewer();
	} catch (e) {
		console.error("Initialization error:", e);
		const statusEl = document.getElementById("status");
		if (statusEl) {
			statusEl.textContent = `Initialization error: ${e.message}`;
		} else {
			alert(`Initialization error: ${e.message}`);
		}
	}
});
