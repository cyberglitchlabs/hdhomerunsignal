const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { execFile } = require('child_process');
const https = require('https');
const path = require('path');
const rateLimit = require('express-rate-limit');
const validate = require('./validate');

// hdhomerun_config is always run without a shell: arguments are passed as an
// array, so request-derived values can never be interpreted as shell syntax.
function hdhr(args, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  return execFile('hdhomerun_config', args, options, callback);
}

// The frontend is served by this server, so cross-origin access is off unless
// origins are explicitly allowed (comma-separated) via HDHR_ALLOWED_ORIGINS.
const allowedOrigins = new Set(
  (process.env.HDHR_ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
);

// Browsers do not enforce CORS on WebSockets, so check Origin ourselves:
// no Origin (non-browser client), same host, or an allowlisted origin.
function isOriginAllowed(origin, host) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch (e) {
    return false;
  }
}

const app = express();
const server = createServer(app);
const io = new Server(server, {
  allowRequest: (req, callback) => {
    callback(null, isOriginAllowed(req.headers.origin, req.headers.host));
  }
});

app.disable('x-powered-by');

// Behind a reverse proxy the client address comes from X-Forwarded-For, which is
// only safe to believe when it was set by a proxy we trust. HDHR_TRUST_PROXY is
// a proxy hop count or a list of proxy IPs/CIDRs; unset means "do not trust".
// An invalid value stops the server rather than silently falling back.
const trustProxy = validate.parseTrustProxy(process.env.HDHR_TRUST_PROXY);
if (trustProxy.error) {
  console.error(validate.logSafe(trustProxy.error));
  process.exit(1);
}
app.set('trust proxy', trustProxy.value);

// Every API call spawns a hdhomerun_config process, so requests are limited per
// client address. HDHR_RATE_LIMIT is requests per minute (0 disables). Without
// HDHR_TRUST_PROXY, clients behind a reverse proxy all share the proxy's address
// and therefore one bucket; the default is generous enough for that.
const rateLimitPerMinute = Number.parseInt(process.env.HDHR_RATE_LIMIT || '300', 10);
const tooManyRequests = (req, res) => res.status(429).json({ error: 'Too many requests' });
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: rateLimitPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: tooManyRequests,
  skip: () => rateLimitPerMinute <= 0
});
// A channel scan occupies a tuner for up to a minute, so it gets a tight limit.
const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: tooManyRequests,
  skip: () => rateLimitPerMinute <= 0
});
app.use(generalLimiter);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  } else if (origin && !isOriginAllowed(origin, req.headers.host) && req.path.startsWith('/api/')) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

class HDHomeRunController {
  constructor() {
    this.devices = [];
    this.activeDevice = null;
    this.activeTuner = 0;
    this.monitoringIntervals = new Map(); // Per-socket monitoring intervals
    this.plpUnavailableLogged = new Set(); // Devices already reported as lacking PLP info
    this.deviceNameCache = new Map(); // Cache for device name lookups
    this.cacheTTL = 5 * 60 * 1000; // 5 minute TTL
    this.httpDiscoveryCache = null; // Cached HTTP API results; only refreshed on explicit user request
  }

  async discoverDevices(forceRefresh = false) {
    // Clear device name cache on explicit user refresh to ensure fresh data
    if (forceRefresh) this.deviceNameCache.clear();

    const devices = [];
    const deviceSet = new Set(); // Track seen device IDs
    const disableDiscovery = process.env.HDHOMERUN_DISABLE_DISCOVERY === 'true';
    const manualDevices = process.env.HDHOMERUN_DEVICES || '';

    // Auto-discover devices unless disabled
    if (!disableDiscovery) {
      const autoDiscovered = await this.autoDiscoverDevices(forceRefresh);
      autoDiscovered.forEach(device => {
        if (!deviceSet.has(device.id)) {
          deviceSet.add(device.id);
          devices.push(device);
        }
      });
    } else {
      console.log('Auto-discovery disabled via HDHOMERUN_DISABLE_DISCOVERY');
    }

    // Add manually specified devices
    if (manualDevices) {
      const manualHosts = manualDevices.split(',').map(h => h.trim()).filter(h => h).filter(h => {
        if (validate.deviceHost(h)) return true;
        console.error(`Ignoring invalid HDHOMERUN_DEVICES entry: ${JSON.stringify(h)}`);
        return false;
      });
      console.log(`Adding ${manualHosts.length} manual device(s):`, manualHosts);

      const manualResults = await Promise.all(
        manualHosts.map(host => this.getDeviceByHost(host))
      );

      manualResults.forEach(device => {
        if (device && !deviceSet.has(device.id)) {
          deviceSet.add(device.id);
          devices.push(device);
          console.log(`Added manual device: ${device.id} at ${device.ip} (${device.online ? 'online' : 'offline'})`);
        }
      });
    }

    this.devices = devices;
    return devices;
  }

