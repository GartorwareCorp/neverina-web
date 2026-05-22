const SVC_UUID = "6e657665-7269-6e61-8000-000000000001";

const CHAR_UUID = {
  // Config
  TEMP_STOP: "6e657665-7269-6e61-8000-000000000011",
  TEMP_START: "6e657665-7269-6e61-8000-000000000012",
  MIN_OFF: "6e657665-7269-6e61-8000-000000000013",
  MAX_RUN: "6e657665-7269-6e61-8000-000000000014",
  COOLDOWN: "6e657665-7269-6e61-8000-000000000015",
  TEMP_INT: "6e657665-7269-6e61-8000-000000000016",
  AMB_OFFSET: "6e657665-7269-6e61-8000-000000000017",
  CONTROL_MODE: "6e657665-7269-6e61-8000-000000000018",
  AMB_START: "6e657665-7269-6e61-8000-000000000019",
  SLOPE_STOP: "6e657665-7269-6e61-8000-00000000001a",
  MIN_ON: "6e657665-7269-6e61-8000-00000000001b",
  MAX_OFF: "6e657665-7269-6e61-8000-00000000001c",
  // Status blob
  STATUS_BLOB: "6e657665-7269-6e61-8000-000000000020",
  // History
  TIME_SYNC: "6e657665-7269-6e61-8000-000000000031",
  HIST_CTRL: "6e657665-7269-6e61-8000-000000000041",
  HIST_DATA: "6e657665-7269-6e61-8000-000000000042",
  // OTA trigger
  OTA_TRIGGER: "6e657665-7269-6e61-8000-000000000051",
};

// Sentinel returned by DS18B20 when disconnected
const SENSOR_DISCONNECTED = -127;
const HIST_TEMP_INVALID_X10 = -32768;
const HIST_HUMIDITY_INVALID = 255;

// Error bitmask flags (must match ERR_* constants in main.cpp)
const ERROR_NAMES = {
  0x01: "Motor controller failure",
  0x02: "Temperature sensor lost",
  0x04: "Ambient sensor failure",
  0x08: "History storage failed",
};
const HIST_FRAME_HEADER_SIZE = 4;
const HIST_FRAME_FLAG_LAST = 0x01;

