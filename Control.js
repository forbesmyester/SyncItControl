module.exports = (function (rekey, addEvents, TransitionState, syncItCallbackToPromise, when, whenNode, whenCallback, whenFunction, arrayFilter, arrayMap, objectMap, objectKeys, SyncIt_Constant) {

"use strict";

var AVAILABLE_AT_ALREADY = 3,
    AVAILABLE_AT_END = 2,
    AVAILABLE_AT_START = 1;

var Control = function(syncIt, eventSourceMonitor, asyncLocalStorage,uploadChangeFunc, conflictResolutionFunction) {
	this._syncIt = syncIt;
	this._eventSourceMonitor = eventSourceMonitor;
	this._uploadChangeFunc = uploadChangeFunc;
	this._datasets = [];
	this._monitoredCallbacks = [];
	this._conflictResolutionFunction = conflictResolutionFunction;
	this._asyncLocalStorage = asyncLocalStorage;
	this._connectingDatasets = [];
	this._connected = false;
	this._transitionState = (function() {
			var t = new TransitionState('DISCONNECTED'),
				states = {
					'DISCONNECTED': ['ANALYZE'],
					'ANALYZE': ['MISSING_DATASET', 'ALL_DATASET'],
					'MISSING_DATASET': ['PUSHING_DISCOVERY', 'DISCONNECTED', 'ERROR'],
					'ALL_DATASET': ['PUSHING_DISCOVERY', 'DISCONNECTED', 'ERROR'],
					'ADDING_DATASET': ['PUSHING_DISCOVERY', 'DISCONNECTED', 'ERROR'],
					'PUSHING_DISCOVERY': ['SYNCHED', 'PUSHING', 'DISCONNECTED', 'ERROR'],
					'PUSHING': ['PUSHING_DISCOVERY', 'SYNCHED', 'DISCONNECTED', 'ERROR'],
					'SYNCHED': ['ADDING_DATASET', 'PUSHING_DISCOVERY', 'DISCONNECTED', 'ERROR'],
					'ERROR': ['DISCONNECTED', 'ERROR']
				};
			for (var k in states) {
				if (states.hasOwnProperty(k)) {
					t.addState(k,states[k]);
				}
			}
			return t;
		})();

	var me = this;

	var stateFunctions = {
		'ANALYZE': this._stateAnalyze,
		'MISSING_DATASET': this._stateAddDataset.bind(this, AVAILABLE_AT_END),
		'ALL_DATASET': this._stateAddDataset.bind(this, AVAILABLE_AT_START),
		'ADDING_DATASET': this._stateAddDataset.bind(this, AVAILABLE_AT_ALREADY),
		'PUSHING_DISCOVERY': this._statePushingDiscovery,
		'PUSHING': this._statePushing,
		'SYNCHED': this._stateSynched,
		'ERROR': this._stateError
	};

	var serverMultiDataToArray = function(data) {
		var r = [];
		objectMap(data, function(v) {
			r = r.concat(v);
		});
		return r;
	};

	var syncItFeedToPromise = function(data) {
		return syncItCallbackToPromise(
			this._syncIt,
			this._syncIt.feed,
			[SyncIt_Constant.Error.OK, SyncIt_Constant.Error.NO_DATA_FOUND],
			data,
			this._conflictResolutionFunction
		);
	}.bind(this);

	this._eventSourceMonitor.on('messaged', function(message) {

		if (!message.hasOwnProperty('command')) {
			return;
		}

		var me = this;

		if (message.command == 'download') {

			syncItFeedToPromise(serverMultiDataToArray(message.data)).done(
				function() {
					me._transitionState.change('PUSHING_DISCOVERY');
					me._perhapsFireMonitoredCallbacks(true, me._currentUrl);
				},
				this._gotoError.bind(this)
			);

		}
	}.bind(this));

	var connectedHandler = function(connObj) {
		this._currentUrl = connObj.url;
		this._perhapsFireMonitoredCallbacks(false, connObj.url);
	}.bind(this);

	this._eventSourceMonitor.on('url-changed', connectedHandler);
	this._eventSourceMonitor.on('connected', connectedHandler);

	this._transitionState.start();
	this._transitionState.on('changed-state', function(oldState, newState) {
		this._emit('entered-state', newState);
		stateFunctions[newState].call(this, newState);
	}.bind(this));
};

Control.prototype._perhapsFireMonitoredCallbacks = function(downloaded, currentUrl) {

	var doIt = function(knownDatasets) {
		this._monitoredCallbacks = this._prepareForConnectedCallbacks(
			this._monitoredCallbacks,
			currentUrl,
			knownDatasets
		);
		this._fireWaitingMonitoredCallbacks();
	}.bind(this);

	if (downloaded) {
		return doIt(true);
	}

	this._asyncLocalStorage.findKeys('*', function(datasets) {
		doIt(datasets);
	});

};

Control.prototype._fireWaitingMonitoredCallbacks = function() {

	var me = this;

	this._monitoredCallbacks = arrayMap(this._monitoredCallbacks, function(callbackData) {
		if (callbackData === null) { return null; }
		if (callbackData.datasets.length === 0) {
			callbackData.callback.call(me);
			return null;
		}
		return callbackData;
	});
};

Control.prototype._extractInfoFromUrl = function(url) {
	var keys = [],
		values = [];
	var data = decodeURIComponent(url).split('&');
	arrayMap(data, function(urlComponent) {
		var vs = urlComponent.split('=');
		keys.push(vs[0].replace(/^[^\[]+\[/,'').replace(/\]$/,''));
		values.push( vs[1].length ? vs[1] : null);
	});
	return rekey(keys, values);
};

Control.prototype._prepareForConnectedCallbacks = function(monitoredCallbacks, currentUrl, versionData) {

	var currentDatasets = objectKeys(this._extractInfoFromUrl(currentUrl)),
		removeDataset = function(datasets, toRemoveDataset) {
			return arrayFilter(datasets, function(dataset) {
				return (dataset !== toRemoveDataset);
			});
		};

	monitoredCallbacks = arrayMap(monitoredCallbacks, function(callbackData) {
		arrayMap(currentDatasets, function(dataset) {
			if (callbackData === null) { return null; }
			if ((versionData === true) || (versionData.indexOf(dataset) > -1)) {
				callbackData.datasets = removeDataset(callbackData.datasets, dataset);
			}
		});
		return callbackData;
	});

	return monitoredCallbacks;
};

Control.prototype.getCurrentState = function() {
	return this._transitionState.current();
};

Control.prototype._gotoError = function() {
	this._transitionState.change('ERROR');
};

Control.prototype._getKnownDatasetVersionsPromise = function() {

	var me = this;

	var getVersionPromise = function(dataset) {
		return whenCallback.call(me._asyncLocalStorage.getItem.bind(me._asyncLocalStorage), dataset);
	};

	return when.all(this._datasets.map(getVersionPromise)).then(
		function(versions) {
			return rekey(me._datasets, versions);
		}
	);
};

Control.prototype._stateAnalyze = function() {
	var me = this;
	this._getKnownDatasetVersionsPromise().done(
		function(datasetAndVersions) {
			var haveNulls = false;
			objectMap(datasetAndVersions, function(v) {
				if (v === null) { haveNulls = true; }
			});
			me._transitionState.change(haveNulls ? 'MISSING_DATASET' : 'ALL_DATASET');
		},
		this._gotoError.bind(this)
	);
};

Control.prototype._stateAddDataset = function(whenAvailable) {

	var me = this;

	if (whenAvailable == AVAILABLE_AT_START) {
		this._emit('available');
	}

	var prepareUrlPart = function(key, dataset, version) {
		var strVersion = '';
		if (version !== null) {
			strVersion = encodeURIComponent(version);
		}
		return encodeURIComponent(key + '[' + dataset + ']') + '=' + strVersion;
	};

	this._getKnownDatasetVersionsPromise().done(
		function(datasetAndVersions) {

			var url = arrayMap(me._datasets, function(dataset) {
				return prepareUrlPart('dataset', dataset, datasetAndVersions[dataset]);
			}).join('&');

			me._eventSourceMonitor.changeUrl(url);
			if (!me._connected) {
				me._eventSourceMonitor.connect();
			}

		},
		this._gotoError.bind(this)
	);
};

Control.prototype.addDatasets = function(datasetNames, callback) {

	var datasetsLeft = arrayFilter(datasetNames, function(dsn) {
		return (this._datasets.indexOf(dsn) === -1);
	}.bind(this)).sort();

	if (datasetsLeft.length === 0) {
		if (callback !== undefined) {
			return callback(null, false, this._datasets);
		}
		return;
	}

	if (callback !== undefined) {
		this._monitoredCallbacks.push({
			datasets: datasetsLeft,
			callback: callback
		});
	}

	this._datasets = this._datasets.concat(datasetNames);
	this._datasets.sort();

	if (this._transitionState.current() === 'SYNCHED') {
		this._transitionState.change('ADDING_DATASET');
	}

};

Control.prototype._hasSyncItGotDataToPushPromise = function() {
	return syncItCallbackToPromise(
		this._syncIt,
		this._syncIt.getFirstInDatasets,
		[SyncIt_Constant.Error.OK, SyncIt_Constant.Error.NO_DATA_FOUND],
		this._datasets
	);
};

Control.prototype._statePushingDiscovery = function() {
	var transitionState = this._transitionState;
	when(this._hasSyncItGotDataToPushPromise()).done(
		function(data) {
			if (data === null) {
				return transitionState.change('SYNCHED');
			}
			return transitionState.change('PUSHING');
		}.bind(this),
		this._gotoError.bind(this)
	);
};

Control.prototype._statePushing = function() {
};

Control.prototype._stateSynched = function() {
};

Control.prototype._stateError = function() {
};

Control.prototype.connect = function() {
	if (['DISCONNECTED', 'ERROR'].indexOf(this._transitionState.current()) == -1) {
		return;
	}
	this._transitionState.change('ANALYZE');
};


addEvents(Control, [
	'available',
	'uploaded-queueitem',
	'error-uploading-queueitem',
	'error-advancing-queueitem',
	'entered-state',
	'feed-version-error',
	'downloaded'
]);

return Control;

}(
	require('rekey'),
	require('add-events'),
	require('transition-state'),
	require('sync-it/syncItCallbackToPromise'),
	require('when'),
	require('when/node/function'),
	require('when/callbacks'),
	require('when/function'),
	require('mout/array/filter'),
	require('mout/array/map'),
	require('mout/object/map'),
	require('mout/object/keys'),
	require('sync-it/Constant')
));

