(function (root, factory) { // UMD from https://github.com/umdjs/umd/blob/master/returnExports.js
	"use strict";
	if (typeof exports === 'object') {
		module.exports = factory(
			require('add-events'),
			require('transition-state'),
			require('sync-it/syncItCallbackToPromise'),
			require('re'),
			require('mout/array/map'),
			require('mout/object/map'),
			require('./emitting-queue'),
			require('when/keys'),
			require('when/node/function'),
			require('sync-it/Constant')
		);
	} else if (typeof define === 'function' && define.amd) {
		define([
			'add-events',
			'transition-state',
			'sync-it/syncItCallbackToPromise',
			're',
			'mout/array/map',
			'mout/object/map',
			'./emitting-queue',
			'when/keys',
			'when/node/function',
			'sync-it/Constant'
		],factory);
	} else {
		throw "Not Tested";
	}
}(this, function (addEvents, TransitionState, syncItCallbackToPromise, Re, arrayMap, objectMap, EmittingQueue, whenKeys, whenNode, SyncItConstant) {

"use strict";

/*										 |
										 |
										 v
								  +-------------+
						   +------+	  Analyze	+------+
						   |	  +-------------+	   |
						   |						   |
   +-------------------+   |   +-------------------+   |   +-------------------+
   |	ALL_DATASET	   |   |   |  MISSING_DATASET  |   |   |   ADDING_DATASET  |
   |-------------------|   |   |-------------------|   |   |-------------------|
   |				   |   |   |				   |   |   |				   |
   |  +-------------+  |   |   |  +-------------+  |   |   |				   |
   |  |	  Offline	|<-----+----->|	  Offline	|  |   |   |				   |
   |  +------+------+  |	   |  +------+------+  |   |   |				   |
   |		 |		   |	   |		 |		   |   |   |				   |
   |		 v		   |	   |		 v		   |   |   |				   |
   |  +-------------+  |	   |  +-------------+  |   |   |  +-------------+  |
   |  | Connecting	|  |	   |  | Connecting	|  |   +----->| Connecting	|  |
   |  +------+------+  |	   |  +------+------+  |	   |  +------+------+  |
   |		 |		   |	   |		 |		   |	   |		 |		   |
   |		 v		   |	   |		 v		   |	   |		 v		   |
   |  +-------------+  |	   |  +-------------+  |	   |  +-------------+  |
   |  | Downloading |  |	   |  | Downloading |  |	   |  | Downloading |  |
   |  +------+------+  |	   |  +------+------+  |	   |  +------+------+  |
   |		 |		   |	   |		 |		   |	   |		 |		   |
   +---------|---------+	   +---------|---------+	   +---------|---------+
			 |							 |							 |
			 +---------------------------+---------------------------+
										 |
										 v
							   +-------------------+
							   | Pushing Discovery |<--+
							   +---------+---------+   |
										 |			   |
										 v			   |
							   +-------------------+   |
							   |	 Pushing	   +---+
							   +---------+---------+
										 |
										 v
							   +-------------------+
							   |	 Synched	   |
							   +-------------------+

Current State Diagram... Any state shown can go to unshown Error state, which
can only lead to the Analyze state.

Analyze will end up going to either one of three states:

 1. All Dataset - If all datasets are known.
 2. Missing Dataset - If we know that we are completely lacking any of the
	datasets which was passed into the constructor.
 3. Adding Dataset - If all previous datasets were known but we have added one
	which is unknown.
	
Of these statuses Downloading in All Dataset as well as Connecting and 
Downloading of Adding Dataset are all classed as online and will fire the 
online event. Connecting and Downloading will fire the adding-new-dataset and
added-new-dataset respectively. From these statuses it will fire pushing and
synced events when it enters Pushing Discovery and Synched Statuses.

*/

var Cls = function(syncIt, eventSourceMonitor, stateConfig, downloadDatasetFunc, uploadChangeFunc, conflictResolutionFunction) {
	this._syncIt = syncIt;
	this._eventSourceMonitor = eventSourceMonitor;
	this._downloadDatasetFunc = downloadDatasetFunc;
	this._uploadChangeFunc = uploadChangeFunc;
	this._datasets = [];
	this._addMonitoredCallbacks = {};
	this._conflictResolutionFunction = conflictResolutionFunction;
	this._stateConfig = stateConfig;
	this._nextState = false;
	this._isInDebugMode = true;
	this._transitionState = (function() {
			var t = new TransitionState('DISCONNECTED'),
				states = {
					'DISCONNECTED': ['RESET'],
					'RESET': ['DISCONNECTED', 'ANALYZE'],
					'ANALYZE': ['DISCONNECTED', 'MISSING_DATASET__OFFLINE', 'ALL_DATASET__OFFLINE', 'RESET', 'ERROR'],
					'MISSING_DATASET__OFFLINE': ['DISCONNECTED', 'MISSING_DATASET__CONNECTING', 'RESET', 'ERROR'],
					'MISSING_DATASET__CONNECTING': ['DISCONNECTED', 'MISSING_DATASET__DOWNLOADING', 'RESET', 'ERROR'],
					'MISSING_DATASET__DOWNLOADING': ['DISCONNECTED', 'PUSHING_DISCOVERY', 'RESET', 'ERROR'],
					'ALL_DATASET__OFFLINE': ['DISCONNECTED', 'ALL_DATASET__CONNECTING', 'RESET', 'ERROR'],
					'ALL_DATASET__CONNECTING': ['DISCONNECTED', 'ALL_DATASET__DOWNLOADING', 'RESET', 'ERROR'],
					'ALL_DATASET__DOWNLOADING': ['DISCONNECTED', 'PUSHING_DISCOVERY', 'RESET', 'ADDING_DATASET__CONNECTING', 'ERROR'],
					'ADDING_DATASET__CONNECTING': ['DISCONNECTED', 'ADDING_DATASET__DOWNLOADING', 'RESET', 'ERROR'],
					'ADDING_DATASET__DOWNLOADING': ['DISCONNECTED', 'PUSHING_DISCOVERY', 'RESET', 'ADDING_DATASET__DOWNLOADING', 'ERROR'],
					'PUSHING_DISCOVERY': ['DISCONNECTED', 'SYNCHED', 'PUSHING', 'RESET', 'ADDING_DATASET__CONNECTING', 'ERROR'],
					'PUSHING': ['DISCONNECTED', 'PUSHING_DISCOVERY', 'RESET', 'ADDING_DATASET__CONNECTING', 'SYNCHED', 'ERROR'],
					'SYNCHED': ['DISCONNECTED', 'RESET', 'ADDING_DATASET__CONNECTING', 'PUSHING_DISCOVERY', 'ERROR'],
					'ERROR': ['DISCONNECTED', 'RESET']
				};
			for (var k in states) {
				if (states.hasOwnProperty(k)) {
					t.addState(k,states[k]);
				}
			}
			return t;
		})();
	this._process();
};

Cls.prototype._addDebug = function(/* Variable set of parameters */) {
	if (!this._isInDebugMode) { return; }
	var debug = this._stateConfig.getItem('_debug');
	if (debug === null) { debug = []; }
	debug.push(arguments);
	this._stateConfig.setItem('_debug', debug);
};

Cls.prototype.addMonitoredDataset = function(datasetName, callback) {
	var transitions = {
			'DISCONNECTED': {now: true, toState: 'RESET'},
			'RESET': {now: true, toState: 'RESET'},
			'ANALYZE': {now: true, toState: 'RESET'},
			'MISSING_DATASET__OFFLINE': {now: true, toState: 'RESET'},
			'MISSING_DATASET__CONNECTING': {now: true, toState: 'RESET'},
			'ALL_DATASET__OFFLINE': {now: true, toState: 'RESET'},
			'ALL_DATASET__CONNECTING': {now: true, toState: 'RESET'},
			'ADDING_DATASET__CONNECTING': {now: true, toState: 'RESET'},
			'MISSING_DATASET__DOWNLOADING': {now: false, toState: 'RESET'},
			'ADDING_DATASET__DOWNLOADING': {now: false, toState: 'ADDING_DATASET__CONNECTING'},
			'PUSHING_DISCOVERY': {now: false, toState: 'ADDING_DATASET__CONNECTING'},
			'SYNCHED': {now: true, toState: 'ADDING_DATASET__CONNECTING'},
			'ALL_DATASET__DOWNLOADING': {now: false, toState: 'ADDING_DATASET__CONNECTING'},
			'PUSHING': {now: false, toState: 'ADDING_DATASET__CONNECTING'},
			'ERROR': {now: false, toState: 'RESET'}
		};
	
	if (this._datasets.indexOf(datasetName) !== -1) { 
		if (callback !== undefined) {
			return callback(null, false, this._datasets);
		}
		return;
	}
	
	if (callback !== undefined) {
		this._addMonitoredCallbacks[datasetName] = callback;
	}
	
	this._datasets.push(datasetName);
    this._datasets.sort();
	if (!transitions.hasOwnProperty(this._transitionState.current())) {
		throw "Must be in an unknown state!";
	}
	if (transitions[this._transitionState.current()].now) {
		this._addDebug('ADDING_DATASET_IMMEDIATE: ' + datasetName);
		return this._transitionState.change(
			transitions[this._transitionState.current()].toState);
	}
	this._addDebug('ADDING_DATASET_DELAYED: ' + datasetName);
	this._nextState = transitions[this._transitionState.current()].toState;
};
    
Cls.prototype.connect = function() {
    if (this._transitionState.current() !== 'DISCONNECTED') { return false; }
	this._addDebug('CONNECT: RESET');
    this._transitionState.change('RESET');
};

Cls.prototype._process = function() {
	
	var stateConfig = this._stateConfig,
		datasets = this._datasets,
		transitionState = this._transitionState,
		eventSourceMonitor = this._eventSourceMonitor,
		emit = this._emit.bind(this),
		downloadDatasetFunc = this._downloadDatasetFunc,
		uploadChangeFunc = this._uploadChangeFunc,
		conflictResolutionFunction = this._conflictResolutionFunction,
		syncIt = this._syncIt,
		reRetryDone = false,
		connectedUrl = false,
		addMonitoredCallbacks = this._addMonitoredCallbacks,
		addDebug = this._addDebug.bind(this);
	;
	
	var getUnknownDataset = function() {
		var i, l,
			knownDatasets = stateConfig.findKeys('*'),
			r = [];
		for (i=0, l=datasets.length; i<l ; i++) {
			if (knownDatasets.indexOf(datasets[i]) == -1) {
				r.push(datasets[i]);
			}
		}
		return r;
	};
	
	var getBaseEventObj = function() {
		return { datasets: datasets };
	};
	
	var doDownloads = function(datasets, next) {
		
		var downloadPromises = {},
			i,
			l,
			downloadDataset = function(dataset) {
				return whenNode.call(
					downloadDatasetFunc,
					dataset,
					stateConfig.getItem(dataset)
				);
			};
		
		for (i=0, l=datasets.length; i<l; i++) {
			downloadPromises[datasets[i]] = downloadDataset(datasets[i]);
		}
		
		whenKeys.all(downloadPromises).done(
			function(allData) {
				var retData = objectMap(allData, function(ar) {
					return { data: ar[0], toVersion: ar[1] };
				});
				addDebug('DATA_DOWNLOADED: ', retData);
				return next(null, retData);
			},
			function(err) {
				next(err);
			}
		);
	};
	
	/**
	 * Will move from something like ALL_DATASET__[existingPrepend] to 
	 * ALL_DATASET__[newPrepend]
	 */
	var transitionWithinStatePath = function(existingPrepend, newPrepend) {
		var current = transitionState.current();
		var re = new RegExp('__' + existingPrepend + '$');
		if (current.match(re)) {
			transitionState.change(
				current.replace(/__.*/, '__' + newPrepend)
			);
		}
	};
	
	var eventSourceChangeFunc = function(connObj) {
		var urls = connObj.url.split('.');
		addDebug('EVENTSOURCE_CHANGE_URL: ', connObj.url);
		for (var i=0; i<urls.length; i++) {
			if (addMonitoredCallbacks.hasOwnProperty(urls[i])) {
				addDebug('EVENTSOURCE_CHANGE_URL_CALLBACK: ', urls[i]);
				addMonitoredCallbacks[urls[i]](null, true, urls);
				delete addMonitoredCallbacks[urls[i]];
			}
		}
		connectedUrl = connObj.url;
		transitionWithinStatePath('CONNECTING', 'DOWNLOADING');
	};
	
	eventSourceMonitor.on('connected', eventSourceChangeFunc);
	
	eventSourceMonitor.on('url-changed', eventSourceChangeFunc);
	
	eventSourceMonitor.on('disconnected', function() {
		connectedUrl = [];
		transitionState.change('DISCONNECTED');
	});
	
	eventSourceMonitor.on('messaged', function(data) {
		if (!data.hasOwnProperty('command') || data.command != 'queueitem') {
			return;
		}
		feedOneDatasetIntoSyncIt(
			data.queueitem.s,
			[data.queueitem],
			data.seqId,
			function(e) {
				if (e !== SyncItConstant.Error.OK) {
					addDebug('MESSAGED_ERROR: ', data);
					return transitionState.change('ERROR');
				}
				addDebug('MESSAGED_SUCCESS: ', data);
			}
		);
	});
	
	var feedOneDatasetIntoSyncIt = function(dataset, queueitems, toDatasetVersion, next) {
		addDebug('FEED: ', dataset, queueitems, toDatasetVersion);
		syncIt.feed(
			queueitems,
			conflictResolutionFunction,
			function(err) {
				addDebug('FEED_CALLBACK: ', dataset, queueitems, toDatasetVersion);
				if (err != SyncItConstant.Error.OK) {
					addDebug('FEED_CALLBACK_ERROR: ', err);
					return next(err);
				}
				if (typeof toDatasetVersion !== 'undefined') {
					addDebug('FEED_CALLBACK_SET_TO_DATASET_VERSION: ', toDatasetVersion);
					stateConfig.setItem(dataset, toDatasetVersion);
				} else {
					addDebug('FEED_CALLBACK_THROW: ', toDatasetVersion);
					throw "Attempting to store undefined within stateConfig(" +
						dataset + ")";
				}
				next(err);
			}
		);
	};
	
	var pushChangesToServer = (function() {
		
		var pushUploadQueue;
		
		var uploadError = function(e, queueitem) {
			addDebug('UPLOAD_ERROR: ', e, queueitem);
			pushUploadQueue.empty();
			pushUploadQueue.resume();
			emit('error-uploading-queueitem', e, queueitem);
			transitionState.change('ERROR');
		};

		var queueitemUploaded = function(queueitem, to, next) {

			var thenContinue = function(e, next) {
				addDebug('QUEUEITEM_ADVANCED', queueitem, to, e);
				if (e !== SyncItConstant.Error.OK) {
					emit(
						'error-advancing-queueitem',
						Array.prototype.slice.call(arguments, 0)
					);
					return transitionState.change(
						'ERROR'
					);
				}
				emit('advanced-queueitem', queueitem);
				next(null);
			};

			if (to === null) {
				addDebug('QUEUEITEM_UPLOADED_NULL: ', queueitem, to);
				// There has been no error, but the item caused no change on the
				// server... This means that it was probably already uploaded.
				syncIt.advance(function(e) {
					thenContinue(e, next);
				});
				return;
			}
			if (typeof to === 'undefined') {
				addDebug('QUEUEITEM_UPLOADED_THROW: ', queueitem, to);
				throw "Attempting to store undefined within stateConfig(" +
					queueitem.s + ")";
			}
			addDebug('QUEUEITEM_UPLOADED: ', queueitem, to);
			emit('uploaded-queueitem', queueitem, to);
			syncIt.advance(function(e) {
				if (e === SyncItConstant.Error.OK) {
					addDebug('STATECONFIG_SET: ', queueitem, to);
					stateConfig.setItem(queueitem.s, to);
				}
				thenContinue(e, next);
			});
		};

		var getQueueitemFromSyncIt = function(next) {
			syncIt.getFirst(function(err, pathItem) {
				var ok = [SyncItConstant.Error.NO_DATA_FOUND, SyncItConstant.Error.OK];
				if (ok.indexOf(err) === -1) {
					return next(err);
				}
				return next(
					null,
					(err === SyncItConstant.Error.NO_DATA_FOUND) ?
						null :
						pathItem
				);
			});
		};
		
		var getAndQueue = function() {
			getQueueitemFromSyncIt(function(e, data) {
				if (e) { return transitionState.change('ERROR'); }
				if (data === null) {
					return transitionState.change('PUSHING_DISCOVERY');
				}
				pushUploadQueue.push(data);
			});
		};
		
		pushUploadQueue = new EmittingQueue(uploadChangeFunc);
		pushUploadQueue.on('item-processed', function(queueitem, to) {
			queueitemUploaded(queueitem, to, function() {
				getAndQueue();
			});
		});
		pushUploadQueue.on('item-could-not-be-processed', uploadError);
		return getAndQueue;
	}());
	
	var processStateChange = function(oldState, currentState) {
		
		var nextState;
		
		addDebug('ENTERED_STATE: ', oldState, currentState, this._nextState);
		
		if (this._nextState) {
			if (currentState !== 'ERROR') {
				nextState = this._nextState;
				this._nextState = false;
				return transitionState.change(nextState);
			} else { return; }
		}

		emit('entered-state', currentState.toLowerCase());
		
		switch (currentState) {
		case 'ERROR':
			if (reRetryDone !== false) {
				return reRetryDone(new Error("Will Retry"));
			}
			var theRe = new Re({
				initial: 1000
			});
			theRe.do(
				function(retryCount, done) {
					reRetryDone = done;
					transitionState.change('RESET');
				},
				function(err) {
					if (err) {
						emit('error-cycle-caused-stoppage');
					}
				}
			);
			break;
		case 'RESET':
			transitionState.change('ANALYZE');
			break;
		case 'ANALYZE':
			if (getUnknownDataset().length === 0) {
				return transitionState.change('ALL_DATASET__OFFLINE');
			}
			return transitionState.change('MISSING_DATASET__OFFLINE');
		case 'ALL_DATASET__OFFLINE':
			emit('available', getBaseEventObj());
			/* falls through */
		case 'MISSING_DATASET__OFFLINE':
			transitionWithinStatePath('OFFLINE', 'CONNECTING');
			break;
		case 'ALL_DATASET__CONNECTING': /* falls through */
		case 'MISSING_DATASET__CONNECTING':
			if (connectedUrl === datasets.join('.')) {
				transitionWithinStatePath('CONNECTING', 'DOWNLOADING');
				return;
			}
			eventSourceMonitor.changeUrl(datasets.join('.'));
			eventSourceMonitor.connect();
			break;
		case 'ADDING_DATASET__CONNECTING':
			eventSourceMonitor.changeUrl(datasets.join('.'));
			break;
		case 'ALL_DATASET__DOWNLOADING':  /* falls through */
		case 'MISSING_DATASET__DOWNLOADING':  /* falls through */
		case 'ADDING_DATASET__DOWNLOADING':	 /* falls through */
			doDownloads(datasets, function(err, datasetsData) {
				
				var erroredDatasets = [],
					feedWorker = function(ob, done) {
							if (ob.queueitems.length === 0) {
								return done(null); 
							}
							feedOneDatasetIntoSyncIt(
								ob.dataset,
								ob.queueitems,
								ob.toVersion,
								function(err) {
									if (err === 24) {
										erroredDatasets.push(ob.dataset);
									}
									done(null);
								}
							);
						},
					feedQueue = new EmittingQueue(feedWorker);
				
				feedQueue.on('new-queue-length', function(l) {
					if (l === 0) {
						arrayMap(erroredDatasets, function(eds) {
							stateConfig.setItem(eds, null);
							emit(
								'feed-version-error',
								eds
							);
						});
						if (erroredDatasets.length) {
							return transitionState.change('ERROR');
						}
						return transitionState.change('PUSHING_DISCOVERY');
					}
				});
				
				objectMap(
					datasetsData,
					function(oneData, dataset) {
						feedQueue.push({
							dataset: dataset,
							queueitems: oneData.data,
							toVersion: oneData.toVersion
						});
					}
				);
				
			});
			break;
		case 'PUSHING_DISCOVERY':
			if (oldState.match(/^MISSING/)) {
				emit('available', getBaseEventObj());
			}
			syncIt.getFirst(function(err) {
				if (err == SyncItConstant.Error.NO_DATA_FOUND) {
					return transitionState.change('SYNCHED');
				}
				if (err == SyncItConstant.Error.OK) {
					return transitionState.change('PUSHING');
				}
				return this._transitionState.change('ERROR');
			});
			break;
		case 'PUSHING':
			pushChangesToServer();
			break;
		case 'SYNCHED':
			if (reRetryDone !== false) {
				reRetryDone(null);
			}
			break;
		}
	}.bind(this);
	
	transitionState.on('changed-state', processStateChange);
	transitionState.on('initial-state', function(state) {
		processStateChange(null, state);
	});
	
	syncIt.listenForAddedToPath(function() {
        if (transitionState.current() === 'SYNCHED') {
            transitionState.change('PUSHING_DISCOVERY');
        }
	});
	
	transitionState.start();
	
};

addEvents(Cls, [
	'available',
	'uploaded-queueitem',
    'advanced-queueitem',   // you could do this on SyncIt itself, so maybe
                            // this should not be here...
	'error-uploading-queueitem',
	'error-advancing-queueitem',
	'entered-state',
	'error-cycle-caused-stoppage',
	'feed-version-error'
]);


return Cls;

}));
