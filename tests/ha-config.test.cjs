const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function generatedConfig(snapshotOptions, {previousConfig, staleRestream, inspect} = {}) {
  const options = {interface: 'eth0', cameras: [{
    name: 'TestCamera', target_host: '198.51.100.10', target_rtsp_port: 554,
    rtsp_path: '/Streaming/Channels/101', width: 1280, height: 720,
    framerate: 25, bitrate: 2048, ...snapshotOptions,
  }]};
  let generated;
  const writes = [];
  const removed = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../rtsp_to_onvif/ha-config.js'), 'utf8'), {
    console: {log() {}, warn() {}},
    require: name => {
      if (name === 'fs') return {
        readFileSync: file => JSON.stringify(file.endsWith('options.json') ? options : previousConfig),
        existsSync: file => file.endsWith('onvif.yaml') ? !!previousConfig : !!staleRestream,
        writeFileSync(file, body, mode) {writes.push({file, mode});}, chmodSync() {},
        unlinkSync(file) {removed.push(file);},
      };
      if (name === 'os') return {networkInterfaces: () => ({eth0: []})};
      if (name === 'child_process') return {execSync: () => 'inet 198.51.100.30/24'};
      if (name === './restream-config.cjs') return require('../rtsp_to_onvif/restream-config.cjs');
      if (name === '/app/node_modules/yaml') return {
        parse: JSON.parse,
        stringify: value => {if (value.onvif) generated = value; return '';},
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, {timeout: 1000});
  inspect?.({writes, removed});
  return generated.onvif[0];
}

test('an explicit empty snapshot path enables the upstream fallback', () => {
  const config = generatedConfig({snapshot_path: ''});
  assert.equal(config.highQuality.snapshot, '');
  assert.equal(config.highQuality.rtsp, '/Streaming/Channels/101');
  assert.equal(config.target.ports.rtsp, 554);
});

test('restream changes only the RTSP upstream and keeps the original snapshot target', () => {
  const config = generatedConfig({restream: true, rtsp_username: 'admin', rtsp_password: 'secret', target_snapshot_port: 80});
  assert.equal(config.target.hostname, '198.51.100.10');
  assert.equal(config.target.rtspHostname, '127.0.0.1');
  assert.equal(config.target.ports.rtsp, 19854);
  assert.equal(config.target.ports.snapshot, 80);
  assert.equal(config.highQuality.rtsp, '/TestCamera');
  assert.equal(config.ports.rtsp, 19554);
  assert.ok(!JSON.stringify(config).includes('secret'));
});

test('omitted snapshot path keeps the existing Wyze default', () => {
  assert.equal(generatedConfig({}).highQuality.snapshot, '/snapshot/TestCamera.jpg');
});

test('explicit snapshot endpoint is preserved', () => {
  const config = generatedConfig({snapshot_path: '/camera/snapshot.jpg', target_snapshot_port: 80});
  assert.equal(config.highQuality.snapshot, '/camera/snapshot.jpg');
  assert.equal(config.target.ports.snapshot, 80);
});

test('enabling/disabling restream preserves camera identity and clears stale credentials', () => {
  const previousConfig = {onvif: [{name: 'TestCamera', mac: '1A:11:B0:00:00:01', uuid: 'persistent-uuid'}]};
  const enabled = generatedConfig({restream: true}, {previousConfig, inspect: ({writes}) => {
    assert.equal(writes.find(write => write.file.endsWith('restream.yaml')).mode.mode, 0o600);
  }});
  const disabled = generatedConfig({restream: false}, {previousConfig, staleRestream: true, inspect: ({removed}) => {
    assert.deepEqual(removed, ['/data/restream.yaml']);
  }});
  for (const config of [enabled, disabled]) {
    assert.equal(config.mac, previousConfig.onvif[0].mac);
    assert.equal(config.uuid, previousConfig.onvif[0].uuid);
  }
  assert.equal(disabled.target.rtspHostname, undefined);
  assert.equal(disabled.target.ports.rtsp, 554);
  assert.equal(disabled.highQuality.rtsp, '/Streaming/Channels/101');
});
