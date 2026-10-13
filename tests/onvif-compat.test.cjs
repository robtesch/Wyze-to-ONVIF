const {test, before} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const http = require('node:http');
const {patchSource, UPSTREAM_SHA, SOURCE_HASH} = require('../rtsp_to_onvif/patch-onvif-server.cjs');

let original;
before(async () => {
  const cache = path.join(__dirname, '..', '.cache', `onvif-server-${UPSTREAM_SHA}.js`);
  if (!fs.existsSync(cache)) {
    const response = await fetch(`https://raw.githubusercontent.com/dlo747/RTSP-to-ONVIF-Unifi-Protect/${UPSTREAM_SHA}/src/onvif-server.js`, {
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, 'Could not fetch pinned upstream fixture');
    const text = await response.text();
    assert.equal(crypto.createHash('sha256').update(text).digest('hex'), SOURCE_HASH);
    fs.mkdirSync(path.dirname(cache), {recursive: true});
    fs.writeFileSync(cache, text);
  }
  original = fs.readFileSync(cache, 'utf8');
  assert.equal(crypto.createHash('sha256').update(original).digest('hex'), SOURCE_HASH);
});

function makeBridge(source, {staticIp, debug = false} = {}) {
  const config = {
    name: 'TestCamera', mac: '02:00:00:00:00:42',
    highQuality: {width: 1280, height: 720, framerate: 25, bitrate: 2048, quality: 4,
      rtsp: '/Streaming/Channels/101'},
    lowQuality: {width: 640, height: 360, framerate: 15, bitrate: 512, quality: 2,
      rtsp: '/Streaming/Channels/102'},
    ports: {server: 8081, rtsp: 19554, snapshot: 18080},
    ...(staticIp ? {ipv4: staticIp} : {}),
  };
  const moduleStub = {exports: {}};
  const logs = [];
  vm.runInNewContext(source, {
    module: moduleStub, Buffer, process: {env: debug ? {DEBUG: '1'} : {}},
    console: {debug: (...args) => logs.push(args.join(' '))},
    require: name => {
      if (name === './net-tools') return {getIp4FromMac: () => '198.51.100.42'};
      if (name === 'os') return {networkInterfaces: () => ({rtsp2onvif_0: [{
        address: '198.51.100.42', cidr: '198.51.100.42/28',
      }]})};
      if (['http', 'dgram', 'url', 'fs'].includes(name)) return require(name);
      if (['xml2js', 'node-uuid', 'simple-node-logger'].includes(name)) return {};
      throw new Error(`Unexpected upstream dependency: ${name}`);
    },
  }, {timeout: 1000});
  const bridge = new moduleStub.exports({info() {}, debug() {}, error() {}}, config);
  return {bridge, logs};
}

async function withEndpoint(source, options, callback) {
  const {bridge, logs} = makeBridge(source, options);
  const server = http.createServer((req, res) => bridge.listen(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(action, {extra = '', header = ''} = {}) {
    const device = ['GetNetworkInterfaces', 'GetDeviceInformation', 'GetServices'].includes(action);
    const namespace = `http://www.onvif.org/ver10/${device ? 'device' : 'media'}/wsdl`;
    // Match Protect's unprefixed action and XML declaration, including optional WS-Security headers.
    const body = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${header}<s:Body><${action} xmlns="${namespace}">${extra}</${action}></s:Body></s:Envelope>`;
    const response = await fetch(`${base}/onvif/${device ? 'device' : 'media'}_service`, {
      method: 'POST', body, headers: {'Content-Type': 'application/soap+xml'},
    });
    assert.equal(response.status, 200);
    return response.text();
  }
  try {
    await callback(request, logs);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

test('pinned upstream reproduces both reported SOAP faults', async () => {
  await withEndpoint(original, {}, async request => {
    for (const action of ['GetNetworkInterfaces', 'GetVideoEncoderConfigurationOptions']) {
      assert.ok((await request(action)).includes(`Unsupported ONVIF action ${action}`));
    }
  });
});

test('network response reports the virtual camera identity and actual DHCP prefix', async () => {
  await withEndpoint(patchSource(original), {}, async request => {
    const xml = await request('GetNetworkInterfaces');
    assert.ok(xml.includes('<tds:GetNetworkInterfacesResponse>'));
    assert.ok(xml.includes('token="rtsp2onvif_0"'));
    assert.ok(xml.includes('<tt:HwAddress>02:00:00:00:00:42</tt:HwAddress>'));
    assert.ok(xml.includes('<tt:FromDHCP><tt:Address>198.51.100.42</tt:Address><tt:PrefixLength>28</tt:PrefixLength>'));
    assert.ok(xml.includes('<tt:DHCP>true</tt:DHCP>'));
    assert.ok(!xml.includes('<s:Fault>'));
  });
});

test('network response distinguishes static configuration from DHCP', async () => {
  await withEndpoint(patchSource(original), {staticIp: '198.51.100.42/24'}, async request => {
    const xml = await request('GetNetworkInterfaces');
    assert.ok(xml.includes('<tt:Manual><tt:Address>198.51.100.42</tt:Address><tt:PrefixLength>24</tt:PrefixLength>'));
    assert.ok(xml.includes('<tt:DHCP>false</tt:DHCP>'));
    assert.ok(!xml.includes('<tt:FromDHCP>'));
  });
});

test('encoder options use the requested profile and advertise fixed passthrough settings', async () => {
  await withEndpoint(patchSource(original), {}, async request => {
    const main = await request('GetVideoEncoderConfigurationOptions', {extra: '<ProfileToken>main_stream</ProfileToken>'});
    assert.ok(main.includes('<tt:Width>1280</tt:Width><tt:Height>720</tt:Height>'));
    assert.ok(main.includes('<tt:FrameRateRange><tt:Min>25</tt:Min><tt:Max>25</tt:Max></tt:FrameRateRange>'));
    assert.ok(main.includes('<tt:H264ProfilesSupported>Main</tt:H264ProfilesSupported>'));
    const sub = await request('GetVideoEncoderConfigurationOptions', {extra: '<ConfigurationToken>encoder_lq_config_token</ConfigurationToken>'});
    assert.ok(sub.includes('<tt:Width>640</tt:Width><tt:Height>360</tt:Height>'));
    assert.ok(sub.includes('<tt:FrameRateRange><tt:Min>15</tt:Min><tt:Max>15</tt:Max></tt:FrameRateRange>'));
    assert.ok(!(await request('GetVideoEncoderConfigurationOptions')).includes('<s:Fault>'));
    for (const extra of ['<ProfileToken>unknown</ProfileToken>', '<ConfigurationToken>unknown</ConfigurationToken>',
      '<ProfileToken>main_stream</ProfileToken><ConfigurationToken>encoder_lq_config_token</ConfigurationToken>']) {
      assert.ok((await request('GetVideoEncoderConfigurationOptions', {extra})).includes('<s:Fault>'));
    }
  });
});

test('existing profile and RTSP URL responses remain identical', async () => {
  for (const action of ['GetProfiles', 'GetDeviceInformation', 'GetServices', 'GetStreamUri']) {
    const options = {extra: '<ProfileToken>main_stream</ProfileToken>'};
    let before;
    await withEndpoint(original, {}, async request => {before = await request(action, options);});
    await withEndpoint(patchSource(original), {}, async request => {
      assert.equal(await request(action, options), before);
    });
  }
});

test('debug output keeps action information and omits authentication tokens', async () => {
  await withEndpoint(patchSource(original), {debug: true}, async (request, logs) => {
    await request('GetProfiles', {header: '<s:Header><Security><UsernameToken><Username>test-user</Username><Password>synthetic-secret</Password><Nonce>synthetic-nonce</Nonce></UsernameToken></Security></s:Header>'});
    assert.ok(logs.some(line => line.includes('Action GetProfiles')));
    for (const secret of ['test-user', 'synthetic-secret', 'synthetic-nonce', 'UsernameToken']) {
      assert.ok(!logs.some(line => line.includes(secret)));
    }
  });
});

test('patch refuses unexpected upstream source', () => {
  assert.throws(() => patchSource(original + '\n'), /differs from pinned upstream/);
});
