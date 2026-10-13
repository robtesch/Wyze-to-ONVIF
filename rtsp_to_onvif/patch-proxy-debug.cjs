const fs = require('node:fs');
const crypto = require('node:crypto');

function patchSource(source) {
  if (crypto.createHash('sha256').update(source).digest('hex') !== '666712f1252531aabc68140a4f666dadad22532ebea95cfea18d4a16fb4d638b') {
    throw new Error('Proxy launcher differs from pinned upstream; review the RTSP diagnostic patch.');
  }
  return source
    .replace("const tcpProxy = require('node-tcp-proxy');", "const tcpProxy = require('node-tcp-proxy');\nconst { debugProxyOptions } = require('./rtsp-debug.cjs');")
    .replace('    let proxies = {};', '    let proxies = {};\n    const rtspPorts = new Set(config.onvif.map(camera => String(camera.ports.rtsp)));')
    .replace('            if (onvifConfig.ports.rtsp && onvifConfig.target.ports.rtsp)\n                proxies[onvifConfig.target.hostname][onvifConfig.ports.rtsp] = onvifConfig.target.ports.rtsp;',
      '            const rtspHost = onvifConfig.target.rtspHostname || onvifConfig.target.hostname;\n            if (!proxies[rtspHost]) proxies[rtspHost] = {};\n            if (onvifConfig.ports.rtsp && onvifConfig.target.ports.rtsp)\n                proxies[rtspHost][onvifConfig.ports.rtsp] = onvifConfig.target.ports.rtsp;')
    .replace('tcpProxy.createProxy(sourcePort, destinationAddress, proxies[destinationAddress][sourcePort]);', 'tcpProxy.createProxy(sourcePort, destinationAddress, proxies[destinationAddress][sourcePort],\n                process.env.DEBUG && rtspPorts.has(String(sourcePort)) ? debugProxyOptions(logger, sourcePort) : undefined);');
}

module.exports = {patchSource};
if (require.main === module) {
  const filename = process.argv[2];
  if (!filename) throw new Error('Usage: node patch-proxy-debug.cjs <main.js>');
  fs.writeFileSync(filename, patchSource(fs.readFileSync(filename, 'utf8')));
  console.log('[rtsp-debug] Added opt-in, redacted RTSP negotiation logging.');
}