  async autoDiscoverDevices(forceRefresh = false) {
    // Try UDP broadcast discovery first
    const udpDevices = await this.udpDiscoverDevices();
    if (udpDevices.length > 0) {
      console.log(`UDP discovery found ${udpDevices.length} device(s)`);
      return udpDevices;
    }

    // Fallback to HTTP discovery API - only hit the remote API on explicit user refresh
    // to avoid hammering the HDHomeRun cloud service on every automatic call.
    if (!forceRefresh && this.httpDiscoveryCache !== null) {
      console.log(`UDP discovery found no devices, using cached HTTP discovery results (${this.httpDiscoveryCache.length} device(s))`);
      return this.httpDiscoveryCache;
    }

    console.log('UDP discovery found no devices, trying HTTP discovery fallback...');
    const httpDevices = await this.httpDiscoverDevices();
    if (httpDevices.length > 0) {
      console.log(`HTTP discovery found ${httpDevices.length} device(s)`);
    } else {
      console.log('HTTP discovery also found no devices');
    }
    this.httpDiscoveryCache = httpDevices;
    return httpDevices;
  }

  async udpDiscoverDevices() {
    return new Promise((resolve) => {
      hdhr(['discover'], { timeout: 5000 }, (error, stdout, stderr) => {
        if (error) {
          console.error('UDP discovery error:', error.message);
          resolve([]);
          return;
        }

        const deviceSet = new Set();
        const discoveredDevices = [];
        const lines = stdout.split('\n').filter(line => line.trim());

        lines.forEach(line => {
          const match = line.match(/hdhomerun device ([A-F0-9-]+) found at ([0-9.]+)/);
          if (match) {
            const deviceId = match[1];
            const deviceIp = match[2];

            if (!deviceSet.has(deviceId)) {
              deviceSet.add(deviceId);
              discoveredDevices.push({ deviceId, deviceIp });
            }
          }
        });

        // Fetch model info for each discovered device
        Promise.all(
          discoveredDevices.map(({ deviceId, deviceIp }) => this.getDeviceModel(deviceIp).then(model => ({
            id: deviceId,
            ip: deviceIp,
            name: model ? `HDHomeRun ${deviceId} (${model})` : `HDHomeRun ${deviceId}`,
            online: true
          })))
        ).then(devices => resolve(devices));
      });
    });
  }

  async httpDiscoverDevices() {
    return new Promise((resolve) => {
      const req = https.get('https://ipv4-api.hdhomerun.com/discover', (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const entries = JSON.parse(data);
            // Filter to tuner devices only (they have DeviceID; DVRs have StorageID instead)
            const tuners = entries.filter(e => e.DeviceID);

            Promise.all(
              tuners.map(entry => {
                const ip = entry.LocalIP;
                const deviceId = entry.DeviceID;
                return this.getDeviceModel(ip).then(model => ({
                  id: ip,
                  ip: ip,
                  name: model
                    ? `HDHomeRun ${deviceId} (${model})`
                    : `HDHomeRun ${deviceId}`,
                  online: true
                }));
              })
            ).then(devices => resolve(devices));
          } catch (parseErr) {
            console.error('HTTP discovery JSON parse error:', parseErr.message);
            resolve([]);
          }
        });
      });

      req.on('error', (err) => {
        console.error('HTTP discovery request error: %s', validate.logSafe(err.message));
        resolve([]);
      });

