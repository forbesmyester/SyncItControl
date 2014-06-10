module.exports = (function (rekey, addEvents, TransitionState, syncItCallbackToPromise, when, whenNode, whenCallback, whenFunction, arrayFilter, arrayMap, objectMap, objectKeys, SyncItConstant, SyncItControlBuffer) {

"use strict";

var AVAILABLE_AT_ALREADY = 3,
    AVAILABLE_AT_END = 2,
    AVAILABLE_AT_START = 1;

var Control = function(syncIt, eventSourceMonitor, asyncLocalStorage, uploadChangeFunc, conflictResolutionFunction) {
	this._syncIt = syncIt;
	this._eventSourceMonitor = eventSourceMonitor;
	this._uploadChangeFunc = uploadChangeFunc;
	this._datasets = [];
	this._monitoredCallbacks = [];
	this._conflictResolutionFunction = conflictResolutionFunction;
	this._asyncLocalStorage = asyncLocalStorage;
	this._connectingDatasets = [];
	this._connected = false;
	this._buffer = null;
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
		'DISCONNECTED': this._stateDisconnected,
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
			syncIt,
			syncIt.feed,
			[SyncItConstant.Error.OK, SyncItConstant.Error.NO_DATA_FOUND],
			serverMultiDataToArray(data),
			conflictResolutionFunction
		).then(function() {
			return data;
		});
	};

	this._eventSourceMonitor.on('messaged', function(message) {

		if (!message.hasOwnProperty('command')) {
			return;
		}

		if (message.command == 'queueitem') {
			me._buffer.add(message.data);
		}

		if (message.command == 'download') {

			syncItFeedToPromise(message.data).then(
				Control._updateKnownDatasetVersionsPromise.bind(this, asyncLocalStorage, me._datasets)
			).done(
				function() {
					me._transitionState.change('PUSHING_DISCOVERY');
					me._perhapsFireMonitoredCallbacks(true, me._currentUrl);
				},
				me._gotoError.bind(me)
			);

			me._buffer.start();

		}
	});

	this._eventSourceMonitor.on('disconnected', function() {
		me._transitionState.change('DISCONNECTED');
	});

	var connectedHandler = function(connObj) {
		me._currentUrl = connObj.url;
		me._perhapsFireMonitoredCallbacks(false, connObj.url);
	};

	this._eventSourceMonitor.on('url-changed', connectedHandler);
	this._eventSourceMonitor.on('connected', connectedHandler);

	this._transitionState.start();
	this._transitionState.on('changed-state', function(oldState, newState) {
		me._emit('entered-state', newState);
		stateFunctions[newState].call(me, newState);
	});

	syncIt.listenForAddedToPath(function() {
        if (me._transitionState.current() === 'SYNCHED') {
            me._transitionState.change('PUSHING_DISCOVERY');
        }
	});
};