function neverina() {
  return {
    // ── Connection state ───────────────────────────────────────
    connected: false,
    connecting: false,
    deviceName: null,

    // ── Config params (form-bound) ─────────────────────────────
    params: {
      tempStop: 0.0,
      tempStart: 6.0,
      minOff: 300,
      maxOn: 3000,
      maxOff: 1200,
      cooldown: 600,
      tempInt: 10,
      ambOffset: 0.0,
      controlMode: 0,
      effStop: 2.0,
      slopeStop: -0.02,
      minOn: 300,
    },

    // ── Live status (updated via BLE notifications) ────────────
    status: {
      temp: null, // float °C  (null = sensor error / disconnected)
      ambTemp: null, // float °C  SHT30 ambient (null = sensor error)
      humidity: null, // float %RH SHT30 ambient humidity (null = sensor error)
      state: null, // 0=OFF 1=COOLDOWN 2=ON
      stateTime: null, // uint32 seconds in current state
      errors: null, // uint8 bitmask (null = unknown, 0 = OK)
      uptime: null, // uint32 seconds since boot
      controlMode: 0, // 0=simple 1=advanced
      ambFloorEma: null,
      tempStopTarget: null,
      gap: null,
    },

    // ── Time sync anchor (set on each connect) ─────────────────
    _millisAnc: 0, // uint32: millis() on device at sync moment
    _epochBaseMs: 0n, // BigInt: Unix ms at sync moment

    // ── History ────────────────────────────────────────────────
    histLoading: false,
    histError: null,
    tempRecords: [], // { t: AbsMs (Number), v: float }
    ambRecords: [], // { t: AbsMs (Number), v: float }  SHT30
    humRecords: [], // { t: AbsMs (Number), v: float }  SHT30 humidity
    stateRecords: [], // { t: AbsMs (Number), s: 0|1|2 }
    histStateTotals: { offMs: 0, cooldownMs: 0, onMs: 0, totalMs: 0 },
    histTempStats: { min: null, avg: null, max: null },
    histAmbStats: { min: null, avg: null, max: null },
    histCycleStats: { count: null, avgOnSec: null, avgOffSec: null, startsPerHour: null },
    histThermalStats: { coolingRateCPerMin: null, heatLeakRateCPerMin: null },
    histRangeOptions: [
      { label: "5min", ms: 5 * 60 * 1000 },
      { label: "15min", ms: 15 * 60 * 1000 },
      { label: "30min", ms: 30 * 60 * 1000 },
      { label: "1h", ms: 1 * 60 * 60 * 1000 },
      { label: "2h", ms: 2 * 60 * 60 * 1000 },
      { label: "4h", ms: 4 * 60 * 60 * 1000 },
      { label: "8h", ms: 8 * 60 * 60 * 1000 },
      { label: "12h", ms: 12 * 60 * 60 * 1000 },
      { label: "24h", ms: 24 * 60 * 60 * 1000 },
      { label: "Completo", ms: 0 },
    ],
    selectedHistRangeMs: 2 * 60 * 60 * 1000,
    prevHistRangeMs: -1,
    _nextHistRequestId: 1,
    _chart: null,

    // ── UI feedback ────────────────────────────────────────────
    saving: false,
    saveError: null,
    validationErrors: {},

    // ── BLE handles (private) ──────────────────────────────────
    _device: null,
    _chars: {},
    _disconnectHandler: null,

    // ── Public actions ─────────────────────────────────────────

    async init() {
      this._configureInstalledAppGuards();
      //await this.tryAutoConnect();
    },

    async tryAutoConnect() {
      if (!navigator.bluetooth || typeof navigator.bluetooth.getDevices !== "function") return;
      if (this.connected || this.connecting) return;

      this.connecting = true;
      try {
        // Give BLE some time to stabilize advertising after boot/wake
        await new Promise((r) => setTimeout(r, 500));

        const devices = await navigator.bluetooth.getDevices();
        const device = devices.find((d) => d?.name === "Neverina");
        if (!device) {
          console.log("[Auto-connect] No previously granted Neverina device found");
          return;
        }

        console.log("[Auto-connect] Found Neverina, attempting connection...");

        // Retry logic for transient connection failures
        let lastErr;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await this._connectToDevice(device);
            console.log("[Auto-connect] Connected successfully on attempt", attempt);
            return;
          } catch (err) {
            lastErr = err;
            const isNetworkError = err.name === "NetworkError";
            console.warn(`[Auto-connect] Attempt ${attempt} failed:`, err.name || "Error", "—", err.message);

            // Retry only on transient network errors
            if (!isNetworkError || attempt === 3) throw err;

            const backoffMs = 500 * attempt;
            console.log(`[Auto-connect] Retrying in ${backoffMs}ms...`);
            await new Promise((r) => setTimeout(r, backoffMs));
          }
        }
      } catch (err) {
        console.warn("[Auto-connect] Skipped:", err?.message || String(err));
      } finally {
        this.connecting = false;
      }
    },

    async connect() {
      if (!navigator.bluetooth) {
        alert("Web Bluetooth is not supported.\nUse Chrome on Desktop or Android.");
        return;
      }
      if (this.connected || this.connecting) return;

      this.connecting = true;
      try {
        const device = await navigator.bluetooth.requestDevice({
          filters: [{ name: "Neverina" }],
          optionalServices: [SVC_UUID],
        });
        await this._connectToDevice(device);
      } catch (err) {
        if (err.name !== "NotFoundError") {
          alert("Connection failed: " + err.message);
        }
        console.error("Connection failed:", err);
      } finally {
        this.connecting = false;
      }
    },

    disconnect() {
      if (this._device?.gatt?.connected) {
        this._device.gatt.disconnect();
      }
    },

    async readAll() {
      try {
        const rf = async (c) => {
          const v = await c.readValue();
          if (v.byteLength < 4) return null;
          return v.getFloat32(0, true);
        };
        const ru = async (c) => {
          const v = await c.readValue();
          return v.getUint32(0, true);
        };
        const ru8 = async (c) => {
          const v = await c.readValue();
          return v.getUint8(0);
        };

        this.params.tempStop = +(await rf(this._chars.TEMP_STOP)).toFixed(1);
        this.params.tempStart = +(await rf(this._chars.TEMP_START)).toFixed(1);
        this.params.minOff = await ru(this._chars.MIN_OFF);
        this.params.maxOn = await ru(this._chars.MAX_RUN);
        this.params.maxOff = await ru(this._chars.MAX_OFF);
        this.params.cooldown = await ru(this._chars.COOLDOWN);
        this.params.tempInt = await ru(this._chars.TEMP_INT);
        this.params.ambOffset = +(await rf(this._chars.AMB_OFFSET)).toFixed(1);
        this.params.controlMode = await ru8(this._chars.CONTROL_MODE);
        this.params.effStop = +(await rf(this._chars.AMB_START)).toFixed(1);
        this.params.slopeStop = +(await rf(this._chars.SLOPE_STOP)).toFixed(3);
        this.params.minOn = await ru(this._chars.MIN_ON);

        // Read status blob
        this._parseStatusBlob(await this._chars.STATUS_BLOB.readValue());
      } catch (err) {
        console.error("readAll failed:", err);
      }
    },

    _parseStatusBlob(dv) {
      if (!dv || dv.byteLength < 24) return;
      const version = dv.getUint8(0);
      if (version !== 1 && version !== 2) {
        console.warn("Unknown STATUS_BLOB version:", version);
        return;
      }
      const tempVal = dv.getFloat32(1, true);
      this.status.temp = this.isValidTemp(tempVal) ? tempVal : null;
      const ambVal = dv.getFloat32(5, true);
      this.status.ambTemp = this.isValidTemp(ambVal) ? ambVal : null;
      const humVal = dv.getFloat32(9, true);
      this.status.humidity = this.isValidHumidity(humVal) ? humVal : null;
      this.status.state = dv.getUint8(13);
      this.status.stateTime = dv.getUint32(14, true);
      this.status.uptime = dv.getUint32(18, true);
      this.status.errors = dv.getUint8(22);
      this.status.controlMode = dv.getUint8(23);
      if (version >= 2 && dv.byteLength >= 36) {
        const floorVal = dv.getFloat32(24, true);
        this.status.ambFloorEma = this.isValidTemp(floorVal) ? floorVal : null;
        const stopTargetVal = dv.getFloat32(28, true);
        this.status.tempStopTarget = this.isValidTemp(stopTargetVal) ? stopTargetVal : null;
        const gapVal = dv.getFloat32(32, true);
        this.status.gap = Number.isFinite(gapVal) ? gapVal : null;
      } else {
        this.status.ambFloorEma = null;
        this.status.tempStopTarget = null;
        this.status.gap = null;
      }
    },

    _validateParams() {
      const e = {};
      if (this.params.minOff < 180) e.minOff = "Minimum 180 s";
      if (this.params.minOff > 600) e.minOff = "Maximum 600 s";
      if (this.params.maxOn < 600) e.maxOn = "Minimum 10 min (600 s)";
      if (this.params.maxOn > 7200) e.maxOn = "Maximum 7200 s";
      if (this.params.maxOff < 180) e.maxOff = "Minimum 180 s";
      if (this.params.maxOff > 28800) e.maxOff = "Maximum 28800 s (8 h)";
      if (this.params.cooldown < 180) e.cooldown = "Minimum 180 s";
      if (this.params.cooldown > 28800) e.cooldown = "Maximum 28800 s";
      if (this.params.minOff > this.params.cooldown || this.params.cooldown > this.params.maxOff) {
        e.cooldown = "Min off ≤ Cooldown ≤ Max off required";
      }
      if (this.params.tempInt < 5) e.tempInt = "Minimum 5 s";
      if (this.params.tempInt > 60) e.tempInt = "Maximum 60 s";
      if (this.params.ambOffset < -20 || this.params.ambOffset > 20) e.ambOffset = "Range −20 to 20 °C";
      if (this.params.effStop < -10 || this.params.effStop > 15) e.effStop = "Range −10 to 15 °C";
      if (this.params.slopeStop < -1 || this.params.slopeStop > 0) e.slopeStop = "Range −1.0 to 0.0 °C/min";
      if (this.params.minOn < 180) e.minOn = "Minimum 180 s";
      if (this.params.minOn > 600) e.minOn = "Maximum 600 s";
      return e;
    },

    async saveAll() {
      this.validationErrors = this._validateParams();
      if (Object.keys(this.validationErrors).length > 0) return;

      this.saving = true;
      this.saveError = null;
      try {
        const wf = async (c, val) => {
          const buf = new ArrayBuffer(4);
          new DataView(buf).setFloat32(0, parseFloat(val), true);
          await c.writeValueWithResponse(buf);
        };
        const wu = async (c, val) => {
          const buf = new ArrayBuffer(4);
          new DataView(buf).setUint32(0, parseInt(val), true);
          await c.writeValueWithResponse(buf);
        };
        const wu8 = async (c, val) => {
          const buf = new ArrayBuffer(1);
          new DataView(buf).setUint8(0, parseInt(val));
          await c.writeValueWithResponse(buf);
        };

        await wf(this._chars.TEMP_STOP, this.params.tempStop);
        await wf(this._chars.TEMP_START, this.params.tempStart);
        await wu(this._chars.MIN_OFF, this.params.minOff);
        await wu(this._chars.MAX_RUN, this.params.maxOn);
        await wu(this._chars.MAX_OFF, this.params.maxOff);
        await wu(this._chars.COOLDOWN, this.params.cooldown);
        await wu(this._chars.TEMP_INT, this.params.tempInt);
        await wf(this._chars.AMB_OFFSET, this.params.ambOffset);
        await wu8(this._chars.CONTROL_MODE, this.params.controlMode);
        await wf(this._chars.AMB_START, this.params.effStop);
        await wf(this._chars.SLOPE_STOP, this.params.slopeStop);
        await wu(this._chars.MIN_ON, this.params.minOn);
      } catch (err) {
        this.saveError = err.message || "Write failed";
      } finally {
        this.saving = false;
      }
    },

    // Trigger OTA mode on the device via BLE.
    async triggerOta() {
      if (!confirm("The device will stop the thermostat and enter firmware update mode.\n\nContinue?")) return;
      try {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setUint32(0, 0xdeadbeef, true);
        await this._chars.OTA_TRIGGER.writeValueWithResponse(buf);
        // Device will disconnect within ~100 ms as BLE is shut down
      } catch (err) {
        // Disconnection mid-write is expected — treat as success
        if (err.name !== "NetworkError") {
          alert("OTA trigger failed: " + err.message);
        }
      }
    },

    // ── Helpers ────────────────────────────────────────────────

    stateLabel() {
      return ["OFF", "CoolDown", "ON"][this.status.state] ?? "—";
    },

    stateBadgeClass() {
      return ["badge-ghost", "badge-warning", "badge-success"][this.status.state] ?? "badge-ghost";
    },

    // Returns array of active error name strings from the bitmask.
    errorList() {
      if (this.status.errors === null) return [];
      return Object.entries(ERROR_NAMES)
        .filter(([bit]) => this.status.errors & Number(bit))
        .map(([, name]) => name);
    },

    formatDuration(secs) {
      if (secs === null || secs === undefined) return "—";
      if (secs < 60) return secs + "s";
      if (secs < 3600) {
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        return s > 0 ? `${m}m ${s}s` : `${m}m`;
      }
      if (secs < 86400) {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        if (s > 0) return `${h}h ${m}m ${s}s`;
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
      }
      const d = Math.floor(secs / 86400);
      const h = Math.floor((secs % 86400) / 3600);
      const m = Math.floor((secs % 3600) / 60);
      if (h > 0) return `${d}d ${h}h ${m}m`;
      return m > 0 ? `${d}d ${m}m` : `${d}d`;
    },

    formatPercent(value) {
      if (!Number.isFinite(value)) return "0.0%";
      return value.toFixed(1) + "%";
    },

    isValidTemp(value) {
      return Number.isFinite(value) && value !== SENSOR_DISCONNECTED && value !== HIST_TEMP_INVALID_X10;
    },

    isValidHumidity(value) {
      return Number.isFinite(value) && value >= 0 && value <= 100 && value !== HIST_HUMIDITY_INVALID;
    },

    histStatePercent(ms) {
      const total = this.histStateTotals.totalMs;
      if (!total || total <= 0) return 0;
      return (ms * 100) / total;
    },

    setHistoryRange() {
      console.log("Selected history range (ms):", this.selectedHistRangeMs, this.prevHistRangeMs);

      // Zero means max range
      const prevRange = this.prevHistRangeMs === 0 ? Number.MAX_SAFE_INTEGER : this.prevHistRangeMs;
      const newRange = this.selectedHistRangeMs === 0 ? Number.MAX_SAFE_INTEGER : this.selectedHistRangeMs;

      if (newRange > prevRange) {
        // If expanding range, load more data.
        this.loadHistory();
      } else {
        // If shrinking range, just trim existing data without reloading (for snappier UI).
        this._buildChart();
      }
    },

    // ── Private ────────────────────────────────────────────────

    _isInstalledPwa() {
      return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    },

    _configureInstalledAppGuards() {
      if (!this._isInstalledPwa()) return;

      document.documentElement.classList.add("pwa-installed");

      document.addEventListener(
        "contextmenu",
        (e) => {
          if (e.target.closest("input, textarea, select, [contenteditable='true']")) return;
          e.preventDefault();
        },
        { passive: false },
      );

      document.addEventListener(
        "selectstart",
        (e) => {
          if (e.target.closest("input, textarea, select, [contenteditable='true']")) return;
          e.preventDefault();
        },
        { passive: false },
      );
    },

    async _connectToDevice(device) {
      this._device = device;

      if (!this._disconnectHandler) {
        this._disconnectHandler = () => {
          this._resetConnectionState();
        };
      }
      this._device.removeEventListener("gattserverdisconnected", this._disconnectHandler);
      this._device.addEventListener("gattserverdisconnected", this._disconnectHandler);

      const server = await this._device.gatt.connect();
      const service = await server.getPrimaryService(SVC_UUID);
      for (const [key, uuid] of Object.entries(CHAR_UUID)) {
        try {
          this._chars[key] = await service.getCharacteristic(uuid);
        } catch (err) {
          throw new Error(`Characteristic ${key} (${uuid}) failed: ${err?.name || "Error"}: ${err?.message || err}`);
        }
      }

      await this._subscribeCharacteristics();

      this.connected = true;
      this.deviceName = this._device.name || "Neverina";

      await this._syncTime();
      await this.readAll();
    },

    _resetConnectionState() {
      this.connected = false;
      this.deviceName = null;
      this.histStateTotals = { offMs: 0, cooldownMs: 0, onMs: 0, totalMs: 0 };
      this.histTempStats = { min: null, avg: null, max: null };
      this.histAmbStats = { min: null, avg: null, max: null };
      this.histCycleStats = { count: null, avgOnSec: null, avgOffSec: null, startsPerHour: null };
      this.histThermalStats = { coolingRateCPerMin: null, heatLeakRateCPerMin: null };
      this.status = {
        temp: null,
        ambTemp: null,
        humidity: null,
        state: null,
        stateTime: null,
        errors: null,
        uptime: null,
        controlMode: 0,
      };
      this._chars = {};
      this.tempRecords = [];
      this.stateRecords = [];
      this.ambRecords = [];
      this.humRecords = [];
      if (this._chart) {
        this._chart.destroy();
        this._chart = null;
      }
    },

    async _syncTime() {
      // Write Date.now() as int64 LE to TIME_SYNC
      const epochMs = BigInt(Date.now());
      const buf = new ArrayBuffer(8);
      new DataView(buf).setBigInt64(0, epochMs, true);
      await this._chars.TIME_SYNC.writeValueWithResponse(buf);

      // Read back the anchor the firmware stored
      const v = await this._chars.TIME_SYNC.readValue();
      this._millisAnc = v.getUint32(0, true);
      this._epochBaseMs = v.getBigInt64(4, true);
      console.log("[TIME_SYNC] millisAnc:", this._millisAnc, "epochBaseMs:", this._epochBaseMs.toString());
    },

    async _subscribeCharacteristics() {
      const self = this;

      await this._chars.STATUS_BLOB.startNotifications();
      this._chars.STATUS_BLOB.addEventListener("characteristicvaluechanged", (e) => {
        self._parseStatusBlob(e.target.value);
      });

      await this._chars.HIST_DATA.startNotifications();
    },

    _millisToEpoch(millis_ms) {
      return Number(this._epochBaseMs + BigInt(millis_ms) - BigInt(this._millisAnc));
    },

    _parseTempBuf(buf) {
      const records = [];
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = 0; i + 6 <= buf.length; i += 6) {
        const ms = dv.getUint32(i, true);
        const tempX10 = dv.getInt16(i + 4, true);
        const v = this.isValidTemp(tempX10) ? tempX10 / 10 : Number.NaN;
        records.push({ t: this._millisToEpoch(ms), v });
      }
      console.log("[HIST] Parsed temp records:", records.length, records);
      return records;
    },

    _parseStateBuf(buf) {
      const records = [];
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = 0; i + 5 <= buf.length; i += 5) {
        const ms = dv.getUint32(i, true);
        const state = dv.getUint8(i + 4);
        records.push({ t: this._millisToEpoch(ms), s: state });
      }
      console.log("[HIST] Parsed state records:", records.length, records);
      return records;
    },

    _parseHumidityBuf(buf) {
      const records = [];
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      for (let i = 0; i + 5 <= buf.length; i += 5) {
        const ms = dv.getUint32(i, true);
        const humidity = dv.getUint8(i + 4);
        const v = this.isValidHumidity(humidity) ? humidity : Number.NaN;
        records.push({ t: this._millisToEpoch(ms), v });
      }
      console.log("[HIST] Parsed humidity records:", records.length, records);
      return records;
    },

    // Convert a Unix epoch ms timestamp to device millis using the time sync anchor.
    // Returns 0 (= send all) if the anchor has not been set yet.
    _epochToDeviceMillis(epochMs) {
      if (!this._millisAnc && this._epochBaseMs === 0n) return 0;
      const deviceMs = this._millisAnc + Number(BigInt(Math.round(epochMs)) - this._epochBaseMs);
      return Math.max(0, Math.min(deviceMs, 0xffffffff));
    },

    // Compute the device-millis cutoff for the current selected range.
    // Returns 0 when "Completo" is selected (send everything).
    _histMillisCutoff() {
      if (this.selectedHistRangeMs <= 0) return 0;
      return this._epochToDeviceMillis(Date.now() - this.selectedHistRangeMs);
    },

    // Requests a dump and resolves with the raw accumulated Uint8Array.
    _requestDump(type, skipOldest) {
      return new Promise((resolve, reject) => {
        const requestId = this._nextHistRequestId;
        this._nextHistRequestId = (this._nextHistRequestId + 1) & 0xffff;
        if (this._nextHistRequestId === 0) this._nextHistRequestId = 1;

        let done = false;
        let totalLength = 0;
        const chunks = [];

        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          this._chars.HIST_DATA.removeEventListener("characteristicvaluechanged", onNotification);

          const merged = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          resolve(merged);
        };

        const fail = (err) => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          this._chars.HIST_DATA.removeEventListener("characteristicvaluechanged", onNotification);
          reject(err);
        };

        const onNotification = (e) => {
          const dv = e.target.value;
          if (!dv || dv.byteLength < HIST_FRAME_HEADER_SIZE) return;

          const frameRequestId = dv.getUint16(0, true);
          const frameType = dv.getUint8(2);
          const flags = dv.getUint8(3);
          if (frameRequestId !== requestId || frameType !== type) return;

          const payloadLength = dv.byteLength - HIST_FRAME_HEADER_SIZE;
          console.log(
            "[HIST_DATA] frame req=",
            frameRequestId,
            "type=",
            frameType,
            "flags=",
            flags,
            "payload=",
            payloadLength,
          );

          if (payloadLength > 0) {
            const payload = new Uint8Array(dv.buffer, dv.byteOffset + HIST_FRAME_HEADER_SIZE, payloadLength);
            chunks.push(payload.slice());
            totalLength += payload.length;
          }

          if ((flags & HIST_FRAME_FLAG_LAST) !== 0) {
            finish();
          }
        };

        this._chars.HIST_DATA.addEventListener("characteristicvaluechanged", onNotification);

        const timeout = setTimeout(() => {
          fail(new Error("History dump timeout (type=" + type + ", req=" + requestId + ")"));
        }, 30000);

        const cmd = new ArrayBuffer(7);
        const dv = new DataView(cmd);
        dv.setUint16(0, requestId, true);
        dv.setUint8(2, type);
        dv.setUint32(3, skipOldest, true);
        this._chars.HIST_CTRL.writeValueWithResponse(cmd).catch(fail);
      });
    },

    async loadHistory() {
      this.histLoading = true;
      this.histError = null;
      try {
        const cutoff = this._histMillisCutoff();

        console.log("[HIST] load range:", {
          selectedHistRangeMs: this.selectedHistRangeMs,
          millisCutoff: cutoff,
        });

        const tempBuf = await this._requestDump(0, cutoff);
        const stateBuf = await this._requestDump(1, cutoff);
        const ambBuf = await this._requestDump(2, cutoff);
        const humBuf = await this._requestDump(3, cutoff);
        this.tempRecords = this._parseTempBuf(tempBuf);
        this.stateRecords = this._parseStateBuf(stateBuf);
        this.ambRecords = this._parseTempBuf(ambBuf);
        this.humRecords = this._parseHumidityBuf(humBuf);
        this._buildChart();

        // Update prevHistRangeMs after successful load.
        this.prevHistRangeMs = this.selectedHistRangeMs;
      } catch (err) {
        this.histError = err.message;
        console.error("[HIST] Load failed:", err);
      } finally {
        this.histLoading = false;
      }
    },

    _buildChart() {
      console.log("[CHART] Building chart with records:", {
        temp: this.tempRecords.length,
        state: this.stateRecords.length,
        amb: this.ambRecords.length,
        hum: this.humRecords.length,
      });

      console.log("[CHART] Destroying previous chart instance (if any)");
      if (this._chart) {
        this._chart.destroy();
        this._chart = null;
      }

      // Replace the canvas node so Chart.js always gets a fresh 2D context.
      // Reusing the same canvas after destroy() can leave the context in a bad
      // state and cause the chart to silently not render on subsequent loads.
      console.log("[CHART] Resetting canvas element for Chart.js");
      let canvas = document.getElementById("histChart");
      if (!canvas) return;
      const parent = canvas.parentNode;
      const fresh = document.createElement("canvas");
      fresh.id = canvas.id;
      const explicitHeight = canvas.getAttribute("height");
      if (explicitHeight) fresh.setAttribute("height", explicitHeight);
      parent.replaceChild(fresh, canvas);
      canvas = fresh;

      const now = Date.now();

      // Build a common timeline and forward-fill previous values on each series.
      // Invalid values (NaN and legacy -127 sentinel) are mapped to null for chart gaps.
      console.log("[CHART] Building data sources for each series with forward-filled values and nulls for invalids");
      const tempSource = this.tempRecords.map((r) => ({ x: r.t, y: this.isValidTemp(r.v) ? r.v : null }));
      const ambSource = this.ambRecords.map((r) => ({ x: r.t, y: this.isValidTemp(r.v) ? r.v : null }));
      const humSource = this.humRecords.map((r) => ({ x: r.t, y: this.isValidHumidity(r.v) ? r.v : null }));
      const stateSource = this.stateRecords.map((r) => ({ x: r.t, y: r.s }));

      if (tempSource.length > 0) tempSource.push({ x: now, y: tempSource[tempSource.length - 1].y });
      if (ambSource.length > 0) ambSource.push({ x: now, y: ambSource[ambSource.length - 1].y });
      if (humSource.length > 0) humSource.push({ x: now, y: humSource[humSource.length - 1].y });
      if (stateSource.length > 0) stateSource.push({ x: now, y: stateSource[stateSource.length - 1].y });

      const timeline = [...new Set([...tempSource, ...ambSource, ...humSource, ...stateSource].map((p) => p.x))].sort(
        (a, b) => a - b,
      );
      if (timeline.length === 0) {
        this.histStateTotals = { offMs: 0, cooldownMs: 0, onMs: 0, totalMs: 0 };
        this.histTempStats = { min: null, avg: null, max: null };
        this.histAmbStats = { min: null, avg: null, max: null };
        this.histCycleStats = { count: null, avgOnSec: null, avgOffSec: null, startsPerHour: null };
        this.histThermalStats = { coolingRateCPerMin: null, heatLeakRateCPerMin: null };
        return;
      }

      const alignSeriesToTimeline = (source, defaultValue) => {
        let srcIdx = 0;
        let lastY = defaultValue;
        const aligned = [];
        for (const x of timeline) {
          while (srcIdx < source.length && source[srcIdx].x <= x) {
            lastY = source[srcIdx].y;
            srcIdx += 1;
          }
          aligned.push({ x, y: lastY });
        }
        return aligned;
      };

      const tempData = alignSeriesToTimeline(tempSource, null);
      const ambData = alignSeriesToTimeline(ambSource, null);
      const humData = alignSeriesToTimeline(humSource, null);
      const stateData = alignSeriesToTimeline(stateSource, 0);

      const hoverGuidePlugin = {
        id: "hoverGuide",
        afterDraw: (chart, _args, pluginOpts) => {
          const tooltip = chart.tooltip;
          if (!tooltip) return;

          const active = tooltip.getActiveElements();
          if (!active || active.length === 0) return;

          const x = active[0]?.element?.x;
          if (!Number.isFinite(x)) return;

          const {
            ctx,
            chartArea: { top, bottom },
          } = chart;

          ctx.save();
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
          ctx.lineWidth = pluginOpts?.lineWidth ?? 1;
          ctx.strokeStyle = pluginOpts?.color ?? "rgba(100, 116, 139, 0.5)";
          ctx.setLineDash(pluginOpts?.dash ?? [4, 4]);
          ctx.stroke();
          ctx.restore();
        },
      };

      // X - axis
      let xMin;
      let xMax;
      const allTempTimes = [...tempData, ...ambData].map((p) => p.x).filter((v) => Number.isFinite(v));

      if (allTempTimes.length === 0) {
        xMin = undefined;
        xMax = undefined;
        this.histCycleStats = { count: null, avgOnSec: null, avgOffSec: null, startsPerHour: null };
        this.histThermalStats = { coolingRateCPerMin: null, heatLeakRateCPerMin: null };
        return;
      }

      xMax = Math.max(...allTempTimes);
      xMin = Math.max(Math.min(...allTempTimes), xMax - (this.selectedHistRangeMs || xMax));

      console.log("[CHART] x-axis range:", {
        dataMin: xMin ? new Date(xMin).toISOString() : "undefined",
        dataMax: xMax ? new Date(xMax).toISOString() : "undefined",
        rangeMs: xMax - xMin,
      });

      // State totals clipped to the visible window [xMin, xMax]
      {
        let offMs = 0;
        let cooldownMs = 0;
        let onMs = 0;
        for (let i = 0; i + 1 < stateData.length; i += 1) {
          const segStart = Math.max(stateData[i].x, xMin);
          const segEnd = Math.min(stateData[i + 1].x, xMax);
          const dt = segEnd - segStart;
          if (dt <= 0) continue;
          if (stateData[i].y === 0) offMs += dt;
          else if (stateData[i].y === 1) cooldownMs += dt;
          else if (stateData[i].y === 2) onMs += dt;
        }
        this.histStateTotals = { offMs, cooldownMs, onMs, totalMs: offMs + cooldownMs + onMs };
      }

      // Temperature stats for visible window (time-weighted average)
      const _computeStats = (data) => {
        const visible = data.filter((p) => p.x >= xMin && p.x <= xMax && Number.isFinite(p.y));
        if (visible.length === 0) return { min: null, avg: null, max: null };
        let min = Infinity;
        let max = -Infinity;
        let weightedSum = 0;
        let totalDt = 0;
        for (let i = 0; i < visible.length; i++) {
          const y = visible[i].y;
          if (y < min) min = y;
          if (y > max) max = y;
          const dt = i + 1 < visible.length ? visible[i + 1].x - visible[i].x : 0;
          weightedSum += y * dt;
          totalDt += dt;
        }
        const avg = totalDt > 0 ? weightedSum / totalDt : visible[0].y;
        return { min, avg, max };
      };
      this.histTempStats = _computeStats(tempData);
      this.histAmbStats = _computeStats(ambData);

      // ── Compressor cycle & thermal performance stats ────────────────
      {
        const onSegs = [];
        const nonOnSegs = [];
        let curOnStart = null;
        let curNonOnStart = null;
        let lastOnEnd = null;
        const cycleOnMs = [];
        const interCycleOffMs = [];

        for (let i = 0; i + 1 < stateData.length; i++) {
          const clampedStart = Math.max(stateData[i].x, xMin);
          const clampedEnd = Math.min(stateData[i + 1].x, xMax);
          if (clampedEnd <= clampedStart) continue;
          const state = stateData[i].y;

          if (state === 2) {
            // Entering ON
            if (curNonOnStart !== null) {
              nonOnSegs.push({ start: curNonOnStart, end: clampedStart });
              curNonOnStart = null;
            }
            if (curOnStart === null) {
              curOnStart = clampedStart;
              if (lastOnEnd !== null) interCycleOffMs.push(clampedStart - lastOnEnd);
            }
          } else {
            // Leaving ON (or never was ON)
            if (curOnStart !== null) {
              cycleOnMs.push(clampedStart - curOnStart);
              onSegs.push({ start: curOnStart, end: clampedStart });
              lastOnEnd = clampedStart;
              curOnStart = null;
            }
            if (curNonOnStart === null) curNonOnStart = clampedStart;
          }
        }
        // Close open segments at window edge
        if (curOnStart !== null) {
          cycleOnMs.push(xMax - curOnStart);
          onSegs.push({ start: curOnStart, end: xMax });
        }
        if (curNonOnStart !== null) nonOnSegs.push({ start: curNonOnStart, end: xMax });

        const cycleCount = cycleOnMs.length;
        const avgOnSec =
          cycleCount > 0 ? cycleOnMs.reduce((a, b) => a + b, 0) / cycleCount / 1000 : null;
        const avgOffSec =
          interCycleOffMs.length > 0
            ? interCycleOffMs.reduce((a, b) => a + b, 0) / interCycleOffMs.length / 1000
            : null;
        const windowMs = xMax - xMin;
        const startsPerHour = windowMs > 0 ? cycleCount / (windowMs / 3600000) : null;

        // Time-weighted mean slope (°C/min) across a list of {start, end} segments
        const _segSlope = (segs) => {
          let wSum = 0;
          let wTot = 0;
          for (const seg of segs) {
            const pts = tempData.filter((p) => p.x >= seg.start && p.x <= seg.end && p.y !== null);
            if (pts.length < 2) continue;
            const dtMs = pts[pts.length - 1].x - pts[0].x;
            const dT = pts[pts.length - 1].y - pts[0].y;
            if (dtMs <= 0) continue;
            wSum += (dT / (dtMs / 60000)) * dtMs;
            wTot += dtMs;
          }
          return wTot > 0 ? wSum / wTot : null;
        };

        const coolingRateCPerMin = _segSlope(onSegs);
        const heatLeakRateCPerMin = _segSlope(nonOnSegs);

        this.histCycleStats = { count: cycleCount, avgOnSec, avgOffSec, startsPerHour };
        this.histThermalStats = { coolingRateCPerMin, heatLeakRateCPerMin };
      }

      // Y - axis
      let yTempMin;
      let yTempMax;
      const allTempVals = [...tempData, ...ambData]
        .filter((p) => p.x >= xMin && p.x <= xMax)
        .map((p) => p.y)
        .filter((v) => Number.isFinite(v));
      if (allTempVals.length > 0) {
        const dataMinY = Math.min(...allTempVals);
        const dataMaxY = Math.max(...allTempVals);
        const span = dataMaxY - dataMinY;
        if (span < 5) {
          const center = (dataMinY + dataMaxY) / 2;
          yTempMin = center - 2.5;
          yTempMax = center + 2.5;
        } else {
          yTempMin = dataMinY;
          yTempMax = dataMaxY;
        }
      }

      let yHumMin;
      let yHumMax;
      const allHumVals = humData
        .filter((p) => p.x >= xMin && p.x <= xMax)
        .map((p) => p.y)
        .filter((v) => Number.isFinite(v));
      if (allHumVals.length > 0) {
        const dataMinY = Math.min(...allHumVals);
        const dataMaxY = Math.max(...allHumVals);
        const span = dataMaxY - dataMinY;
        if (span < 10) {
          const center = (dataMinY + dataMaxY) / 2;
          yHumMin = Math.max(0, center - 5);
          yHumMax = Math.min(100, center + 5);
        } else {
          yHumMin = dataMinY;
          yHumMax = dataMaxY;
        }
      }

      console.log("[CHART] y-axis range:", {
        dataMin: yTempMin,
        dataMax: yTempMax,
      });

      this._chart = new Chart(canvas, {
        type: "line",
        plugins: [hoverGuidePlugin],
        data: {
          datasets: [
            {
              label: "Compressor",
              data: stateData,
              borderColor: "rgba(250, 204, 21, 0.32)",
              backgroundColor: "rgba(250, 204, 21, 0.12)",
              borderWidth: 1,
              pointRadius: 0,
              fill: true,
              stepped: true,
              yAxisID: "yState",
            },
            {
              label: "Fridge (°C)",
              data: tempData,
              borderColor: "rgb(239, 68, 68)",
              borderWidth: 1.5,
              pointRadius: 0,
              fill: false,
              yAxisID: "yTemp",
            },
            {
              label: "Ambient (°C)",
              data: ambData,
              borderColor: "rgb(249, 115, 22)",
              borderWidth: 1.5,
              pointRadius: 0,
              fill: false,
              yAxisID: "yTemp",
            },
            {
              label: "Humidity (%)",
              data: humData,
              borderColor: "rgb(20, 184, 166)",
              borderWidth: 1.5,
              pointRadius: 0,
              fill: false,
              yAxisID: "yHum",
            },
          ],
        },
        options: {
          responsive: true,
          animation: true,
          parsing: false,
          interaction: {
            mode: "index",
            axis: "x",
            intersect: false,
          },
          scales: {
            x: {
              type: "time",
              min: xMin,
              max: xMax,
              time: {
                tooltipFormat: "HH:mm:ss",
                displayFormats: {
                  second: "HH:mm:ss",
                  minute: "HH:mm",
                  hour: "HH:mm",
                },
              },
              ticks: { autoSkip: true, maxTicksLimit: 8 },
            },
            yTemp: {
              type: "linear",
              position: "left",
              min: yTempMin,
              max: yTempMax,
              title: { display: false, text: "°C" },
              ticks: {
                stepSize: 0.1,
                precision: 1,
                padding: 0,
              },
            },
            yState: {
              type: "linear",
              position: "right",
              min: 0,
              max: 2,
              display: true,
              grid: {
                drawOnChartArea: false,
                drawTicks: false,
              },
              border: {
                display: false,
              },
              ticks: {
                display: false,
                stepSize: 1,
              },
            },
            yHum: {
              type: "linear",
              position: "right",
              min: yHumMin,
              max: yHumMax,
              grid: {
                drawOnChartArea: false,
              },
              title: { display: false, text: "%RH" },
              ticks: {
                stepSize: 10,
                callback: (val) => `${val}%`,
              },
            },
          },
          plugins: {
            decimation: {
              enabled: true,
              algorithm: "lttb",
              samples: 400,
              threshold: 800,
            },
            hoverGuide: {
              color: "rgba(100, 116, 139, 0.55)",
              lineWidth: 1,
              dash: [4, 4],
            },
            legend: { display: true },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  if (!Number.isFinite(ctx.parsed.y)) {
                    return `${ctx.dataset.label}: —`;
                  }
                  if (ctx.dataset.yAxisID === "yState") {
                    return `${ctx.dataset.label}: ${["OFF", "CoolDown", "ON"][ctx.parsed.y] ?? "?"}`;
                  }
                  if (ctx.dataset.yAxisID === "yHum") {
                    return `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(0)} %`;
                  }
                  return `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} °C`;
                },
              },
            },
          },
        },
      });
    },
  };
}
