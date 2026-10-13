const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {debugProxyOptions} = require('../rtsp_to_onvif/rtsp-debug.cjs');

function connection(logger) {
  const logs = [];
  const socket = new EventEmitter();
  socket.remoteAddress = '198.51.100.40';
  const context = {proxySocket: socket};
  const options = debugProxyOptions(logger || {debug: line => logs.push(line)}, 19554);
  function send(direction, buffer, size = buffer.length) {
    for (let offset = 0; offset < buffer.length; offset += size) {
      const chunk = buffer.subarray(offset, offset + size);
      assert.equal(options[direction](context, chunk), chunk, 'must forward the identical Buffer');
    }
  }
  return {logs, socket, send};
}

test('logs authentication outcomes, transport and media across fragmented TCP messages', () => {
  for (const size of [1, 7, 4096]) {
    const {send, logs, socket} = connection();
    send('upstream', Buffer.from('DESCRIBE rtsp://user:uri-secret@example.test/video RTSP/1.0\r\nCSeq: 1\r\nAuthorization: Basic YmFzaWMtc2VjcmV0\r\n\r\n'), size);
    send('downstream', Buffer.from('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="realm-secret", nonce="nonce-secret"\r\n\r\n'), size);
    send('upstream', Buffer.from('DESCRIBE rtsp://example.test/video RTSP/1.0\r\nCSeq: 2\r\nAuthorization: Digest username="user-secret", response="digest-secret"\r\n\r\n'), size);
    const sdp = 'v=0\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 profile-level-id=42001e;sprop-parameter-sets=sps-secret\r\na=control:rtsp://user:control-secret@example.test/track\r\n';
    send('downstream', Buffer.from(`RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Type: application/sdp\r\nContent-Length: ${Buffer.byteLength(sdp)}\r\n\r\n${sdp}`), size);
    send('upstream', Buffer.from('SETUP rtsp://example.test/track RTSP/1.0\r\nCSeq: 3\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n'), size);
    send('downstream', Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 3\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n'), size);
    send('upstream', Buffer.from('PLAY rtsp://example.test/video RTSP/1.0\r\nCSeq: 4\r\n\r\n'), size);
    const payload = Buffer.from('media-secret');
    const frame = Buffer.alloc(4); frame[0] = 0x24; frame[1] = 0; frame.writeUInt16BE(payload.length, 2);
    send('downstream', Buffer.concat([Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 4\r\n\r\n'), frame, payload, frame, payload]), size);
    socket.emit('close');
    const text = logs.join('\n');
    assert.match(text, /RESPONSE DESCRIBE cseq=1 status=401/);
    assert.match(text, /RESPONSE DESCRIBE cseq=2 status=200/);
    assert.match(text, /REQUEST SETUP cseq=3 auth=none transport=TCP/);
    assert.match(text, /RESPONSE PLAY cseq=4 status=200/);
    assert.match(text, /SDP codecs=H264 profile_level_id=42001e/);
    assert.match(text, /CLOSE requests=4 responses=4 interleaved_frames=2/);
    assert.equal(logs.filter(line => line.includes('MEDIA channel=0')).length, 1);
    for (const secret of ['uri-secret', 'YmFzaWMtc2VjcmV0', 'realm-secret', 'nonce-secret', 'user-secret',
      'digest-secret', 'sps-secret', 'control-secret', 'media-secret', 'Authorization', 'WWW-Authenticate', 'rtsp://']) {
      assert.ok(!text.includes(secret), `logged sensitive material: ${secret}`);
    }
  }
});

test('UDP setup and rejection can be distinguished without logging transport addresses', () => {
  const {send, logs} = connection();
  send('upstream', Buffer.from('SETUP rtsp://example.test/video RTSP/1.0\r\nCSeq: 3\r\nTransport: RTP/AVP;unicast;destination=private-host;client_port=1000-1001\r\n\r\n'));
  send('downstream', Buffer.from('RTSP/1.0 461 Unsupported Transport\r\nCSeq: 3\r\n\r\n'));
  assert.match(logs.join('\n'), /transport=UDP/);
  assert.match(logs.join('\n'), /RESPONSE SETUP cseq=3 status=461/);
  assert.ok(!logs.join('\n').includes('private-host'));
});

test('oversized SDP and incomplete media are bounded and not exposed', () => {
  const {send, logs, socket} = connection();
  const body = 'oversized-secret'.repeat(2000);
  send('downstream', Buffer.from(`RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Type: application/sdp\r\nContent-Length: ${body.length}\r\n\r\n${body}RTSP/1.0 200 OK\r\nCSeq: 2\r\n\r\n`), 7);
  send('downstream', Buffer.from([0x24, 0, 0, 100, 1, 2]));
  socket.emit('close');
  assert.equal(logs.filter(line => line.includes('RESPONSE')).length, 2);
  assert.ok(!logs.join('\n').includes('oversized-secret'));
  assert.match(logs.join('\n'), /interleaved_frames=0/);
});

test('oversized headers and logger failures never alter forwarded bytes', () => {
  const {send, logs} = connection();
  send('upstream', Buffer.from('header-secret'.repeat(6000)));
  send('upstream', Buffer.from('PLAY rtsp://example.test/video RTSP/1.0\r\nCSeq: 1\r\n\r\n'));
  assert.ok(!logs.join('\n').includes('header-secret'));
  const failing = connection({debug() {throw new Error('logging failed');}});
  failing.send('upstream', Buffer.from('PLAY rtsp://example.test/video RTSP/1.0\r\nCSeq: 1\r\n\r\n'));
});
