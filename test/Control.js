var toExport = function() {

"use strict";

var
	expect = require('expect.js'),
	getTLIdEncoderDecoder = require('get_tlid_encoder_decoder'),
	EventSourceMonitor = require('eventsource-monitor'),
	SyncIt = require('sync-it/SyncIt'),
	SyncItConstant = require('sync-it/Constant'),
	SyncItBuffer = require('sync-it/SyncItBuffer'),
	FakeLocalStorage = require('sync-it/FakeLocalStorage'),
	AsyncLocalStorage = require('sync-it/AsyncLocalStorage'),
	addEvents = require('add-events'),
	Path_AsyncLocalStorage = require('sync-it/Path/AsyncLocalStorage'),
	Control = require('../Control'),
	syncItCallbackToPromise = require('sync-it/syncItCallbackToPromise'),
	when = require('when'),
	arrayMap = require('mout/array/map'),
	whenCallback = require('when/callbacks');

var getAsyncLocalStorage = function(uniq) {
	var asyncLocalStorage =  new AsyncLocalStorage(
		new FakeLocalStorage(),
		uniq,
		JSON.stringify,
		JSON.parse
	);
	var EventingAsyncLocalStorage = function(asyncLocalStorage) {
		this._asyncLocalStorage = asyncLocalStorage;
	};
	EventingAsyncLocalStorage.prototype.findKeys = function() {
		var args = Array.prototype.slice.call(arguments);
		return this._asyncLocalStorage.findKeys.apply(this._asyncLocalStorage, args);
	};
	EventingAsyncLocalStorage.prototype.setItem = function(k, v, next) {
		var me = this;
		this._asyncLocalStorage.setItem(k, v, function(e) {
			next(e);
			me._emit('setItem', k, v);
		});
	};
	EventingAsyncLocalStorage.prototype.key = function() {
		var args = Array.prototype.slice.call(arguments);
		return this._asyncLocalStorage.key.apply(this._asyncLocalStorage, args);
	};
	EventingAsyncLocalStorage.prototype.clear = function() {
		var args = Array.prototype.slice.call(arguments);
		return this._asyncLocalStorage.clear.apply(this._asyncLocalStorage, args);
	};
	EventingAsyncLocalStorage.prototype.getItem = function() {
		var args = Array.prototype.slice.call(arguments);
		return this._asyncLocalStorage.getItem.apply(this._asyncLocalStorage, args);
	};
	EventingAsyncLocalStorage.prototype.removeItem = function() {
		var args = Array.prototype.slice.call(arguments);
		return this._asyncLocalStorage.removeItem.apply(this._asyncLocalStorage, args);
	};
	addEvents(EventingAsyncLocalStorage, ['setItem']);
	return new EventingAsyncLocalStorage(asyncLocalStorage);
};

var tLEncoderDecoder = getTLIdEncoderDecoder(new Date().getTime(), 2);

var getSyncIt = function(asyncLocalStorage, userId) {
	var pathstore = new Path_AsyncLocalStorage(
			asyncLocalStorage,
			tLEncoderDecoder
		);

	return new SyncItBuffer(new SyncIt(pathstore, userId));
};

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

var getFakeEventSourceFactory = function() {
	var eventSources = [];
	var f = function(url) {
		eventSources.unshift(new FakeEventSource(url));
		return eventSources[0];
	};
	f.eventSources = eventSources;
	return f;
};

describe('utility function', function() {
	it('called _prepareUrl which will do so', function() {
		expect(Control._prepareUrl(['a', 'b'], {b: 'v4'})).to.equal('dataset%5Ba%5D=&dataset%5Bb%5D=v4');
	});

	it('called _getKnownVersionChanges will ensure that only highest versions are stored', function() {
		var result = Control._getKnownVersionChanges(
				{
					a: 'fff',
					b: 'jjj',
					c: 'mmm'
				},
				{
					a: [ { _q: 'aaa' }, { _q: 'ggg' } ],
					b: [ { _q: 'aaa' } ],
					d: [ { _q: 'ttt' } ]
				}
			),
			expected = { a: 'ggg', d: 'ttt' };

		expect(result).to.eql(expected);
	});
	it('can convert array to messageDownloadFormat', function() {
		expect(Control._convertToMessageDownloadFormat([
			{s: 'aaa', k: 'z1'},
			{s: 'bbb', k: 'z2'},
			{s: 'aaa', k: 'z3'},
			{s: 'aaa', k: 'z4'},
			{s: 'ccc', k: 'z5'}
		])).to.eql(
			{
				aaa: [{s: 'aaa', k: 'z1'}, {s: 'aaa', k: 'z3'}, {s: 'aaa', k: 'z4'}],
				bbb: [{s: 'bbb', k: 'z2'}],
				ccc: [{s: 'ccc', k: 'z5'}]
			}
		);
	});
});

describe('will connect and download ending as synched', function() {

	var runTest = function(controlsAsyncLocalStorage, expectedStateOrder, bVersion, done) {

		var fakeEventSourceFactory = getFakeEventSourceFactory(),
			syncIt = getSyncIt(getAsyncLocalStorage('s1', 'aa')),
			eventSourceMonitor = new EventSourceMonitor(fakeEventSourceFactory),
			control = new Control(
					syncIt,
					eventSourceMonitor,
					controlsAsyncLocalStorage,
					null,
					null
				),
			stateOrder = [];

		control.addDatasets(['aa', 'bb'], function() {
			stateOrder.push('add_dataset_callback');
		});

		eventSourceMonitor.on('added-managed-connection', function() {
			fakeEventSourceFactory.eventSources[0].open();
		});

		eventSourceMonitor.on('url-changed', function() {
			fakeEventSourceFactory.eventSources[0].pretendMessage({
				command: 'queueitem',
				data: {"s": 'aa', "k": 'aa2', "b":1, "m":"another", "u":{"Size": 'Big'}, "o":"set", "t":1393446188224, _q: 'v1' }
			});
			fakeEventSourceFactory.eventSources[0].pretendMessage({
				command: 'download',
				data: {
					aa: [
						{"s": 'aa', "k": 'aa2', "b":0, "m":"another", "u":{"Color": 'Red'}, "o":"set", "t":1393446188224, _q: 'v2' },
					]
				}
			});
		});

		syncIt.listenForFed(function(dataset, datakey, queueitem) {
			if (queueitem.b == 1) {
				expect(stateOrder).to.eql(expectedStateOrder);
				when.all([
					syncItCallbackToPromise(
						syncIt,
						syncIt.getFull,
						[SyncItConstant.Error.OK],
						'aa',
						'aa2'
					),
					Control._getKnownDatasetVersionsPromise(
						controlsAsyncLocalStorage,
						[ 'aa', 'bb' ]
					)
				]).done(
					function(result) {
						var queueitem = result[0];
						var knownDataVersions = result[1];
						expect(knownDataVersions).to.eql({aa: 'v2', bb: bVersion});
						expect(queueitem.v).to.equal(2);
						done();
					},
					function() {
						expect().fail();
					}
				);
			}
		});
		control.on('entered-state', function(state) {
			stateOrder.push(state);
		});
		control.connect();
	};

	it('it has data to download but no data to upload at all', function(done) {
		runTest(
			getAsyncLocalStorage('c1', 'aa'),
			['ANALYZE', 'MISSING_DATASET', 'PUSHING_DISCOVERY', 'add_dataset_callback', 'SYNCHED'],
			null,
			done
		);
	});

	it('it has data to download and knows some of the datasets but with nothing to upload', function(done) {

		var controlStorage = getAsyncLocalStorage('c1', 'aa');

		controlStorage.setItem('aa', 'aa1', function() {
			runTest(
				controlStorage,
				['ANALYZE', 'MISSING_DATASET', 'PUSHING_DISCOVERY', 'add_dataset_callback', 'SYNCHED'],
				null,
				done
			);
		});
	});

	it('it has data to download and knows of the datasets but with nothing to upload', function(done) {

		var controlStorage = getAsyncLocalStorage('c1', 'aa');

		when.map([
			whenCallback.call(controlStorage.setItem.bind(controlStorage), 'aa', 'aa1'),
			whenCallback.call(controlStorage.setItem.bind(controlStorage), 'bb', 'bb1'),
		]).done(
			function() {
				runTest(
					controlStorage,
					['ANALYZE', 'ALL_DATASET', 'add_dataset_callback', 'PUSHING_DISCOVERY', 'SYNCHED'],
					'bb1',
					done
				);
			},
			function() { expect().fail(); }
		);
	});
});

describe('will connect, download then upload ending as synched', function() {

	var runTest = function(controlsAsyncLocalStorage, expectedStateOrder, done) {

		var fakeEventSourceFactory = getFakeEventSourceFactory(),
			syncIt = getSyncIt(getAsyncLocalStorage('s1', 'aa')),
			eventSourceMonitor = new EventSourceMonitor(fakeEventSourceFactory),
			uploadedQueueitems = [],
			uploadFunction = function(queueitem, next) {
					uploadedQueueitems.push(queueitem);
					next(null, { http_status: 200 });
				},
			uploadedChangesSort = function(qiA, qiB) {

					var sub = function(field) {
						if (qiA[field] == qiB[field]) { return 0; }
						return ( qiA[field] < qiB[field] ) ? -1 : 1;
					};

					var fields = ['o', 's', 'k'],
						r,
						i;

					for (i=0; i<fields.length; i++) {
						r = sub(fields[i]);
						if (r !== 0) { return r; }
					}

					return 0;

				},
			control = new Control(
					syncIt,
					eventSourceMonitor,
					controlsAsyncLocalStorage,
					uploadFunction,
					null
				),
			stateOrder = [],
			extractOpDatakeyAndDataset = function(queueitem) {
					return { o: queueitem.o, s: queueitem.s, k: queueitem.k };
				};

		control.addDatasets(['aa', 'bb'], function() {
			stateOrder.push('add_dataset_callback');
		});

		eventSourceMonitor.on('added-managed-connection', function() {
			syncIt.set('aa', 'aa1', { size: 'Big', color: 'Red' }, function(err) {
				expect(err).to.equal(SyncItConstant.Error.OK);
				fakeEventSourceFactory.eventSources[0].open();
			});
		});

		eventSourceMonitor.on('url-changed', function() {
			fakeEventSourceFactory.eventSources[0].pretendMessage({
				command: 'download',
				data: {}
			});
		});

		control.on('entered-state', function(state) {
			stateOrder.push(state);
			if (state == 'SYNCHED') {
				expect(
					arrayMap(
						uploadedQueueitems.sort(uploadedChangesSort),
						extractOpDatakeyAndDataset
					)
				).to.eql([
					{ o: 'set', s: 'aa', k: 'aa1' },
					{ o: 'set', s: 'aa', k: 'aa2' },
					{ o: 'update', s: 'aa', k: 'aa1' }
				]);
				expect(stateOrder).to.eql(expectedStateOrder);
				done();
			}
		});

		syncIt.set('aa', 'aa2', { size: 'Big', color: 'Red' }, function(err) {
			expect(err).to.equal(SyncItConstant.Error.OK);
			syncIt.update('aa', 'aa1', { size: 'Big', color: 'Red' }, function(err) {
				expect(err).to.equal(SyncItConstant.Error.OK);
				control.connect();
			});
		});
	};

	it('it has data to download and will then upload it\'s own', function(done) {
		runTest(
			getAsyncLocalStorage('c1', 'aa'),
			['ANALYZE', 'MISSING_DATASET', 'PUSHING_DISCOVERY', 'add_dataset_callback', 'PUSHING',  'PUSHING_DISCOVERY', 'PUSHING',  'PUSHING_DISCOVERY', 'PUSHING',  'PUSHING_DISCOVERY', 'SYNCHED'],
			done
		);
	});

});

describe('will connect and download data, add data in SyncIt then handle conflict', function() {

	var runTest = function(controlsAsyncLocalStorage, expectedStateOrder, done) {

		var fakeEventSourceFactory = getFakeEventSourceFactory(),
			syncIt = getSyncIt(getAsyncLocalStorage('s1', 'aa')),
			eventSourceMonitor = new EventSourceMonitor(fakeEventSourceFactory),
			conflictResolutionFunction = function(dataset, datakey, storerecord, serverQueueitems, localPathitems, resolved) {
					resolved(true, [{o: 'update', u: { state: 'Fixed' } }]);
				},
			control = new Control(
					syncIt,
					eventSourceMonitor,
					controlsAsyncLocalStorage,
					function() {}, // No uploads will occur
					conflictResolutionFunction
				),
			stateOrder = [];

		control.addDatasets(['aa', 'bb'], function() {
			stateOrder.push('add_dataset_callback');
		});

		eventSourceMonitor.on('added-managed-connection', function() {
			fakeEventSourceFactory.eventSources[0].open();
		});

		eventSourceMonitor.on('url-changed', function() {
			fakeEventSourceFactory.eventSources[0].pretendMessage({
				command: 'download',
				data: {
					aa: [
						{"s": 'aa', "k": 'aa2', "b":0, "m":"another", "u":{"Color": 'Red'}, "o":"set", "t":1393446188224, _q: 'z1'},
					]
				}
			});
		});

		var doFeedTest = function() {
			fakeEventSourceFactory.eventSources[0].pretendMessage({
				command: 'queueitem',
				data: {"s": 'aa', "k": 'aa2', "b":1, "m":"another", "u":{"Size": 'Big'}, "o":"set", "t":139344618822, _q: 'z2'}
			});
		};

		var listenForResolved = function() {
			syncIt.listenForAddedToPath(function(dataset, datakey, queueitem) {
				expect(queueitem.b).to.equal(2);
			});
			controlsAsyncLocalStorage.once('setItem', function() {
				controlsAsyncLocalStorage.getItem('aa', function(v) {
					expect(v).to.equal('z2');
					done();
				});
			});
		};

		syncIt.listenForFed(function(dataset, datakey, queueitem) {
			expect(dataset).to.equal('aa');
			expect(datakey).to.equal('aa2');
			if (queueitem.b === 1) {
				listenForResolved();
			}
		});

		control.on('entered-state', function(state) {
			stateOrder.push(state);
			if (state === 'SYNCHED') {
				syncIt.set('aa', 'aa2', { size: 'Big', color: 'Red' }, function(err) {
					expect(err).to.equal(SyncItConstant.Error.OK);
					syncIt.getFull('aa', 'aa2', function(status, queueitem) {
						expect(queueitem.v).to.equal(2);
						doFeedTest();
					});
				});
			}
		});
		control.connect();
	};

	it('it has data to download by no data at all', function(done) {
		runTest(
			getAsyncLocalStorage('c1', 'aa'),
			['ANALYZE', 'MISSING_DATASET', 'PUSHING_DISCOVERY', 'add_dataset_callback', 'SYNCHED'],
			done
		);
	});

});

describe('will upload things which are added to syncIt when Synched', function() {

	var runTest = function(controlsAsyncLocalStorage, expectedStateOrder, bVersion, done) {

		var fakeEventSourceFactory = getFakeEventSourceFactory(),
			syncIt = getSyncIt(getAsyncLocalStorage('s1', 'aa')),
			eventSourceMonitor = new EventSourceMonitor(fakeEventSourceFactory),
			uploadedQueueitem = [],
			firstSynched = true,
			uploadFunction = function(queueitem, next) {
					uploadedQueueitem.push(queueitem);
					next(null, { http_status: 200 });
				},
			control = new Control(
					syncIt,
					eventSourceMonitor,
					controlsAsyncLocalStorage,
					uploadFunction,
					null
				),
			stateOrder = [];

		control.addDatasets(['aa', 'bb'], function() {
			stateOrder.push('add_dataset_callback');
		});

		syncIt.listenForAdvanced(function(dataset, datakey) {
			expect(dataset).to.equal('aa');
			expect(datakey).to.equal('aa1');
		});

		eventSourceMonitor.on('added-managed-connection', function() {
			fakeEventSourceFactory.eventSources[0].open();
		});

		eventSourceMonitor.on('url-changed', function() {
			fakeEventSourceFactory.eventSources[0].pretendMessage({
				command: 'download',
				data: { aa: [] }
			});
		});

		control.on('entered-state', function(state) {
			stateOrder.push(state);
			if ((state === 'SYNCHED') && (firstSynched)) {
				firstSynched = false;
				syncIt.set('aa', 'aa1', { size: 'Big' }, function(status) {
					expect(status).to.equal(SyncItConstant.Error.OK);
				});
				return;
			}
			if (state === 'SYNCHED') {
				expect(uploadedQueueitem.length).to.equal(1);
				expect(stateOrder).to.eql(expectedStateOrder);
				done();
			}
		});
		control.connect();
	};

	it('standard path', function(done) {
		runTest(
			getAsyncLocalStorage('c1', 'aa'),
			[
				'ANALYZE', 'MISSING_DATASET', 'PUSHING_DISCOVERY', 'add_dataset_callback',
				'SYNCHED', 'PUSHING_DISCOVERY', 'PUSHING', 'PUSHING_DISCOVERY',
				'SYNCHED'],
			null,
			done
		);
	});

});

};

if (typeof $ !== 'undefined') {
	module.exports = toExport;
	return;
}
toExport();
