'use strict';

const fs = require('node:fs');
const net = require('node:net');
const readline = require('node:readline');
const {spawn} = require('node:child_process');
const {DEFAULT_PORT, redact} = require('./restream-config.cjs');

function portOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port});
    let done = false;
    const finish = value => {if (!done) {done = true; socket.destroy(); resolve(value);}};
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(200, () => finish(false));
  });
}

// Keep both services in the app's lifecycle, including FFmpeg grandchildren.
async function supervise({options, restreamCommand, bridgeCommand, log = console.log, stopTimeout = 3000}) {
  const children = [];
  let stopping;
  let finish;
  const completion = new Promise(resolve => {finish = resolve;});
  const cameras = options.cameras || [];
  const port = options.restream_port || DEFAULT_PORT;
  const emit = message => log(redact(message, cameras));
  const signalGroup = (child, signal) => {
    if (!child.pid) return;
    try {process.kill(-child.pid, signal);} catch (error) {if (error.code !== 'ESRCH') emit('[services] Could not signal a child process group.');}
  };
  async function stop(code) {
    if (stopping) return stopping;
    stopping = (async () => {
      for (const item of children) signalGroup(item.child, 'SIGTERM');
      const timeout = setTimeout(() => {
        for (const item of children) signalGroup(item.child, 'SIGKILL');
      }, stopTimeout);
      await Promise.all(children.map(item => item.done));
      // A child can exit before one of its grandchildren. Kill the remaining
      // process groups before ending this app, even when the parent has exited.
      for (const item of children) signalGroup(item.child, 'SIGKILL');
      clearTimeout(timeout);
      finish(code);
    })();
    return stopping;
  }
  function launch(name, command) {
    const child = spawn(command.file, command.args, {cwd: command.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    const item = {child};
    item.done = new Promise(resolve => {
      child.once('error', () => {emit(`[services] ${name} could not start.`); resolve(); void stop(1);});
      child.once('exit', (code, signal) => {
        if (!stopping) emit(`[services] ${name} exited (${signal || code}); stopping the app.`);
        resolve();
        if (!stopping) void stop(1);
      });
    });
    children.push(item);
    for (const output of [child.stdout, child.stderr]) {
      const reader = readline.createInterface({input: output});
      reader.on('line', line => emit(`[${name}] ${line}`));
    }
    return item;
  }
  const onSignal = () => {void stop(0);};
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    if (await portOpen(port)) throw new Error('restream_port is already in use; choose another port in Configuration.');
    launch('restream', restreamCommand);
    const deadline = Date.now() + 10000;
    while (!stopping && !await portOpen(port)) {
      if (Date.now() > deadline) throw new Error('Bundled restream did not become ready.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!stopping) {
      emit(`[services] Copy-only restream ready on 127.0.0.1:${port}.`);
      launch('bridge', bridgeCommand);
    }
    return await completion;
  } catch (error) {
    emit(`[services] ${error.message}`);
    await stop(1);
    return await completion;
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}

module.exports = {supervise, portOpen};
if (require.main === module) {
  const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
  supervise({options,
    restreamCommand: {file: '/usr/local/bin/go2rtc', args: ['-config', '/data/restream.yaml']},
    bridgeCommand: {file: process.execPath, args: ['main.js', '/data/onvif.yaml'], cwd: '/app'},
  }).then(code => {process.exitCode = code;}).catch(() => {console.error('[services] Startup failed.'); process.exitCode = 1;});
}
