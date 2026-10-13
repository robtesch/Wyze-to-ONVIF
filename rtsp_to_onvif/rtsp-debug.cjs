const net = require('node:net');

const MAX_HEADER = 64 * 1024;
const MAX_SDP = 16 * 1024;

// Observe RTSP framing without changing bytes or retaining media payloads.
class Inspector {
  constructor(onHeader, onFrame, onSdp) {
    Object.assign(this, {onHeader, onFrame, onSdp});
    this.pending = Buffer.alloc(0);
    this.body = null;
    this.disabled = false;
  }
  feed(data) {
    if (this.disabled) return;
    if (this.pending.length) {
      data = Buffer.concat([this.pending, data]);
      this.pending = Buffer.alloc(0);
    }
    while (data.length) {
      if (this.body) {
        const count = Math.min(this.body.remaining, data.length);
        if (this.body.parts) this.body.parts.push(data.subarray(0, count));
        this.body.remaining -= count;
        data = data.subarray(count);
        if (this.body.remaining === 0) {
          const body = this.body;
          this.body = null;
          if (body.channel !== undefined && body.total > 0) this.onFrame(body.channel, body.total);
          if (body.parts) this.onSdp(Buffer.concat(body.parts).toString('utf8'));
        }
        continue;
      }
      if (data[0] === 0x24) {
        if (data.length < 4) {this.pending = data; return;}
        const size = data.readUInt16BE(2);
        if (size) this.body = {remaining: size, total: size, channel: data[1]};
        data = data.subarray(4);
        continue;
      }
      const end = data.indexOf('\r\n\r\n');
      if (end < 0) {
        if (data.length > MAX_HEADER) this.disabled = true;
        else this.pending = data;
        return;
      }
      if (end > MAX_HEADER) {this.disabled = true; return;}
      const lines = data.subarray(0, end).toString('utf8').split('\r\n');
      const headers = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      this.onHeader(lines[0], headers);
      const length = /^\d{1,10}$/.test(headers['content-length'] || '') ? Number(headers['content-length']) : 0;
      if (length) this.body = {
        remaining: length,
        parts: headers['content-type']?.toLowerCase() === 'application/sdp' && length <= MAX_SDP ? [] : null,
      };
      data = data.subarray(end + 4);
    }
  }
}

function sequence(headers) {
  return /^\d{1,10}$/.test(headers.cseq || '') ? headers.cseq : '?';
}
function transport(header) {
  if (/\bRTP\/AVP(?:F)?\/TCP\b/i.test(header || '')) return ' transport=TCP';
  if (/\bRTP\/AVP(?:F)?\b/i.test(header || '')) return ' transport=UDP';
  return '';
}

function debugProxyOptions(logger, port) {
  const sessions = new WeakMap();
  let nextId = 0;
  function session(context) {
    const socket = context.proxySocket;
    let state = sessions.get(socket);
    if (state) return state;
    const address = net.isIP(socket.remoteAddress || '') ? socket.remoteAddress : 'unknown';
    const prefix = `[RTSP ${port}#${++nextId} peer=${address}]`;
    const emit = message => {
      try {logger.debug(`${prefix} ${message}`);} catch { /* Forwarding must not depend on logging. */ }
    };
    const methods = new Map();
    const channels = new Set();
    state = {requests: 0, responses: 0, frames: 0};
    state.upstream = new Inspector((line, headers) => {
      const method = line.match(/^(OPTIONS|DESCRIBE|SETUP|PLAY|PAUSE|TEARDOWN|GET_PARAMETER|SET_PARAMETER|ANNOUNCE|RECORD)\s+\S+\s+RTSP\/1\.0$/)?.[1];
      if (!method) return;
      const cseq = sequence(headers);
      const auth = headers.authorization?.match(/^(Basic|Digest)\b/i)?.[1]?.toLowerCase() || (headers.authorization ? 'other' : 'none');
      if (methods.size >= 128) methods.delete(methods.keys().next().value);
      methods.set(cseq, method);
      state.requests++;
      emit(`REQUEST ${method} cseq=${cseq} auth=${auth}${transport(headers.transport)}`);
    }, () => {}, () => {});
    state.downstream = new Inspector((line, headers) => {
      const status = line.match(/^RTSP\/1\.0\s+(\d{3})(?:\s|$)/)?.[1];
      if (!status) return;
      const cseq = sequence(headers);
      const method = methods.get(cseq) || 'unknown';
      methods.delete(cseq);
      state.responses++;
      emit(`RESPONSE ${method} cseq=${cseq} status=${status}${transport(headers.transport)}`);
    }, (channel, bytes) => {
      state.frames++;
      if (!channels.has(channel)) {
        channels.add(channel);
        emit(`MEDIA channel=${channel} first_frame_bytes=${bytes}`);
      }
    }, sdp => {
      const allowed = new Set(['H264', 'H265', 'PCMU', 'PCMA', 'MPEG4-GENERIC', 'OPUS', 'L16', 'L8', 'MPA']);
      const codecs = [...sdp.matchAll(/^a=rtpmap:\d+\s+([\w-]+)\//gmi)].map(match => allowed.has(match[1].toUpperCase()) ? match[1].toUpperCase() : 'OTHER');
      const profiles = [...sdp.matchAll(/\bprofile-level-id=([0-9a-f]{6})(?:[;\s]|$)/gi)].map(match => match[1].toLowerCase());
      emit(`SDP codecs=${[...new Set(codecs)].join(',') || 'unknown'}${profiles.length ? ` profile_level_id=${profiles.join(',')}` : ''}`);
    });
    sessions.set(socket, state);
    emit('OPEN');
    socket.once('close', () => emit(`CLOSE requests=${state.requests} responses=${state.responses} interleaved_frames=${state.frames}`));
    socket.once('error', error => emit(`CLIENT_ERROR code=${/^[A-Z0-9_]{1,32}$/.test(error.code || '') ? error.code : 'OTHER'}`));
    return state;
  }
  function inspect(direction, context, data) {
    try {
      session(context)[direction].feed(data);
    } catch {
      // Diagnostic failures must never interrupt the proxy or expose raw data.
    }
    return data;
  }
  return {
    upstream: (context, data) => inspect('upstream', context, data),
    downstream: (context, data) => inspect('downstream', context, data),
  };
}

module.exports = {debugProxyOptions, Inspector};
