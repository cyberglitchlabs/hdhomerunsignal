# HDHomeRun Signal Monitor

A modern web application that replaces the discontinued HDHomeRun Signal Android app. This web app provides real-time signal monitoring, channel tuning, and device management for HDHomeRun devices in the United States, Canada, United Kingdom/EU and Australia.

> **This is a fork** of [Petelombardo/hdhomerunsignal](https://github.com/Petelombardo/hdhomerunsignal), the original HDHomeRun Signal Monitor by Pete Lombardo, who deserves the credit for the app itself. This fork adds security hardening (input validation and a fix for a command-injection vulnerability, rate limiting, CORS and WebSocket origin checks), a hardened container image, CI with vulnerability and code scanning and signed images, and a Helm chart for Kubernetes. See the commit history for the details.

## Features

- **Multi-Region Support**: Supports US/Canada (ATSC), UK/EU (DVB-T/T2) and Australia (DVB-T) broadcast standards with region-specific channel maps
- **Device Discovery**: Automatically finds HDHomeRun devices on your network
- **Real-time Signal Monitoring**: Live updates of signal strength, SNR quality, and symbol quality with dBm/dB estimates
- **Session Markers**: Each signal meter (strength, SNR, symbol quality) shows three reference points for the current channel: the live reading, a faded high-water mark showing the best reading so far, and a ▲ caret marking the starting reading from when the channel first locked. Hover over a meter to see Now / Start / Peak values.
- **Antenna Tuning Mode**: Monitor all tuners simultaneously with real-time graphs for optimal antenna positioning
- **Direct Channel Tuning**: Quickly tune to specific channels with channel up/down controls
- **Multi-tuner Support**: Switch between tuners on devices that support multiple tuners
- **ATSC 3.0 Support**: Displays PLP and L1 information for NextGen TV broadcasts (US)
- **Watch Live TV**: Click to watch any detected program in your local media player (VLC, mpv, etc.) via M3U playlist, with right-click option to copy the stream URL
- **Program Detection**: Automatically shows available programs/PIDs on tuned channels
- **Progressive Web App**: Install on mobile devices for a native app experience
- **Responsive Design**: Works on both desktop and mobile devices
- **Modern UI**: Clean, dark theme interface with Material-UI components

## Screenshots Reference
Main Mode
<img width="929" height="1033" alt="image" src="https://github.com/user-attachments/assets/ba400c79-5cfe-4e51-bc7c-e9cc2239dc65" />


Antenna Mode
<img width="1084" height="1252" alt="image" src="https://github.com/user-attachments/assets/1fab4b4e-dc43-428c-9367-4324bb79d8df" />


The original Android app functionality has been recreated and enhanced with:
- Region selection (US / Canada / UK-EU / Australia) with appropriate broadcast standards
- Device selection dropdown
- Real-time signal strength, SNR quality, and symbol quality meters with dB conversion
- Session markers on each meter showing start point, peak (high-water mark) and current reading
- **Antenna tuning mode** - simultaneous monitoring of all tuners with real-time graphing (new!)
- Direct channel tuning with up/down controls
- Channel map selection (region-specific: US/CA broadcast/cable/HRC/IRC, UK-EU broadcast/cable or AU broadcast/cable)
- Data rate monitoring
- Program/PID listing for tuned channels with Watch buttons
- Watch live TV directly from the app using M3U stream URLs
- ATSC 3.0 advanced information display (US)
- Automatic reconnection after network interruptions

## Prerequisites

- Docker and Docker Compose
- HDHomeRun device(s) on your network
- Network access for device discovery (requires host networking mode)

### System Requirements

**Prebuilt Docker images are available for:**
- **x86_64** (AMD64) - Traditional desktops and servers
- **ARM64** (aarch64) - Raspberry Pi 4/5, Orange Pi, Banana Pi, and other ARMv8 SBCs

**Recommended hardware:** Raspberry Pi 4 or newer, or other ARMv8-based single-board computers. These provide:
- Low power consumption (perfect for 24/7 operation)
- Small form factor (can be placed near your antenna/HDHomeRun)
- More than sufficient processing power for signal monitoring
- Cost-effective dedicated hardware

**Other architectures:** If your CPU architecture is not among the supported ones, you can build the container yourself from source. A minimum of 4GB RAM is required for compilation.

The Docker image will automatically select the correct architecture for your platform.

## Installation & Setup

Pull the pre-built container from Docker Hub
https://hub.docker.com/r/petelombardo/hdhomerun-signal-web

OR

1. **Clone or download this project to your server**

2. **Build and start the container:**
   ```bash
   docker-compose up -d
   ```

3. **Access the web interface:**
   - Open your browser to `http://your-server-ip:3000`
   - The app will automatically discover HDHomeRun devices on your network

### Kubernetes (Helm)

A Helm chart is included in [`charts/hdhomerun-signal`](charts/hdhomerun-signal). Container images are published to `ghcr.io/cyberglitchlabs/hdhomerunsignal` for amd64 and arm64.

```bash
helm install hdhr ./charts/hdhomerun-signal \
  --namespace hdhomerun --create-namespace \
  --set 'hdhomerun.devices={192.168.1.100}'

kubectl -n hdhomerun port-forward svc/hdhr-hdhomerun-signal 8080:80
```

Tagged releases also publish the chart as an OCI artifact:
`helm install hdhr oci://ghcr.io/cyberglitchlabs/charts/hdhomerun-signal --version <version> ...`

**Device discovery.** Discovery works by broadcast, which does not cross the pod network. By default the chart therefore talks only to the tuner IPs or hostnames in `hdhomerun.devices`. To use auto-discovery, set `hostNetwork=true` and `hdhomerun.discovery.enabled=true` and schedule the pod on a node on the same LAN as the tuners. `hostNetwork` bypasses pod network isolation (NetworkPolicy does not apply and it does not meet the *restricted* Pod Security Standard), so prefer static device addresses.

**Security defaults.** The pod runs as a non-root user with a read-only root filesystem, no capabilities, the `RuntimeDefault` seccomp profile, and no service account token. A NetworkPolicy limits egress to DNS and the tuner control port (65001) and ingress to the release namespace; use `networkPolicy.ingress.from` to admit your ingress controller. The Ingress is off by default and requires TLS when enabled.

> **The app has no authentication.** Anyone who can reach it can retune your tuners. Keep it on a trusted network, or put it behind an authenticating reverse proxy or VPN.

**Behind an ingress or reverse proxy.** Set `trustProxy` (the `HDHR_TRUST_PROXY` variable) so per-client rate limiting sees each user's real address; `--set trustProxy=1` is right for a single ingress controller directly in front of the pod. Without it every client shares the proxy's address and therefore one rate-limit bucket. Set it to the number of proxies you actually run, or their addresses, and no more: trusting a proxy hop that is not there lets any client spoof its address with an `X-Forwarded-For` header. (Tested with one hop; if a load balancer sits in front of your ingress controller, count both.)

The proxy must also **preserve the original `Host` header** (nginx-ingress does by default). The API and WebSocket reject browser requests whose `Origin` does not match the `Host` they arrive with, and `X-Forwarded-Host` is not consulted. If your proxy rewrites `Host`, list the public origin in `allowedOrigins` (`HDHR_ALLOWED_ORIGINS`) instead.

### Image provenance

Release images are scanned for fixable HIGH/CRITICAL vulnerabilities before publishing, carry an SBOM and SLSA provenance, and are signed with [cosign](https://github.com/sigstore/cosign) using GitHub's OIDC identity (no long-lived keys):

```bash
cosign verify ghcr.io/cyberglitchlabs/hdhomerunsignal:<tag> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/cyberglitchlabs/hdhomerunsignal/\.github/workflows/release\.yml@'
```

## Usage

### Normal Mode

1. **Device Selection**: Choose your HDHomeRun device from the dropdown
2. **Tuner Selection**: Select which tuner to monitor/control
3. **Channel Tuning**:
   - Enter a channel number and press the tune button or hit Enter
   - Use the Previous/Next buttons to step through channels
   - The app automatically detects channels tuned by other applications (e.g., tvheadend)
4. **Monitor Signal**: View real-time signal strength (dBm), SNR (dB), and symbol quality. Each meter also shows:
   - **Current**: the solid, color-coded bar
   - **High-water mark**: a faded bar behind it showing the peak reading since you tuned the channel
   - **Starting point**: a ▲ caret under the bar marking the first reading after the channel locked

   Hover over a meter for exact Now / Start / Peak percentages. The markers reset when you change channel, tuner or device, but stay in place through a brief loss of lock, so swinging the antenna won't wipe them. This makes it easy to tell whether an adjustment helped.
5. **View Programs**: See detected programs/PIDs and ATSC 3.0 technical details when available
6. **Watch Live TV**: Each detected program has a **Watch** button that downloads an M3U playlist file, which opens in your default media player (VLC, mpv, etc.) to stream live TV. Right-click the Watch button to **Copy Stream URL** to your clipboard for use in any application.
7. **Channel Map**: Select the appropriate channel map (US Broadcast is default)

### Antenna Tuning Mode

Perfect for aligning your antenna for optimal signal reception:

1. **Activate**: Click the satellite icon button next to the device selector
2. **View All Tuners**: See real-time signal data from all tuners simultaneously in a grid layout
3. **Monitor Symbol Quality**: Each tuner shows a color-coded badge:
   - **Green** (100%): Perfect signal lock - antenna is properly aligned
   - **Red** (<100%): Signal present but poor - keep adjusting
   - **Gray** (0%): No signal detected
4. **Watch the Graphs**: Side-by-side real-time graphs show:
   - **Signal Strength** (left): Overall signal power over last 60 seconds
   - **SNR Quality** (right): Signal-to-noise ratio over last 60 seconds
5. **Optimize Your Antenna**:
   - Prioritize getting Symbol Quality to 100% (green) on all tuned channels
   - Then maximize SNR quality for better reception in varying conditions
   - Signal strength helps with initial rough positioning
6. **Return to Normal Mode**: Click the satellite icon again

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Web server port | `3000` |
| `HDHOMERUN_DEVICES` | Comma-separated list of device IPs or hostnames to manually add (supplements auto-discovery) | *(empty)* |
| `HDHOMERUN_DISABLE_DISCOVERY` | Set to `true` to disable auto-discovery (use only manually specified devices) | `false` |
| `HDHR_ALLOWED_ORIGINS` | Comma-separated browser origins (e.g. `https://hdhr.example.com`) allowed to call the API cross-origin. Only needed if the UI is served from a different origin than the API | *(empty, same-origin only)* |
| `HDHR_RATE_LIMIT` | Requests per minute allowed per client address (channel scans have a separate, stricter limit). `0` disables limiting | `300` |
| `HDHR_TRUST_PROXY` | Which reverse proxies may set `X-Forwarded-For`, so rate limiting sees the real client address: a proxy hop count (`1`-`32`) or a comma-separated list of proxy IPs/CIDRs (e.g. `10.42.0.0/16`). `true`, `false`, `0` and zero-length prefixes such as `0.0.0.0/0` are refused, and **an invalid value stops the server from starting**. Leave unset if the app is not behind a proxy | *(empty, trust nothing)* |

**Examples:**

```bash
# Add a specific device on a different subnet
HDHOMERUN_DEVICES=192.168.2.50

# Add multiple devices
HDHOMERUN_DEVICES=192.168.1.100,hdhomerun.local,10.0.0.25

# Disable auto-discovery and only use specified devices
HDHOMERUN_DISABLE_DISCOVERY=true
HDHOMERUN_DEVICES=192.168.1.100,192.168.1.101
```

**Docker Compose example:**
```yaml
services:
  hdhomerun-signal:
    image: petelombardo/hdhomerun-signal-web
    network_mode: host
    environment:
      - HDHOMERUN_DEVICES=192.168.2.50,192.168.2.51
      - HDHOMERUN_DISABLE_DISCOVERY=false
```

### Region Selection
Select your region (United States, Canada, United Kingdom/EU or Australia) to configure the app for your broadcast standard:
- **United States**: ATSC 1.0/3.0 broadcasts, channels 2-36
- **United Kingdom / EU**: DVB-T/T2 broadcasts, channels 5-60
- **Australia**: DVB-T broadcasts, VHF channels 6-12 (including 9A) and UHF channels 28-51

**Important**: You must have a region-appropriate HDHomeRun device:
- US models work with ATSC broadcasts
- EU models (HDHomeRun Connect Duo EU, etc.) work with DVB-T/T2 broadcasts
- Australian broadcasts need a DVB-T model (the EU/AU hardware)

### Channel Maps

**United States:**
- **US Broadcast**: Standard over-the-air channels
- **US Cable**: Cable TV channels
- **US HRC**: Harmonically Related Carrier cable
- **US IRC**: Incrementally Related Carrier cable

**United Kingdom / EU:**
- **UK/EU Broadcast**: Standard DVB-T/T2 over-the-air channels
- **UK/EU Cable**: Cable TV channels

**Australia:**
- **AU Broadcast**: Standard DVB-T over-the-air channels
- **AU Cable**: Cable TV channels

### Signal Quality Interpretation
- **Signal Strength**: Raw power level (aim for 80%+)
- **SNR Quality**: Signal-to-noise ratio (aim for 80%+)
- **Symbol Quality**: Error correction quality (should be 100% when properly aligned)

## Technical Details

### Architecture
- **Frontend**: React with Material-UI
- **Backend**: Node.js with Express and Socket.io
- **Communication**: REST API + WebSockets for real-time updates
- **HDHomeRun Integration**: Uses `hdhomerun_config` command-line tool

### Docker Configuration
- Uses host networking mode for device discovery
- Multi-stage build for optimized image size
- Automatic installation of hdhomerun_config binary

### API Endpoints
- `GET /api/devices` - Discover HDHomeRun devices
- `GET /api/devices/:id/info` - Get device information
- `GET /api/devices/:id/tuner/:tuner/status` - Get tuner status
- `GET /api/devices/:id/tuner/:tuner/programs` - Get programs on current channel
- `GET /api/devices/:id/tuner/:tuner/plpinfo` - Get ATSC 3.0 PLP information
- `GET /api/devices/:id/tuner/:tuner/l1info` - Get ATSC 3.0 L1 information
- `POST /api/devices/:id/tuner/:tuner/channel` - Set channel
- `POST /api/devices/:id/tuner/:tuner/clear` - Clear/stop tuner
- `GET /api/devices/:id/stream/play.m3u?ch=&program=&name=` - Download M3U playlist for a program
- `GET /api/devices/:id/stream/url?ch=&program=` - Get raw stream URL for a program
- WebSocket: `start-monitoring` - Begin real-time signal updates
- WebSocket: `stop-monitoring` - Stop real-time signal updates

## Development

To run in development mode:

1. **Backend** (in `/backend` directory):
   ```bash
   npm install
   npm run dev
   ```

2. **Frontend** (in `/frontend` directory):
   ```bash
   npm install
   npm start
   ```

## Troubleshooting

### No devices found
- Ensure HDHomeRun devices are on the same network
- Check that host networking mode is enabled in Docker
- Verify `hdhomerun_config discover` works from command line

### Poor signal quality
- Use Signal Strength for rough antenna direction
- Optimize antenna position based on SNR Quality
- Symbol Quality should reach 100% when properly aligned

### Connection issues
- Check firewall settings
- Ensure port 3000 is accessible
- Verify Docker container is running with host networking

## License

This project is provided as-is for personal use. HDHomeRun is a trademark of SiliconDust Engineering Ltd.