      req.setTimeout(5000, () => {
        req.destroy();
        console.error('HTTP discovery request timed out');
        resolve([]);
      });
    });
  }

  async getDeviceModel(host) {
    return new Promise((resolve) => {
      hdhr([host, 'get', '/sys/hwmodel'], { timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout.trim() || null);
      });
    });
  }

  async getDeviceByHost(host) {
    // Check cache first
    const cached = this.deviceNameCache.get(host);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      console.log(`Using cached device info for ${host}`);
      return cached.device;
    }

    return new Promise((resolve) => {
      // Query the device to verify it's reachable and get model info for the name
      hdhr([host, 'get', '/sys/hwmodel'], { timeout: 5000 }, (error, stdout) => {
        if (error) {
          console.error(`Failed to query device at ${host}:`, error.message);
          // Return offline device instead of null so UI can show it grayed out
          const offlineDevice = {
            id: host,
            ip: host,
            name: `HDHomeRun (${host})`,
            online: false
          };
          this.deviceNameCache.set(host, { device: offlineDevice, timestamp: Date.now() });
          resolve(offlineDevice);
          return;
        }

        const model = stdout.trim() || 'Unknown';

        // Try to get the device ID for display purposes
        hdhr(['discover', host], { timeout: 5000 }, (discoverErr, discoverOut) => {
          const match = discoverOut && discoverOut.match(/hdhomerun device ([A-F0-9-]+) found at ([0-9.]+)/);
          const deviceId = match ? match[1] : null;

          // Always use the user-specified host as the ID for commands
          // This ensures hdhomerun_config can reach the device directly by IP/hostname
          // rather than trying to rediscover it (which may fail across subnets)
          const device = {
            id: host,
            ip: host,
            name: deviceId ? `HDHomeRun ${deviceId} (${model})` : `HDHomeRun ${model} (${host})`,
            online: true
          };

          // Cache the result
          this.deviceNameCache.set(host, { device, timestamp: Date.now() });
          console.log(`Cached device info for ${host}`);

          resolve(device);
        });
      });
    });
  }

  async getDeviceInfo(deviceId) {
    return new Promise((resolve, reject) => {
      // Get both model and tuner count
      hdhr([deviceId, 'get', '/sys/model'], (error, stdout) => {
        if (error) {
          resolve({ model: 'Unknown', tuners: 2, atsc3Support: false });
          return;
        }
        
        const model = stdout.trim();
        
        // ATSC 3.0 support - will be auto-detected based on PLP data availability
        const atsc3Support = true; // Auto-detect rather than model-based
        
        // Try to get actual tuner count by checking which tuners exist
        this.getTunerCount(deviceId).then(tunerCount => {
          resolve({ model, tuners: tunerCount, atsc3Support });
        }).catch(() => {
          // Fallback to model-based detection
          let tuners = 2;
          if (model.includes('PRIME')) tuners = 3;
          else if (model.includes('QUATTRO') || model.includes('QUATRO')) tuners = 4;
          else if (model.includes('DUO')) tuners = 2;
          else if (model.includes('FLEX')) tuners = 2;
          else if (model.includes('CONNECT')) tuners = 2;
          
          resolve({ model, tuners, atsc3Support });
        });
      });
    });
  }

  async getTunerCount(deviceId) {
    return new Promise((resolve, reject) => {
      // Check tuners 0-7 to see which ones exist
      const checkTuner = (tunerNum) => {
        return new Promise((resolveCheck) => {
          hdhr([deviceId, 'get', `/tuner${tunerNum}/status`], (error, stdout) => {
            // If no error, tuner exists (even if status is 'none')
            resolveCheck(!error);
          });
        });
      };

      Promise.all([
        checkTuner(0), checkTuner(1), checkTuner(2), checkTuner(3),
        checkTuner(4), checkTuner(5), checkTuner(6), checkTuner(7)
      ]).then(results => {
        const tunerCount = results.filter(exists => exists).length;
        resolve(tunerCount > 0 ? tunerCount : 2); // Default to 2 if none found
      }).catch(() => {
        resolve(2); // Default fallback
      });
    });
  }

  async scanChannels(deviceId, tuner = 0, channelMap = 'us-bcast') {
    return new Promise((resolve, reject) => {
      hdhr([deviceId, 'scan', `/tuner${tuner}`, channelMap], { timeout: 60000 }, (error, stdout, stderr) => {
        if (error) {
          console.error('Scan error:', error);
          resolve([]);
          return;
        }

        const channels = [];
        const lines = stdout.split('\n');
        
        lines.forEach(line => {
          const scanMatch = line.match(/SCANNING: (\d+) \(([^)]+)\)/);
          const lockMatch = line.match(/LOCK: (\w+) \(ss=(\d+) snq=(\d+) seq=(\d+)\)/);
          const programMatch = line.match(/PROGRAM (\d+): ([\d.]+) (.+)/);
          
          if (scanMatch && lockMatch) {
            const frequency = scanMatch[1];
            const channel = scanMatch[2];
            const modulation = lockMatch[1];
            const signalStrength = parseInt(lockMatch[2]);
            const snr = parseInt(lockMatch[3]);
            const symbolQuality = parseInt(lockMatch[4]);
            
            channels.push({
              frequency,
              channel,
              modulation,
              signalStrength,
              snr,
              symbolQuality,
              programs: []
            });
          }
          
          if (programMatch && channels.length > 0) {
            const programNum = programMatch[1];
            const virtualChannel = programMatch[2];
            const name = programMatch[3];
            
            channels[channels.length - 1].programs.push({
              programNum,
              virtualChannel,
              name
            });
          }
        });

        resolve(channels);
      });
    });
  }

  async getTunerStatus(deviceId, tuner = 0) {
    return new Promise(async (resolve, reject) => {
      try {
        // Get both regular status and debug info simultaneously
        const [statusResult, debugResult] = await Promise.all([
          this.getStatusCommand(deviceId, tuner, 'status'),
          this.getStatusCommand(deviceId, tuner, 'debug')
        ]);

        if (!statusResult) {
          resolve(null);
          return;
        }

        const status = {};
        const statusLine = statusResult.trim();
        
        if (statusLine === 'none') {
          resolve({ channel: 'none', lock: false });
          return;
        }

        const patterns = {
          channel: /ch=([^\s]+)/,
          lock: /lock=([^\s]+)/,
          ss: /ss=(\d+)/,
          snq: /snq=(\d+)/,
          seq: /seq=(\d+)/,
          bps: /bps=(\d+)/,
          pps: /pps=(\d+)/
        };

        Object.entries(patterns).forEach(([key, pattern]) => {
          const match = statusLine.match(pattern);
          if (match) {
            status[key] = key === 'lock' ? match[1] : 
                         ['ss', 'snq', 'seq', 'bps', 'pps'].includes(key) ? 
                         parseInt(match[1]) : match[1];
          }
        });

        status.lock = status.lock !== undefined;
        
        // Extract dB values from debug output with educated conversion
        if (debugResult) {
          const dbgMatch = debugResult.match(/dbg=(\d+)-(\d+)\/(-?\d+)/);
          if (dbgMatch) {
            const signalRaw = parseInt(dbgMatch[1]);
            const snrRaw = parseInt(dbgMatch[2]);
            
            // Signal strength: map raw values to realistic ATSC dBm range
            // Based on observed data: 9-86 raw maps to roughly -80 to -40 dBm
            let estimatedSignalDbm;
            if (signalRaw >= 80) estimatedSignalDbm = -40 - (100 - signalRaw) * 0.5;  // Strong: -40 to -50
            else if (signalRaw >= 60) estimatedSignalDbm = -50 - (80 - signalRaw) * 0.5;   // Good: -50 to -60
            else if (signalRaw >= 20) estimatedSignalDbm = -60 - (60 - signalRaw) * 0.5;   // Fair: -60 to -80
            else estimatedSignalDbm = -80 - (20 - signalRaw) * 0.5;                       // Weak: -80+
            
            // SNR: more direct conversion (0-80 raw ≈ 0-25 dB)
            const estimatedSnrDb = snrRaw * 0.31; // Rough linear conversion
            
            status.ssDb = Math.round(estimatedSignalDbm * 10) / 10;
            status.snrDb = snrRaw > 0 ? Math.round(estimatedSnrDb * 10) / 10 : 0;
            status.debugRaw = `${signalRaw}-${snrRaw}/${dbgMatch[3]}`;
            
            console.log(`dB estimate: ${status.ss}% signal = ${signalRaw} raw → ${status.ssDb}dBm, ${status.snq}% SNR = ${snrRaw} raw → ${status.snrDb}dB`);
          }
        }
        
        resolve(status);
      } catch (error) {
        resolve(null);
      }
    });
  }

  async getStatusCommand(deviceId, tuner, command) {
    return new Promise((resolve) => {
      hdhr([deviceId, 'get', `/tuner${tuner}/${command}`], (error, stdout) => {
        if (error) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  async getSignalDbValues(deviceId, tuner = 0) {
    return new Promise((resolve, reject) => {
      // Try to get dB values using various debug commands
      Promise.all([
        this.getDbValue(deviceId, tuner, 'debug'),
        this.getDbValue(deviceId, tuner, 'vstatus'),
        this.getDbValue(deviceId, tuner, 'streaminfo'),
        this.getDbValue(deviceId, tuner, 'plotsample')
      ]).then(results => {
        console.log(`dB query results for ${deviceId} tuner ${tuner}:`, results);
        
        const dbData = {};
        
        // Parse results for dB values
        results.forEach((result, index) => {
          if (result) {
            console.log(`Command ${index} output:`, result);
            
            // Look for HDHomeRun debug format: dbg=65-19/-1817
            const dbgMatch = result.match(/dbg=(\d+)-(\d+)\/(-?\d+)/);
            if (dbgMatch) {
              // Format appears to be: signal-snr/something
              const signalRaw = parseInt(dbgMatch[1]);
              const snrRaw = parseInt(dbgMatch[2]);
              const thirdValue = parseInt(dbgMatch[3]);
              
              // Convert to actual dB values 
              // Different conversion for ATSC 1.0 vs 3.0 - try simpler mapping
              // For 71% signal, expect around -50 to -60 dBm
              dbData.ssDb = -100 + (signalRaw * 0.5); // Linear scaling attempt
              dbData.snrDb = snrRaw;
              dbData.debugRaw = `${signalRaw}-${snrRaw}/${thirdValue}`;
              
              console.log(`Converted dB values: signal=${signalRaw} -> ${dbData.ssDb}dBm, snr=${snrRaw} -> ${dbData.snrDb}dB`);
            }
            
            // Look for standard dB patterns as fallback
            const ssDbMatch = result.match(/ss=(-?\d+(?:\.\d+)?)dBm/i);
            const snrDbMatch = result.match(/snr=(-?\d+(?:\.\d+)?)dB/i);
            const rssiMatch = result.match(/rssi=(-?\d+(?:\.\d+)?)/i);
            
            if (ssDbMatch) dbData.ssDb = parseFloat(ssDbMatch[1]);
            if (snrDbMatch) dbData.snrDb = parseFloat(snrDbMatch[1]);
            if (rssiMatch) dbData.rssi = parseFloat(rssiMatch[1]);
          }
        });
        
        console.log('Parsed dB data:', dbData);
        resolve(dbData);
      }).catch((error) => {
        console.log('dB query error:', error);
        resolve({});
      });
    });
  }

  async getDbValue(deviceId, tuner, command) {
    return new Promise((resolve) => {
      hdhr([deviceId, 'get', `/tuner${tuner}/${command}`], (error, stdout) => {
        if (error) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  async getCurrentProgram(deviceId, tuner = 0) {
    return new Promise((resolve, reject) => {
      hdhr([deviceId, 'get', `/tuner${tuner}/program`], (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }

        const program = stdout.trim();
        if (program && program !== 'none') {
          resolve(program);
        } else {
          resolve(null);
        }
      });
    });
  }

  async getCurrentChannelPrograms(deviceId, tuner = 0, maxRetries = 3) {
    return new Promise(async (resolve, reject) => {
      // First check if tuner is locked
      const status = await this.getTunerStatus(deviceId, tuner);
      if (!status || !status.lock || status.channel === 'none') {
        resolve([]);
        return;
      }

      let attempt = 0;
      const tryGetPrograms = () => {
        hdhr([deviceId, 'get', `/tuner${tuner}/streaminfo`], (error, stdout) => {
          if (error) {
            if (attempt < maxRetries) {
              attempt++;
              setTimeout(tryGetPrograms, 1500); // Wait 1.5s between retries
              return;
            }
            resolve([]);
            return;
          }

          const programs = [];
          const lines = stdout.split('\n').filter(line => line.trim());
          
          lines.forEach(line => {
            // Enhanced parsing for both ATSC 1.0 and 3.0 formats
            // ATSC 1.0: tsid=0x0001 program=1: 12.1 WHYY (encrypted)
            // ATSC 3.0: service=1: 12.1 WHYY (atsc3) or program=1: 12.1 WHYY
            const programMatch = line.match(/(?:program|service)=(\d+):\s*([\d.]+)\s+(.+?)(?:\s+\(([^)]+)\))?$/);
            if (programMatch) {
              const programNum = programMatch[1];
              const virtualChannel = programMatch[2];
              const name = programMatch[3].trim();
              const status = programMatch[4] || '';
              
              programs.push({
                programNum,
                virtualChannel,
                name,
                callsign: name,
                status,
                encrypted: status.includes('encrypted'),
                atsc3: status.includes('atsc3')
              });
            } else {
              // Try alternative format parsing
              const altMatch = line.match(/(\d+):\s*([\d.]+)\s+(.+?)(?:\s+\(([^)]+)\))?$/);
              if (altMatch) {
                programs.push({
                  programNum: altMatch[1],
                  virtualChannel: altMatch[2],
                  name: altMatch[3].trim(),
                  callsign: altMatch[3].trim(),
                  status: altMatch[4] || '',
                  encrypted: (altMatch[4] || '').includes('encrypted'),
                  atsc3: (altMatch[4] || '').includes('atsc3')
                });
              }
            }
          });

          // If no programs found and we have retries left, try again
          if (programs.length === 0 && attempt < maxRetries) {
            attempt++;
            setTimeout(tryGetPrograms, 2000); // Wait longer for ATSC 3.0
            return;
          }

          resolve(programs);
        });
      };

      tryGetPrograms();
    });
  }

  async setChannel(deviceId, tuner, channel) {
    return new Promise((resolve, reject) => {
      // ATSC 3.0 (atsc3:27:0+1+2) and regular channels use the same set command
      hdhr([deviceId, 'set', `/tuner${tuner}/channel`, channel], (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async setAtsc3Channel(deviceId, tuner, channel, plps = []) {
    return new Promise((resolve, reject) => {
      let channelStr = `atsc3:${channel}`;
      if (plps.length > 0) {
        channelStr += `:${plps.join('+')}`;
      }
      
      hdhr([deviceId, 'set', `/tuner${tuner}/channel`, channelStr], (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async incrementChannel(deviceId, tuner) {
    return new Promise((resolve, reject) => {
      hdhr([deviceId, 'set', `/tuner${tuner}/channel`, '+'], (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async decrementChannel(deviceId, tuner) {
    return new Promise((resolve, reject) => {
      hdhr([deviceId, 'set', `/tuner${tuner}/channel`, '-'], (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async clearTuner(deviceId, tuner) {
    return new Promise((resolve, reject) => {
      hdhr([deviceId, 'set', `/tuner${tuner}/channel`, 'none'], (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  async getPlpInfo(deviceId, tuner = 0) {
    return new Promise((resolve, reject) => {
      hdhr([deviceId, 'get', `/tuner${tuner}/plpinfo`], (error, stdout) => {
        if (error) {
          // Devices without ATSC 3.0 (or older models) fail this query on every
          // poll; say so once per device instead of on every poll.
          if (!this.plpUnavailableLogged.has(deviceId)) {
            this.plpUnavailableLogged.add(deviceId);
            console.log('PLP info not available from %s (no ATSC 3.0 support?); not logging again', validate.logSafe(deviceId));
          }
          resolve(null);
          return;
        }

        const plpData = {};
        const lines = stdout.split('\n').filter(line => line.trim());
        
        lines.forEach(line => {
          // Parse PLP info output
          // Actual format: "0: sfi=0 mod=qam256 cod=10/15 layer=core ti=cti lls=1 lock=1"
          const plpMatch = line.match(/^(\d+):/);
          if (plpMatch) {
            const plpId = plpMatch[1];
            plpData[plpId] = {};
            
            // Extract all key=value pairs
            const sfiMatch = line.match(/sfi=(\w+)/);
            const modMatch = line.match(/mod=(\w+)/);
            const codMatch = line.match(/cod=([0-9/]+)/);
            const layerMatch = line.match(/layer=(\w+)/);
            const tiMatch = line.match(/ti=(\w+)/);
            const llsMatch = line.match(/lls=(\d+)/);
            const lockMatch = line.match(/lock=(\d+)/);
            
            if (sfiMatch) plpData[plpId].sfi = sfiMatch[1];
            if (modMatch) plpData[plpId].modulation = modMatch[1];
            if (codMatch) plpData[plpId].coderate = codMatch[1];
            if (layerMatch) plpData[plpId].layer = layerMatch[1];
            if (tiMatch) plpData[plpId].timeInterleaving = tiMatch[1];
            if (llsMatch) plpData[plpId].lls = llsMatch[1] === '1';
            if (lockMatch) plpData[plpId].lock = lockMatch[1] === '1';
          }
        });

        console.log('Parsed PLP data:', plpData);
        resolve(Object.keys(plpData).length > 0 ? plpData : null);
      });
    });
  }

  async getL1Info(deviceId, tuner = 0) {
    return new Promise((resolve, reject) => {
      hdhr([deviceId, 'get', `/tuner${tuner}/l1info`], (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }

        const l1Data = {};
        const lines = stdout.split('\n').filter(line => line.trim());
        
        lines.forEach(line => {
          // Parse L1 info output
          // Format examples: l1_basic_mode=1 l1_detail_mode=2 fft_size=8192
          const keyValueMatch = line.match(/(\w+)=([^\s]+)/g);
          if (keyValueMatch) {
            keyValueMatch.forEach(match => {
              const [key, value] = match.split('=');
              l1Data[key] = value;
            });
          }
        });

        resolve(Object.keys(l1Data).length > 0 ? l1Data : null);
      });
    });
  }

  startMonitoring(socket, deviceId, tuner) {
    this.stopMonitoring(socket);

    const intervalId = setInterval(async () => {
      try {
        const status = await this.getTunerStatus(deviceId, tuner);
        const currentProgram = await this.getCurrentProgram(deviceId, tuner);

        // Get ATSC 3.0 info if channel is tuned and device supports it
        let plpInfo = null;
        let l1Info = null;
        if (status && status.channel && status.channel !== 'none') {
          // Try to get ATSC 3.0 info - will return null if not ATSC 3.0
          plpInfo = await this.getPlpInfo(deviceId, tuner);
          l1Info = await this.getL1Info(deviceId, tuner);
        }

        socket.emit('tuner-status', {
          ...status,
          currentProgram,
          plpInfo,
          l1Info
        });
      } catch (error) {
        console.error('Monitoring error:', error);
      }
    }, 1000);

    this.monitoringIntervals.set(socket.id, intervalId);
  }

  startAntennaMode(socket, deviceId, tunerCount) {
    this.stopMonitoring(socket);

    console.log(`Starting antenna mode for device ${deviceId} with ${tunerCount} tuners`);

    const intervalId = setInterval(async () => {
      try {
        // Monitor all tuners simultaneously
        const allTunersData = await Promise.all(
          Array.from({ length: tunerCount }, (_, i) =>
            this.getTunerStatus(deviceId, i)
              .then(status => ({ tuner: i, status }))
              .catch(error => {
                console.error(`Error monitoring tuner ${i}:`, error);
                return { tuner: i, status: null };
              })
          )
        );

        socket.emit('antenna-mode-status', allTunersData);
      } catch (error) {
        console.error('Antenna mode monitoring error:', error);
      }
    }, 1000);

    this.monitoringIntervals.set(socket.id, intervalId);
  }

  stopMonitoring(socket) {
    const socketId = socket?.id;
    if (socketId && this.monitoringIntervals.has(socketId)) {
      clearInterval(this.monitoringIntervals.get(socketId));
      this.monitoringIntervals.delete(socketId);
    }
  }

  stopAllMonitoring() {
    this.monitoringIntervals.forEach(intervalId => clearInterval(intervalId));
    this.monitoringIntervals.clear();
  }
}

const hdhrController = new HDHomeRunController();

// API Routes
// Every :id and :tuner is validated once here, before any handler runs, and
// replaced with its normalised value.
app.param('id', (req, res, next, value) => {
  const id = validate.deviceHost(value);
  if (!id) return res.status(400).json({ error: 'Invalid device id' });
  req.params.id = id;
  next();
});

app.param('tuner', (req, res, next, value) => {
  const t = validate.tuner(value);
  if (t === null) return res.status(400).json({ error: 'Invalid tuner' });
  req.params.tuner = t;
  next();
});

app.get('/api/devices', async (req, res) => {
  try {
    const forceRefresh = req.query.force === 'true';
    const devices = await hdhrController.discoverDevices(forceRefresh);
    res.json(devices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/info', async (req, res) => {
  try {
    const info = await hdhrController.getDeviceInfo(req.params.id);
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/scan/:tuner', scanLimiter, async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const channelMap = validate.channelMap(req.query.channelMap === undefined ? 'us-bcast' : req.query.channelMap);
    if (!channelMap) {
      res.status(400).json({ error: 'Invalid channelMap' });
      return;
    }
    const channels = await hdhrController.scanChannels(id, tuner, channelMap);
    res.json(channels);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/tuner/:tuner/status', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const status = await hdhrController.getTunerStatus(id, tuner);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/tuner/:tuner/programs', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const programs = await hdhrController.getCurrentChannelPrograms(id, tuner);
    res.json(programs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/tuner/:tuner/channel', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const channel = validate.channel(req.body && req.body.channel);
    if (!channel) {
      res.status(400).json({ error: 'Invalid channel' });
      return;
    }
    const result = await hdhrController.setChannel(id, tuner, channel);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/tuner/:tuner/channel/up', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const result = await hdhrController.incrementChannel(id, tuner);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/tuner/:tuner/channel/down', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const result = await hdhrController.decrementChannel(id, tuner);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/tuner/:tuner/clear', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const result = await hdhrController.clearTuner(id, tuner);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/tuner/:tuner/plpinfo', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const plpInfo = await hdhrController.getPlpInfo(id, tuner);
    res.json(plpInfo);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/devices/:id/tuner/:tuner/l1info', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const l1Info = await hdhrController.getL1Info(id, tuner);
    res.json(l1Info);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/devices/:id/tuner/:tuner/atsc3', async (req, res) => {
  try {
    const { id, tuner } = req.params;
    const body = req.body || {};
    const channel = validate.digits(String(body.channel));
    const plps = validate.plps(body.plps);
    if (!channel || !plps) {
      res.status(400).json({ error: 'Invalid channel or plps' });
      return;
    }
    const result = await hdhrController.setAtsc3Channel(id, tuner, channel, plps);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get stream URL only (for copying to clipboard)
// Uses RF channel + program number to avoid virtual channel ambiguity
app.get('/api/devices/:id/stream/url', async (req, res) => {
  try {
    const { id } = req.params;
    const ch = validate.digits(req.query.ch);
    const program = validate.digits(req.query.program);

    if (!ch || !program) {
      res.status(400).json({ error: 'Missing or invalid ch or program query parameter' });
      return;
    }

    const device = hdhrController.devices.find(d => d.id === id);
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }

    const streamUrl = `http://${device.ip}:5004/auto/ch${ch}-${program}`;
    res.json({ url: streamUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// M3U playlist endpoint for streaming
// Uses RF channel + program number instead of virtual channel
app.get('/api/devices/:id/stream/play.m3u', async (req, res) => {
  try {
    const { id } = req.params;
    const ch = validate.digits(req.query.ch);
    const program = validate.digits(req.query.program);
    const name = validate.displayName(req.query.name);

    if (!ch || !program) {
      res.status(400).json({ error: 'Missing or invalid ch or program query parameter' });
      return;
    }

    const channelName = name || `Ch${ch} Program ${program}`;

    const device = hdhrController.devices.find(d => d.id === id);
    if (!device) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }

    // Tune by RF channel + program number so no channel scan is needed
    // and virtual channel collisions (e.g. two stations on 2.1) are avoided
    const streamUrl = `http://${device.ip}:5004/auto/ch${ch}-${program}`;
    const m3uContent = `#EXTM3U
#EXTINF:-1,${channelName}
${streamUrl}
`;

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    const filename = name ? name.replace(/[^a-zA-Z0-9._-]/g, '_') : `ch${ch}-${program}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.m3u"`);
    res.send(m3uContent);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.IO for real-time updates
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('start-monitoring', (payload) => {
    const deviceId = validate.deviceHost(payload && payload.deviceId);
    const tuner = validate.tuner(payload && payload.tuner);
    if (!deviceId || tuner === null) return;
    console.log(`Starting monitoring for device ${deviceId}, tuner ${tuner}`);
    hdhrController.startMonitoring(socket, deviceId, tuner);
  });

  socket.on('start-antenna-mode', (payload) => {
    const deviceId = validate.deviceHost(payload && payload.deviceId);
    const tunerCount = Number(payload && payload.tunerCount);
    if (!deviceId || !Number.isInteger(tunerCount) || tunerCount < 1 || tunerCount > 8) return;
    hdhrController.startAntennaMode(socket, deviceId, tunerCount);
  });

  socket.on('stop-monitoring', () => {
    console.log('Stopping monitoring for:', socket.id);
    hdhrController.stopMonitoring(socket);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    hdhrController.stopMonitoring(socket);
  });
});

// Version endpoint for update checking
app.get('/api/version', (req, res) => {
  try {
    const versionPath = path.join(__dirname, 'public', 'build-version.json');
    const fs = require('fs');
    if (fs.existsSync(versionPath)) {
      const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
      res.json(versionData);
    } else {
      // Fallback if version file doesn't exist
      res.json({ hash: 'unknown', buildTime: null });
    }
  } catch (error) {
    res.json({ hash: 'unknown', buildTime: null });
  }
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  // Report the bound port (not PORT) so PORT=0 is usable, e.g. by the tests.
  console.log(`HDHomeRun Signal server running on port ${server.address().port}`);
});

// Node runs as PID 1 in a container, where signals without a handler are
// ignored: without this, `docker stop` and pod termination wait out the full
// grace period and then SIGKILL the process.
const SHUTDOWN_TIMEOUT_MS = 5000;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('%s received, shutting down', signal);

  // Force exit if open connections keep the server from closing in time.
  setTimeout(() => {
    console.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  hdhrController.stopAllMonitoring();
  io.close(() => process.exit(0));
  server.closeIdleConnections();
}

['SIGTERM', 'SIGINT'].forEach(signal => process.on(signal, () => shutdown(signal)));
