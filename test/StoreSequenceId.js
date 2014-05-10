/*jshint smarttabs:true */
(function (root, factory) {

	"use strict";

	if (typeof exports === 'object') {
		// Node. Does not work with strict CommonJS, but
		// only CommonJS-like enviroments that support module.exports,
		// like Node.
		module.exports = factory(
			require('../node_modules/expect.js/expect.js'),
			require('../StoreSequenceId.js')
		);
	} else if (typeof define === 'function' && define.amd) {
		// AMD. Register as an anonymous module.
		define(
			[
				'../StoreSequenceId.js'
			],
			factory.bind(this, expect)
		);
	} else {
		throw "Not tested";
	}
}(this, function (
	expect,
	StoreSequenceId
) {
// =============================================================================

"use strict";

var StateConfig = function() {
	this.changes = [];
	this.current = null;
	this.key = null;
};

StateConfig.prototype.setItem = function(k, v) {
	this.current = v;
	this.key = k;
};

StateConfig.prototype.getItem = function() {
	return this.current;
};

var cmpFunc = function(a, b) { return a<b?-1:1; };

describe('storeSequenceId',function() {

	it('if we are sure we are in adding things in order from the server', function() {

		// add the change if greated
		var stateConfig = new StateConfig();
		var storeSequenceId = new StoreSequenceId(stateConfig, cmpFunc);
		storeSequenceId.setItem(true, 'bob', null);
		expect(stateConfig.key).to.equal('bob');
	
	});
	it('if we are sure we are in adding things in order from the server', function() {

		// add the change if greated
		var stateConfig = new StateConfig();
		var storeSequenceId = new StoreSequenceId(stateConfig, cmpFunc);
		storeSequenceId.setItem(true, 'bob', 'a');
		expect(stateConfig.getItem()).to.equal('a');
		storeSequenceId.setItem(true, 'bob', 'c');
		expect(stateConfig.getItem()).to.equal('c');

		// do nothing if not greater
		storeSequenceId.setItem(true, 'bob', 'c');
		expect(stateConfig.getItem()).to.equal('c');

		// do nothing if not greater

	});

	it('if we are not sure, we should buffer and then add latest when we are', function() {

		// add three changes, with the latest in the middle
		var stateConfig = new StateConfig();
		var storeSequenceId = new StoreSequenceId(stateConfig, cmpFunc);
		storeSequenceId.setItem(false, 'bob', 'a');
		storeSequenceId.setItem(false, 'bob', 'g');
		storeSequenceId.setItem(false, 'bob', 'e');

		// add another one which is not the highest
		storeSequenceId.setItem(true, 'bob', 'c');

		// now test that the latest the middle of the first three
		expect(stateConfig.getItem()).to.equal('g');

	});

	it('a quick test to make sure it considers the sure one when there is already unsure', function() {

		// add three changes, with the latest in the middle
		var stateConfig = new StateConfig();
		var storeSequenceId = new StoreSequenceId(stateConfig, cmpFunc);
		storeSequenceId.setItem(false, 'bob', 'a');
		storeSequenceId.setItem(false, 'bob', 'e');
		storeSequenceId.setItem(false, 'bob', 'c');

		// add another one which is not the highest
		storeSequenceId.setItem(true, 'bob', 'g');

		// now test that the latest the middle of the first three
		expect(stateConfig.getItem()).to.equal('g');

	});
});

}));
