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

var getStateConfig = function(localStorage, userId) {
	// data format = { dataset-[dataset]: [version] }
	return new SyncLocalStorage(
		localStorage,
		'sic-state-' + userId,
		JSON.stringify,
		JSON.parse
	);
};

var getSyncIt = function(localStorage, userId) {
	var tLEncoderDecoder = getTLIdEncoderDecoder(1392885440069, 2),
		asyncLocalStorage = new AsyncLocalStorage(
			localStorage,
			'sic-' + userId,
			JSON.stringify,
			JSON.parse
		),
		pathstore = new Path_AsyncLocalStorage(
			asyncLocalStorage,
			tLEncoderDecoder
		);
		
	return new SyncItBuffer(new SyncIt(pathstore, userId));
};



describe('SyncItControl',function() {
	
	it('standard use case with all dataset known', function(done) {
		
		/*
		This will use already known datasets, download changes, add some data
		which will then be uploaded. After all that a message will be recieved
		which will cause the data to appear in the local SyncIt.
		*/
		
		var userId = 'user-aaa',
			localStorage = new FakeLocalStorage(),
			syncIt = getSyncIt(localStorage, userId),
			eventOrder = [],
			eventSources = [],
			fakeEventSourceFactory = function(url) {
					eventOrder.push('event-source-created');
					eventSources.unshift(new FakeEventSource(url));
					return eventSources[0];
				},
			eventSourceMonitor = new EventSourceMonitor(fakeEventSourceFactory),
			stateConfig = getStateConfig(localStorage, userId)
		;
		
		var conflictResolutionFunction = function() { expect().fail(); },
			downloadDatasetFunc = function(dataset, from, next) {
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
				},
			uploadChangeFunc = function(queueitem, next) {
					next(null, "cars@2");
				},
			initialDatasets = ['cars'],
			attemptToMessage = function() {
					eventSources[0].pretendMessage({
						command: 'queueitem',
						to: 'cars@3',
						queueitem: {
							"s":"cars",
							"k":"subaru",
							"b":1,
							"m":"another",
							"u":{ "$set": {"Drive":"4WD"} },
							"o":"update",
							"t":1393446188229
						}
					});
					syncIt.listenForFed(function() {
						syncIt.get('cars', 'subaru', function(e, data) {
							expect(e).to.equal(0);
							expect(data).to.eql({
								'Drive': '4WD',
								'Color': 'Red'
							});
							done();
						});
					});
				}
		;
		
		stateConfig.setItem(initialDatasets[0], null);
		
		var syncItControl = new SyncItControl(
			syncIt,
			eventSourceMonitor,
			stateConfig,
			downloadDatasetFunc,
			uploadChangeFunc,
			conflictResolutionFunction
		);
		
		syncItControl.on('advanced-queueitem', function(queueitem) {
			expect(queueitem.k).to.equal('bmw');
			expect(stateConfig.getItem(initialDatasets[0])).to.equal('cars@2');
			attemptToMessage();
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
		
		syncItControl.connect(initialDatasets);
		
	});
	
	it('adding datasets use case (when synched)', function(done) {
		
		/*
		Tests that we stay connected and online when adding completely unknown
		datasets
		*/
		
		var userId = 'user-aaa',
			localStorage = new FakeLocalStorage(),
			syncIt = getSyncIt(localStorage, userId),
			eventSources = [],
			fakeEventSourceFactory = function(url) {
					eventSources.unshift(new FakeEventSource(url));
					return eventSources[0];
				},
			eventSourceMonitor = new EventSourceMonitor(fakeEventSourceFactory),
			stateConfig = getStateConfig(localStorage, userId);
		
		var conflictResolutionFunction = function() { expect().fail(); },
			uploadChangeFunc = function() { expect().fail(); },
			downloadDatasetFunc = function(dataset, from, next) {
					var downloadedData = { uc: 'Red', k: 'subaru', s: 'cars' };
					if (dataset === 'planes') {
						downloadedData = { uc: 'White', k: 'lear', s: 'planes' };
					}
					downloadedData = {
						"queueitems":[
							{
								"s":downloadedData.s,
								"k":downloadedData.k,
								"b":0,
								"m":"another",
								"u":{"Color": downloadedData.uc},
								"o":"set",
								"t":1393446188224
							}
						],
						"to": downloadedData.s + "@1"
					};
					return next(
						null,
						downloadedData.queueitems,
						downloadedData.to
					);
				},
			initialDatasets = ['cars'];
		
		stateConfig.setItem(initialDatasets[0], null);
		
		eventSourceMonitor.on('added-managed-connection', function() {
			eventSources[0].open();
		});
		
		var syncItControl = new SyncItControl(
			syncIt,
			eventSourceMonitor,
			stateConfig,
			downloadDatasetFunc,
			uploadChangeFunc,
			conflictResolutionFunction
		);
		
		syncItControl.once('synched', function() {
			syncItControl.addMonitoredDataset('planes');
			syncItControl.once('synched', function() {
				syncIt.get('planes', 'lear', function(err, data) {
					expect(err).to.equal(0);
					expect(data).to.eql({Color: 'White'});
					done();
				});
			});
		});
		
		syncItControl.connect(initialDatasets);
	});
	
	it('adding datasets use case (when pushing-discovery)', function(done) {
		
		/*
		Tests that we can add datasets before being synched but that it will 
		also wait for the next state change.
		*/
		
		var userId = 'user-aaa',
			localStorage = new FakeLocalStorage(),
			syncIt = getSyncIt(localStorage, userId),
			eventSources = [],
			fakeEventSourceFactory = function(url) {
					eventSources.unshift(new FakeEventSource(url));
					return eventSources[0];
				},
			eventSourceMonitor = new EventSourceMonitor(fakeEventSourceFactory),
			stateConfig = getStateConfig(localStorage, userId);
		
		var conflictResolutionFunction = function() { expect().fail(); },
			uploadChangeFunc = function() { expect().fail(); },
			downloadDatasetFunc = function(dataset, from, next) {
					var downloadedData = { uc: 'Red', k: 'subaru', s: 'cars' };
					if (dataset === 'planes') {
						downloadedData = { uc: 'White', k: 'lear', s: 'planes' };
					}
					downloadedData = {
						"queueitems":[
							{
								"s":downloadedData.s,
								"k":downloadedData.k,
								"b":0,
								"m":"another",
								"u":{"Color": downloadedData.uc},
								"o":"set",
								"t":1393446188224
							}
						],
						"to": downloadedData.s + "@1"
					};
					return next(
						null,
						downloadedData.queueitems,
						downloadedData.to
					);
				},
			initialDatasets = ['cars'];
		
		stateConfig.setItem(initialDatasets[0], null);
		
		eventSourceMonitor.on('added-managed-connection', function() {
			eventSources[0].open();
		});
		
		var syncItControl = new SyncItControl(
			syncIt,
			eventSourceMonitor,
			stateConfig,
			downloadDatasetFunc,
			uploadChangeFunc,
			conflictResolutionFunction
		);
		
		syncItControl.on('entered-state', function(state) {
			if (state != 'pushing_discovery') { return; }
			syncItControl.addMonitoredDataset('planes');
		});
		
		syncItControl.on('synched', function() {
			syncIt.get('planes', 'lear', function(err, data) {
				expect(err).to.equal(0);
				expect(data).to.eql({Color: 'White'});
				done();
			});
		});
		
		syncItControl.connect(initialDatasets);
	});
	
	it('it can recover from errors', function(done) {
		
		this.timeout(5000);
		
		var userId = 'user-aaa',
			localStorage = new FakeLocalStorage(),
			syncIt = getSyncIt(localStorage, userId),
			eventSources = [],
			fakeEventSourceFactory = function(url) {
					eventSources.unshift(new FakeEventSource(url));
					return eventSources[0];
				},
			eventSourceMonitor = new EventSourceMonitor(fakeEventSourceFactory),
			stateConfig = getStateConfig(localStorage, userId),
			synchedCount = 0,
			errorCount = 0,
			uploadedQueueitem = null
		;
		
		var conflictResolutionFunction = function() { expect().fail(); },
			downloadDatasetFunc = function(dataset, from, next) {
					return next(null, [], null);
				},
			uploadChangeFunc = function(queueitem, next) {
					if (++errorCount > 3) {
						uploadedQueueitem = queueitem;
						next(null, 'cars@1');
					}
					next(new Error("Cannot upload"));
				},
			initialDatasets = ['cars']
		;
		
		var syncItControl = new SyncItControl(
			syncIt,
			eventSourceMonitor,
			stateConfig,
			downloadDatasetFunc,
			uploadChangeFunc,
			conflictResolutionFunction
		);
		
		eventSourceMonitor.on('added-managed-connection', function() {
			eventSources[0].open();
		});
		
		syncItControl.on('synched', function() {
			if (++synchedCount == 2) {
				expect(uploadedQueueitem.s).to.equal('cars');
				expect(uploadedQueueitem.k).to.equal('ford');
				expect(uploadedQueueitem.u.color).to.equal('white');
				return done();
			}
			syncIt.set('cars', 'ford', {color: 'white'}, function(e) {
				expect(e).to.equal(0);
			});
		});
		
		// syncItControl.on('entered-state', function(state) {
		// 	console.log("CURRENT_STATE: ", state);
		// });
		
		syncItControl.connect(initialDatasets);
	});
	
	it('will pass through EventSource messages into SyncIt', function() {
		
	});
	
	it('will go from Synched to Pushing Discovery to Synched', function() {
		
	});
	
	it('will re-establish everything on error', function() {
		
	});
	
});

}));
