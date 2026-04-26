const SVC_UUID = "6e657665-7269-6e61-8000-000000000001";

const CHAR_UUID = {
  // Config
  TEMP_STOP: "6e657665-7269-6e61-8000-000000000011",
  TEMP_START: "6e657665-7269-6e61-8000-000000000012",
  MIN_OFF: "6e657665-7269-6e61-8000-000000000013",
  MAX_RUN: "6e657665-7269-6e61-8000-000000000014",
  COOLDOWN: "6e657665-7269-6e61-8000-000000000015",
  TEMP_INT: "6e657665-7269-6e61-8000-000000000016",
  // Status
  CURR_TEMP: "6e657665-7269-6e61-8000-000000000021",
  COMP_STATE: "6e657665-7269-6e61-8000-000000000022",
  STATE_TIME: "6e657665-7269-6e61-8000-000000000023",
  ERR_STATUS: "6e657665-7269-6e61-8000-000000000024",
  UPTIME: "6e657665-7269-6e61-8000-000000000025",
  CURR_AMB: "6e657665-7269-6e61-8000-000000000026",
  // History
  TIME_SYNC: "6e657665-7269-6e61-8000-000000000031",
  HIST_CTRL: "6e657665-7269-6e61-8000-000000000041",
  HIST_DATA: "6e657665-7269-6e61-8000-000000000042",
  // OTA trigger
  OTA_TRIGGER: "6e657665-7269-6e61-8000-000000000051",
};

