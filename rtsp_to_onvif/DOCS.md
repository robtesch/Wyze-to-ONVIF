# RTSP to ONVIF for UniFi Protect

Wraps [dlo747/RTSP-to-ONVIF-Unifi-Protect](https://github.com/dlo747/RTSP-to-ONVIF-Unifi-Protect)
as a Home Assistant app (add-on). Each configured camera becomes a virtual
ONVIF device with its own MAC address and DHCP-assigned IP on your LAN,
adoptable by UniFi Protect as a third-party camera.

## Requirements

- **Ethernet.** The app creates one macvlan interface per camera on the
  host's network interface. This does not work over Wi-Fi.
- Home Assistant and your UniFi Protect console on the same L2 network/VLAN
  (or a route for ONVIF/RTSP traffic between them).
- UniFi Protect with third-party ONVIF camera support enabled
  (Settings → System → Advanced → Third-Party Cameras).
- An RTSP source, e.g. [docker-wyze-bridge](https://github.com/IDisposable/docker-wyze-bridge).

## Configuration

| Option | Description |
|---|---|
| `interface` | Host network interface to attach virtual camera interfaces to. On a Raspberry Pi this is usually `eth0` or `end0` — if you guess wrong, the app log lists the available names at startup. |
| `debug` | ONVIF action and redacted RTSP negotiation logging. Includes request/status codes, TCP/UDP transport, codec/profile summaries and connection/media counts; omits credentials, complete URLs and media payloads. |
| `restream_port` | Internal loopback-only RTSP port when any camera enables `restream`. Default `19854`; change it if another app already uses that port. |
| `cameras` | List of virtual cameras, see below. |

Per camera:

| Option | Required | Description |
|---|---|---|
| `name` | yes | Letters/digits only, must start with a letter. Shown in Protect. Changing it later resets the camera's generated MAC — Protect will see a new device. |
| `target_host` | yes | IP/hostname of the RTSP source (your wyze-bridge host). |
| `target_rtsp_port` | no | RTSP port of the source. Default `8554` (wyze-bridge default). |
| `target_snapshot_port` | no | HTTP port of the source for snapshots. Default `5000` (wyze-bridge Web-UI). |
| `rtsp_path` | yes | Stream path on the source, e.g. `/front-door` for wyze-bridge camera `front-door`. |
| `restream` | no | Default false. Rebuild RTSP/SDP/RTP through bundled go2rtc 1.9.14 and FFmpeg, copying video and audio without transcoding. Useful for legacy streams that play elsewhere but disconnect in Protect. |
| `rtsp_username` / `rtsp_password` | no | Source credentials for `restream: true`. Enter plain values; the app URL-encodes them. Stored in app Configuration and a mode-0600 generated file, and redacted from service logs. Omit for an unauthenticated source. Ignored in passthrough mode. |
| `snapshot_path` | no | Snapshot path on the source. Defaults to `/snapshot/<name>.jpg`. Set to `""` to use the bridge's built-in placeholder image when the source has no HTTP snapshot endpoint. |
| `width`, `height`, `framerate`, `bitrate` | yes | Must match what the source stream actually delivers (bitrate in kb/s). Protect uses these as the advertised stream capabilities. |
| `ip` | no | A **static IP** for this camera's virtual interface, e.g. `192.168.40.247`. Must be on the same subnet as Home Assistant and free (ideally outside your DHCP pool). Omit to let DHCP assign one. Recommended — see [Static vs. DHCP](#static-vs-dhcp-recommended). |
| `server_port` | no | ONVIF HTTP port on the camera's virtual IP. Default `8081`, safe to share between cameras. |
| `rtsp_proxy_port` / `snapshot_proxy_port` | no | Local proxy ports. Auto-assigned uniquely per camera (`19554+n` / `18080+n`); only set them to resolve a port conflict. |
| `mac` / `uuid` | no | Auto-generated on first start and persisted in `/data/onvif.yaml`. Only set to pin values explicitly. |

### Example (two Wyze cams via wyze-bridge at 192.168.1.20)

```yaml
interface: eth0
debug: false
cameras:
  - name: FrontDoor
    target_host: 192.168.1.20
    rtsp_path: /front-door
    width: 1920
    height: 1080
    framerate: 20
    bitrate: 2048
    ip: 192.168.1.247
  - name: Garage
    target_host: 192.168.1.20
    rtsp_path: /garage
    width: 1920
    height: 1080
    framerate: 20
    bitrate: 2048
    ip: 192.168.1.248
```

### Bundled copy-only restream

Enable `restream: true` on a camera to run the known copy-only workaround inside
this app. Point `target_host`, `target_rtsp_port` and `rtsp_path` at the **original
camera**, and add its RTSP credentials:

```yaml
interface: end0
debug: false
cameras:
  - name: GateIntercom
    target_host: 192.168.1.52
    target_rtsp_port: 554
    rtsp_path: /Streaming/Channels/101
    restream: true
    rtsp_username: admin
    rtsp_password: "YOUR_CAMERA_PASSWORD"
    snapshot_path: ""
    width: 1280
    height: 720
    framerate: 25
    bitrate: 2048
```

The app supervises go2rtc, the ONVIF bridge and FFmpeg together. FFmpeg starts
on demand and copies both encoded tracks (`video=copy`, `audio=copy`); it does
not resize, change frame rate or re-encode. Only cameras opting in use it.
The internal restream listens on loopback, with its HTTP/WebRTC listeners
disabled. Public RTSP and ONVIF ports stay the same, and snapshot requests
still target the original camera. The public RTSP proxy for a restreamed
camera uses the internal unauthenticated stream; Protect's saved credentials
do not authenticate this endpoint. Source authentication happens inside FFmpeg.

To migrate from a separate go2rtc app:

1. Update this app **in place**, preserving its persistent data. Keep the camera
   name and any explicit MAC/UUID/IP/port settings.
2. Configure the original source and credentials as above, save and restart.
   Keep the separate go2rtc app running during this test: its port 8554 does not
   conflict with the bundled default 19854.
3. Confirm Protect has live video and stays online. Stop the separate go2rtc
   app, then verify playback again before uninstalling it. Check whether any
   other HA integrations use its streams before removing it.
4. Turn `debug` off after verification. No camera deletion or re-adoption is
   needed. You can roll back by disabling `restream` and restoring the old
   `127.0.0.1:8554` target and stream path while the separate app is running.

This preserves an already-proven restream arrangement inside one HA app. The
original disconnect's exact cause is not established: incorrect source SDP
metadata and RTSP/RTP compatibility are both possible contributors.

### Static vs. DHCP (recommended)

By default each virtual camera gets its IP from your DHCP server. That address
is tied to the camera's auto-generated MAC, which lives in `/data`. If you
**uninstall and reinstall** the app, `/data` is wiped, new MACs are generated,
and DHCP hands out new IPs — so your cameras change address and Protect sees
them as new devices.

To avoid this, set a fixed **`ip`** per camera (as above). Choose an address on
the Home Assistant subnet that is free and, ideally, outside your DHCP pool.
Static IPs are reproducible from your configuration, so they survive reinstalls.

For a camera to stay the *same device* in Protect across a reinstall, also pin
its **`mac`** — Protect identifies third-party cameras by MAC. Setting both `ip`
and `mac` makes a camera fully reproducible: re-entering the same config brings
back the exact same device. You can copy the generated MAC from the app log
or from `/data/onvif.yaml` before reinstalling.

## Adopting in UniFi Protect

1. Start the app and open its log. For each camera you should see the
   macvlan interface being created (`NET_CONF: ADD - rtsp2onvif_N`), a DHCP
   lease, and `HTTP listening on <ip>:8081`. The virtual cameras appear in
   your UniFi client list with MAC prefix `1A:11:B0`.
2. In Protect, the cameras should be discovered automatically (WS-Discovery).
   If not, add them manually by IP with the ONVIF port (default `8081`).
   If the RTSP source requires authentication, enter its username/password in
   Protect. The ONVIF endpoint does not validate credentials, but the TCP proxy
   forwards RTSP authentication to the source.

## Troubleshooting

- **Adopted but no video / Camera lost power.** Enable `debug: true` and restart.
  `[RTSP ...]` lines identify the peer and show request/response sequences. A
  single `401` challenge is normal; repeated `401` responses to authenticated
  requests suggest an authentication problem. Check the `SETUP` response and
  transport, then `PLAY` and whether `MEDIA` frames arrive. Media counters cover
  RTSP-interleaved TCP frames; UDP media does not pass through this TCP proxy.
  These logs narrow the failure; a successful `PLAY` alone does not establish
  that Protect can display the video.

- **UniFi VLAN/firewall rules.** If Protect adopts a camera but the stream
  stays black, confirm your firewall policy allows traffic to the **virtual
  camera IPs** (not just the Home Assistant host) and to the RTSP source host.
  Add the camera IPs to the relevant allow rule.
- **"IP address conflict" on the host IP.** The virtual cameras share the
  host's L2 network, so the host would otherwise answer ARP for its own IP out
  of the camera interfaces (ARP flux), which UniFi flags as a conflict. The
  app installs an nftables `arp`-family rule on every start to suppress
  this automatically — no action needed. (The usual `arp_ignore` sysctl can't
  be used: host-network app containers get a read-only `/proc/sys`.)

## Notes and limitations

- Streams must be H.264 (wyze-bridge outputs H.264 by default). PTZ, audio
  playback, and smart detections are not available for third-party cameras
  in Protect; snapshots and timeline scrubbing are hit-or-miss upstream.
- Generated MACs/UUIDs live in `/data/onvif.yaml`. Uninstalling the app
  deletes `/data`, and Protect will then see brand-new cameras on reinstall.
- If a camera fails with `Failed to find IP address for MAC address ...`,
  the macvlan interface didn't get created or didn't get a DHCP lease —
  check the `interface` option, that the Pi is on Ethernet, and that your
  DHCP server has free leases.
- After a host reboot the interfaces are recreated with the same persisted
  MACs, so DHCP hands back the same IPs (assuming your DHCP server honors
  lease reuse — fixed IP reservations in your router make this bulletproof).
