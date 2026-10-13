# RTSP to ONVIF for UniFi Protect

[![Home Assistant App](https://img.shields.io/badge/Home%20Assistant-App-41BDF5?logo=home-assistant&logoColor=white)](https://www.home-assistant.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> [!NOTE]
> **This project is essentially entirely AI-generated.** The code, configuration, and documentation were produced with an AI assistant (Claude). It is working and in active use, but please review it yourself before deploying it in your own environment.

A Home Assistant app (add-on) that turns any RTSP stream into a virtual **ONVIF camera** that **UniFi Protect** can adopt as a third-party camera.

It's built for exposing [docker-wyze-bridge](https://github.com/mrlt8/docker-wyze-bridge) streams (Wyze cameras) to Protect, but it works with any H.264 RTSP source.

## How it works

Each camera you configure becomes its own virtual ONVIF device — a macvlan network interface on your LAN with its own MAC address and DHCP-assigned IP. Protect discovers and adopts it like a real ONVIF camera, while the app proxies the RTSP stream through from your source. Under the hood it wraps [dlo747/RTSP-to-ONVIF-Unifi-Protect](https://github.com/dlo747/RTSP-to-ONVIF-Unifi-Protect).

> Home Assistant recently renamed **Add-ons** to **Apps**. This project is a Home Assistant app; if your Home Assistant still says "Add-ons", it's the same thing.

## Features

- Exposes any RTSP stream as a UniFi-adoptable ONVIF camera
- One virtual camera per source stream, each with a stable MAC/IP that survives restarts
- Designed around docker-wyze-bridge, but source-agnostic
- Automatically prevents the macvlan "IP conflict" that UniFi would otherwise flag (see [Troubleshooting](#troubleshooting))
- Runs entirely on your LAN — no cloud, no external dependencies

## Prerequisites

- **Home Assistant OS or Supervised** (apps/add-ons required).
- **Wired Ethernet on the Home Assistant host.** The app creates a macvlan interface per camera; this does not work over Wi-Fi.
- An **RTSP source** — e.g. the [docker-wyze-bridge](https://github.com/mrlt8/docker-wyze-bridge) app.
- **UniFi Protect** with third-party ONVIF cameras enabled: *Protect → Settings → System → Advanced → Discover Third-Party Cameras*.
- The Home Assistant host and the UniFi Protect console on the **same L2 network/VLAN**, or a route between them.
- If you use VLAN firewall rules, they must **allow traffic to the virtual camera IPs** (see [Troubleshooting](#troubleshooting)).

## Installation

1. In Home Assistant, go to **Settings → Apps → App Store** (older versions: *Settings → Add-ons → Add-on Store*).
2. Open the **⋮** menu (top-right) → **Repositories**, paste this repository URL, and click **Add**:
   ```
   https://github.com/DueHack12/Wyze-to-ONVIF
   ```
3. Find **RTSP to ONVIF for UniFi Protect** in the store and click **Install**.
4. Open the **Configuration** tab, fill it in (below), then **Start** the app.

## Configuration

### Top-level options

| Option | Required | Description |
|---|---|---|
| `interface` | yes | The Home Assistant host's Ethernet interface to attach the virtual cameras to (e.g. `eth0`, `end0`). The camera IPs come from this interface's subnet via DHCP. If you're unsure of the name, start the app once — the log lists the available interfaces. |
| `debug` | no | Verbose ONVIF-server logging. Default `false`. |
| `cameras` | yes | List of virtual cameras (see below). |

### Per-camera options

| Option | Required | Description |
|---|---|---|
| `name` | yes | Letters and digits only, must start with a letter. Shown in Protect. Changing it later regenerates the camera's MAC, so Protect sees a brand-new device. |
| `target_host` | yes | IP or hostname of the RTSP source (your wyze-bridge host). |
| `rtsp_path` | yes | Stream path on the source, e.g. `/front-door` for a wyze-bridge camera named `front-door`. |
| `width`, `height`, `framerate`, `bitrate` | yes | Must match what the source stream actually delivers (bitrate in kb/s). Protect advertises these as the camera's capabilities. |
| `ip` | no | A **static IP** for this camera's virtual interface, e.g. `192.168.40.247`. Must be on the same subnet as Home Assistant and free (ideally outside your DHCP pool). Omit to use DHCP. **Recommended** — see [Static IPs](#static-ips-recommended). |
| `target_rtsp_port` | no | RTSP port of the source. Default `8554` (wyze-bridge default). |
| `target_snapshot_port` | no | HTTP port of the source for snapshots. Default `5000`. |
| `snapshot_path` | no | Snapshot path on the source. Defaults to `/snapshot/<name>.jpg`. Set to `""` to use the bridge's built-in placeholder image when the source has no HTTP snapshot endpoint. |
| `server_port` | no | ONVIF HTTP port on the camera's virtual IP. Default `8081`; safe to share across cameras. |
| `rtsp_proxy_port` / `snapshot_proxy_port` | no | Local proxy ports, auto-assigned uniquely per camera (`19554+n` / `18080+n`). Only set these to resolve a port conflict. |
| `mac` / `uuid` | no | Auto-generated on first start and persisted. Only set to pin specific values. |

### Example

Two Wyze cameras served by docker-wyze-bridge running on the same host (`192.168.40.213`), each pinned to a static IP:

```yaml
interface: end0
debug: false
cameras:
  - name: StageLeft
    target_host: 192.168.40.213
    rtsp_path: /stageleft
    width: 1920
    height: 1080
    framerate: 20
    bitrate: 2048
    ip: 192.168.40.247
  - name: StageRight
    target_host: 192.168.40.213
    rtsp_path: /stageright
    width: 1920
    height: 1080
    framerate: 20
    bitrate: 2048
    ip: 192.168.40.248
```

### Static IPs (recommended)

By default each virtual camera gets its IP from DHCP, tied to an auto-generated MAC stored in the app's `/data`. If you **uninstall and reinstall** the app, `/data` is wiped and new MACs are generated, so DHCP hands out new addresses and Protect sees the cameras as new devices.

Setting a fixed **`ip`** per camera avoids this — static IPs are reproducible from your configuration and survive reinstalls. Pick a free address on the Home Assistant subnet, ideally outside your DHCP pool.

For a camera to remain the *same device* in Protect across a reinstall, also pin its **`mac`** (Protect identifies third-party cameras by MAC). Setting both `ip` and `mac` makes a camera fully reproducible — re-entering the same config restores the exact same device. Grab the generated MAC from the app log or `/data/onvif.yaml` before reinstalling.

## Adopting in UniFi Protect

For sources that provide RTSP video but no HTTP snapshot endpoint, add
`snapshot_path: ""` to the camera configuration. Keep the quotes: an omitted or
null value uses the existing default path. Protect will receive the bridge's
static placeholder image for snapshot requests; live video still uses the same
RTSP stream. This setting does not generate snapshots from the video.

1. Start the app and open its **Log**. For each camera you should see the interface created, a DHCP lease, and `SERVER: <name> — HTTP listening on <ip>:8081`. The virtual cameras appear on your network with MAC prefix `1A:11:B0`.
2. In Protect, the cameras are usually discovered automatically. If not, use **Protect → Devices → Can't find your device? → advanced adoption** and enter the camera's virtual IP with ONVIF port `8081`. If the RTSP source requires authentication, enter that source's username/password in Protect. The ONVIF endpoint itself does not validate credentials, but the TCP proxy forwards the source's RTSP authentication challenge.

## Troubleshooting

- **UniFi VLAN/firewall rules.** If Protect can't pull the stream, make sure your firewall policy allows traffic to the **virtual camera IPs** — not just the Home Assistant host. Add the camera IPs (and the RTSP source host) to the relevant allow rule.
- **"IP address conflict" on the host IP.** The virtual cameras share the host's L2 network, so by default the host would answer ARP for its own IP out of the camera interfaces (ARP flux), and UniFi flags a conflict. The app installs an nftables rule on startup to suppress this automatically — no action needed. (The usual `arp_ignore` sysctl can't be used because host-network app containers get a read-only `/proc/sys`.)
- **Wrong interface.** If no interfaces come up, double-check the `interface` option against the names printed in the app log at startup, and confirm the host is on wired Ethernet.
- **`Failed to find IP address for MAC address ...`.** The macvlan interface didn't get a DHCP lease. Check the `interface` option, the Ethernet connection, and that your DHCP server has free leases (a fixed reservation in your router makes IPs stable).
- **Camera offline.** A black tile in Protect for a camera whose physical source is offline is expected; it recovers when the source stream returns.

## Limitations

- Streams must be **H.264** (wyze-bridge's default).
- PTZ, two-way audio, and smart detections are not available for third-party ONVIF cameras in Protect. Snapshots and timeline scrubbing depend on upstream and can be inconsistent.
- Uninstalling the app clears its `/data`, so the generated MACs are lost and Protect will see new devices on reinstall.

## Development and compatibility tests

With Node.js 20 or later, run `npm test` from the repository root. The tests fetch
and cache the pinned upstream ONVIF server, verify its SHA-256 hash, and exercise
its SOAP request handler over a local HTTP endpoint. They cover the previously
unsupported network-interface and encoder-options requests, DHCP/static network
reporting, profile selection, and debug-log handling of authentication tokens.

The image build applies `rtsp_to_onvif/patch-onvif-server.cjs` to that pinned
server. Updating the upstream commit also requires reviewing this patch and
updating the expected source hash. The tests verify the protocol responses;
successful adoption and stable video still need validation with the actual
camera and Protect version.

## Credits

- [dlo747/RTSP-to-ONVIF-Unifi-Protect](https://github.com/dlo747/RTSP-to-ONVIF-Unifi-Protect) — the ONVIF server this app wraps.
- [docker-wyze-bridge](https://github.com/mrlt8/docker-wyze-bridge) — the usual RTSP source.

## License

Released under the [MIT License](LICENSE).
