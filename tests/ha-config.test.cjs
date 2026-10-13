const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function generatedConfig(snapshotOptions) {
  const options = {interface: 'eth0', cameras: [{
    name: 'TestCamera', target_host: '198.51.100.10', target_rtsp_port: 554,
    rtsp_path: '/Streaming/Channels/101', width: 1280, height: 720,
    framerate: 25, bitrate: 2048, ...snapshotOptions,
  }]};
  let generated;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../rtsp_to_onvif/ha-config.js'), 'utf8'), {
    console: {log() {}, warn() {}},
    require: name => {
      if (name === 'fs') return {
        readFileSync: () => JSON.stringify(options), existsSync: () => false,
        writeFileSync() {},
      };
      if (name === 'os') return {networkInterfaces: () => ({eth0: []})};
      if (name === 'child_process') return {execSync: () => 'inet 198.51.100.30/24'};
      if (name === '/app/node_modules/yaml') return {
        stringify: value => {generated = value; return '';},
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, {timeout: 1000});
  return generated.onvif[0];
}

test('an explicit empty snapshot path enables the upstream fallback', () => {
  const config = generatedConfig({snapshot_path: ''});
  assert.equal(config.highQuality.snapshot, '');
  assert.equal(config.highQuality.rtsp, '/Streaming/Channels/101');
  assert.equal(config.target.ports.rtsp, 554);
});

test('omitted snapshot path keeps the existing Wyze default', () => {
  assert.equal(generatedConfig({}).highQuality.snapshot, '/snapshot/TestCamera.jpg');
});

test('explicit snapshot endpoint is preserved', () => {
  const config = generatedConfig({snapshot_path: '/camera/snapshot.jpg', target_snapshot_port: 80});
  assert.equal(config.highQuality.snapshot, '/camera/snapshot.jpg');
  assert.equal(config.target.ports.snapshot, 80);
});
