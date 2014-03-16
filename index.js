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
	this._datasets = false;
	this._conflictResolutionFunction = conflictResolutionFunction;
	this._stateConfig = stateConfig;
	this._nextState = false;
	this._transitionState = (function() {
			var t = new TransitionState('RESET'),
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
					'SYNCHED': ['DISCONNECTED', 'RESET', 'ADDING_DATASET__CONNECTING', 'ERROR'],
					'ERROR': ['DISCONNECTED', 'RESET']
				};
			for (var k in states) {
				if (states.hasOwnProperty(k)) {
					t.addState(k,states[k]);
				}
			}
			return t;
		})();
};

Cls.prototype.addMonitoredDataset = function(datasetName) {
	var transitions = {
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
	
	if (this._datasets.indexOf(datasetName) !== -1) { return; }
	this._datasets.push(datasetName);
	if (!transitions.hasOwnProperty(this._transitionState.current())) {
		throw "Must be in an unknown state!";
	}
	if (transitions[this._transitionState.current()].now) {
		return this._transitionState.change(transitions[this._transitionState.current()].toState);
	}
	this._nextState = transitions[this._transitionState.current()].toState;
};

Cls.prototype.connect = function(datasetsToAdd) {
	
	var i, l;
	
	if (this._datasets === false) {
		if (!datasetsToAdd.length) {
			throw "You must connect to initial datasets";
		}
		this._datasets = JSON.parse(JSON.stringify(datasetsToAdd));
		return this._process();
	}
	
	if (arguments.length) {
		for (i=0, l=datasetsToAdd.length; i<l; i++) {
			if (this._datasets.indexOf(datasetsToAdd[i])) {
				this.addMonitoredDataset(datasetsToAdd[i]);
			}
		}
	}
	
	if (this._transitionState.current() === 'DISCONNECTED') {
		this._transitionState.change('RESET');
	}
	
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
		uploadQueue,
		reRetryDone = false,
		connectedUrl = false
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
		connectedUrl = this._url;
		transitionWithinStatePath('CONNECTING', 'DOWNLOADING');
	});
	
	eventSourceMonitor.on('url-changed', function() {
		connectedUrl = this._url;
		transitionWithinStatePath('CONNECTING', 'DOWNLOADING');
	});
	
	eventSourceMonitor.on('disconnected', function() {
		connectedUrl = false;
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
					transitionState.change('ERROR');
				}
			}
		);
	});
	
	var feedOneDatasetIntoSyncIt = function(dataset, queueitems, toDatasetVersion, next) {
		syncIt.feed(
			queueitems,
			conflictResolutionFunction,
			function(err) {
				if (err != SyncItConstant.Error.OK) {
					return next(err);
				}
				if (typeof toDatasetVersion !== 'undefined') {
					stateConfig.setItem(dataset, toDatasetVersion);
				} else {
					throw "Attempting to store undefined within stateConfig(" +
						dataset + ")"
				}
				next(err);
			}
		);
	};
	
	var uploadError = function(e, queueitem) {
		uploadQueue.empty();
		uploadQueue.resume();
		emit('error-uploading-queueitem', e, queueitem);
		transitionState.change('ERROR');
	};
	
	var queueitemUploaded = function(queueitem, to) {
		if (typeof to !== 'undefined') {
			stateConfig.setItem(queueitem.s, to);
		} else {
			throw "Attempting to store undefined within stateConfig(" +
				dataset + ")"
		}
		emit('uploaded-queueitem', queueitem, to);
		syncIt.advance(queueitemAdvanced);
	};
	
	var pushChangesInSyncIt = function() {
		
		var pushUploadQueue;
		
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
				if (e) { transitionState.change('ERROR'); }
				if (data === null) {
					return transitionState.change('SYNCHED');
				}
				pushUploadQueue.push(data);
			});
		};
		
		pushUploadQueue = new EmittingQueue(uploadChangeFunc);
		pushUploadQueue.on('item-processed', function(queueitem, to) {
			queueitemUploaded(queueitem, to);
			getAndQueue();
		});
		pushUploadQueue.on('item-could-not-be-processed', uploadError);
		getAndQueue();
	};
	
	var processStateChange = function(oldState, currentState) {
		
		var nextState;
		
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
			datasets.sort();
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
			emit('online', getBaseEventObj());
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
								'feed-version-error-caused-history-destroy',
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
			emit('pushing', getBaseEventObj());
			pushChangesInSyncIt();
			break;
		case 'SYNCHED':
			if (reRetryDone !== false) {
				reRetryDone(null);
			}
			emit('synched', getBaseEventObj());
			break;
		}
	}.bind(this);
	
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
	
	uploadQueue = new EmittingQueue(uploadChangeFunc);
	uploadQueue.on('item-processed', queueitemUploaded);
	uploadQueue.on('item-could-not-be-processed', uploadError);
	syncIt.listenForAddedToPath(function(dataset, datakey, queueitem) {
		uploadQueue.push(queueitem);
	});
	
	transitionState.start();
	
};

addEvents(Cls, [
	'offline',
	'online',
	'pushing',
	'synched',
	'adding-new-dataset',
	'added-new-dataset',
	'removed-dataset',
	'available',
	'unavailable',
	'uploaded-queueitem',
	'advanced-queueitem',
	'error-uploading-queueitem',
	'error-advancing-queueitem',
	'entered-state',
	'error-cycle-caused-stoppage',
	'feed-version-error-caused-history-destroy'
]);


return Cls;

}));
