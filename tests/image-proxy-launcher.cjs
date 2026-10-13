// Run the real patched upstream launcher without creating macvlan interfaces.
// Only discovery/interface allocation is replaced; all TCP proxies are real.
const fs = require('node:fs');
const YAML = require('/app/node_modules/yaml');
const config = YAML.parse(fs.readFileSync('/data/onvif.yaml', 'utf8'));
class FixtureCamera {
  getHostname() {return '127.0.0.1';}
  startHttpServer() {}
  startDiscovery() {}
  enableDebugOutput() {}
}
const launcher = new Function('require', fs.readFileSync('/app/main.js', 'utf8'));
launcher(name => {
  if (name === './src/config-tools') return {readAndCheckConfig: () => config};
  if (name === './src/onvif-server') return FixtureCamera;
  if (name.startsWith('./')) return require(`/app/${name.slice(2)}`);
  return require(`/app/node_modules/${name}`);
});
