/*jshint smarttabs:true */
(function (root, factory) {

	"use strict";

	if (typeof exports === 'object') {
		// Node. Does not work with strict CommonJS, but
		// only CommonJS-like enviroments that support module.exports,
		// like Node.
		module.exports = factory(
			require('expect.js'),
			require('get_tlid_encoder_decoder'),
			require('eventsource-monitor'),
			require('syncit/SyncIt'),
			require('syncit/SyncItBuffer'),
			require('syncit/FakeLocalStorage'),
			require('syncit/SyncLocalStorage'),
			require('syncit/AsyncLocalStorage'),
			require('syncit/Path/AsyncLocalStorage'),
			require('../index.js')
		);
	} else if (typeof define === 'function' && define.amd) {
		return define(
			[
				'getTLIdEncoderDecoder',
				'eventsource-monitor',
				'syncit/SyncIt',
				'syncit/SyncItBuffer',
				'syncit/FakeLocalStorage',
				'syncit/SyncLocalStorage',
				'syncit/AsyncLocalStorage',
				'syncit/Path/AsyncLocalStorage',
				'../index.js'
			],
			factory.bind(this, expect)
		);
	} else {
		// Browser globals (root is window)
		throw "Not currently tested...";
	}
}(this, function (expect, getTLIdEncoderDecoder, EventSourceMonitor, SyncIt, 
	SyncItBuffer, FakeLocalStorage, SyncLocalStorage, AsyncLocalStorage,
	Path_AsyncLocalStorage, SyncItControl) {

"use strict";

var FakeEventSource = function(url) {
	this._url = url;
};

FakeEventSource.prototype.open = function() {
	this.onopen({currentTarget: this});
};

FakeEventSource.prototype.pretendDisconnected = function() {
	this.onerror({currentTarget: this});
};

FakeEventSource.prototype.pretendMessage = function(msg) {
	this.onmessage({
		currentTarget: this,
		data: JSON.stringify(msg)
	});
};

describe('SyncItControl',function() {
	
	it('becomes available before being connected when all dataset known', function(done) {
		
		var eventOrder = [];
		
		var userId = 'user-aaa',
			tLEncoderDecoder = getTLIdEncoderDecoder(1392885440069, 2),
			localStorage = new FakeLocalStorage(),
			asyncLocalStorage = new AsyncLocalStorage(
				localStorage,
				'sic-' + userId,
				JSON.stringify,
				JSON.parse
			),
			pathstore = new Path_AsyncLocalStorage(
				asyncLocalStorage,
				tLEncoderDecoder
			),
			syncIt = new SyncIt(pathstore, userId);
		
		var eventSources = [],
			fakeEventSourceFactory = function(url) {
				eventOrder.push('event-source-created');
				eventSources.unshift(new FakeEventSource(url));
				return eventSources[0];
			};
		
		var eventSourceMonitor = new EventSourceMonitor(fakeEventSourceFactory);
		
		// data format = { dataset-[dataset]: [version] }
		var stateConfig = new SyncLocalStorage(
			localStorage,
			'sic-state-' + userId,
			JSON.stringify,
			JSON.parse
		);
		
		var downloadDatasetFunc = function(dataset, from, next) {
			eventOrder.push('downloads-started');
			var downloadedData = {
				"queueitems":[
					{
						"s":"cars",
						"k":"subaru",
						"b":0,
						"m":"another",
						"u":{"Color":"Red"},
						"o":"set",
						"t":1393446188224
					}
				],
				"to":"cars@1"
			};
			return next(
				null,
				downloadedData.queueitems,
				downloadedData.to
			);
		};
		var uploadChangeFunc = function(queueitem, next) {
			next(null, "cars@2");
		};
		var conflictResolutionFunction = function() { expect().fail(); };
		var initialDatasets = ['cars'];
		
		stateConfig.setItem(initialDatasets[0], null);
		
		var syncItControl = new SyncItControl(
			syncIt,
			eventSourceMonitor,
			stateConfig,
			downloadDatasetFunc,
			uploadChangeFunc,
			conflictResolutionFunction,
			initialDatasets
		);
		
		syncItControl.on('advanced-queueitem', function(queueitem) {
			expect(queueitem.k).to.equal('bmw');
			expect(stateConfig.getItem(initialDatasets[0])).to.equal('cars@2');
			done();
		});
		
		eventSourceMonitor.on('added-managed-connection', function() {
			eventOrder.push('added-managed-connection');
			eventSources[0].open();
		});
		
		syncItControl.on('available', function(evt) {
			eventOrder.push('available');
			expect(evt.datasets).to.eql(initialDatasets);
		});
		
		syncItControl.on('uploaded-queueitem', function(queueitem, to) {
			expect(queueitem.k).to.equal('bmw');
			expect(to).to.equal('cars@2');
		});
		
		syncItControl.on('synched', function(evt) {
			eventOrder.push('synched');
			expect(evt.datasets).to.eql(initialDatasets);
			expect(eventOrder).to.eql([
				'available',
				'event-source-created',
				'added-managed-connection',
				'downloads-started',
				'synched'
			]);
			syncIt.get('cars', 'subaru', function(e, data) {
				expect(e).to.equal(0);
				expect(data).to.eql({"Color":"Red"});
				syncIt.set('cars', 'bmw', {Color: 'blue'}, function(e) {
					expect(e).to.equal(0);
				});
			});
		});
		
		syncItControl.connect();
		
	});
	
	it('goes through MISSING_DATASET some dataset not known', function() {
		
	});
	
	it('will push all data online before becoming Synched', function() {
		
	});
	
	it('will pass through EventSource messages into SyncIt', function() {
		
	});
	
	it('will go from Synched to Pushing Discovery to Synched', function() {
		
	});
	
	it('will re-establish everything on error', function() {
		
	});
	
});

}));
