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
			require('sync-it/SyncIt'),
			require('sync-it/SyncItBuffer'),
			require('sync-it/FakeLocalStorage'),
			require('sync-it/SyncLocalStorage'),
			require('sync-it/AsyncLocalStorage'),
			require('sync-it/Path/AsyncLocalStorage'),
			require('../StoreSequenceId.js'),
			require('../index.js')
		);
	} else if (typeof define === 'function' && define.amd) {
		return define(
			[
				'getTLIdEncoderDecoder',
				'eventsource-monitor',
				'sync-it/SyncIt',
				'sync-it/SyncItBuffer',
				'sync-it/FakeLocalStorage',
				'sync-it/SyncLocalStorage',
				'sync-it/AsyncLocalStorage',
				'sync-it/Path/AsyncLocalStorage',
				'../StoreSequenceId.js',
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
	Path_AsyncLocalStorage, StoreSequenceId, SyncItControl) {

	"use strict";

	var FakeEventSource = function(url) {
		this._url = url;
		this.readyState = 0;
	};

	FakeEventSource.prototype.open = function() {
		this.readyState = 1;
		this.onopen({currentTarget: this});
	};

	FakeEventSource.prototype.close = function() {
		this.readyState = 2;
	};

	FakeEventSource.prototype.pretendDisconnected = function() {
		this.readyState = 2;
		this.onerror({currentTarget: this});
	};

	FakeEventSource.prototype.pretendMessage = function(msg) {
		this.readyState = 1;
		this.onmessage({
			currentTarget: this,
			data: JSON.stringify(msg)
		});
	};

var mainTimestamp = 1392885440069;
var getStoreSequenceId = function(localStorage, userId) {
	// data format = { dataset-[dataset]: [version] }
	var tLEncoderDecoder = getTLIdEncoderDecoder(mainTimestamp, 2),
		stateConfig = new SyncLocalStorage(
			localStorage,
			'sic-state-' + userId,
			JSON.stringify,
			JSON.parse
		);

	return new StoreSequenceId(
		stateConfig,
		tLEncoderDecoder.sort
	);
};

var getSyncIt = function(localStorage, userId) {
	var tLEncoderDecoder = getTLIdEncoderDecoder(mainTimestamp, 2),
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
			stateConfig = getStoreSequenceId(localStorage, userId)
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
						"seqId":"cars@1"
					};
					return next(
						null,
						downloadedData.queueitems,
						downloadedData.seqId
					);
				},
			uploadChangeFunc = function(queueitem, next) {
					next(null, "cars@2");
				},
			initialDataset = 'cars',
			attemptToMessageSelf = function(next) {
					// Our own message re-echo'd, should be ignored...
					eventSources[0].pretendMessage({
						command: 'queueitem',
						seqId: 'cars@2',
						queueitem: {
							"s":"cars",
							"k":"subaru",
							"b":0,
							"m":"user-aaa",
							"u":{ "$set": {"Drive":"4WD", "Color":"Red"} },
							"o":"update",
							"t":1393446188229
						}
					});
					next();
				},
			attemptToMessage2 = function() {
					eventSources[0].pretendMessage({
						command: 'queueitem',
						seqId: 'cars@3',
						queueitem: {
							"s":"cars",
							"k":"subaru",
							"b":1,
							"m":"another",
							"u":{ "$set": {"Drive":"4WD"} },
							"o":"update",
							"t":1393446188230
						}
					});
					syncIt.listenForFed(function() {
						syncIt.get('cars', 'subaru', function(e, data) {
							expect(e).to.equal(0);
							expect(data).to.eql({
								'Drive': '4WD',
								'Color': 'Red'
							});
							expect(
								stateConfig.getItem('cars')
							).to.equal('cars@1');
							done();
						});
					});
				}
		;

		stateConfig.setItem(true, initialDataset, null);

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
			attemptToMessageSelf(attemptToMessage2);
		});

		eventSourceMonitor.on('added-managed-connection', function() {
			eventOrder.push('added-managed-connection');
			eventSources[0].open();
		});

		syncItControl.on('available', function(evt) {
			eventOrder.push('available');
			expect(evt.datasets).to.eql([initialDataset]);
		});

		syncItControl.on('uploaded-queueitem', function(queueitem, to) {
			expect(queueitem.k).to.equal('bmw');
			expect(to).to.equal('cars@2');
		});

		syncItControl.on('entered-state', function(state) {
			if (state !== 'synched') { return; }
			eventOrder.push('synched');
			expect(eventOrder[eventOrder.length-1]).to.equal('synched');
			expect(eventOrder.slice(0,6)).to.eql([
				'available',
				'event-source-created',
				'added-managed-connection',
				'addMonitoredDataset',
				'downloads-started',
				'synched'
			]);
			if (eventOrder.length < 7) {
				syncIt.get('cars', 'subaru', function(e, data) {
					expect(e).to.equal(0);
					expect(data).to.eql({"Color":"Red"});
					syncIt.set('cars', 'bmw', {Color: 'blue'}, function(e) {
						expect(e).to.equal(0);
					});
				});
			}
		});

		syncItControl.addMonitoredDataset(initialDataset, function() {
			eventOrder.push('addMonitoredDataset');
		});

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
			stateConfig = getStoreSequenceId(localStorage, userId);

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
						"seqId": downloadedData.s + "@1"
					};
					return next(
						null,
						downloadedData.queueitems,
						downloadedData.seqId
					);
				},
			initialDataset = 'cars';

		stateConfig.setItem(true, initialDataset, null);

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
			if (state !== 'synched') { return; }
			syncItControl.addMonitoredDataset('planes');
			syncItControl.on('entered-state', function(state) {
				if (state !== 'synched') { return; }
				syncIt.get('planes', 'lear', function(err, data) {
					expect(err).to.equal(0);
					expect(data).to.eql({Color: 'White'});
					done();
				});
			});
		});

		syncItControl.addMonitoredDataset(initialDataset);
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
			stateConfig = getStoreSequenceId(localStorage, userId),
			addMonitoredDatasetsCalled = [],
			addedPlanes = false;

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
						"seqId": downloadedData.s + "@1"
					};
					return next(
						null,
						downloadedData.queueitems,
						downloadedData.seqId
					);
				},
			initialDataset = 'cars';

		stateConfig.setItem(true, initialDataset, null);

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
			syncItControl.addMonitoredDataset('planes', function(e, newDs, nowConnected) {
				expect(e).to.equal(null);
				expect(newDs).to.eql(!addedPlanes);
				addedPlanes = true;
				addMonitoredDatasetsCalled.push('planes');
				expect(nowConnected).to.eql(['cars', 'planes']);
			});
		});

		syncItControl.on('entered-state', function(state) {
			if (state !== 'synched') { return; }
			syncIt.get('planes', 'lear', function(err, data) {
				expect(err).to.equal(0);
				expect(data).to.eql({Color: 'White'});
				expect(addMonitoredDatasetsCalled).to.eql(['cars', 'planes', 'planes']);
				done();
			});
		});

		syncItControl.addMonitoredDataset(initialDataset, function(e, newDs, nowConnected) {
			expect(e).to.equal(null);
			expect(newDs).to.eql(true);
			addMonitoredDatasetsCalled.push(initialDataset);
			expect(nowConnected).to.eql(['cars']);
		});
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
			stateConfig = getStoreSequenceId(localStorage, userId),
			synchedCount = 0,
			errorCount = 0,
			uploadAttempts = 0,
			uploadedQueueitem = null
		;

		var conflictResolutionFunction = function() { expect().fail(); },
			downloadDatasetFunc = function(dataset, from, next) {
					return next(null, [], null);
				},
			uploadChangeFunc = function(queueitem, next) {
					if (++errorCount > 3) {
						expect(uploadAttempts).to.equal(3);
						uploadedQueueitem = queueitem;
						next(null, 'cars@1');
						return;
					}
					next(new Error("Cannot upload"));
				},
			initialDataset = 'cars'
		;

		var syncItControl = new SyncItControl(
			syncIt,
			eventSourceMonitor,
			stateConfig,
			downloadDatasetFunc,
			uploadChangeFunc,
			conflictResolutionFunction
		);

		syncItControl.on('error-uploading-queueitem', function(_, queueitem) {
			uploadAttempts++;
			expect(queueitem.s).to.equal('cars');
		});

		eventSourceMonitor.on('added-managed-connection', function() {
			eventSources[0].open();
		});

		syncItControl.on('entered-state', function(state) {
			if (state !== 'synched') { return; }
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

		syncItControl.addMonitoredDataset(initialDataset);
	});


	it('will not store the state of events until synched', function(done) {

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
			stateConfig = getStoreSequenceId(localStorage, userId),
			uploadChangeFunc = function(queueitem, next) {
					next(null, null);
				},
			downloadDatasetFunc = function(dataset, from, next) {
					/* global setTimeout: false */
					setTimeout(function() {
						return next(null, [], null);
					}, 1000);
				},
			fedCount = 0
		;

		var localStorageSetItem = localStorage.setItem;
		localStorage.setItem = function(k, v) {
			localStorageSetItem.call(localStorage,k, v);
			if (
				(syncItControl.getState() === 'SYNCHED') &&
				(v !== null)
			) {
				expect(v.indexOf('cars@1')).to.be.greaterThan(-1);
				done();
			}
		}

		var conflictResolutionFunction = function() { expect().fail(); };

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

		syncIt.listenForFed(function() {
			syncIt.get('cars', 'subaru', function(e, data) {
				expect(e).to.equal(0);
				expect(data).to.eql({
					'Drive': '4WD'
				});
				fedCount = fedCount + 1;
				expect(stateConfig.getItem('cars')).to.equal(null);
			});
		});

		syncItControl.on('entered-state', function(state) {
			if (['missing_dataset__downloading'].indexOf(state) > -1) {
				eventSources[0].pretendMessage({
					command: 'queueitem',
					seqId: 'cars@' + (state === 'synched' ? 2 : 1),
					queueitem: {
						"s":"cars",
						"k":"subaru",
						"b": (state === 'synched' ? 1 : 0),
						"m":"another",
						"u":{ "$set": {"Drive":"4WD"} },
						"o":"update",
						"t":1393446188230
					}
				});
			}
		});

		syncItControl.addMonitoredDataset('cars');

	});

	it('it can reconnect and handle non uploads', function(done) {

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
			stateConfig = getStoreSequenceId(localStorage, userId),
			synchedCount = 0
		;

		var conflictResolutionFunction = function() { expect().fail(); },
			downloadDatasetFunc = function(dataset, from, next) {
				return next(null, [], null);
			},
			uploadChangeFunc = function(queueitem, next) {
				expect(stateConfig.getItem('cars')).to.equal(null);
				syncIt.getFirst(function(err, data) {
					expect(err).to.equal(0);
					expect(data.k).to.equal('volvo');
					done();
				});
			},
			initialDataset = 'cars'
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

		syncItControl.on('entered-state', function(state) {
			if (synchedCount > 0) { return; }
			if (state !== 'synched') { return; }
			synchedCount = synchedCount + 1;
			eventSources[0].pretendDisconnected();
			syncItControl.on('entered-state', function(state) {
				if (synchedCount > 1) { return; }
				if (state !== 'synched') { return; }
				synchedCount = synchedCount + 1;
				syncIt.set('cars', 'volvo', { size: 'big' }, function(err) {
					expect(err).to.equal(0);
				});
			});
			syncItControl.connect();
		});

		syncItControl.addMonitoredDataset(initialDataset);
	});

});

}));
