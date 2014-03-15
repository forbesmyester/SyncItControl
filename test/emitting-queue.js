/*jshint smarttabs:true */
(function (root, factory) {

	"use strict";

	if (typeof exports === 'object') {
		// Node. Does not work with strict CommonJS, but
		// only CommonJS-like enviroments that support module.exports,
		// like Node.
		module.exports = factory(
			require('../node_modules/expect.js/expect.js'),
			require('../emitting-queue.js')
		);
	} else if (typeof define === 'function' && define.amd) {
		// AMD. Register as an anonymous module.
		define(
			[
				'../emitting-queue.js'
			],
			factory.bind(this, expect)
		);
	} else {
		throw "Not tested";
	}
}(this, function (
	expect,
	EmittingQueue
) {
// =============================================================================

"use strict";

describe('Emitting Queue',function() {
	it('Should be able to process normally', function(done) {
		var processed = [];
		var eq = new EmittingQueue(function(item, next) {
			setTimeout(function() {
				processed.push(item);
				next(null, item.id);
			}, 10);
		});
		
		eq.push({id: 'c', name: 'jack'});
		eq.push({id: 'e', name: 'jill'});
		eq.push({id: 'v', name: 'hill'});
		
		eq.on('item-processed', function(item, cb1) {
			expect(item.id).to.equal(
				processed[processed.length-1].id
			);
			expect(cb1).to.equal(item.id);
		});
		eq.on('new-queue-length', function(left) {
			expect(left).to.equal(3 - processed.length);
			if (processed.length === 3) { done(); }
		});
	});
	it('Will suspend on error, then resumed', function(done) {
		var processed = [];
		var resumed = false;
		var eq = new EmittingQueue(function(item, next) {
			setTimeout(function() {
				if (resumed || !processed.length) {
					processed.push(item);
					return next(null, item.id);
				}
				next("SOMETHING!");
			}, 10);
		});
		
		eq.push({id: 'c', name: 'jack'});
		eq.push({id: 'e', name: 'jill'});
		eq.push({id: 'v', name: 'hill'});
		
		eq.on('item-processed', function(item, cb1) {
			expect(item.id).to.equal(
				processed[processed.length-1].id
			);
			expect(cb1).to.equal(item.id);
		});
		eq.on('new-queue-length', function(left) {
			expect(left).to.equal(3 - processed.length);
			if (left === 0) { return done(); }
		});
		eq.on('item-could-not-be-processed', function(err, item) {
			expect(err).to.equal('SOMETHING!');
			expect(item.id).to.equal('e');
			expect(eq.isSuspended()).to.equal(true);
			eq.resume();
			resumed = true;
		});
	});
	it('Will suspend on error, be emptied, then resumed', function(done) {
		var processed = [];
		var resumed = false;
		var eq = new EmittingQueue(function(item, next) {
			setTimeout(function() {
				if (resumed || !processed.length) {
					processed.push(item);
					return next(null, item.id);
				}
				next("SOMETHING!");
			}, 10);
		});
		
		var pushItems = [
			{id: 'c', name: 'jack'},
			{id: 'e', name: 'jill'},
			{id: 'v', name: 'hill'}
		];
		
		eq.on('item-processed', function(item, cb1) {
			expect(item.id).to.equal(
				processed[processed.length-1].id
			);
			expect(cb1).to.equal(item.id);
		});
		var nqlSeq = [1,2,3,2,0,1,2,1,0];
		var nqlPos = 0;
		eq.on('new-queue-length', function(left) {
			expect(left).to.equal(nqlSeq[nqlPos++]);
			if (nqlPos-1 === 4) {
				eq.push(pushItems[1]);
			}
			if (nqlPos-1 === 5) {
				eq.push(pushItems[2]);
			}
			if (nqlPos === nqlSeq.length) {
				expect(processed.length).to.equal(3);
				expect(processed[0].id).to.equal('c');
				expect(processed[1].id).to.equal('e');
				expect(processed[2].id).to.equal('v');
				done();
			}
		});
		eq.on('item-could-not-be-processed', function(err, item) {
			expect(err).to.equal('SOMETHING!');
			expect(item.id).to.equal('e');
			expect(eq.isSuspended()).to.equal(true);
			eq.empty();
			eq.resume();
			resumed = true;
		});
		
		eq.push(pushItems[0]);
		eq.push(pushItems[1]);
		eq.push(pushItems[2]);
		
	});
	it('Can be emptied', function(done) {
		var processed = [];
		var eq = new EmittingQueue(function(item, next) {
			setTimeout(function() {
				if (!processed.length) {
					processed.push(item);
					return next(null, item.id);
				}
				eq.empty();
			}, 10);
		});
		
		eq.push({id: 'c', name: 'jack'});
		eq.push({id: 'e', name: 'jill'});
		eq.push({id: 'v', name: 'hill'});
		
		eq.on('item-processed', function(item, cb1) {
			expect(item.id).to.equal(
				processed[processed.length-1].id
			);
			expect(cb1).to.equal(item.id);
		});
		var newQueueLengthEmitted = false;
		eq.on('new-queue-length', function(left) {
			if (!newQueueLengthEmitted) {
				expect(left).to.equal(3 - processed.length);
				newQueueLengthEmitted = true;
				return;
			}
			expect(left).to.equal(0);
		});
		eq.on('emptied', function(items) {
			expect(items.length).to.equal(2);
			expect(items[0].id).to.equal('e');
			expect(items[1].id).to.equal('v');
			expect(processed.length).to.equal(1);
			done();
		});
		
	});
});

}));