// Sentinel returned by DS18B20 when disconnected
const SENSOR_DISCONNECTED = -127;

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
      minOff: 240,
      maxRun: 3000,
      cooldown: 600,
      tempInt: 10,
    },

    // ── Live status (updated via BLE notifications) ────────────
    status: {
      temp: null, // float °C  (null = sensor error / disconnected)
      ambTemp: null, // float °C  SHT30 ambient (null = sensor error)
      state: null, // 0=OFF 1=COOLDOWN 2=ON
      stateTime: null, // uint32 seconds in current state
      errors: null, // uint8 bitmask (null = unknown, 0 = OK)
      uptime: null, // uint32 seconds since boot
    },

    // ── Time sync anchor (set on each connect) ─────────────────
    _millisAnc: 0, // uint32: millis() on device at sync moment
    _epochBaseMs: 0n, // BigInt: Unix ms at sync moment

    // ── History ────────────────────────────────────────────────
    histLoading: false,
    histError: null,
    histAvailable: false, // true once HIST_CTRL has been read
    tempRecords: [], // { t: AbsMs (Number), v: float }
    ambRecords: [], // { t: AbsMs (Number), v: float }  SHT30
    stateRecords: [], // { t: AbsMs (Number), s: 0|1|2 }
    _nextHistRequestId: 1,
    _chart: null,

    // ── UI feedback ────────────────────────────────────────────
    saving: false,
    saveError: null,
    validationErrors: {},

    // ── BLE handles (private) ──────────────────────────────────
    _device: null,
    _chars: {},

    // ── Public actions ─────────────────────────────────────────

    async connect() {
      if (!navigator.bluetooth) {
        alert("Web Bluetooth is not supported.\nUse Chrome on Desktop or Android.");
        return;
      }
      this.connecting = true;
      try {
        this._device = await navigator.bluetooth.requestDevice({
          filters: [{ name: "Neverina" }],
          optionalServices: [SVC_UUID],
        });

        this._device.addEventListener("gattserverdisconnected", () => {
          this.connected = false;
          this.deviceName = null;
          this.histAvailable = false;
          this.status = { temp: null, ambTemp: null, state: null, stateTime: null, errors: null, uptime: null };
          this._chars = {};
        });

        const server = await this._device.gatt.connect();
        const service = await server.getPrimaryService(SVC_UUID);

        for (const [key, uuid] of Object.entries(CHAR_UUID)) {
          this._chars[key] = await service.getCharacteristic(uuid);
        }

        await this._subscribeStatus();
        await this._subscribeHistData();

        this.connected = true;
        this.deviceName = this._device.name;

        await this._syncTime();
        await this.readAll();
        await this._readHistCounts();
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
          if (v.byteLength < 4) return null; // uninitialized characteristic
          return v.getFloat32(0, true);
        };
        const ru = async (c) => {
          const v = await c.readValue();
          return v.getUint32(0, true);
        };

        this.params.tempStop = +(await rf(this._chars.TEMP_STOP)).toFixed(1);
        this.params.tempStart = +(await rf(this._chars.TEMP_START)).toFixed(1);
        this.params.minOff = await ru(this._chars.MIN_OFF);
        this.params.maxRun = await ru(this._chars.MAX_RUN);
        this.params.cooldown = await ru(this._chars.COOLDOWN);
        this.params.tempInt = await ru(this._chars.TEMP_INT);

        const tempVal = await rf(this._chars.CURR_TEMP);
        this.status.temp = tempVal !== SENSOR_DISCONNECTED ? tempVal : null;
        const ambVal = await rf(this._chars.CURR_AMB);
        this.status.ambTemp = ambVal !== SENSOR_DISCONNECTED ? ambVal : null;
        this.status.state = (await this._chars.COMP_STATE.readValue()).getUint8(0);
        this.status.stateTime = await ru(this._chars.STATE_TIME);
        this.status.errors = (await this._chars.ERR_STATUS.readValue()).getUint8(0);
        this.status.uptime = (await this._chars.UPTIME.readValue()).getUint32(0, true);
      } catch (err) {
        console.error("readAll failed:", err);
      }
    },

    _validateParams() {
      const e = {};
      if (this.params.minOff < 120) e.minOff = "Minimum 2 min (120 s)";
      if (this.params.minOff > 600) e.minOff = "Maximum 600 s";
      if (this.params.maxRun < 600) e.maxRun = "Minimum 10 min (600 s)";
      if (this.params.maxRun > 7200) e.maxRun = "Maximum 7200 s";
      if (this.params.cooldown < 120) e.cooldown = "Minimum 2 min (120 s)";
      if (this.params.cooldown > 1800) e.cooldown = "Maximum 1800 s";
      if (this.params.tempInt < 5) e.tempInt = "Minimum 5 s";
      if (this.params.tempInt > 60) e.tempInt = "Maximum 60 s";
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

        await wf(this._chars.TEMP_STOP, this.params.tempStop);
        await wf(this._chars.TEMP_START, this.params.tempStart);
        await wu(this._chars.MIN_OFF, this.params.minOff);
        await wu(this._chars.MAX_RUN, this.params.maxRun);
        await wu(this._chars.COOLDOWN, this.params.cooldown);
        await wu(this._chars.TEMP_INT, this.params.tempInt);
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
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      if (s > 0) return `${h}h ${m}m ${s}s`;
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    },

    // ── Private ────────────────────────────────────────────────

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

    async _readHistCounts() {
      const v = await this._chars.HIST_CTRL.readValue();
      const tempCount = v.getUint32(0, true);
      const stateCount = v.getUint32(4, true);
      const ambCount = v.byteLength >= 12 ? v.getUint32(8, true) : 0;
      this.histAvailable = tempCount > 0 || stateCount > 0 || ambCount > 0;
      return { tempCount, stateCount, ambCount };
    },

    async _subscribeStatus() {
      const self = this;

      await this._chars.CURR_TEMP.startNotifications();
      this._chars.CURR_TEMP.addEventListener("characteristicvaluechanged", (e) => {
        if (!e.target.value || e.target.value.byteLength < 4) return;
        const val = e.target.value.getFloat32(0, true);
        self.status.temp = val !== SENSOR_DISCONNECTED ? val : null;
      });

      await this._chars.COMP_STATE.startNotifications();
      this._chars.COMP_STATE.addEventListener("characteristicvaluechanged", (e) => {
        if (!e.target.value || e.target.value.byteLength < 1) return;
        self.status.state = e.target.value.getUint8(0);
      });

      await this._chars.STATE_TIME.startNotifications();
      this._chars.STATE_TIME.addEventListener("characteristicvaluechanged", (e) => {
        if (!e.target.value || e.target.value.byteLength < 4) return;
        self.status.stateTime = e.target.value.getUint32(0, true);
      });

      await this._chars.ERR_STATUS.startNotifications();
      this._chars.ERR_STATUS.addEventListener("characteristicvaluechanged", (e) => {
        if (!e.target.value || e.target.value.byteLength < 1) return;
        self.status.errors = e.target.value.getUint8(0);
      });

      await this._chars.UPTIME.startNotifications();
      this._chars.UPTIME.addEventListener("characteristicvaluechanged", (e) => {
        if (!e.target.value || e.target.value.byteLength < 4) return;
        self.status.uptime = e.target.value.getUint32(0, true);
      });

      await this._chars.CURR_AMB.startNotifications();
      this._chars.CURR_AMB.addEventListener("characteristicvaluechanged", (e) => {
        if (!e.target.value || e.target.value.byteLength < 4) return;
        const val = e.target.value.getFloat32(0, true);
        self.status.ambTemp = val !== SENSOR_DISCONNECTED ? val : null;
      });
    },

    async _subscribeHistData() {
      // Keep notifications enabled. Each request installs its own temporary
      // listener keyed by requestId and dataset type.
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
        records.push({ t: this._millisToEpoch(ms), v: tempX10 / 10 });
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
        const tempBuf = await this._requestDump(0, 0);
        const stateBuf = await this._requestDump(1, 0);
        const ambBuf = await this._requestDump(2, 0);
        this.tempRecords = this._parseTempBuf(tempBuf);
        this.stateRecords = this._parseStateBuf(stateBuf);
        this.ambRecords = this._parseTempBuf(ambBuf);
        this._buildChart();
      } catch (err) {
        this.histError = err.message;
        console.error("[HIST] Load failed:", err);
      } finally {
        this.histLoading = false;
      }
    },

    _buildChart() {
      const canvas = document.getElementById("histChart");
      if (!canvas) return;

      if (this._chart) {
        this._chart.destroy();
        this._chart = null;
      }

      const now = Date.now();

      // Filter out -127 (sensor disconnected) for temperature
      const tempData = this.tempRecords.filter((r) => r.v !== -127).map((r) => ({ x: r.t, y: r.v }));
      if (tempData.length > 0) {
        tempData.push({ x: now, y: tempData[tempData.length - 1].y });
      }

      const ambData = this.ambRecords.filter((r) => r.v !== -127).map((r) => ({ x: r.t, y: r.v }));
      if (ambData.length > 0) {
        ambData.push({ x: now, y: ambData[ambData.length - 1].y });
      }

      const stateData = this.stateRecords.map((r) => ({ x: r.t, y: r.s }));
      if (stateData.length > 0) {
        stateData.push({ x: now, y: stateData[stateData.length - 1].y });
      }

      let yTempMin;
      let yTempMax;
      const allTempVals = [...tempData, ...ambData].map((p) => p.y);
      if (allTempVals.length > 0) {
        const dataMin = Math.min(...allTempVals);
        const dataMax = Math.max(...allTempVals);
        const span = dataMax - dataMin;
        if (span < 5) {
          const center = (dataMin + dataMax) / 2;
          yTempMin = center - 2.5;
          yTempMax = center + 2.5;
        } else {
          yTempMin = dataMin;
          yTempMax = dataMax;
        }
      }

      this._chart = new Chart(canvas, {
        type: "line",
        data: {
          datasets: [
            {
              label: "Compressor",
              data: stateData,
              borderColor: "rgba(234, 88, 12, 0.4)",
              backgroundColor: "rgba(234, 88, 12, 0.15)",
              borderWidth: 1,
              pointRadius: 0,
              fill: true,
              stepped: true,
              yAxisID: "yState",
            },
            {
              label: "Fridge (°C)",
              data: tempData,
              borderColor: "rgb(59, 130, 246)",
              borderWidth: 1.5,
              pointRadius: 0,
              fill: false,
              yAxisID: "yTemp",
            },
            {
              label: "Ambient (°C)",
              data: ambData,
              borderColor: "rgb(251, 146, 60)",
              borderWidth: 1.5,
              pointRadius: 0,
              fill: false,
              yAxisID: "yTemp",
            },
          ],
        },
        options: {
          responsive: true,
          interaction: { mode: "index", intersect: false },
          scales: {
            x: {
              type: "time",
              max: now,
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
              title: { display: false, text: "State" },
              ticks: {
                padding: 0,
                stepSize: 1,
                callback: (val) => ["OFF", "CD", "ON"][val] ?? "",
              },
            },
          },
          plugins: {
            legend: { display: true },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  if (ctx.dataset.yAxisID === "yState") {
                    return "State: " + (["OFF", "CoolDown", "ON"][ctx.parsed.y] ?? "?");
                  }
                  return ctx.parsed.y.toFixed(1) + " °C";
                },
              },
            },
          },
        },
      });
    },
  };
}
