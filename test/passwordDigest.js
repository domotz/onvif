const assert = require('assert');
const onvif = require('../lib/onvif');

// Regression tests for BT-6835: on cameras that enforce WS-UsernameToken
// `Created`-timestamp freshness (replay protection, e.g. Axis Q1785-LE), the
// digest timestamp must be a real wall-clock time even before `timeShift`
// has been learned from getSystemDateAndTime. The buggy fallback produced
// `process.uptime() * 1000` (~1970), which such cameras reject with
// "Sender not authorized", driving Domotz to auto-lock the device.
describe('_passwordDigest timestamp (BT-6835)', () => {
	it('uses wall-clock time when timeShift is not yet known', () => {
		const cam = new onvif.Cam({autoconnect: false, username: 'admin', password: '9999'});
		assert.strictEqual(cam.timeShift, undefined, 'precondition: timeShift must be unset');

		const {timestamp} = cam._passwordDigest();
		const created = new Date(timestamp).getTime();
		const skew = created - Date.now();

		assert.ok(
			Math.abs(skew) < 5000,
			`Created (${timestamp}) must be within 5s of now; got skew ${skew}ms (~1970 fallback regression)`
		);
	});

	it('stays camera-aligned when timeShift is known', () => {
		const cam = new onvif.Cam({autoconnect: false, username: 'admin', password: '9999'});
		// Emulate what getSystemDateAndTime sets: camera clock 1h ahead of our wall clock.
		const cameraNow = Date.now() + 3600 * 1000;
		cam.timeShift = cameraNow - (process.uptime() * 1000);

		const {timestamp} = cam._passwordDigest();
		const skew = new Date(timestamp).getTime() - cameraNow;

		assert.ok(
			Math.abs(skew) < 5000,
			`Created (${timestamp}) must track camera time; got skew ${skew}ms`
		);
	});
});