Control._updateKnownDatasetVersionsPromise = function(asyncLocalStorage, datasets, messageData) {
	return Control._getKnownDatasetVersionsPromise(asyncLocalStorage, datasets).then(
		function(dataVersions) {
			var requiredVersionChanges = Control._getKnownVersionChanges(
				dataVersions,
				messageData
			);
			var r = [];
			objectMap(requiredVersionChanges, function(version, dataset) {
				r.push(whenCallback.call(
					asyncLocalStorage.setItem.bind(asyncLocalStorage),
					dataset,
					version
				));
			});
			return when.all(r);
		}
	);
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

/**
 * ## Control._prepareForConnectedCallbacks()
 *
 * The idea of this function is to remove elements from
 * monitoredCallbacks[n][datasets] and if the array is empty it is ready to
 * call the callback.
 *
 * ### Parameters
 *
 *  * monitoredCallbacks - an array of Objects, when the objects "datasets" key is empty SyncItControl will fire the callback.
 *  * currentUrl - The URL that the EventSource is connected to.
 *  * alreadyConnectedDatasets - True or an array of Datasets. Which we already have some information about as we do not wait for the EventSource to connect to these before firing the callback.
 *
 */
Control.prototype._prepareForConnectedCallbacks = function(monitoredCallbacks, currentUrl, alreadyConnectedDatasets) {

	var currentDatasets = objectKeys(this._extractInfoFromUrl(currentUrl)),
		removeDataset = function(datasets, toRemoveDataset) {
				return arrayFilter(datasets, function(dataset) {
					return (dataset !== toRemoveDataset);
				});
			};

	monitoredCallbacks = arrayMap(monitoredCallbacks, function(callbackData) {
		if (callbackData === null) { return null; }
		arrayMap(currentDatasets, function(dataset) {
			if ((alreadyConnectedDatasets === true) || (alreadyConnectedDatasets.indexOf(dataset) > -1)) {
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
	throw new Error("AT ERROR");
	// this._transitionState.change('ERROR');
};

Control._getKnownVersionChanges = function(knownDatasetVersions, downloadedData) {

	var extractSequenceIdFromQueueitem = function(queueitem) {
		if (!queueitem.hasOwnProperty('_q')) { return null; }
		return queueitem._q;
	};

	var forIndividualDataset = function(knownVersion, downloadedData) {
		var highest = arrayMap(downloadedData, extractSequenceIdFromQueueitem).sort().pop();
		if (knownVersion === null) { return highest; }
		return ( highest > knownVersion ) ? highest : null;
	};

	var r = {};

	objectMap(downloadedData, function(v, k) {
		if ( (v === null) || (v.length === 0) ) { return; }
		var storedVersion = knownDatasetVersions.hasOwnProperty(k) ? knownDatasetVersions[k] : null;
		var proposed = forIndividualDataset(storedVersion, v);
		if (proposed !== null) {
			r[k] = proposed;
		}
	});

	return r;
};

Control.prototype._getKnownDatasetVersionsPromise = function() {

	return Control._getKnownDatasetVersionsPromise(
		this._asyncLocalStorage,
		this._datasets
	);

};

Control._getKnownDatasetVersionsPromise = function(asyncLocalStorage, datasets) {

	var getVersionPromise = function(dataset) {
		return whenCallback.call(asyncLocalStorage.getItem.bind(asyncLocalStorage), dataset);
	};

	return when.all(arrayMap(datasets, getVersionPromise)).then(
		function(versions) {
			return rekey(datasets, versions);
		}
	);
};

Control.prototype._stateDisconnected = function() { };

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

Control._convertToMessageDownloadFormat = function(arrayOfQueueitem) {
	var r = {};
	arrayMap(arrayOfQueueitem, function(queueitem) {
		if (!r.hasOwnProperty(queueitem.s)) { r[queueitem.s] = []; }
		r[queueitem.s].push(queueitem);
	});
	return objectMap(r, function(arrayOfQueueitemInDataset) {
		return arrayOfQueueitemInDataset.sort();
	});
};

Control.prototype._stateAddDataset = function(whenAvailable) {

	var me = this;

	this._buffer = new SyncItControlBuffer(
		function() { me._gotoError(); },
		function(queueitem, next) {
			me._syncIt.feed(
				[ queueitem ],
				me._conflictResolutionFunction,
				function(err) {
					if (err) { me._gotoError(); }
					Control._updateKnownDatasetVersionsPromise(
						me._asyncLocalStorage,
						me._datasets,
						Control._convertToMessageDownloadFormat([queueitem])
					).done(
						function() { next(null); },
						me._gotoError
					);
				}
			);
		},
		function() { },
		function() { }
	);

	if (whenAvailable == AVAILABLE_AT_START) {
		this._emit('available');
	}

	this._getKnownDatasetVersionsPromise().done(
		function(datasetAndVersions) {

			me._eventSourceMonitor.changeUrl(Control._prepareUrl(me._datasets, datasetAndVersions));
			if (!me._connected) {
				me._eventSourceMonitor.connect();
			}

		},
		me._gotoError
	);
};

Control._prepareUrl = function(fullDatasetList, knownDatasetVersions) {

	var prepareUrlPart = function(key, dataset, version) {
		var strVersion = '';
		if (version !== null) {
			strVersion = encodeURIComponent(version);
		}
		return encodeURIComponent(key + '[' + dataset + ']') + '=' + strVersion;
	};

	return arrayMap(fullDatasetList, function(dataset) {
		return prepareUrlPart(
			'dataset',
			dataset,
			knownDatasetVersions.hasOwnProperty(dataset) ? knownDatasetVersions[dataset] : ''
		);
	}).join('&');
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
		[SyncItConstant.Error.OK, SyncItConstant.Error.NO_DATA_FOUND],
		this._datasets
	);
};

Control.prototype._findSyncItFirst = function(callbackWhenDataFound) {
	var transitionState = this._transitionState;
	when(this._hasSyncItGotDataToPushPromise()).done(
		function(data) {
			if (data === null) {
				return transitionState.change('SYNCHED');
			}
			return callbackWhenDataFound(data);
		}.bind(this),
		this._gotoError.bind(this)
	);
};

Control.prototype._statePushingDiscovery = function() {
	var transitionState = this._transitionState;
	this._findSyncItFirst(function() {
		return transitionState.change('PUSHING');
	});
};

Control.prototype._statePushing = function() {

	var me = this;

	this._findSyncItFirst(function(queueitem) {
		me._uploadChangeFunc(queueitem, function(err) {
			if (err) { return me._gotoError(); }
			me._syncIt.advance(function(status) {
				if (status !== SyncItConstant.Error.OK) {
					return me._gotoError();
				}
				return me._transitionState.change('PUSHING_DISCOVERY');
			});
		});
	});
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
	require('sync-it/Constant'),
	require('syncit-control-buffer')
));

