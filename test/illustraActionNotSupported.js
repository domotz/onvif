const assert = require('assert');
const http = require('http');
const fs = require('fs');
const onvif = require('../lib/onvif');

// Regression tests for BT-6884: Illustra/Tyco cameras (e.g. Flex4 4K Bullet,
// firmware Illustra.SS018.24.03.00.0010) dispatch SOAP on the WS-Addressing
// action this library puts in the Content-Type header, and have no entry for
// GetVideoSources - they answer `wsa5:ActionNotSupported`. connect() treated
// any upstart-function error as fatal, so the camera was discarded even though
// GetProfiles had already returned valid profiles, leaving Domotz with no ONVIF
// driver and no Camera tab.
//
// The camera is emulated locally: every operation answers from the ordinary
// serverMockup fixtures except GetVideoSources, which returns the SOAP 1.2
// fault the real firmware sends.

const fixtures = __dirname + '/serverMockup/';
const port = 10102;

const actionNotSupportedFault =
	'<?xml version="1.0" encoding="UTF-8"?>' +
	'<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"' +
	' xmlns:wsa5="http://www.w3.org/2005/08/addressing">' +
	'<SOAP-ENV:Body>' +
	'<SOAP-ENV:Fault>' +
	'<SOAP-ENV:Code>' +
	'<SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value>' +
	'<SOAP-ENV:Subcode><SOAP-ENV:Value>wsa5:ActionNotSupported</SOAP-ENV:Value></SOAP-ENV:Subcode>' +
	'</SOAP-ENV:Code>' +
	'<SOAP-ENV:Reason>' +
	'<SOAP-ENV:Text xml:lang="en">The [action] cannot be processed at the receiver.</SOAP-ENV:Text>' +
	'</SOAP-ENV:Reason>' +
	'</SOAP-ENV:Fault>' +
	'</SOAP-ENV:Body>' +
	'</SOAP-ENV:Envelope>';

// Operations the emulated firmware has no dispatch entry for. Mutable so each
// test can pick which operation the camera refuses.
let unsupportedOperations = [];
// When set, GetProfiles answers with an empty profile list.
let withoutProfiles = false;
// When set, the camera advertises Media2 (Profile T) and answers GetProfiles in the
// ver20 format - what the Illustra Flex4 actually does.
let media2 = false;

const service = (namespace, path) =>
	'<tds:Service>' +
	'<tds:Namespace>' + namespace + '</tds:Namespace>' +
	'<tds:XAddr>http://localhost' + path + '</tds:XAddr>' +
	'<tds:Version><tt:Major>2</tt:Major><tt:Minor>60</tt:Minor></tds:Version>' +
	'</tds:Service>';

const media2Services =
	'<?xml version="1.0" encoding="UTF-8"?>' +
	'<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"' +
	' xmlns:tds="http://www.onvif.org/ver10/device/wsdl"' +
	' xmlns:tt="http://www.onvif.org/ver10/schema">' +
	'<SOAP-ENV:Body><tds:GetServicesResponse>' +
	service('http://www.onvif.org/ver10/device/wsdl', '/onvif/device_service') +
	service('http://www.onvif.org/ver10/media/wsdl', '/onvif/media_service') +
	service('http://www.onvif.org/ver20/media/wsdl', '/onvif/media2_service') +
	'</tds:GetServicesResponse></SOAP-ENV:Body>' +
	'</SOAP-ENV:Envelope>';

// Two profiles sharing one physical video source, as the Flex4 reports them.
const media2Profile = (token) =>
	'<tr2:Profiles token="' + token + '" fixed="true">' +
	'<tr2:Name>' + token + '</tr2:Name>' +
	'<tr2:Configurations>' +
	'<tr2:VideoSource token="VideoSourceConfig_1">' +
	'<tt:Name>VideoSourceConfig_1</tt:Name><tt:UseCount>2</tt:UseCount>' +
	'<tt:SourceToken>VideoSource_1</tt:SourceToken>' +
	'<tt:Bounds x="0" y="0" width="3840" height="2160"/>' +
	'</tr2:VideoSource>' +
	'<tr2:VideoEncoder token="VideoEncoder_' + token + '">' +
	'<tt:Name>VideoEncoder_' + token + '</tt:Name><tt:UseCount>1</tt:UseCount>' +
	'<tt:Encoding>H264</tt:Encoding>' +
	'<tt:Resolution><tt:Width>3840</tt:Width><tt:Height>2160</tt:Height></tt:Resolution>' +
	'<tt:RateControl><tt:FrameRateLimit>15</tt:FrameRateLimit><tt:BitrateLimit>8192</tt:BitrateLimit></tt:RateControl>' +
	'</tr2:VideoEncoder>' +
	'</tr2:Configurations>' +
	'</tr2:Profiles>';

const media2Profiles =
	'<?xml version="1.0" encoding="UTF-8"?>' +
	'<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"' +
	' xmlns:tr2="http://www.onvif.org/ver20/media/wsdl"' +
	' xmlns:tt="http://www.onvif.org/ver10/schema">' +
	'<SOAP-ENV:Body><tr2:GetProfilesResponse>' +
	media2Profile('Profile_1') + media2Profile('Profile_2') +
	'</tr2:GetProfilesResponse></SOAP-ENV:Body>' +
	'</SOAP-ENV:Envelope>';

