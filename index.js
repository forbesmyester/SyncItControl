(function (root, factory) { // UMD from https://github.com/umdjs/umd/blob/master/returnExports.js
	"use strict";
	if (typeof exports === 'object') {
		module.exports = factory(
			require('add-events'),
			require('transition-state'),
			require('./syncItCallbackToPromise'),
			require('mout/array/map'),
			require('mout/object/map'),
			require('emitting-queue'),
			require('when/keys'),     // TODO: Remove... I think when but it's
			require('when/node/function'),// not __really__ required
			require('syncit/Constant')
		);
	} else if (typeof define === 'function' && define.amd) {
		define([
			'add-events',
			'transition-state',
			'./syncItCallbackToPromise',
			'mout/array/map',
			'mout/object/map',
			'emitting-queue',
			'when/keys',
			'when/node/function',
			'syncit/Constant'
		],factory);
	} else {
		throw "Not Tested";
	}
}(this, function (addEvents, TransitionState, syncItCallbackToPromise, arrayMap, objectMap, EmittingQueue, whenKeys, whenNode, SyncItConstant) {

"use strict";

/*                                       |
                                         |
                                         v
                                  +-------------+
                           +------+   Analyze   +------+
                           |      +-------------+      |
                           |                           |
   +-------------------+   |   +-------------------+   |   +-------------------+
   |    ALL_DATASET    |   |   |  MISSING_DATASET  |   |   |   ADDING_DATASET  |
   |-------------------|   |   |-------------------|   |   |-------------------|
   |                   |   |   |                   |   |   |                   |
   |  +-------------+  |   |   |  +-------------+  |   |   |                   |
   |  |   Offline   |<-----+----->|   Offline   |  |   |   |                   |
   |  +------+------+  |       |  +------+------+  |   |   |                   |
   |         |         |       |         |         |   |   |                   |
   |         v         |       |         v         |   |   |                   |
   |  +-------------+  |       |  +-------------+  |   |   |  +-------------+  |
   |  | Connecting  |  |       |  | Connecting  |  |   +----->| Connecting  |  |
   |  +------+------+  |       |  +------+------+  |       |  +------+------+  |
   |         |         |       |         |         |       |         |         |
   |         v         |       |         v         |       |         v         |
   |  +-------------+  |       |  +-------------+  |       |  +-------------+  |
   |  | Downloading |  |       |  | Downloading |  |       |  | Downloading |  |
   |  +------+------+  |       |  +------+------+  |       |  +------+------+  |
   |         |         |       |         |         |       |         |         |
   +---------|---------+       +---------|---------+       +---------|---------+
             |                           |                           |
             +---------------------------+---------------------------+
                                         |
                                         v
                               +-------------------+
                               | Pushing Discovery |<--+
                               +---------+---------+   |
                                         |             |
                                         v             |
                               +-------------------+   |
                               |     Pushing       +---+
                               +---------+---------+
                                         |
                                         v
                               +-------------------+
                               |     Synched       |
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

var Cls = function(syncIt, eventSourceMonitor, stateConfig, downloadDatasetFunc, uploadChangeFunc, conflictResolutionFunction, initialDatasets) {
	this._syncIt = syncIt;
	this._eventSourceMonitor = eventSourceMonitor;
	this._downloadDatasetFunc = downloadDatasetFunc;
	this._uploadChangeFunc = uploadChangeFunc;
	this._datasets = initialDatasets;
	this._conflictResolutionFunction = conflictResolutionFunction;
	this._stateConfig = stateConfig;
	this._transitionState = (function() {
			var t = new TransitionState('RESET'),
				states = {
					'RESET': ['ANALYZE'],
					'ANALYZE': ['MISSING_DATASET__OFFLINE', 'ALL_DATASET__OFFLINE', 'ADDING_DATASET__CONNECTING', 'RESET'],
					'MISSING_DATASET__OFFLINE': ['MISSING_DATASET__CONNECTING', 'RESET'],
					'MISSING_DATASET__CONNECTING': ['MISSING_DATASET__DOWNLOADING', 'RESET'],
					'MISSING_DATASET__DOWNLOADING': ['PUSHING_DISCOVERY', 'RESET'],
					'ALL_DATASET__OFFLINE': ['ALL_DATASET__CONNECTING', 'RESET'],
					'ALL_DATASET__CONNECTING': ['ALL_DATASET__DOWNLOADING', 'RESET'],
					'ALL_DATASET__DOWNLOADING': ['PUSHING_DISCOVERY', 'RESET'],
					'ADDING_DATASET__CONNECTING': ['ADDING_DATASET__DOWNLOADING', 'RESET'],
					'ADDING_DATASET__DOWNLOADING': ['PUSHING_DISCOVERY', 'RESET'],
					'PUSHING_DISCOVERY': ['SYNCHED', 'PUSHING', 'RESET'],
					'PUSHING': ['PUSHING_DISCOVERY', 'RESET'],
					'SYNCHED': ['RESET'],
					'ERROR': []
				};
			for (var k in states) {
				if (states.hasOwnProperty(k)) {
					t.addState(k,states[k]);
				}
			}
			return t;
		})();
};

// Cls.prototype.addMonitoredDataset = function(datasetName) {
// 	
// };
// 
// Cls.prototype.removeMonitoredDataset = function(datasetName) {
// 	
// };

Cls.prototype.connect = function() {
	var stateConfig = this._stateConfig,
		datasets = this._datasets,
		transitionState = this._transitionState,
		lastReset = 0,
		eventSourceMonitor = this._eventSourceMonitor,
		eventSourceMonitorStarted = false,
		emit = this._emit.bind(this),
		downloadDatasetFunc = this._downloadDatasetFunc,
		uploadChangeFunc = this._uploadChangeFunc,
		syncIt = this._syncIt,
		uploadQueue
	;
	
	var allDatasetKnown = function() {
		var i, l,
			knownDatasets = stateConfig.findKeys('*');
		for (i=0, l=datasets.length; i<l ; i++) {
			if (knownDatasets.indexOf(datasets[i]) == -1) {
				return false;
			}
		}
		return true;
	};
	
	var getBaseEventObj = function() {
		return { datasets: datasets };
	};
	
	var reset = function() {
		/* global setTimeout */
		eventSourceMonitor.disconnect();
		var now = new Date().getTime(),
			gotoAnalyze = function() {
				lastReset = new Date().getTime();
				transitionState.change('ANALYZE');
			};
		if (lastReset + 5000 > now) {
			return setTimeout(gotoAnalyze, 5000);
		}
		gotoAnalyze();
	};
	
	var performAnalysis = function() {
		if (allDatasetKnown()) {
			return transitionState.change('ALL_DATASET__OFFLINE');
		}
		return transitionState.change('MISSING_DATASET__OFFLINE');
	};
	
	var attemptConnect = function() {
		if (!eventSourceMonitorStarted) {
			eventSourceMonitor.connect(datasets);
			eventSourceMonitorStarted = true;
		}
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
	
	eventSourceMonitor.on('connected', function() {
		transitionWithinStatePath('CONNECTING', 'DOWNLOADING');
	});
	
	eventSourceMonitor.on('messaged', function(data) {
		feedOneDatasetIntoSyncIt(
			data.queueitem.s,
			[data.queueitem],
			data.to,
			function(e) {
				if (e !== SyncItConstant.Error.OK) {
					transitionState.change('ERROR');
				}
			}
		);
	});
	
	var feedOneDatasetIntoSyncIt = function(dataset, queueitems, toDatasetVersion, next) {
		syncIt.feed(
			queueitems,
			function() {
				throw new Error("CONFLICT: FAIL FAIL FAIL");
			},
			function(err) {
				if (err != SyncItConstant.Error.OK) {
					return next(err);
				}
				stateConfig.setItem(dataset, toDatasetVersion);
				next(err);
			}
		);
	};
	
	var processStateChange = function(oldState, currentState) {
		
		// (function() {
		// 	/* global console */
		// 	console.log([oldState, currentState]);
		// }());
		
		switch (currentState) {
		case 'RESET':
			reset();
			break;
		case 'ANALYZE':
			performAnalysis();
			break;
		case 'ALL_DATASET__OFFLINE':
			emit('available', getBaseEventObj());
			/* falls through */
		case 'MISSING_DATASET__OFFLINE':
			transitionWithinStatePath('OFFLINE', 'CONNECTING');
			break;
		case 'ALL_DATASET__CONNECTING': /* falls through */
		case 'MISSING_DATASET__CONNECTING': /* falls through */
		case 'ADDING_DATASET__CONNECTING':
			attemptConnect();
			break;
		case 'ALL_DATASET__DOWNLOADING':  /* falls through */
		case 'MISSING_DATASET__DOWNLOADING':  /* falls through */
		case 'ADDING_DATASET__DOWNLOADING':  /* falls through */
			emit('online', getBaseEventObj());
			doDownloads(datasets, function(err, datasetsData) {
				
				var promises = objectMap(
					datasetsData,
					function(oneData, dataset) {
						return syncItCallbackToPromise(
							syncIt,
							feedOneDatasetIntoSyncIt,
							[0],
							dataset,
							oneData.data,
							oneData.toVersion
						);
					}
				);
				
				whenKeys.all(promises).done(
					function() {
						transitionState.change('PUSHING_DISCOVERY');
					},
					function() {
						return transitionState.change('ERROR');
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
			emit('pushing', getBaseEventObj());
			break;
		case 'SYNCHED':
			emit('synched', getBaseEventObj());
			break;
		}
	};
	
	transitionState.on('changed-state', processStateChange);
	transitionState.on('initial-state', function(state) {
		processStateChange(null, state);
	});
	
	var queueitemAdvanced = function(e, dataset, datakey, queueitem) {
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
	};
	
	var uploadError = function(e, queueitem) {
		uploadQueue.empty();
		uploadQueue.resume();
		emit('error-uploading-queueitem', e, queueitem);
		transitionState.change('ERROR');
	};
	
	uploadQueue = new EmittingQueue(uploadChangeFunc);
	uploadQueue.on('item-processed', function(queueitem, to) {
		stateConfig.setItem(queueitem.s, to);
		emit('uploaded-queueitem', queueitem, to);
		syncIt.advance(queueitemAdvanced);
	});
	
	uploadQueue.on('item-could-not-be-processed', uploadError);
	syncIt.listenForAddedToPath(function(dataset, datakey, queueitem) {
		uploadQueue.push(queueitem);
	});
	
	transitionState.start();
	
};

addEvents(Cls, [
	'offline', 'online', 'pushing', 'synched', 'adding-new-dataset',
	'added-new-dataset', 'removed-dataset', 'available', 'unavailable',
	'uploaded-queueitem', 'advanced-queueitem',
	'error-uploading-queueitem', 'error-advancing-queueitem'
]);


return Cls;

}));
