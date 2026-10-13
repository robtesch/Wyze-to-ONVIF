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
| `debug` | Verbose logging from the ONVIF server. |
| `cameras` | List of virtual cameras, see below. |

Per camera:

| Option | Required | Description |
|---|---|---|
| `name` | yes | Letters/digits only, must start with a letter. Shown in Protect. Changing it later resets the camera's generated MAC — Protect will see a new device. |
| `target_host` | yes | IP/hostname of the RTSP source (your wyze-bridge host). |
| `target_rtsp_port` | no | RTSP port of the source. Default `8554` (wyze-bridge default). |
| `target_snapshot_port` | no | HTTP port of the source for snapshots. Default `5000` (wyze-bridge Web-UI). |
| `rtsp_path` | yes | Stream path on the source, e.g. `/front-door` for wyze-bridge camera `front-door`. |
| `snapshot_path` | no | Snapshot path on the source. Defaults to `/snapshot/<name>.jpg`. Snapshots are not fully working upstream yet. |
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