const emptyProfiles =
	'<?xml version="1.0" encoding="UTF-8"?>' +
	'<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"' +
	' xmlns:trt="http://www.onvif.org/ver10/media/wsdl">' +
	'<SOAP-ENV:Body><trt:GetProfilesResponse/></SOAP-ENV:Body>' +
	'</SOAP-ENV:Envelope>';

const fixtureFor = (request) => {
	if (request.indexOf('GetSystemDateAndTime') !== -1) {
		return 'GetSystemDateAndTime.xml';
	}
	if (request.indexOf('GetServices') !== -1) {
		return 'GetServices.xml';
	}
	if (request.indexOf('GetProfiles') !== -1) {
		return 'GetProfiles.xml';
	}
	if (request.indexOf('GetVideoSources') !== -1) {
		return 'media.GetVideoSources.xml';
	}
	return 'Error.xml';
};

const listener = (req, res) => {
	req.setEncoding('utf8');
	const chunks = [];
	req.on('data', (chunk) => chunks.push(chunk));
	req.on('end', () => {
		const request = chunks.join('');
		const refused = unsupportedOperations.some((operation) => request.indexOf('<' + operation + ' ') !== -1);
		res.setHeader('Content-Type', 'application/soap+xml;charset=UTF-8');
		if (media2 && request.indexOf('<GetServices ') !== -1) {
			return res.end(media2Services);
		}
		if (media2 && request.indexOf('<GetProfiles ') !== -1) {
			return res.end(media2Profiles);
		}
		if (withoutProfiles && request.indexOf('<GetProfiles ') !== -1) {
			return res.end(emptyProfiles);
		}
		if (refused) {
			res.statusCode = 500;
			return res.end(actionNotSupportedFault);
		}
		return res.end(fs.readFileSync(fixtures + fixtureFor(request)));
	});
};

describe('Camera refusing an upstart operation (BT-6884)', () => {
	let server = null;

	before((done) => {
		server = http.createServer(listener).listen(port, done);
	});

	after((done) => {
		server.close(done);
	});

	// Assertions must not throw inside the library's callback: parseSOAPString wraps
	// consumer callbacks in a try/catch and would recycle the AssertionError as a SOAP
	// error, hiding the real failure behind a mocha timeout.
	const check = (done, assertions) => {
		try {
			assertions();
			done();
		} catch (e) {
			done(e);
		}
	};

	const connect = (callback) => new onvif.Cam({
		hostname: 'localhost',
		username: 'admin',
		password: '9999',
		port: port,
	}, callback);

	beforeEach(() => {
		unsupportedOperations = [];
		withoutProfiles = false;
		media2 = false;
	});

	describe('GetVideoSources answered with wsa5:ActionNotSupported', () => {
		beforeEach(() => {
			unsupportedOperations = ['GetVideoSources'];
		});

		it('still connects, keeping the profiles the camera did return', (done) => {
			connect(function(err) {
				const cam = this;
				check(done, () => {
					assert.ok(!err, 'connect must not fail: ' + (err && err.message));
					assert.ok(cam.profiles.length > 0, 'profiles returned by the camera must be kept');
				});
			});
		});

		it('derives the active source from the profiles', (done) => {
			connect(function(err) {
				const cam = this;
				check(done, () => {
					assert.ok(!err, 'connect must not fail: ' + (err && err.message));
					assert.ok(cam.activeSource, 'activeSource must be set so getSnapshotUri/PTZ defaults work');
					assert.strictEqual(cam.activeSource.sourceToken, 'vidsrc0');
					assert.strictEqual(cam.activeSource.profileToken, 'main');
					assert.strictEqual(cam.activeSource.videoSourceConfigurationToken, 'vscfg0');
				});
			});
		});
	});

	// The customer's camera is a Profile T device: its profiles come from Media2 and are
	// converted to the Media1 shape by getProfiles, so the fallback must work on those too.
	describe('Media2 camera refusing GetVideoSources', () => {
		beforeEach(() => {
			unsupportedOperations = ['GetVideoSources'];
			media2 = true;
		});

		it('derives one active source from the Media2 profiles', (done) => {
			connect(function(err) {
				const cam = this;
				check(done, () => {
					assert.ok(!err, 'connect must not fail: ' + (err && err.message));
					assert.strictEqual(cam.media2Support, true, 'precondition: camera must use Media2');
					assert.strictEqual(cam.profiles.length, 2);
					assert.strictEqual(cam.activeSources.length, 1, 'the two profiles share one video source');
					assert.strictEqual(cam.activeSource.sourceToken, 'VideoSource_1');
					assert.strictEqual(cam.activeSource.profileToken, 'Profile_1');
					assert.strictEqual(cam.activeSource.videoSourceConfigurationToken, 'VideoSourceConfig_1');
				});
			});
		});
	});

	describe('GetVideoSources unsupported and no profiles to fall back on', () => {
		beforeEach(() => {
			unsupportedOperations = ['GetVideoSources'];
			withoutProfiles = true;
		});

		it('fails to connect, because no video source can be determined', (done) => {
			connect((err) => check(done, () => {
				assert.ok(err, 'connect must not report success without any video source');
			}));
		});
	});

	describe('GetProfiles answered with wsa5:ActionNotSupported', () => {
		beforeEach(() => {
			unsupportedOperations = ['GetProfiles'];
		});

		it('fails to connect, because without profiles the camera is unusable', (done) => {
			connect((err) => check(done, () => {
				assert.ok(err, 'connect must report the GetProfiles failure');
			}));
		});
	});
});
