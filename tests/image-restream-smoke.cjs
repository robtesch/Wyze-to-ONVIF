// Real H.264/PCMU -> FFmpeg copy -> bundled go2rtc -> actual patched TCP proxy.
// Run with --network none. No LAN devices, macvlan or credentials are touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {spawn, execFileSync, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const YAML = require('/app/node_modules/yaml');
const {supervise, portOpen} = require('/service-runner.cjs');

async function waitPort(port) {
  for (let i = 0; i < 100; i++) {
    if (await portOpen(port)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Port ${port} did not become ready`);
}

(async () => {
  fs.mkdirSync('/data', {recursive: true});
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '3',
    '-c:v', 'libx264', '-profile:v', 'main', '-level:v', '3.1', '-g', '25', '-bf', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'pcm_mulaw', '-ar', '8000', '-ac', '1', '-y', '/tmp/source.mkv'], {timeout: 20000});
  const original = execFileSync('ffmpeg', ['-v', 'error', '-i', '/tmp/source.mkv', '-map', '0:v:0',
    '-frames:v', '1', '-f', 'framemd5', '-'], {encoding: 'utf8'});
  const frameHash = original.trim().split('\n').filter(line => !line.startsWith('#'))[0].split(',').at(-1).trim();
  fs.writeFileSync('/tmp/source.yaml', YAML.stringify({
    api: {listen: ''}, webrtc: {listen: ''}, rtsp: {listen: '0.0.0.0:20000'}, streams: {Source: []},
  }));
  const source = spawn('/usr/local/bin/go2rtc', ['-config', '/tmp/source.yaml'], {detached: true, stdio: 'ignore'});
  const stopSource = () => {try {process.kill(-source.pid, 'SIGKILL');} catch {}};
  let publisher;
  let services;
  const logs = [];
  try {
    await waitPort(20000);
    publisher = spawn('ffmpeg', ['-v', 'error', '-re', '-stream_loop', '-1', '-i', '/tmp/source.mkv',
      '-c', 'copy', '-rtsp_transport', 'tcp', '-f', 'rtsp', 'rtsp://127.0.0.1:20000/Source'], {detached: true, stdio: 'ignore'});
    await new Promise(resolve => setTimeout(resolve, 1000));
    const options = {interface: 'lo', cameras: [{
      name: 'TestCamera', target_host: '127.0.0.2', target_rtsp_port: 20000,
      rtsp_path: '/Source', restream: true, snapshot_path: '',
      width: 1280, height: 720, framerate: 25, bitrate: 2048,
    }]};
    fs.writeFileSync('/data/options.json', JSON.stringify(options));
    fs.writeFileSync('/data/onvif.yaml', YAML.stringify({onvif: [{name: 'TestCamera', mac: '1A:11:B0:00:00:01', uuid: 'persistent-identity'}]}));
    execFileSync(process.execPath, ['/ha-config.js']);
    const config = YAML.parse(fs.readFileSync('/data/onvif.yaml', 'utf8')).onvif[0];
    assert.equal(config.mac, '1A:11:B0:00:00:01');
    assert.equal(config.uuid, 'persistent-identity');
    assert.equal(fs.statSync('/data/restream.yaml').mode & 0o777, 0o600);
    services = supervise({options,
      restreamCommand: {file: '/usr/local/bin/go2rtc', args: ['-config', '/data/restream.yaml']},
      bridgeCommand: {file: process.execPath, args: ['/checks/tests/image-proxy-launcher.cjs', '/data/onvif.yaml']},
      log: line => logs.push(line),
    });
    await waitPort(19554);
    const url = 'rtsp://127.0.0.1:19554/TestCamera';
    const probeTask = run('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-analyzeduration', '1000000',
      '-show_entries', 'stream=codec_name,width,height,profile,level,sample_rate,channels', '-of', 'json', url], {timeout: 15000});
    // Inspect while a reader is active: go2rtc stops FFmpeg on demand when the
    // last reader leaves, so checking after ffprobe exits is intentionally too late.
    let remuxer;
    for (let attempt = 0; attempt < 50 && !remuxer; attempt++) {
      const commands = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(pid => {
        try {return [fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')];} catch {return [];}
      });
      remuxer = commands.find(args => args.includes('rtsp://127.0.0.2:20000/Source') && args.includes('-allowed_media_types'));
      if (!remuxer) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(remuxer, 'Copy remuxer should be running');
    assert.ok(remuxer.some((arg, index) => /^(?:-c|-codec):v$/.test(arg) && remuxer[index + 1] === 'copy'));
    assert.ok(remuxer.some((arg, index) => /^(?:-c|-codec):a$/.test(arg) && remuxer[index + 1] === 'copy'));
    const probe = await probeTask;
    const streams = JSON.parse(probe.stdout).streams;
    const video = streams.find(stream => stream.codec_name === 'h264');
    assert.deepEqual([video.width, video.height, video.profile, video.level], [1280, 720, 'Main', 31]);
    const audio = streams.find(stream => stream.codec_name === 'pcm_mulaw');
    assert.deepEqual([audio.sample_rate, audio.channels], ['8000', 1]);
    const decoded = await run('ffmpeg', ['-v', 'error', '-rtsp_transport', 'tcp', '-i', url,
      '-map', '0:v:0', '-frames:v', '3', '-f', 'framemd5', '-'], {timeout: 15000});
    const hashes = decoded.stdout.trim().split('\n').filter(line => !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
    assert.deepEqual(hashes, [frameHash, frameHash, frameHash]);
    assert.ok(logs.some(line => line.includes('19554 --> 127.0.0.1:19854')));
    assert.ok(logs.some(line => line.includes('18080 --> 127.0.0.2:5000')));
    process.emit('SIGTERM');
    assert.equal(await services, 0);
    services = null;
    assert.equal(await portOpen(19854), false);
    assert.equal(await portOpen(19554), false);
    assert.equal(await portOpen(18080), false);
    console.log('PASS: real copy-only H.264/PCMU restream decodes unchanged frames through the patched proxy, preserves identity and stops cleanly.');
  } finally {
    if (services) {process.emit('SIGTERM'); await services;}
    if (publisher?.pid) {try {process.kill(-publisher.pid, 'SIGKILL');} catch {}}
    stopSource();
    for (const child of [publisher, source]) {
      if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
    }
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
