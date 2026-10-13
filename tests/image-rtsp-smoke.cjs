// Exercise the real TCP proxy and debug interceptors inside the built image.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const tcpProxy = require('/app/node_modules/node-tcp-proxy');
const {debugProxyOptions} = require('/app/rtsp-debug.cjs');

(async () => {
  const logs = [];
  const auth = 'Authorization: Basic c3ludGhldGljLXNlY3JldA==\r\n';
  const requests = ['DESCRIBE', 'DESCRIBE', 'SETUP', 'PLAY'].map((method, i) => Buffer.from(
    `${method} rtsp://user:url-secret@example.test/video RTSP/1.0\r\nCSeq: ${i + 1}\r\n` +
    (i ? auth : '') + (method === 'SETUP' ? 'Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n' : '') + '\r\n'));
  const sdp = 'v=0\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 profile-level-id=640028\r\n';
  const media = Buffer.from('synthetic-media-secret');
  const frame = Buffer.alloc(4); frame[0] = 0x24; frame.writeUInt16BE(media.length, 2);
  const responses = [
    Buffer.from('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Basic realm="realm-secret"\r\n\r\n'),
    Buffer.from(`RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Type: application/sdp\r\nContent-Length: ${sdp.length}\r\n\r\n${sdp}`),
    Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 3\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n'),
    Buffer.concat([Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 4\r\n\r\n'), frame, media]),
  ];
  const receivedRequests = [];
  const upstream = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      let end;
      while ((end = pending.indexOf('\r\n\r\n')) >= 0) {
        receivedRequests.push(pending.subarray(0, end + 4));
        pending = pending.subarray(end + 4);
        const response = responses[receivedRequests.length - 1];
        socket.write(response.subarray(0, 7));
        socket.write(response.subarray(7));
      }
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = tcpProxy.createProxy(0, '127.0.0.1', upstream.address().port,
    debugProxyOptions({debug: line => logs.push(line)}, 19554));
  await new Promise(resolve => proxy.server.once('listening', resolve));
  const client = net.createConnection(proxy.server.address().port, '127.0.0.1');
  let received = Buffer.alloc(0);
  let waiter;
  client.on('data', data => {received = Buffer.concat([received, data]); waiter?.();});
  try {
    await new Promise((resolve, reject) => {client.once('connect', resolve); client.once('error', reject);});
    let expectedLength = 0;
    for (let i = 0; i < requests.length; i++) {
      expectedLength += responses[i].length;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for proxy response')), 5000);
        waiter = () => {
          if (received.length >= expectedLength) {clearTimeout(timeout); waiter = null; resolve();}
        };
        client.write(requests[i].subarray(0, 3));
        client.write(requests[i].subarray(3));
        waiter();
      });
    }
    assert.deepEqual(Buffer.concat(receivedRequests), Buffer.concat(requests));
    assert.deepEqual(received, Buffer.concat(responses));
    const text = logs.join('\n');
    assert.match(text, /RESPONSE DESCRIBE cseq=1 status=401/);
    assert.match(text, /RESPONSE DESCRIBE cseq=2 status=200/);
    assert.match(text, /RESPONSE PLAY cseq=4 status=200/);
    assert.match(text, /SDP codecs=H264 profile_level_id=640028/);
    assert.match(text, /MEDIA channel=0/);
    for (const secret of ['url-secret', 'c3ludGhldGljLXNlY3JldA==', 'realm-secret', 'synthetic-media-secret', 'rtsp://']) {
      assert.ok(!text.includes(secret));
    }
    const main = fs.readFileSync('/app/main.js', 'utf8');
    assert.ok(main.includes('process.env.DEBUG && rtspPorts.has(String(sourcePort))'));
    console.log('PASS: actual proxy preserves RTSP authentication, SDP and media bytes; diagnostic output is redacted.');
  } finally {
    client.destroy();
    const closed = new Promise(resolve => proxy.server.once('close', resolve));
    proxy.end();
    await closed;
    await new Promise(resolve => upstream.close(resolve));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
