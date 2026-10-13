// Run inside the built image, without networking privileges or external access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const {execFileSync} = require('node:child_process');

(async () => {
  fs.mkdirSync('/data', {recursive: true});
  fs.writeFileSync('/data/options.json', JSON.stringify({interface: 'lo', cameras: [{
    name: 'TestCamera', target_host: '198.51.100.10', target_rtsp_port: 554,
    rtsp_path: '/Streaming/Channels/101', snapshot_path: '',
    width: 1280, height: 720, framerate: 25, bitrate: 2048,
  }]}));
  execFileSync(process.execPath, ['/ha-config.js']);
  const YAML = require('/app/node_modules/yaml');
  const config = YAML.parse(fs.readFileSync('/data/onvif.yaml', 'utf8')).onvif[0];
  assert.equal(config.highQuality.snapshot, '');

  const OnvifServer = require('/app/src/onvif-server');
  // The snapshot handler needs only the translated configuration. Skip the
  // constructor's MAC/interface lookup so the test never modifies host networking.
  const bridge = Object.create(OnvifServer.prototype);
  bridge.config = {...config, hostname: '127.0.0.1'};
  bridge.logger = {error() {}};
  const server = http.createServer((req, res) => bridge.listen(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  bridge.config.ports.server = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/onvif/media_service`, {
      method: 'POST', headers: {'Content-Type': 'application/soap+xml'},
      body: '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><GetSnapshotUri xmlns="http://www.onvif.org/ver10/media/wsdl"><ProfileToken>main_stream</ProfileToken></GetSnapshotUri></s:Body></s:Envelope>',
    });
    assert.equal(response.status, 200);
    const xml = await response.text();
    const uri = xml.match(/<tt:Uri>([^<]+)<\/tt:Uri>/)?.[1];
    assert.equal(uri, `http://127.0.0.1:${server.address().port}/snapshot.png`);
    const image = await fetch(uri);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(bytes.length > 8);
    assert.equal(bridge.getStreamUri('main_stream'), 'rtsp://127.0.0.1:19554/Streaming/Channels/101');
    console.log('PASS: real config translation selects a reachable built-in PNG; RTSP path remains intact.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
