'use strict';

const net = require('node:net');

const DEFAULT_PORT = 19854;
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function sourceUrl(camera) {
  const host = camera.target_host;
  if (!host || (!net.isIP(host) && !/^[A-Za-z0-9.-]+$/.test(host))) {
    throw new Error(`Camera ${camera.name}: target_host must be an IP address or hostname.`);
  }
  if (!camera.rtsp_path?.startsWith('/') || camera.rtsp_path.includes('#')) {
    throw new Error(`Camera ${camera.name}: rtsp_path must start with / and contain no fragment options.`);
  }
  const port = camera.target_rtsp_port || 8554;
  const url = new URL(`rtsp://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}${camera.rtsp_path}`);
  url.username = encode(camera.rtsp_username || '');
  url.password = encode(camera.rtsp_password || '');
  return url.href;
}

function restreamConfig(options) {
  const cameras = options.cameras || [];
  const selected = cameras.filter(camera => camera.restream);
  if (!selected.length) return null;
  const port = options.restream_port || DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('restream_port must be between 1024 and 65535.');
  for (const [index, camera] of cameras.entries()) {
    if ([camera.server_port || 8081, camera.rtsp_proxy_port || 19554 + index,
      camera.snapshot_proxy_port || 18080 + index].includes(port)) {
      throw new Error('restream_port conflicts with a camera server or proxy port.');
    }
  }
  const streams = {};
  for (const camera of selected) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(camera.name) || Object.hasOwn(streams, camera.name)) {
      throw new Error('Restream camera names must be unique and contain only letters/digits.');
    }
    streams[camera.name] = [`ffmpeg:${sourceUrl(camera)}#video=copy#audio=copy`];
  }
  return {
    api: {listen: ''}, webrtc: {listen: ''},
    rtsp: {listen: `127.0.0.1:${port}`}, streams,
    log: {level: 'info', format: 'text'},
  };
}

function redact(line, cameras) {
  // Child-process errors can include complete FFmpeg commands and source URLs.
  let safe = line.replace(/(rtsps?:\/\/)[^\s"'<>]*@/gi, '$1<REDACTED>@');
  for (const camera of cameras) {
    const password = camera.rtsp_password;
    if (!password) continue;
    for (const value of new Set([password, encode(password), encodeURIComponent(password)])) {
      safe = safe.split(value).join('<REDACTED>');
    }
  }
  return safe;
}

module.exports = {DEFAULT_PORT, restreamConfig, sourceUrl, redact};
