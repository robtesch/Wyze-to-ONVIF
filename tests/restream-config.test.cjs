const {test} = require('node:test');
const assert = require('node:assert/strict');
const {restreamConfig, sourceUrl, redact} = require('../rtsp_to_onvif/restream-config.cjs');

const camera = {
  name: 'GateIntercom', target_host: '192.0.2.52', target_rtsp_port: 554,
  rtsp_path: '/Streaming/Channels/101', restream: true,
  rtsp_username: 'admin', rtsp_password: 'p@ss:# /\'word',
};

test('copy-only restream is opt-in and listens only on loopback', () => {
  assert.equal(restreamConfig({cameras: [{...camera, restream: false}]}), null);
  const config = restreamConfig({cameras: [camera]});
  assert.equal(config.rtsp.listen, '127.0.0.1:19854');
  assert.equal(config.api.listen, '');
  assert.equal(config.webrtc.listen, '');
  assert.deepEqual(Object.keys(config.streams), ['GateIntercom']);
  assert.ok(config.streams.GateIntercom[0].endsWith('#video=copy#audio=copy'));
  assert.ok(!JSON.stringify(config).includes('#video=h264'));
  assert.ok(!JSON.stringify(config).includes(camera.rtsp_password));
});

test('source credentials are URL encoded without changing the RTSP path/query', () => {
  const url = new URL(sourceUrl(camera));
  assert.equal(decodeURIComponent(url.username), camera.rtsp_username);
  assert.equal(decodeURIComponent(url.password), camera.rtsp_password);
  assert.equal(url.pathname, camera.rtsp_path);
  assert.equal(url.port, '554');
  assert.equal(new URL(sourceUrl({...camera, target_host: '2001:db8::52', rtsp_path: '/live?channel=1'})).hostname, '[2001:db8::52]');
  assert.equal(new URL(sourceUrl({...camera, rtsp_path: '/live?channel=1'})).search, '?channel=1');
});

test('fragment injection, duplicate names and internal/public port collisions fail clearly', () => {
  assert.throws(() => sourceUrl({...camera, rtsp_path: '/live#video=h264'}), /fragment/);
  assert.throws(() => sourceUrl({...camera, target_host: 'host/path'}), /hostname/);
  assert.throws(() => restreamConfig({cameras: [camera, camera]}), /unique/);
  assert.throws(() => restreamConfig({restream_port: 19554, cameras: [camera]}), /conflict/);
  assert.throws(() => restreamConfig({restream_port: 18080, cameras: [camera]}), /conflict/);
  assert.throws(() => restreamConfig({restream_port: 8081, cameras: [camera]}), /conflict/);
});

test('logs redact credentials, including a URL split across input chunks after line assembly', () => {
  const safe = redact(`ffmpeg -i ${sourceUrl(camera)} failed; password=${camera.rtsp_password}`, [camera]);
  assert.ok(!safe.includes(camera.rtsp_password));
  assert.ok(!safe.includes(encodeURIComponent(camera.rtsp_password)));
  assert.ok(!safe.includes('admin:'));
  assert.ok(safe.includes('192.0.2.52'));
});
