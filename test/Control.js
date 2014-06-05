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
	syncItCallbackToPromise = require('sync-it/syncItCallbackToPromise');

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
	it('it has data to download by no data to upload', function(done) {

		var fakeEventSourceFactory = getFakeEventSourceFactory(),
			syncIt = getSyncIt(getAsyncLocalStorage('s1', 'aa')),
			eventSourceMonitor = new EventSourceMonitor(fakeEventSourceFactory),
			control = new Control(
					syncIt,
					eventSourceMonitor,
					getAsyncLocalStorage('s1', 'aa'),
					null,
					null
				),
			expectedStateOrder = ['ANALYZE', 'MISSING_DATASET', 'PUSHING_DISCOVERY', 'add_dataset_callback', 'SYNCHED'],
			stateOrder = [];

		control.addDatasets(['aa', 'bb'], function() {
			stateOrder.push('add_dataset_callback');
			expect(control.getCurrentState()).to.equal('PUSHING_DISCOVERY');
		});

		eventSourceMonitor.on('added-managed-connection', function() {
			fakeEventSourceFactory.eventSources[0].open();
		});

		eventSourceMonitor.on('url-changed', function() {
			fakeEventSourceFactory.eventSources[0].pretendMessage({
				command: 'download',
				data: {
					a: [
						{"s": 'aa', "k": 'aa1', "b":0, "m":"another", "u":{"Color": 'Red'}, "o":"set", "t":1393446188224 },
						{"s": 'aa', "k": 'aa1', "b":1, "m":"another", "u":{"Size": 'Big'}, "o":"set", "t":1393446188224 }
					]
				}
			});
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
					'aa1'
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
	});
});

};

if (typeof $ !== 'undefined') {
	module.exports = toExport;
	return;
}
toExport();
