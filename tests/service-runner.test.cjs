const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {supervise, portOpen} = require('../rtsp_to_onvif/service-runner.cjs');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('bridge exit stops the restream process group, including FFmpeg-like grandchildren', {timeout: 10000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restream-lifecycle-'));
  const pidFile = path.join(dir, 'pid');
  const port = await freePort();
  const logs = [];
  const restream = `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {stdio:'ignore'});
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    require('node:net').createServer(s => s.end()).listen(${port}, '127.0.0.1');
    process.stdout.write('rtsp://admin:sec');
    setTimeout(() => process.stdout.write('ret@192.0.2.52/live\\n'), 10);
  `;
  try {
    const code = await supervise({options: {restream_port: port, cameras: [{rtsp_password: 'secret'}]},
      restreamCommand: {file: process.execPath, args: ['-e', restream]},
      bridgeCommand: {file: process.execPath, args: ['-e', 'setTimeout(() => process.exit(7), 150)']},
      stopTimeout: 150, log: line => logs.push(line),
    });
    assert.equal(code, 1);
    assert.equal(await portOpen(port), false);
    assert.ok(logs.some(line => line.includes('bridge exited (7)')));
    assert.ok(logs.some(line => line.includes('<REDACTED>@192.0.2.52')));
    assert.ok(!logs.join('\n').includes('secret'));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    // A killed orphan can briefly remain a zombie until the test host reaps it.
    for (let attempt = 0; attempt < 30; attempt++) {
      const stat = `/proc/${pid}/stat`;
      if (!fs.existsSync(stat) || /\) Z /.test(fs.readFileSync(stat, 'utf8'))) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Restream grandchild survived app shutdown');
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});

test('occupied port fails before starting either service', {timeout: 5000}, async () => {
  const server = net.createServer(s => s.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const logs = [];
  try {
    const code = await supervise({options: {restream_port: server.address().port},
      restreamCommand: {file: '/must-not-run', args: []}, bridgeCommand: {file: '/must-not-run', args: []},
      log: line => logs.push(line),
    });
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /already in use/);
    assert.ok(!logs.join('\n').includes('could not start'));
  } finally {await new Promise(resolve => server.close(resolve));}
});

test('failed restream startup prevents bridge launch and removes signal handlers', {timeout: 5000}, async () => {
  const before = process.listenerCount('SIGTERM');
  const logs = [];
  const code = await supervise({options: {restream_port: await freePort()},
    restreamCommand: {file: '/does-not-exist', args: []}, bridgeCommand: {file: '/must-not-run', args: []},
    log: line => logs.push(line),
  });
  assert.equal(code, 1);
  assert.match(logs.join('\n'), /restream could not start/);
  assert.equal(process.listenerCount('SIGTERM'), before);
});

test('app stop signal cleanly stops both services', {timeout: 5000}, async () => {
  const port = await freePort();
  const code = await supervise({options: {restream_port: port},
    restreamCommand: {file: process.execPath, args: ['-e', `require('net').createServer(s => s.end()).listen(${port},'127.0.0.1')`]},
    bridgeCommand: {file: process.execPath, args: ['-e', 'console.log("ready"); setInterval(() => {}, 1000)']},
    log: line => {if (line.includes('[bridge] ready')) process.emit('SIGTERM');},
  });
  assert.equal(code, 0);
  assert.equal(await portOpen(port), false);
});
