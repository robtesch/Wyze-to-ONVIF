'use strict';

// Translates Home Assistant add-on options (/data/options.json) into the
// onvif.yaml format expected by dlo747/RTSP-to-ONVIF-Unifi-Protect.
//
// The output lives in /data (persistent add-on storage) because the upstream
// server generates missing MAC/UUID values and writes them back into this
// file. UniFi Protect identifies cameras by MAC address, so this script also
// carries generated values forward (keyed by camera name) whenever the
// options change and the file is regenerated.

const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const YAML = require('/app/node_modules/yaml');

const OPTIONS_FILE = '/data/options.json';
const CONFIG_FILE = '/data/onvif.yaml';

const options = JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
const cameras = options.cameras || [];

const interfaces = os.networkInterfaces();
if (!interfaces[options.interface]) {
    console.warn(
        `[ha-config] WARNING: network interface "${options.interface}" not found on this host. ` +
        `Available interfaces: ${Object.keys(interfaces).join(', ')}. ` +
        'Set the correct one in the app Configuration tab.'
    );
}

// A per-camera static `ip` is given as a plain address (e.g. 192.168.40.247).
// `ip addr add` needs a CIDR, so derive the prefix length from the host
// interface's own subnet (falling back to /24 if it can't be read).
function hostPrefixLength(iface) {
    try {
        const out = execSync(`ip -o -4 addr show ${iface}`, { encoding: 'utf8' });
        const m = out.match(/inet\s+\d+\.\d+\.\d+\.\d+\/(\d+)/);
        if (m) return m[1];
    } catch (error) {
        // interface may not be up yet — fall through to the default
    }
    return '24';
}
const prefixLen = hostPrefixLength(options.interface);

let previous = {};
if (fs.existsSync(CONFIG_FILE)) {
    try {
        const old = YAML.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        for (const cam of (old && old.onvif) || []) {
            previous[cam.name] = { mac: cam.mac, uuid: cam.uuid };
        }
    } catch (error) {
        console.warn(`[ha-config] Could not parse existing ${CONFIG_FILE}, regenerating: ${error.message}`);
    }
}

const config = {
    onvif: cameras.map((cam, index) => {
        const prev = previous[cam.name] || {};
        const entry = {
            name: cam.name,
            description: cam.name,
            dev: options.interface,
            target: {
                hostname: cam.target_host,
                ports: {
                    rtsp: cam.target_rtsp_port || 8554,
                    snapshot: cam.target_snapshot_port || 5000,
                },
            },
            highQuality: {
                rtsp: cam.rtsp_path,
                // An explicit empty path selects upstream's built-in placeholder.
                snapshot: cam.snapshot_path ?? `/snapshot/${cam.name}.jpg`,
                width: cam.width,
                height: cam.height,
                framerate: cam.framerate,
                bitrate: cam.bitrate,
                quality: 4,
            },
            // The RTSP/snapshot proxies bind on all interfaces, so each camera
            // needs its own port; the ONVIF server binds per virtual IP, so
            // one server port is safe to share.
            // 19554+: the 18554/18555 range is taken by other services on
            // some hosts (this add-on shares the host network namespace).
            ports: {
                server: cam.server_port || 8081,
                rtsp: cam.rtsp_proxy_port || 19554 + index,
                snapshot: cam.snapshot_proxy_port || 18080 + index,
            },
        };

        // Optional static IP for this camera's virtual interface. Accepts a
        // plain address (prefix added from the host subnet) or a full CIDR.
        // When omitted, the interface uses DHCP.
        if (cam.ip) {
            entry.ipv4 = cam.ip.indexOf('/') !== -1 ? cam.ip : `${cam.ip}/${prefixLen}`;
        }

        const mac = cam.mac || prev.mac;
        const uuid = cam.uuid || prev.uuid;
        if (mac) entry.mac = mac;
        if (uuid) entry.uuid = uuid;
        return entry;
    }),
};

fs.writeFileSync(CONFIG_FILE, YAML.stringify(config), 'utf8');
console.log(`[ha-config] Wrote ${CONFIG_FILE} with ${config.onvif.length} camera(s)`);
