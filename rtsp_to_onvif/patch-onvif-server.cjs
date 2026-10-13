// Compatibility patch for the pinned dlo747 ONVIF server. Applied at image build.
const fs = require('node:fs');
const crypto = require('node:crypto');

const UPSTREAM_SHA = 'fcdbcf9f624bd00c874bc00b6b5a07a77ec4f536';
const SOURCE_HASH = '8fc79e82146ea42575660e76c7769b68eed18b4f7370873dea829ecd8505c3be';

function patchSource(source) {
  if (crypto.createHash('sha256').update(source).digest('hex') !== SOURCE_HASH) {
    throw new Error(`ONVIF source differs from pinned upstream ${UPSTREAM_SHA}; review the compatibility patch before updating upstream.`);
  }
  function insertBefore(anchor, addition) {
    if (source.split(anchor).length !== 2) throw new Error(`Expected one patch anchor: ${anchor}`);
    source = source.replace(anchor, addition + anchor);
  }

  insertBefore('    getDeviceInformationResponse() {', `    getNetworkInterfacesResponse() {
        const interfaces = require('os').networkInterfaces();
        let interfaceName = this.config.name;
        let prefix = 24;
        for (const [name, addresses] of Object.entries(interfaces)) {
            const address = addresses.find(entry => entry.address === this.config.hostname);
            if (address) {
                interfaceName = name;
                if (address.cidr) prefix = Number(address.cidr.split('/')[1]);
                break;
            }
        }
        if (this.config.ipv4) prefix = Number(this.config.ipv4.split('/')[1] || prefix);
        const name = this.xmlEscape(interfaceName);
        const mac = this.xmlEscape(this.config.mac.toLowerCase());
        const address = this.xmlEscape(this.config.hostname);
        const addressType = this.config.ipv4 ? 'Manual' : 'FromDHCP';
        return \`    <tds:GetNetworkInterfacesResponse>
      <tds:NetworkInterfaces token="\${name}">
        <tt:Enabled>true</tt:Enabled>
        <tt:Info><tt:Name>\${name}</tt:Name><tt:HwAddress>\${mac}</tt:HwAddress></tt:Info>
        <tt:IPv4><tt:Enabled>true</tt:Enabled><tt:Config>
          <tt:\${addressType}><tt:Address>\${address}</tt:Address><tt:PrefixLength>\${prefix}</tt:PrefixLength></tt:\${addressType}>
          <tt:DHCP>\${!this.config.ipv4}</tt:DHCP>
        </tt:Config></tt:IPv4>
      </tds:NetworkInterfaces>
    </tds:GetNetworkInterfacesResponse>\`;
    }
    getVideoEncoderConfigurationOptionsResponse(profileToken, configurationToken) {
        const profile = this.profiles.find(p =>
            (!profileToken || p.attributes.token === profileToken) &&
            (!configurationToken || p.VideoEncoderConfiguration.attributes.token === configurationToken)
        );
        if (!profile) return null;
        const encoder = profile.VideoEncoderConfiguration;
        const width = encoder.Resolution.Width;
        const height = encoder.Resolution.Height;
        const fps = encoder.RateControl.FrameRateLimit;
        const interval = encoder.RateControl.EncodingInterval;
        const govLength = encoder.H264.GovLength;
        // The proxy cannot reconfigure or transcode the camera. Advertise its
        // existing profile, with fixed ranges, rather than inventing options.
        return \`    <trt:GetVideoEncoderConfigurationOptionsResponse>
      <trt:Options>
        <tt:QualityRange><tt:Min>\${encoder.Quality}</tt:Min><tt:Max>\${encoder.Quality}</tt:Max></tt:QualityRange>
        <tt:H264>
          <tt:ResolutionsAvailable><tt:Width>\${width}</tt:Width><tt:Height>\${height}</tt:Height></tt:ResolutionsAvailable>
          <tt:GovLengthRange><tt:Min>\${govLength}</tt:Min><tt:Max>\${govLength}</tt:Max></tt:GovLengthRange>
          <tt:FrameRateRange><tt:Min>\${fps}</tt:Min><tt:Max>\${fps}</tt:Max></tt:FrameRateRange>
          <tt:EncodingIntervalRange><tt:Min>\${interval}</tt:Min><tt:Max>\${interval}</tt:Max></tt:EncodingIntervalRange>
          <tt:H264ProfilesSupported>\${encoder.H264.H264Profile}</tt:H264ProfilesSupported>
        </tt:H264>
      </trt:Options>
    </trt:GetVideoEncoderConfigurationOptionsResponse>\`;
    }
`);
  insertBefore("                case 'GetServices':", "                case 'GetNetworkInterfaces':\n                    return this.sendSoapResponse(response, this.getNetworkInterfacesResponse());\n");
  insertBefore("                case 'GetVideoSources':", `                case 'GetVideoEncoderConfigurationOptions': {
                    const options = this.getVideoEncoderConfigurationOptionsResponse(profileToken, this.getRequestValue(body, 'ConfigurationToken'));
                    if (!options) return this.sendSoapFault(response, 'Unknown or inconsistent profile/configuration token');
                    return this.sendSoapResponse(response, options);
                }
`);
  const debugBody = '                console.debug(`SERVER: \${body}`);';
  if (!source.includes(debugBody)) throw new Error('Expected SOAP debug-body statement');
  source = source.replace(debugBody, '                // Request bodies contain WS-Security tokens; log only path and action.');
  return source;
}

module.exports = {patchSource, UPSTREAM_SHA, SOURCE_HASH};
if (require.main === module) {
  const filename = process.argv[2];
  if (!filename) throw new Error('Usage: node patch-onvif-server.cjs <onvif-server.js>');
  fs.writeFileSync(filename, patchSource(fs.readFileSync(filename, 'utf8')));
  console.log('[onvif-compat] Added network-interface and encoder-options responses.');
}
