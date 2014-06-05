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
	Path_AsyncLocalStorage = require('sync-it/Path/AsyncLocalStorage'),
	Control = require('../Control'),
	syncItCallbackToPromise = require('sync-it/syncItCallbackToPromise'),
	when = require('when'),
	whenCallback = require('when/callbacks');

var getAsyncLocalStorage = function(uniq) {
	return new AsyncLocalStorage(
		new FakeLocalStorage(),
		uniq,
		JSON.stringify,
		JSON.parse
	);
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
describe('will connect and download the data through MISSING_DATASET when', function() {

	var runTest = function(controlsAsyncLocalStorage, expectedStateOrder, done) {

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
			setTimeout(function() {
				fakeEventSourceFactory.eventSources[0].pretendMessage({
					command: 'download',
					data: {
						a: [
							{"s": 'aa', "k": 'aa2', "b":0, "m":"another", "u":{"Color": 'Red'}, "o":"set", "t":1393446188224 },
							{"s": 'aa', "k": 'aa2', "b":1, "m":"another", "u":{"Size": 'Big'}, "o":"set", "t":1393446188224 }
						]
					}
				});
			},10);
		});

		control.on('entered-state', function(state) {
			stateOrder.push(state);
			if (state == 'SYNCHED') {
				expect(stateOrder).to.eql(expectedStateOrder);
				syncItCallbackToPromise(
					syncIt,
					syncIt.getFull,
					[SyncItConstant.Error.OK],
					'aa',
					'aa2'
				).done(
					function(queueitem) {
						expect(queueitem.v).to.equal(2);
						done();
					},
					function() {
						expect().fail();
					}
				);
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

	it('it has data to download and knows some of the datasets but with nothing to upload', function(done) {

		var controlStorage = getAsyncLocalStorage('c1', 'aa');

		controlStorage.setItem('aa', 'aa1', function() {
			runTest(
				controlStorage,
				['ANALYZE', 'MISSING_DATASET', 'PUSHING_DISCOVERY', 'add_dataset_callback', 'SYNCHED'],
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
					done
				);
			},
			function() { expect().fail(); }
		);
	});
});

};

if (typeof $ !== 'undefined') {
	module.exports = toExport;
	return;
}
toExport();
