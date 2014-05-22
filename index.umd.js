!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var n;"undefined"!=typeof window?n=window:"undefined"!=typeof global?n=global:"undefined"!=typeof self&&(n=self),n.SyncItControl=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
module.exports = (function (addEvents) {

"use strict";

// Author: Matthew Forrester <matt_at_keyboardwritescode.com>
// Copyright: Matthew Forrester
// License: MIT/BSD-style


var EmittingQueue = function(worker) {
	this._worker = worker;
	this._items = [];
	this._processing = false;
	this._processingItem = false;
	this._suspended = false;
	
	var cb = function(err) {
		this._processing = false;
		if (err) {
			this._suspended = true;
			this._items.unshift(this._processingItem);
			this._emit('item-could-not-be-processed', err, this._items[0]);
			return true;
		}
		this._emit.apply(
			this,
			['item-processed', this._processingItem].concat(
				Array.prototype.slice.call(arguments, 1)
			)
		);
		this._emit('new-queue-length', this._items.length);
	}.bind(this);
	
	/* global setInterval: false */
	setInterval(function() {
		if (
			this._processing ||
			this._suspended ||
			this._items.length === 0
		) { return; }
		this._processing = true;
		this._processingItem = this._items.shift();
		worker(this._processingItem, cb);
	}.bind(this), 10);
};

EmittingQueue.prototype.push = function(item) {
	this._items.push(item);
	this._emit('new-queue-length', this._items.length);
};

EmittingQueue.prototype.isSuspended = function() {
	return this._suspended;
};

EmittingQueue.prototype.resume = function() {
	this._suspended = false;
};

EmittingQueue.prototype.empty = function() {
	var removed = [this._processingItem].concat(this._items);
	this._items = [];
	this._processing = false;
	this._emit('new-queue-length', this._items.length);
	this._emit('emptied', removed);
};

addEvents(EmittingQueue, ['item-processed', 'item-could-not-be-processed', 'new-queue-length', 'emptied']);

return EmittingQueue;

}(_dereq_('add-events')));

},{"add-events":3}],2:[function(_dereq_,module,exports){
module.exports = (function (addEvents, TransitionState, syncItCallbackToPromise, Re, arrayMap, objectMap, EmittingQueue, whenKeys, whenNode, SyncItConstant) {

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

var Cls = function(syncIt, eventSourceMonitor, storeSequenceId, downloadDatasetFunc, uploadChangeFunc, conflictResolutionFunction) {
	this._syncIt = syncIt;
	this._eventSourceMonitor = eventSourceMonitor;
	this._downloadDatasetFunc = downloadDatasetFunc;
	this._uploadChangeFunc = uploadChangeFunc;
	this._datasets = [];
	this._addMonitoredCallbacks = {};
	this._conflictResolutionFunction = conflictResolutionFunction;
	this._storeSequenceId = storeSequenceId;
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
	return;
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
	
	var storeSequenceId = this._storeSequenceId,
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
		addDebug = this._addDebug.bind(this)
	;
	
	var getUnknownDataset = function() {
		var i, l,
			knownDatasets = storeSequenceId.findKeys('*'),
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
					storeSequenceId.getItem(dataset)
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
			(transitionState.current() == 'SYNCHED'),
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
	
	var feedOneDatasetIntoSyncIt = function(fromDownloadOrSynched, dataset, queueitems, toDatasetVersion, next) {
		addDebug('FEED: ', fromDownloadOrSynched, dataset, queueitems, toDatasetVersion);
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
					storeSequenceId.setItem(fromDownloadOrSynched, dataset, toDatasetVersion);
				} else {
					addDebug('FEED_CALLBACK_THROW: ', toDatasetVersion);
					throw "Attempting to store undefined within storeSequenceId(" +
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
				throw "Attempting to store undefined within storeSequenceId(" +
					queueitem.s + ")";
			}
			addDebug('QUEUEITEM_UPLOADED: ', queueitem, to);
			emit('uploaded-queueitem', queueitem, to);
			syncIt.advance(function(e) { thenContinue(e, next); });
		};

		var getQueueitemFromSyncIt = function(next) {
			syncIt.getFirstInDatasets(datasets, function(err, pathItem) {
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
			var countToLoad = function(ob) {
				var r = 0;
				for (var k in ob) {
					if (ob.hasOwnProperty(k)) {
						if (ob[k].hasOwnProperty('data')) {
							r = r + ob[k].data.length;
						}
					}
				}
				return r;
			};
			doDownloads(datasets, function(err, datasetsData) {

				emit('downloaded', countToLoad(datasetsData));
				
				var recordDatasetsIfNotKnown = function(datasets) {
					var i, l;
					for (i=0, l=datasets.length; i<l; i++) {
						if (storeSequenceId.getItem(datasets[i])) {
							continue;
						}
						storeSequenceId.setItem(true, datasets[i], null);
					}
				};

				recordDatasetsIfNotKnown(datasets);

				var erroredDatasets = [],
					feedWorker = function(ob, done) {
							if (ob.queueitems.length === 0) {
								return done(null); 
							}
							feedOneDatasetIntoSyncIt(
								true,
								ob.dataset,
								ob.queueitems,
								ob.toVersion,
								function(err) {
									storeSequenceId.setItem(true, ob.dataset, ob.toVersion);
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
							storeSequenceId.setItem(true, eds, null);
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
			syncIt.getFirstInDatasets(datasets, function(err) {
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
	'feed-version-error',
	'downloaded'
]);


return Cls;

}(
	_dereq_('add-events'),
	_dereq_('transition-state'),
	_dereq_('sync-it/syncItCallbackToPromise'),
	_dereq_('re'),
	_dereq_('mout/array/map'),
	_dereq_('mout/object/map'),
	_dereq_('./emitting-queue'),
	_dereq_('when/keys'),
	_dereq_('when/node/function'),
	_dereq_('sync-it/Constant')
));

},{"./emitting-queue":1,"add-events":3,"mout/array/map":5,"mout/object/map":16,"re":17,"sync-it/Constant":18,"sync-it/syncItCallbackToPromise":19,"transition-state":20,"when/keys":21,"when/node/function":22}],3:[function(_dereq_,module,exports){
module.exports = (function () {
	
// Author: Matthew Forrester <matt_at_keyboardwritescode.com>
// Copyright: Matthew Forrester
// License: MIT/BSD-style

"use strict";

/**
 * # addEvents()
 *
 * Adds events to an existing pseudo-classical Javascript class.
 *
 * NOTE: Overwrites the following variables within the prototype:
 *
 * * _eventTypes
 * * _emit
 * * on
 * * once
 * * removeAllListeners
 * * removeAllOnceListeners
 * * removeOnceListener
 * * removeOnceListener
 *
 * NOTE: Overwrites the following variables within the instance of a class
 *
 * * _onceListeners
 * * _listeners
 * 
 * ## Example
 *
 * ```javascript
 * var MyClass = function() {
 * };
 *
 * MyClass.prototype.doSomething = function() {
 *	return this._emit('doneit','a','b');
 * };
 *
 * addEvents(MyClass,['doneit']);
 *
 * var myClass = new MyClass();
 * myClass.on('doneit',function (a, b) {
 *	console.log('a = ' + a + ', b = ' + b);
 * });
 * myClass.doSomething();
 * ```
 *
 * ## Parameters
 * * **@param {Function} `classFunc`** The class to add events to.
 * * **@param {Array} `events`** The events you want the class to support.
 */
var addEvents = function(classFunc, events) {

	classFunc.prototype._eventTypes = events;
	
	classFunc.prototype._emit = function(event /*, other arguments */) {

		var i = 0,
			args = Array.prototype.slice.call(arguments, 1);
		
		if (this._eventTypes.indexOf(event) === -1) {
			throw "SyncIt._emit(): Attempting to fire unknown event '" + event + "'";
		}
		
		var toFire = [];
		
		if (
			this.hasOwnProperty('_onceListeners') &&
			this._onceListeners.hasOwnProperty(event)
		) {
			while (this._onceListeners[event].length) {
				toFire.push(this._onceListeners[event].shift());
			}
		}
		
		if (
			this.hasOwnProperty('_listeners') &&
			this._listeners.hasOwnProperty(event)
		) {

			for (i=0; i<this._listeners[event].length; i++) {
				toFire.push(this._listeners[event][i]);
			}
		}
		
		while (toFire.length) {
			toFire.shift().apply(this, args);
		}
		
	};

	var pushTo = function(objKey, event, func, ctx) {
		
		if (ctx._eventTypes.indexOf(event) === -1) {
			throw "addEvents: Attempting to listen for unknown event '"+event+"'";
		}
		
		if (!ctx.hasOwnProperty(objKey)) {
			ctx[objKey] = {};
		}
		
		if (!ctx[objKey].hasOwnProperty(event)) {
			ctx[objKey][event] = [];
		}
		
		ctx[objKey][event].push(func);
	};

	/**
	 * ### CLASS.on()
	 * 
	 * Adds an event listeners to an event
	 * 
	 * #### Parameters
	 * 
	 * * **@param {String} `event`** The name of the event to listen for
	 * * **@param {Function} `listener`** The listener to fire when event occurs.
	 * 
	 * #### Returns
	 * 
	 * * **@return {Boolean}** True if that event is available to listen to.
	 */
	classFunc.prototype.on = function(event, func) {
		pushTo('_listeners', event, func, this);
	};
	classFunc.prototype.listen = classFunc.prototype.on;
	
	/**
	 * ### CLASS.once()
	 * 
	 * Adds an event listeners which will be called only once then removed
	 * 
	 * #### Parameters
	 * 
	 * * **@param {String} `event`** The name of the event to listen for
	 * * **@param {Function} `listener`** The listener to fire when event occurs.
	 * 
	 * #### Returns
	 * 
	 * * **@return {Boolean}** True if that event is available to listen to.
	 */
	classFunc.prototype.once = function(event,func) {
		pushTo('_onceListeners', event, func, this);
	};
	
	var removeAllListeners = function(objKey, event, ctx) {	
		var propertyNames = (function(ob) {
			var r = [];
			for (var k in ob) { if (ob.hasOwnProperty(k)) {
				r.push(k);
			} }
			return r;
		})(ctx[objKey]);
		
		if (propertyNames.indexOf(event) == -1) {
			return [];
		}
		
		var r = ctx[objKey][event];
		ctx[objKey][event] = [];
		return r;
	};

	/**
	 * ### CLASS.removeAllListeners()
	 *
	 * Removes all non `once` listeners for a specific event.
	 *
	 * #### Parameters
	 * 
	 * * **@param {String} `event`** The name of the event you want to remove all listeners for.
	 * 
	 * #### Returns
	 * 
	 * * **@return {Array}** The listeners that have just been removed.
	 */
	classFunc.prototype.removeAllListeners = function(event) {
		return removeAllListeners('_listeners', event, this);
	};
	
	/**
	 * ### CLASS.removeAllOnceListeners()
	 *
	 * Removes all `once` listeners for a specific event.
	 *
	 * #### Parameters
	 * 
	 * * **@param {String} `event`** The name of the event you want to remove all listeners for.
	 * 
	 * #### Returns
	 * 
	 * * **@return {Array}** The listeners that have just been removed.
	 */
	classFunc.prototype.removeAllOnceListeners = function(event) {
		return removeAllListeners('_onceListeners', event, this);
	};
	
	var removeListener = function(objKey, event, listener, ctx) {
		
		var i = 0,
			replacement = [],
			successful = false;
		
		var propertyNames = (function(ob) {
			var r = [];
			for (var k in ob) { if (ob.hasOwnProperty(k)) {
				r.push(k);
			} }
			return r;
		})(ctx[objKey]);
		
		if (propertyNames.indexOf(event) == -1) {
			return false;
		}
		
		for (i=0; i<ctx[objKey][event].length; i++) {
			if (ctx[objKey][event][i] !== listener) {
				replacement.push(ctx[objKey][event][i]);
			} else {
				successful = true;
			}
		}
		ctx[objKey][event] = replacement;
		
		return successful;
	};
	
	/**
	 * ### CLASS.removeListener()
	 *
	 * Removes a specific listener from an event (note, not from the `once()` call).
	 *
	 * #### Parameters
	 * 
	 * * **@param {String} `event`** The name of the event you want to remove a listener from.
	 * * **@param {Function} `listener`** The listener you want to remove.
	 * 
	 * #### Returns
	 * 
	 * * **@return {Boolean}** True if the listener was removed, false otherwise.
	 */
	classFunc.prototype.removeListener = function(event, listener) {
		return removeListener('_listeners', event, listener, this);
	};

	/**
	 * ### CLASS.removeOnceListener()
	 *
	 * Removes a specific listener from an event (note, not from the `once()` call).
	 *
	 * #### Parameters
	 * 
	 * * **@param {String} `event`** The name of the event you want to remove a listener from.
	 * * **@param {Function} `listener`** The listener you want to remove.
	 * 
	 * #### Returns
	 * 
	 * * **@return {Boolean}** True if the listener was removed, false otherwise.
	 */
	classFunc.prototype.removeOnceListener = function(event, listener) {
		return removeListener('_onceListeners', event, listener, this);
	};

};

return addEvents;

}());

},{}],4:[function(_dereq_,module,exports){
// shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}],5:[function(_dereq_,module,exports){
var makeIterator = _dereq_('../function/makeIterator_');

    /**
     * Array map
     */
    function map(arr, callback, thisObj) {
        callback = makeIterator(callback, thisObj);
        var results = [];
        if (arr == null){
            return results;
        }

        var i = -1, len = arr.length;
        while (++i < len) {
            results[i] = callback(arr[i], i, arr);
        }

        return results;
    }

     module.exports = map;


},{"../function/makeIterator_":7}],6:[function(_dereq_,module,exports){


    /**
     * Returns the first argument provided to it.
     */
    function identity(val){
        return val;
    }

    module.exports = identity;



},{}],7:[function(_dereq_,module,exports){
var identity = _dereq_('./identity');
var prop = _dereq_('./prop');
var deepMatches = _dereq_('../object/deepMatches');

    /**
     * Converts argument into a valid iterator.
     * Used internally on most array/object/collection methods that receives a
     * callback/iterator providing a shortcut syntax.
     */
    function makeIterator(src, thisObj){
        if (src == null) {
            return identity;
        }
        switch(typeof src) {
            case 'function':
                // function is the first to improve perf (most common case)
                // also avoid using `Function#call` if not needed, which boosts
                // perf a lot in some cases
                return (typeof thisObj !== 'undefined')? function(val, i, arr){
                    return src.call(thisObj, val, i, arr);
                } : src;
            case 'object':
                return function(val){
                    return deepMatches(val, src);
                };
            case 'string':
            case 'number':
                return prop(src);
        }
    }

    module.exports = makeIterator;



},{"../object/deepMatches":12,"./identity":6,"./prop":8}],8:[function(_dereq_,module,exports){


    /**
     * Returns a function that gets a property of the passed object
     */
    function prop(name){
        return function(obj){
            return obj[name];
        };
    }

    module.exports = prop;



},{}],9:[function(_dereq_,module,exports){
var isKind = _dereq_('./isKind');
    /**
     */
    var isArray = Array.isArray || function (val) {
        return isKind(val, 'Array');
    };
    module.exports = isArray;


},{"./isKind":10}],10:[function(_dereq_,module,exports){
var kindOf = _dereq_('./kindOf');
    /**
     * Check if value is from a specific "kind".
     */
    function isKind(val, kind){
        return kindOf(val) === kind;
    }
    module.exports = isKind;


},{"./kindOf":11}],11:[function(_dereq_,module,exports){


    var _rKind = /^\[object (.*)\]$/,
        _toString = Object.prototype.toString,
        UNDEF;

    /**
     * Gets the "kind" of value. (e.g. "String", "Number", etc)
     */
    function kindOf(val) {
        if (val === null) {
            return 'Null';
        } else if (val === UNDEF) {
            return 'Undefined';
        } else {
            return _rKind.exec( _toString.call(val) )[1];
        }
    }
    module.exports = kindOf;


},{}],12:[function(_dereq_,module,exports){
var forOwn = _dereq_('./forOwn');
var isArray = _dereq_('../lang/isArray');

    function containsMatch(array, pattern) {
        var i = -1, length = array.length;
        while (++i < length) {
            if (deepMatches(array[i], pattern)) {
                return true;
            }
        }

        return false;
    }

    function matchArray(target, pattern) {
        var i = -1, patternLength = pattern.length;
        while (++i < patternLength) {
            if (!containsMatch(target, pattern[i])) {
                return false;
            }
        }

        return true;
    }

    function matchObject(target, pattern) {
        var result = true;
        forOwn(pattern, function(val, key) {
            if (!deepMatches(target[key], val)) {
                // Return false to break out of forOwn early
                return (result = false);
            }
        });

        return result;
    }

    /**
     * Recursively check if the objects match.
     */
    function deepMatches(target, pattern){
        if (target && typeof target === 'object') {
            if (isArray(target) && isArray(pattern)) {
                return matchArray(target, pattern);
            } else {
                return matchObject(target, pattern);
            }
        } else {
            return target === pattern;
        }
    }

    module.exports = deepMatches;



},{"../lang/isArray":9,"./forOwn":14}],13:[function(_dereq_,module,exports){
var hasOwn = _dereq_('./hasOwn');

    var _hasDontEnumBug,
        _dontEnums;

    function checkDontEnum(){
        _dontEnums = [
                'toString',
                'toLocaleString',
                'valueOf',
                'hasOwnProperty',
                'isPrototypeOf',
                'propertyIsEnumerable',
                'constructor'
            ];

        _hasDontEnumBug = true;

        for (var key in {'toString': null}) {
            _hasDontEnumBug = false;
        }
    }

    /**
     * Similar to Array/forEach but works over object properties and fixes Don't
     * Enum bug on IE.
     * based on: http://whattheheadsaid.com/2010/10/a-safer-object-keys-compatibility-implementation
     */
    function forIn(obj, fn, thisObj){
        var key, i = 0;
        // no need to check if argument is a real object that way we can use
        // it for arrays, functions, date, etc.

        //post-pone check till needed
        if (_hasDontEnumBug == null) checkDontEnum();

        for (key in obj) {
            if (exec(fn, obj, key, thisObj) === false) {
                break;
            }
        }


        if (_hasDontEnumBug) {
            var ctor = obj.constructor,
                isProto = !!ctor && obj === ctor.prototype;

            while (key = _dontEnums[i++]) {
                // For constructor, if it is a prototype object the constructor
                // is always non-enumerable unless defined otherwise (and
                // enumerated above).  For non-prototype objects, it will have
                // to be defined on this object, since it cannot be defined on
                // any prototype objects.
                //
                // For other [[DontEnum]] properties, check if the value is
                // different than Object prototype value.
                if (
                    (key !== 'constructor' ||
                        (!isProto && hasOwn(obj, key))) &&
                    obj[key] !== Object.prototype[key]
                ) {
                    if (exec(fn, obj, key, thisObj) === false) {
                        break;
                    }
                }
            }
        }
    }

    function exec(fn, obj, key, thisObj){
        return fn.call(thisObj, obj[key], key, obj);
    }

    module.exports = forIn;



},{"./hasOwn":15}],14:[function(_dereq_,module,exports){
var hasOwn = _dereq_('./hasOwn');
var forIn = _dereq_('./forIn');

    /**
     * Similar to Array/forEach but works over object properties and fixes Don't
     * Enum bug on IE.
     * based on: http://whattheheadsaid.com/2010/10/a-safer-object-keys-compatibility-implementation
     */
    function forOwn(obj, fn, thisObj){
        forIn(obj, function(val, key){
            if (hasOwn(obj, key)) {
                return fn.call(thisObj, obj[key], key, obj);
            }
        });
    }

    module.exports = forOwn;



},{"./forIn":13,"./hasOwn":15}],15:[function(_dereq_,module,exports){


    /**
     * Safer Object.hasOwnProperty
     */
     function hasOwn(obj, prop){
         return Object.prototype.hasOwnProperty.call(obj, prop);
     }

     module.exports = hasOwn;



},{}],16:[function(_dereq_,module,exports){
var forOwn = _dereq_('./forOwn');
var makeIterator = _dereq_('../function/makeIterator_');

    /**
     * Creates a new object where all the values are the result of calling
     * `callback`.
     */
    function mapValues(obj, callback, thisObj) {
        callback = makeIterator(callback, thisObj);
        var output = {};
        forOwn(obj, function(val, key, obj) {
            output[key] = callback(val, key, obj);
        });

        return output;
    }
    module.exports = mapValues;


},{"../function/makeIterator_":7,"./forOwn":14}],17:[function(_dereq_,module,exports){
(function (){

	// global on the server, window in the browser
	var root = this,
		previous_re = root.Re;

	Re.noConflict = function(){
		root.Re = previous_re;
		return Re;
	};


	// start actual code
	Re.STRATEGIES = {CONSTANT: 0, EXPONENTIAL: 1, LINEAR: 2};

	var RETRIES_DEFAULT = 10,
		EXP_STRAT_DEFAULT = {"type": Re.STRATEGIES.EXPONENTIAL, "initial":100, "base":2},
		CONST_STRAT_DEFAULT = {"type": Re.STRATEGIES.CONSTANT, "initial":400},
		LINEAR_STRAT_DEFAULT = {"type": Re.STRATEGIES.LINEAR, "initial": 100};

	Re.prototype.retryInterval;

	function Re(options){
		if(!(this instanceof Re)) return new Re(options);

		var strategy;

		if(typeof options === "undefined") options = {};
		if(typeof options.retries === "undefined") options.retries = RETRIES_DEFAULT;
		if(typeof options.strategy === "undefined") options.strategy = EXP_STRAT_DEFAULT;
		if(typeof options.strategy.type === "undefined") throw new TypeError("Invalid retry strategy");

		strategy = options.strategy;

		this.retry = 0;
		this.timeout = options.timeout;
		this.maxRetries = options.retries;

		switch(options.strategy.type){
			case Re.STRATEGIES.CONSTANT:
				if(typeof strategy.initial === "undefined") strategy.initial = CONST_STRAT_DEFAULT.initial;
				this.retryInterval = createConstantRetry(strategy);
				break;
			case Re.STRATEGIES.EXPONENTIAL:
				if(typeof strategy.initial === "undefined") strategy.initial = EXP_STRAT_DEFAULT.initial;
				if(typeof strategy.base === "undefined") strategy.base = EXP_STRAT_DEFAULT.base;
				this.retryInterval = createExponentialRetry(strategy);
				break;
			case Re.STRATEGIES.LINEAR:
				if(typeof strategy.initial === "undefined") strategy.initial = LINEAR_STRAT_DEFAULT.initial;
				this.retryInterval = createLinearRetry(strategy);
				break;
			default:
				throw new TypeError("Invalid retry strategy");
				break;
		}
	};

	Re.prototype.try = function(operation, callback){
		var done = this.createDoneCallback(operation, callback, this.try);

		try{
			operation(this.retry, done);
		} catch(err) {
			done(err);
		}
	};

	Re.prototype.do = function(operation, callback){
		var done = this.createDoneCallback(operation, callback, this.do);

		operation(this.retry, done);
	};

	Re.prototype.createDoneCallback = function(operation, callback, method){
		var self = this;
		return function(err){
			var doneArguments = arguments;

			callback = callback || function () {};

			if(!err) return setTimeout(function(){callback.apply(null, doneArguments);}, 0);

			if(self.retry < self.maxRetries){
				setTimeout(function(){
						method.call(self, operation, callback);
					},
					self.retryInterval(self.retry));
			} else {
				return setTimeout(function(){callback.apply(null, doneArguments);}, 0);
			}

			self.retry++;
		};
	};

	function createExponentialRetry(spec){
		return function(retries){
			var spread = spec.rand ? Math.random() + 1 : 1,
				initial = spec.initial,
				base = spec.base,
				max = spec.max,
				full = spread * initial * Math.pow(base, retries);

			return max ? Math.min(full, max) : full;
		};
	};

	function createLinearRetry(spec){
		return function(retries){
			var spread = spec.rand ? Math.random() + 1 : 1,
				initial = spec.initial,
				max = spec.max,
				full = spread*initial*(retries+1);
				
			return max ? Math.min(full, max) : full;
		};
	};

	function createConstantRetry(spec){
		return function(){
			var spread = spec.rand ? Math.random() + 1 : 1,
				initial = spec.initial;
			return spread*initial;
		};
	};

	// Node.js
	if(typeof module !== 'undefined' && module.exports){
		module.exports = Re;
	}
	// included directly via <script> tag
	else {
		root.Re = Re;
	}

}());
},{}],18:[function(_dereq_,module,exports){
module.exports = (function () {

"use strict";

// Author: Matthew Forrester <matt_at_keyboardwritescode.com>
// Copyright: 2013 Matthew Forrester
// License: MIT/BSD-style

var Error = {};

/**
 Everything was normal.
*/
Error.OK = 0;

/**
 A request was made for data at a location, but that location contains no data.
*/
Error.NO_DATA_FOUND = -1;

/**
 Data wrote from journal into store, but we could not clear the journal record.
*/
Error.COULD_NOT_ADVANCE_QUEUE = 1;

/**
 Data wrote from journal into store, but we could not clear the journal record.
*/
Error.NOTHING_TO_ADVANCE_TO = 21;
Error.TRYING_TO_ADD_NON_DEFAULT_ROOT = 22;
Error.PATH_DOES_NOT_EXISTS = 22;
Error.MULTIPLE_PATHS_FOUND = 23;
/**
 The data is currently locked, please try again.
*/
Error.UNABLE_TO_PROCESS_BECAUSE_LOCKED = 2;

/**
 The data is currently locked for feeding, please try again.
*/
Error.UNABLE_TO_PROCESS_BECAUSE_FEED_LOCKED = 10;
Error.FEED_VERSION_ERROR = 24;

/**
 Trying to apply an update based on a version number higher than the current.
*/
Error.TRYING_TO_ADVANCE_TO_FUTURE_VERSION = 3;

/**
 Trying to apply an update based on a version which is no longer current.
*/
Error.TRYING_TO_APPLY_UPDATE_BASED_ON_OLD_VERSION = 4;

/**
 We are trying to apply an update that has already been.
*/
Error.TRYING_TO_APPLY_UPDATE_ALREADY_APPLIED = -2;

/**
 Trying to change data post delete
 */
Error.DATA_ALREADY_REMOVED = 8;

/**
 Trying to change data post delete
 */
Error.FEEDING_OUT_OF_DATE_BASEDONVERSION = 9;

/**
 Failure writing update.
*/
Error.FAILURE_WRITING_UPDATE = 5;

/**
 * Trying to Feed data into SyncIt, but without a version
 */
Error.FEED_REQUIRES_BASED_ON_VERSION = 6;

/**
 * A request was made to add a Queueitem, but it is based on an outdated version.
 */
Error.TRYING_TO_ADD_QUEUEITEM_BASED_ON_OLD_VERSION = 11;

/**
 * A request was made to add a Queueitem, but we already have it (note this may only happen for the latest!)
 */
Error.TRYING_TO_ADD_ALREADY_ADDED_QUEUEITEM = 12;

/**
 * For some reason, we are trying to add an item based on something that does not yet exist!
 */
Error.TRYING_TO_ADD_FUTURE_QUEUEITEM = 20;

/**
 * It is only possible to use `SyncIt.feed()` for Queueitem coming from elsewhere.
 */
Error.YOU_CANNOT_FEED_YOUR_OWN_CHANGES = 13;

/**
 * If you have local Queueitem that have been put into the Repository and not
 * applied locally, but are feeding Queueitem with a higher version.
 */
Error.BASED_ON_IN_QUEUE_LESS_THAN_BASED_IN_BEING_FED = 18;

/**
 * It might be that SyncIt had an item in the Queue that was applied but could not
 * be cleared. At this point you should call SyncIt.removeStaleFromQueue.
 */
Error.STALE_FOUND_IN_QUEUE = 19;

/**
 * Validation Error
 */
Error.INVALID_DATASET = 14;

/**
 * Validation Error
 */
Error.INVALID_DATAKEY = 15;

/**
 * Validation Error
 */
Error.INVALID_MODIFIER = 16;

/**
 * Validation Error
 */
Error.INVALID_OPERATION = 17;

/**
 * Trying to apply an update, but the queue is empty.
 */
Error.PATH_EMPTY = -3;

/**
 * When resolving conflict, we were told not to continue
 */
Error.NOT_RESOLVED = -4;

/**
 Trying to apply an update based on a version number higher than the current.
*/
Error.MUST_APPLY_SERVER_PATCH_BEFORE_LOCAL = 7;

var Location = {};

Location.IN_QUEUE = 1;

Location.IN_STORE = 2;

var Locking = {};

Locking.ADDING_TO_QUEUE = 1;

Locking.ADVANCING = 2;

Locking.FEEDING = 4;

Locking.CLEANING = 8;

Locking.MAXIMUM_BIT_PATTERN = 15;

var Validation = {};

Validation.DATASET_REGEXP = /^[A-Za-z][A-Za-z0-9\-]+$/;

Validation.DATAKEY_REGEXP = /^[A-Za-z][A-Za-z0-9\-]+$/;

Validation.MODIFIER_REGEXP = /^[A-Za-z][A-Za-z0-9\-]+$/;

Validation.OPERATION_REGEXP = /^(set)|(update)|(remove)$/;

/**
 * These identify different types of information found while navigating a path.
 */
var FollowInformationType = {};
FollowInformationType.INFO = 1;
FollowInformationType.ROOTITEM = 2;
FollowInformationType.PATHITEM = 3;
FollowInformationType.OTHER_PATHS = 4;

return {
	Error: Error,
	Location: Location,
	Locking: Locking,
	Validation: Validation,
	FollowInformationType: FollowInformationType
};

}());

},{}],19:[function(_dereq_,module,exports){
module.exports = (function (when) {

	"use strict";
	
	return function(ctx, func, successErrorCodes /*, params */) {
		var params = Array.prototype.slice.call(arguments).slice(3),
			deferred = when.defer();
		
		params.push(function(err) {
			if (successErrorCodes.indexOf(err) > -1) {
				return deferred.resolve.apply(
					ctx,
					Array.prototype.slice.call(arguments).slice(1)
				);
			}
			return deferred.reject(err);
		});
		func.apply(ctx, params);
		
		return deferred.promise;
	};
	
}(_dereq_('when')));

},{"when":23}],20:[function(_dereq_,module,exports){
module.exports = (function (addEvents) {

"use strict";

// Author: Matthew Forrester <matt_at_keyboardwritescode.com>
// Copyright: Matthew Forrester
// License: MIT/BSD-style


var TransitionState = function(initialState) {
	this._states = {};
	this._state = null;
	this._initialState = initialState;
};

TransitionState.prototype.addState = function(stateName, validNextStates) {
	this._states[stateName] = validNextStates;
};

TransitionState.prototype.current = function() {
	return this._state;
};

TransitionState.prototype.change = function(newState) {
	var oldState = this._state;
	if (!this._states.hasOwnProperty(newState)) {
		throw new Error("TransitionState: Attempting to transition from " +
			"state '" + this._state + "' to state '" + newState +
			"' but state '" + newState + "' does not exist.");
	}
	if (this._states[oldState].indexOf(newState) == -1) {
		throw new Error("TransitionState: Attempting to transition to " +
			"state '" + newState + "' from state '" + this._state +
			"' but that is not a valid transition");
	}
	this._state = newState;
	this._emit('changed-state', oldState, newState);
};

TransitionState.prototype.start = function() {
	var i, l, k, nextStates;
	
	for (k in this._states) {
		if (this._states.hasOwnProperty(k)) {
			nextStates = this._states[k];
			for (i=0, l=nextStates.length; i<l; i++) {
				if (!this._states.hasOwnProperty(nextStates[i])) {
					throw new Error("TransitionState: There is a transition " +
						"from state '" + k + "' to state '" + nextStates[i] +
						"' but state '" + nextStates[i] + "' does not exist.");
				}
			}
		}
	}
	
	this._state = this._initialState;
	this._emit('initial-state', this._initialState);
};

addEvents(TransitionState, ['changed-state', 'initial-state']);

return TransitionState;

}(_dereq_('add-events')));

},{"add-events":3}],21:[function(_dereq_,module,exports){
/** @license MIT License (c) copyright 2011-2013 original author or authors */

/**
 * Licensed under the MIT License at:
 * http://www.opensource.org/licenses/mit-license.php
 *
 * @author Brian Cavalier
 * @author John Hann
 */
(function(define) { 'use strict';
define(function(_dereq_) {
	var when, promise, keys, eachKey, owns;

	when = _dereq_('./when');
	promise = when.promise;

	// Public API

	keys = {
		all: all,
		map: map
	};

	// Safe ownProp
	owns = {}.hasOwnProperty;

	// Use Object.keys if available, otherwise for..in
	eachKey = Object.keys
		? function(object, lambda) {
			Object.keys(object).forEach(function(key) {
				lambda(object[key], key);
			});
		}
		: function(object, lambda) {
			for(var key in object) {
				if(owns.call(object, key)) {
					lambda(object[key], key);
				}
			}
		};

	return keys;

	/**
	 * Resolve all the key-value pairs in the supplied object or promise
	 * for an object.
	 * @param {Promise|object} object or promise for object whose key-value pairs
	 *  will be resolved
	 * @returns {Promise} promise for an object with the fully resolved key-value pairs
	 */
	function all(object) {
		return map(object, identity);
	}

	/**
	 * Map values in the supplied object's keys
	 * @param {Promise|object} object or promise for object whose key-value pairs
	 *  will be reduced
	 * @param {function} mapFunc mapping function mapFunc(value) which may
	 *  return either a promise or a value
	 * @returns {Promise} promise for an object with the mapped and fully
	 *  resolved key-value pairs
	 */
	function map(object, mapFunc) {
		return when(object, function(object) {
			return promise(resolveMap);

			function resolveMap(resolve, reject, notify) {
				var results, toResolve;

				results = {};
				toResolve = 0;

				eachKey(object, function(value, key) {
					++toResolve;
					when(value, mapFunc).then(function(mapped) {
						results[key] = mapped;

						if(!--toResolve) {
							resolve(results);
						}
					}, reject, notify);
				});

				// If there are no keys, resolve immediately
				if(!toResolve) {
					resolve(results);
				}
			}
		});
	}

	function identity(x) { return x; }

});
})(
	typeof define === 'function' && define.amd ? define : function (factory) { module.exports = factory(_dereq_); }
	// Boilerplate for AMD and Node
);

},{"./when":23}],22:[function(_dereq_,module,exports){
/** @license MIT License (c) copyright 2013 original author or authors */

/**
 * node/function.js
 *
 * Collection of helpers for interfacing with node-style asynchronous functions
 * using promises.
 *
 * @author brian@hovercraftstudios.com
 * @contributor renato.riccieri@gmail.com
 */

(function(define) {
define(function(_dereq_) {

	var when, slice, setTimer, cjsRequire, vertxSetTimer;

	when = _dereq_('../when');
	slice = [].slice;
	cjsRequire = _dereq_;

	try {
		vertxSetTimer = cjsRequire('vertx').setTimer;
		setTimer = function (f, ms) { return vertxSetTimer(ms, f); };
	} catch(e) {
		setTimer = setTimeout;
	}

	return {
		apply: apply,
		call: call,
		lift: lift,
		bind: lift, // DEPRECATED alias for lift
		createCallback: createCallback,
		bindCallback: bindCallback,
		liftCallback: liftCallback
	};

	/**
	 * Takes a node-style async function and calls it immediately (with an optional
	 * array of arguments or promises for arguments). It returns a promise whose
	 * resolution depends on whether the async functions calls its callback with the
	 * conventional error argument or not.
	 *
	 * With this it becomes possible to leverage existing APIs while still reaping
	 * the benefits of promises.
	 *
	 * @example
	 *    function onlySmallNumbers(n, callback) {
	 *		if(n < 10) {
	 *			callback(null, n + 10);
	 *		} else {
	 *			callback(new Error("Calculation failed"));
	 *		}
	 *	}
	 *
	 *    var nodefn = require("when/node/function");
	 *
	 *    // Logs '15'
	 *    nodefn.apply(onlySmallNumbers, [5]).then(console.log, console.error);
	 *
	 *    // Logs 'Calculation failed'
	 *    nodefn.apply(onlySmallNumbers, [15]).then(console.log, console.error);
	 *
	 * @param {function} func node-style function that will be called
	 * @param {Array} [args] array of arguments to func
	 * @returns {Promise} promise for the value func passes to its callback
	 */
	function apply(func, args) {
		return _apply(func, this, args);
	}

	/**
	 * Apply helper that allows specifying thisArg
	 * @private
	 */
	function _apply(func, thisArg, args) {
		return when.all(args || []).then(function(resolvedArgs) {
			var d = when.defer();
			var callback = createCallback(d.resolver);

			func.apply(thisArg, resolvedArgs.concat(callback));

			return d.promise;
		});
	}

	/**
	 * Has the same behavior that {@link apply} has, with the difference that the
	 * arguments to the function are provided individually, while {@link apply} accepts
	 * a single array.
	 *
	 * @example
	 *    function sumSmallNumbers(x, y, callback) {
	 *		var result = x + y;
	 *		if(result < 10) {
	 *			callback(null, result);
	 *		} else {
	 *			callback(new Error("Calculation failed"));
	 *		}
	 *	}
	 *
	 *    // Logs '5'
	 *    nodefn.call(sumSmallNumbers, 2, 3).then(console.log, console.error);
	 *
	 *    // Logs 'Calculation failed'
	 *    nodefn.call(sumSmallNumbers, 5, 10).then(console.log, console.error);
	 *
	 * @param {function} func node-style function that will be called
	 * @param {...*} [args] arguments that will be forwarded to the function
	 * @returns {Promise} promise for the value func passes to its callback
	 */
	function call(func /*, args... */) {
		return _apply(func, this, slice.call(arguments, 1));
	}

	/**
	 * Takes a node-style function and returns new function that wraps the
	 * original and, instead of taking a callback, returns a promise. Also, it
	 * knows how to handle promises given as arguments, waiting for their
	 * resolution before executing.
	 *
	 * Upon execution, the orginal function is executed as well. If it passes
	 * a truthy value as the first argument to the callback, it will be
	 * interpreted as an error condition, and the promise will be rejected
	 * with it. Otherwise, the call is considered a resolution, and the promise
	 * is resolved with the callback's second argument.
	 *
	 * @example
	 *    var fs = require("fs"), nodefn = require("when/node/function");
	 *
	 *    var promiseRead = nodefn.lift(fs.readFile);
	 *
	 *    // The promise is resolved with the contents of the file if everything
	 *    // goes ok
	 *    promiseRead('exists.txt').then(console.log, console.error);
	 *
	 *    // And will be rejected if something doesn't work out
	 *    // (e.g. the files does not exist)
	 *    promiseRead('doesnt_exist.txt').then(console.log, console.error);
	 *
	 *
	 * @param {Function} func node-style function to be bound
	 * @param {...*} [args] arguments to be prepended for the new function
	 * @returns {Function} a promise-returning function
	 */
	function lift(func /*, args... */) {
		var args = slice.call(arguments, 1);
		return function() {
			return _apply(func, this, args.concat(slice.call(arguments)));
		};
	}

	/**
	 * Takes an object that responds to the resolver interface, and returns
	 * a function that will resolve or reject it depending on how it is called.
	 *
	 * @example
	 *	function callbackTakingFunction(callback) {
	 *		if(somethingWrongHappened) {
	 *			callback(error);
	 *		} else {
	 *			callback(null, interestingValue);
	 *		}
	 *	}
	 *
	 *	var when = require('when'), nodefn = require('when/node/function');
	 *
	 *	var deferred = when.defer();
	 *	callbackTakingFunction(nodefn.createCallback(deferred.resolver));
	 *
	 *	deferred.promise.then(function(interestingValue) {
	 *		// Use interestingValue
	 *	});
	 *
	 * @param {Resolver} resolver that will be 'attached' to the callback
	 * @returns {Function} a node-style callback function
	 */
	function createCallback(resolver) {
		return function(err, value) {
			if(err) {
				resolver.reject(err);
			} else if(arguments.length > 2) {
				resolver.resolve(slice.call(arguments, 1));
			} else {
				resolver.resolve(value);
			}
		};
	}

	/**
	 * Attaches a node-style callback to a promise, ensuring the callback is
	 * called for either fulfillment or rejection. Returns a promise with the same
	 * state as the passed-in promise.
	 *
	 * @example
	 *	var deferred = when.defer();
	 *
	 *	function callback(err, value) {
	 *		// Handle err or use value
	 *	}
	 *
	 *	bindCallback(deferred.promise, callback);
	 *
	 *	deferred.resolve('interesting value');
	 *
	 * @param {Promise} promise The promise to be attached to.
	 * @param {Function} callback The node-style callback to attach.
	 * @returns {Promise} A promise with the same state as the passed-in promise.
	 */
	function bindCallback(promise, callback) {
		promise = when(promise);

		if (callback) {
			promise.then(success, wrapped);
		}

		return promise;

		function success(value) {
			wrapped(null, value);
		}

		function wrapped(err, value) {
			setTimer(function () {
				callback(err, value);
			}, 0);
		}
	}

	/**
	 * Takes a node-style callback and returns new function that accepts a
	 * promise, calling the original callback when the promise is either
	 * fulfilled or rejected with the appropriate arguments.
	 *
	 * @example
	 *	var deferred = when.defer();
	 *
	 *	function callback(err, value) {
	 *		// Handle err or use value
	 *	}
	 *
	 *	var wrapped = liftCallback(callback);
	 *
	 *	// `wrapped` can now be passed around at will
	 *	wrapped(deferred.promise);
	 *
	 *	deferred.resolve('interesting value');
	 *
	 * @param {Function} callback The node-style callback to wrap.
	 * @returns {Function} The lifted, promise-accepting function.
	 */
	function liftCallback(callback) {
		return function(promise) {
			return bindCallback(promise, callback);
		};
	}
});

})(
	typeof define === 'function' && define.amd ? define : function (factory) { module.exports = factory(_dereq_); }
	// Boilerplate for AMD and Node
);




},{"../when":23}],23:[function(_dereq_,module,exports){
(function (process){
/** @license MIT License (c) copyright 2011-2013 original author or authors */

/**
 * A lightweight CommonJS Promises/A and when() implementation
 * when is part of the cujo.js family of libraries (http://cujojs.com/)
 *
 * Licensed under the MIT License at:
 * http://www.opensource.org/licenses/mit-license.php
 *
 * @author Brian Cavalier
 * @author John Hann
 * @version 2.8.0
 */
(function(define) { 'use strict';
define(function (_dereq_) {

	// Public API

	when.promise   = promise;    // Create a pending promise
	when.resolve   = resolve;    // Create a resolved promise
	when.reject    = reject;     // Create a rejected promise
	when.defer     = defer;      // Create a {promise, resolver} pair

	when.join      = join;       // Join 2 or more promises

	when.all       = all;        // Resolve a list of promises
	when.map       = map;        // Array.map() for promises
	when.reduce    = reduce;     // Array.reduce() for promises
	when.settle    = settle;     // Settle a list of promises

	when.any       = any;        // One-winner race
	when.some      = some;       // Multi-winner race

	when.isPromise = isPromiseLike;  // DEPRECATED: use isPromiseLike
	when.isPromiseLike = isPromiseLike; // Is something promise-like, aka thenable

	/**
	 * Register an observer for a promise or immediate value.
	 *
	 * @param {*} promiseOrValue
	 * @param {function?} [onFulfilled] callback to be called when promiseOrValue is
	 *   successfully fulfilled.  If promiseOrValue is an immediate value, callback
	 *   will be invoked immediately.
	 * @param {function?} [onRejected] callback to be called when promiseOrValue is
	 *   rejected.
	 * @param {function?} [onProgress] callback to be called when progress updates
	 *   are issued for promiseOrValue.
	 * @returns {Promise} a new {@link Promise} that will complete with the return
	 *   value of callback or errback or the completion value of promiseOrValue if
	 *   callback and/or errback is not supplied.
	 */
	function when(promiseOrValue, onFulfilled, onRejected, onProgress) {
		// Get a trusted promise for the input promiseOrValue, and then
		// register promise handlers
		return cast(promiseOrValue).then(onFulfilled, onRejected, onProgress);
	}

	/**
	 * Creates a new promise whose fate is determined by resolver.
	 * @param {function} resolver function(resolve, reject, notify)
	 * @returns {Promise} promise whose fate is determine by resolver
	 */
	function promise(resolver) {
		return new Promise(resolver,
			monitorApi.PromiseStatus && monitorApi.PromiseStatus());
	}

	/**
	 * Trusted Promise constructor.  A Promise created from this constructor is
	 * a trusted when.js promise.  Any other duck-typed promise is considered
	 * untrusted.
	 * @constructor
	 * @returns {Promise} promise whose fate is determine by resolver
	 * @name Promise
	 */
	function Promise(resolver, status) {
		var self, value, consumers = [];

		self = this;
		this._status = status;
		this.inspect = inspect;
		this._when = _when;

		// Call the provider resolver to seal the promise's fate
		try {
			resolver(promiseResolve, promiseReject, promiseNotify);
		} catch(e) {
			promiseReject(e);
		}

		/**
		 * Returns a snapshot of this promise's current status at the instant of call
		 * @returns {{state:String}}
		 */
		function inspect() {
			return value ? value.inspect() : toPendingState();
		}

		/**
		 * Private message delivery. Queues and delivers messages to
		 * the promise's ultimate fulfillment value or rejection reason.
		 * @private
		 */
		function _when(resolve, notify, onFulfilled, onRejected, onProgress) {
			consumers ? consumers.push(deliver) : enqueue(function() { deliver(value); });

			function deliver(p) {
				p._when(resolve, notify, onFulfilled, onRejected, onProgress);
			}
		}

		/**
		 * Transition from pre-resolution state to post-resolution state, notifying
		 * all listeners of the ultimate fulfillment or rejection
		 * @param {*} val resolution value
		 */
		function promiseResolve(val) {
			if(!consumers) {
				return;
			}

			var queue = consumers;
			consumers = undef;

			value = coerce(self, val);
			enqueue(function () {
				if(status) {
					updateStatus(value, status);
				}
				runHandlers(queue, value);
			});
		}

		/**
		 * Reject this promise with the supplied reason, which will be used verbatim.
		 * @param {*} reason reason for the rejection
		 */
		function promiseReject(reason) {
			promiseResolve(new RejectedPromise(reason));
		}

		/**
		 * Issue a progress event, notifying all progress listeners
		 * @param {*} update progress event payload to pass to all listeners
		 */
		function promiseNotify(update) {
			if(consumers) {
				var queue = consumers;
				enqueue(function () {
					runHandlers(queue, new ProgressingPromise(update));
				});
			}
		}
	}

	promisePrototype = Promise.prototype;

	/**
	 * Register handlers for this promise.
	 * @param [onFulfilled] {Function} fulfillment handler
	 * @param [onRejected] {Function} rejection handler
	 * @param [onProgress] {Function} progress handler
	 * @return {Promise} new Promise
	 */
	promisePrototype.then = function(onFulfilled, onRejected, onProgress) {
		var self = this;

		return new Promise(function(resolve, reject, notify) {
			self._when(resolve, notify, onFulfilled, onRejected, onProgress);
		}, this._status && this._status.observed());
	};

	/**
	 * Register a rejection handler.  Shortcut for .then(undefined, onRejected)
	 * @param {function?} onRejected
	 * @return {Promise}
	 */
	promisePrototype['catch'] = promisePrototype.otherwise = function(onRejected) {
		return this.then(undef, onRejected);
	};

	/**
	 * Ensures that onFulfilledOrRejected will be called regardless of whether
	 * this promise is fulfilled or rejected.  onFulfilledOrRejected WILL NOT
	 * receive the promises' value or reason.  Any returned value will be disregarded.
	 * onFulfilledOrRejected may throw or return a rejected promise to signal
	 * an additional error.
	 * @param {function} onFulfilledOrRejected handler to be called regardless of
	 *  fulfillment or rejection
	 * @returns {Promise}
	 */
	promisePrototype['finally'] = promisePrototype.ensure = function(onFulfilledOrRejected) {
		return typeof onFulfilledOrRejected === 'function'
			? this.then(injectHandler, injectHandler)['yield'](this)
			: this;

		function injectHandler() {
			return resolve(onFulfilledOrRejected());
		}
	};

	/**
	 * Terminate a promise chain by handling the ultimate fulfillment value or
	 * rejection reason, and assuming responsibility for all errors.  if an
	 * error propagates out of handleResult or handleFatalError, it will be
	 * rethrown to the host, resulting in a loud stack track on most platforms
	 * and a crash on some.
	 * @param {function?} handleResult
	 * @param {function?} handleError
	 * @returns {undefined}
	 */
	promisePrototype.done = function(handleResult, handleError) {
		this.then(handleResult, handleError)['catch'](crash);
	};

	/**
	 * Shortcut for .then(function() { return value; })
	 * @param  {*} value
	 * @return {Promise} a promise that:
	 *  - is fulfilled if value is not a promise, or
	 *  - if value is a promise, will fulfill with its value, or reject
	 *    with its reason.
	 */
	promisePrototype['yield'] = function(value) {
		return this.then(function() {
			return value;
		});
	};

	/**
	 * Runs a side effect when this promise fulfills, without changing the
	 * fulfillment value.
	 * @param {function} onFulfilledSideEffect
	 * @returns {Promise}
	 */
	promisePrototype.tap = function(onFulfilledSideEffect) {
		return this.then(onFulfilledSideEffect)['yield'](this);
	};

	/**
	 * Assumes that this promise will fulfill with an array, and arranges
	 * for the onFulfilled to be called with the array as its argument list
	 * i.e. onFulfilled.apply(undefined, array).
	 * @param {function} onFulfilled function to receive spread arguments
	 * @return {Promise}
	 */
	promisePrototype.spread = function(onFulfilled) {
		return this.then(function(array) {
			// array may contain promises, so resolve its contents.
			return all(array, function(array) {
				return onFulfilled.apply(undef, array);
			});
		});
	};

	/**
	 * Shortcut for .then(onFulfilledOrRejected, onFulfilledOrRejected)
	 * @deprecated
	 */
	promisePrototype.always = function(onFulfilledOrRejected, onProgress) {
		return this.then(onFulfilledOrRejected, onFulfilledOrRejected, onProgress);
	};

	/**
	 * Casts x to a trusted promise. If x is already a trusted promise, it is
	 * returned, otherwise a new trusted Promise which follows x is returned.
	 * @param {*} x
	 * @returns {Promise}
	 */
	function cast(x) {
		return x instanceof Promise ? x : resolve(x);
	}

	/**
	 * Returns a resolved promise. The returned promise will be
	 *  - fulfilled with promiseOrValue if it is a value, or
	 *  - if promiseOrValue is a promise
	 *    - fulfilled with promiseOrValue's value after it is fulfilled
	 *    - rejected with promiseOrValue's reason after it is rejected
	 * In contract to cast(x), this always creates a new Promise
	 * @param  {*} x
	 * @return {Promise}
	 */
	function resolve(x) {
		return promise(function(resolve) {
			resolve(x);
		});
	}

	/**
	 * Returns a rejected promise for the supplied promiseOrValue.  The returned
	 * promise will be rejected with:
	 * - promiseOrValue, if it is a value, or
	 * - if promiseOrValue is a promise
	 *   - promiseOrValue's value after it is fulfilled
	 *   - promiseOrValue's reason after it is rejected
	 * @deprecated The behavior of when.reject in 3.0 will be to reject
	 * with x VERBATIM
	 * @param {*} x the rejected value of the returned promise
	 * @return {Promise} rejected promise
	 */
	function reject(x) {
		return when(x, function(e) {
			return new RejectedPromise(e);
		});
	}

	/**
	 * Creates a {promise, resolver} pair, either or both of which
	 * may be given out safely to consumers.
	 * The resolver has resolve, reject, and progress.  The promise
	 * has then plus extended promise API.
	 *
	 * @return {{
	 * promise: Promise,
	 * resolve: function:Promise,
	 * reject: function:Promise,
	 * notify: function:Promise
	 * resolver: {
	 *	resolve: function:Promise,
	 *	reject: function:Promise,
	 *	notify: function:Promise
	 * }}}
	 */
	function defer() {
		var deferred, pending, resolved;

		// Optimize object shape
		deferred = {
			promise: undef, resolve: undef, reject: undef, notify: undef,
			resolver: { resolve: undef, reject: undef, notify: undef }
		};

		deferred.promise = pending = promise(makeDeferred);

		return deferred;

		function makeDeferred(resolvePending, rejectPending, notifyPending) {
			deferred.resolve = deferred.resolver.resolve = function(value) {
				if(resolved) {
					return resolve(value);
				}
				resolved = true;
				resolvePending(value);
				return pending;
			};

			deferred.reject  = deferred.resolver.reject  = function(reason) {
				if(resolved) {
					return resolve(new RejectedPromise(reason));
				}
				resolved = true;
				rejectPending(reason);
				return pending;
			};

			deferred.notify  = deferred.resolver.notify  = function(update) {
				notifyPending(update);
				return update;
			};
		}
	}

	/**
	 * Run a queue of functions as quickly as possible, passing
	 * value to each.
	 */
	function runHandlers(queue, value) {
		for (var i = 0; i < queue.length; i++) {
			queue[i](value);
		}
	}

	/**
	 * Coerces x to a trusted Promise
	 * @param {*} x thing to coerce
	 * @returns {*} Guaranteed to return a trusted Promise.  If x
	 *   is trusted, returns x, otherwise, returns a new, trusted, already-resolved
	 *   Promise whose resolution value is:
	 *   * the resolution value of x if it's a foreign promise, or
	 *   * x if it's a value
	 */
	function coerce(self, x) {
		if (x === self) {
			return new RejectedPromise(new TypeError());
		}

		if (x instanceof Promise) {
			return x;
		}

		try {
			var untrustedThen = x === Object(x) && x.then;

			return typeof untrustedThen === 'function'
				? assimilate(untrustedThen, x)
				: new FulfilledPromise(x);
		} catch(e) {
			return new RejectedPromise(e);
		}
	}

	/**
	 * Safely assimilates a foreign thenable by wrapping it in a trusted promise
	 * @param {function} untrustedThen x's then() method
	 * @param {object|function} x thenable
	 * @returns {Promise}
	 */
	function assimilate(untrustedThen, x) {
		return promise(function (resolve, reject) {
			enqueue(function() {
				try {
					fcall(untrustedThen, x, resolve, reject);
				} catch(e) {
					reject(e);
				}
			});
		});
	}

	makePromisePrototype = Object.create ||
		function(o) {
			function PromisePrototype() {}
			PromisePrototype.prototype = o;
			return new PromisePrototype();
		};

	/**
	 * Creates a fulfilled, local promise as a proxy for a value
	 * NOTE: must never be exposed
	 * @private
	 * @param {*} value fulfillment value
	 * @returns {Promise}
	 */
	function FulfilledPromise(value) {
		this.value = value;
	}

	FulfilledPromise.prototype = makePromisePrototype(promisePrototype);

	FulfilledPromise.prototype.inspect = function() {
		return toFulfilledState(this.value);
	};

	FulfilledPromise.prototype._when = function(resolve, _, onFulfilled) {
		try {
			resolve(typeof onFulfilled === 'function' ? onFulfilled(this.value) : this.value);
		} catch(e) {
			resolve(new RejectedPromise(e));
		}
	};

	/**
	 * Creates a rejected, local promise as a proxy for a value
	 * NOTE: must never be exposed
	 * @private
	 * @param {*} reason rejection reason
	 * @returns {Promise}
	 */
	function RejectedPromise(reason) {
		this.value = reason;
	}

	RejectedPromise.prototype = makePromisePrototype(promisePrototype);

	RejectedPromise.prototype.inspect = function() {
		return toRejectedState(this.value);
	};

	RejectedPromise.prototype._when = function(resolve, _, __, onRejected) {
		try {
			resolve(typeof onRejected === 'function' ? onRejected(this.value) : this);
		} catch(e) {
			resolve(new RejectedPromise(e));
		}
	};

	/**
	 * Create a progress promise with the supplied update.
	 * @private
	 * @param {*} value progress update value
	 * @return {Promise} progress promise
	 */
	function ProgressingPromise(value) {
		this.value = value;
	}

	ProgressingPromise.prototype = makePromisePrototype(promisePrototype);

	ProgressingPromise.prototype._when = function(_, notify, f, r, u) {
		try {
			notify(typeof u === 'function' ? u(this.value) : this.value);
		} catch(e) {
			notify(e);
		}
	};

	/**
	 * Update a PromiseStatus monitor object with the outcome
	 * of the supplied value promise.
	 * @param {Promise} value
	 * @param {PromiseStatus} status
	 */
	function updateStatus(value, status) {
		value.then(statusFulfilled, statusRejected);

		function statusFulfilled() { status.fulfilled(); }
		function statusRejected(r) { status.rejected(r); }
	}

	/**
	 * Determines if x is promise-like, i.e. a thenable object
	 * NOTE: Will return true for *any thenable object*, and isn't truly
	 * safe, since it may attempt to access the `then` property of x (i.e.
	 *  clever/malicious getters may do weird things)
	 * @param {*} x anything
	 * @returns {boolean} true if x is promise-like
	 */
	function isPromiseLike(x) {
		return x && typeof x.then === 'function';
	}

	/**
	 * Initiates a competitive race, returning a promise that will resolve when
	 * howMany of the supplied promisesOrValues have resolved, or will reject when
	 * it becomes impossible for howMany to resolve, for example, when
	 * (promisesOrValues.length - howMany) + 1 input promises reject.
	 *
	 * @param {Array} promisesOrValues array of anything, may contain a mix
	 *      of promises and values
	 * @param howMany {number} number of promisesOrValues to resolve
	 * @param {function?} [onFulfilled] DEPRECATED, use returnedPromise.then()
	 * @param {function?} [onRejected] DEPRECATED, use returnedPromise.then()
	 * @param {function?} [onProgress] DEPRECATED, use returnedPromise.then()
	 * @returns {Promise} promise that will resolve to an array of howMany values that
	 *  resolved first, or will reject with an array of
	 *  (promisesOrValues.length - howMany) + 1 rejection reasons.
	 */
	function some(promisesOrValues, howMany, onFulfilled, onRejected, onProgress) {

		return when(promisesOrValues, function(promisesOrValues) {

			return promise(resolveSome).then(onFulfilled, onRejected, onProgress);

			function resolveSome(resolve, reject, notify) {
				var toResolve, toReject, values, reasons, fulfillOne, rejectOne, len, i;

				len = promisesOrValues.length >>> 0;

				toResolve = Math.max(0, Math.min(howMany, len));
				values = [];

				toReject = (len - toResolve) + 1;
				reasons = [];

				// No items in the input, resolve immediately
				if (!toResolve) {
					resolve(values);

				} else {
					rejectOne = function(reason) {
						reasons.push(reason);
						if(!--toReject) {
							fulfillOne = rejectOne = identity;
							reject(reasons);
						}
					};

					fulfillOne = function(val) {
						// This orders the values based on promise resolution order
						values.push(val);
						if (!--toResolve) {
							fulfillOne = rejectOne = identity;
							resolve(values);
						}
					};

					for(i = 0; i < len; ++i) {
						if(i in promisesOrValues) {
							when(promisesOrValues[i], fulfiller, rejecter, notify);
						}
					}
				}

				function rejecter(reason) {
					rejectOne(reason);
				}

				function fulfiller(val) {
					fulfillOne(val);
				}
			}
		});
	}

	/**
	 * Initiates a competitive race, returning a promise that will resolve when
	 * any one of the supplied promisesOrValues has resolved or will reject when
	 * *all* promisesOrValues have rejected.
	 *
	 * @param {Array|Promise} promisesOrValues array of anything, may contain a mix
	 *      of {@link Promise}s and values
	 * @param {function?} [onFulfilled] DEPRECATED, use returnedPromise.then()
	 * @param {function?} [onRejected] DEPRECATED, use returnedPromise.then()
	 * @param {function?} [onProgress] DEPRECATED, use returnedPromise.then()
	 * @returns {Promise} promise that will resolve to the value that resolved first, or
	 * will reject with an array of all rejected inputs.
	 */
	function any(promisesOrValues, onFulfilled, onRejected, onProgress) {

		function unwrapSingleResult(val) {
			return onFulfilled ? onFulfilled(val[0]) : val[0];
		}

		return some(promisesOrValues, 1, unwrapSingleResult, onRejected, onProgress);
	}

	/**
	 * Return a promise that will resolve only once all the supplied promisesOrValues
	 * have resolved. The resolution value of the returned promise will be an array
	 * containing the resolution values of each of the promisesOrValues.
	 * @memberOf when
	 *
	 * @param {Array|Promise} promisesOrValues array of anything, may contain a mix
	 *      of {@link Promise}s and values
	 * @param {function?} [onFulfilled] DEPRECATED, use returnedPromise.then()
	 * @param {function?} [onRejected] DEPRECATED, use returnedPromise.then()
	 * @param {function?} [onProgress] DEPRECATED, use returnedPromise.then()
	 * @returns {Promise}
	 */
	function all(promisesOrValues, onFulfilled, onRejected, onProgress) {
		return _map(promisesOrValues, identity).then(onFulfilled, onRejected, onProgress);
	}

	/**
	 * Joins multiple promises into a single returned promise.
	 * @return {Promise} a promise that will fulfill when *all* the input promises
	 * have fulfilled, or will reject when *any one* of the input promises rejects.
	 */
	function join(/* ...promises */) {
		return _map(arguments, identity);
	}

	/**
	 * Settles all input promises such that they are guaranteed not to
	 * be pending once the returned promise fulfills. The returned promise
	 * will always fulfill, except in the case where `array` is a promise
	 * that rejects.
	 * @param {Array|Promise} array or promise for array of promises to settle
	 * @returns {Promise} promise that always fulfills with an array of
	 *  outcome snapshots for each input promise.
	 */
	function settle(array) {
		return _map(array, toFulfilledState, toRejectedState);
	}

	/**
	 * Promise-aware array map function, similar to `Array.prototype.map()`,
	 * but input array may contain promises or values.
	 * @param {Array|Promise} array array of anything, may contain promises and values
	 * @param {function} mapFunc map function which may return a promise or value
	 * @returns {Promise} promise that will fulfill with an array of mapped values
	 *  or reject if any input promise rejects.
	 */
	function map(array, mapFunc) {
		return _map(array, mapFunc);
	}

	/**
	 * Internal map that allows a fallback to handle rejections
	 * @param {Array|Promise} array array of anything, may contain promises and values
	 * @param {function} mapFunc map function which may return a promise or value
	 * @param {function?} fallback function to handle rejected promises
	 * @returns {Promise} promise that will fulfill with an array of mapped values
	 *  or reject if any input promise rejects.
	 */
	function _map(array, mapFunc, fallback) {
		return when(array, function(array) {

			return new Promise(resolveMap);

			function resolveMap(resolve, reject, notify) {
				var results, len, toResolve, i;

				// Since we know the resulting length, we can preallocate the results
				// array to avoid array expansions.
				toResolve = len = array.length >>> 0;
				results = [];

				if(!toResolve) {
					resolve(results);
					return;
				}

				// Since mapFunc may be async, get all invocations of it into flight
				for(i = 0; i < len; i++) {
					if(i in array) {
						resolveOne(array[i], i);
					} else {
						--toResolve;
					}
				}

				function resolveOne(item, i) {
					when(item, mapFunc, fallback).then(function(mapped) {
						results[i] = mapped;

						if(!--toResolve) {
							resolve(results);
						}
					}, reject, notify);
				}
			}
		});
	}

	/**
	 * Traditional reduce function, similar to `Array.prototype.reduce()`, but
	 * input may contain promises and/or values, and reduceFunc
	 * may return either a value or a promise, *and* initialValue may
	 * be a promise for the starting value.
	 *
	 * @param {Array|Promise} promise array or promise for an array of anything,
	 *      may contain a mix of promises and values.
	 * @param {function} reduceFunc reduce function reduce(currentValue, nextValue, index, total),
	 *      where total is the total number of items being reduced, and will be the same
	 *      in each call to reduceFunc.
	 * @returns {Promise} that will resolve to the final reduced value
	 */
	function reduce(promise, reduceFunc /*, initialValue */) {
		var args = fcall(slice, arguments, 1);

		return when(promise, function(array) {
			var total;

			total = array.length;

			// Wrap the supplied reduceFunc with one that handles promises and then
			// delegates to the supplied.
			args[0] = function (current, val, i) {
				return when(current, function (c) {
					return when(val, function (value) {
						return reduceFunc(c, value, i, total);
					});
				});
			};

			return reduceArray.apply(array, args);
		});
	}

	// Snapshot states

	/**
	 * Creates a fulfilled state snapshot
	 * @private
	 * @param {*} x any value
	 * @returns {{state:'fulfilled',value:*}}
	 */
	function toFulfilledState(x) {
		return { state: 'fulfilled', value: x };
	}

	/**
	 * Creates a rejected state snapshot
	 * @private
	 * @param {*} x any reason
	 * @returns {{state:'rejected',reason:*}}
	 */
	function toRejectedState(x) {
		return { state: 'rejected', reason: x };
	}

	/**
	 * Creates a pending state snapshot
	 * @private
	 * @returns {{state:'pending'}}
	 */
	function toPendingState() {
		return { state: 'pending' };
	}

	//
	// Internals, utilities, etc.
	//

	var promisePrototype, makePromisePrototype, reduceArray, slice, fcall, nextTick, handlerQueue,
		funcProto, call, arrayProto, monitorApi,
		capturedSetTimeout, cjsRequire, MutationObs, undef;

	cjsRequire = _dereq_;

	//
	// Shared handler queue processing
	//
	// Credit to Twisol (https://github.com/Twisol) for suggesting
	// this type of extensible queue + trampoline approach for
	// next-tick conflation.

	handlerQueue = [];

	/**
	 * Enqueue a task. If the queue is not currently scheduled to be
	 * drained, schedule it.
	 * @param {function} task
	 */
	function enqueue(task) {
		if(handlerQueue.push(task) === 1) {
			nextTick(drainQueue);
		}
	}

	/**
	 * Drain the handler queue entirely, being careful to allow the
	 * queue to be extended while it is being processed, and to continue
	 * processing until it is truly empty.
	 */
	function drainQueue() {
		runHandlers(handlerQueue);
		handlerQueue = [];
	}

	// Allow attaching the monitor to when() if env has no console
	monitorApi = typeof console !== 'undefined' ? console : when;

	// Sniff "best" async scheduling option
	// Prefer process.nextTick or MutationObserver, then check for
	// vertx and finally fall back to setTimeout
	/*global process,document,setTimeout,MutationObserver,WebKitMutationObserver*/
	if (typeof process === 'object' && process.nextTick) {
		nextTick = process.nextTick;
	} else if(MutationObs =
		(typeof MutationObserver === 'function' && MutationObserver) ||
			(typeof WebKitMutationObserver === 'function' && WebKitMutationObserver)) {
		nextTick = (function(document, MutationObserver, drainQueue) {
			var el = document.createElement('div');
			new MutationObserver(drainQueue).observe(el, { attributes: true });

			return function() {
				el.setAttribute('x', 'x');
			};
		}(document, MutationObs, drainQueue));
	} else {
		try {
			// vert.x 1.x || 2.x
			nextTick = cjsRequire('vertx').runOnLoop || cjsRequire('vertx').runOnContext;
		} catch(ignore) {
			// capture setTimeout to avoid being caught by fake timers
			// used in time based tests
			capturedSetTimeout = setTimeout;
			nextTick = function(t) { capturedSetTimeout(t, 0); };
		}
	}

	//
	// Capture/polyfill function and array utils
	//

	// Safe function calls
	funcProto = Function.prototype;
	call = funcProto.call;
	fcall = funcProto.bind
		? call.bind(call)
		: function(f, context) {
			return f.apply(context, slice.call(arguments, 2));
		};

	// Safe array ops
	arrayProto = [];
	slice = arrayProto.slice;

	// ES5 reduce implementation if native not available
	// See: http://es5.github.com/#x15.4.4.21 as there are many
	// specifics and edge cases.  ES5 dictates that reduce.length === 1
	// This implementation deviates from ES5 spec in the following ways:
	// 1. It does not check if reduceFunc is a Callable
	reduceArray = arrayProto.reduce ||
		function(reduceFunc /*, initialValue */) {
			/*jshint maxcomplexity: 7*/
			var arr, args, reduced, len, i;

			i = 0;
			arr = Object(this);
			len = arr.length >>> 0;
			args = arguments;

			// If no initialValue, use first item of array (we know length !== 0 here)
			// and adjust i to start at second item
			if(args.length <= 1) {
				// Skip to the first real element in the array
				for(;;) {
					if(i in arr) {
						reduced = arr[i++];
						break;
					}

					// If we reached the end of the array without finding any real
					// elements, it's a TypeError
					if(++i >= len) {
						throw new TypeError();
					}
				}
			} else {
				// If initialValue provided, use it
				reduced = args[1];
			}

			// Do the actual reduce
			for(;i < len; ++i) {
				if(i in arr) {
					reduced = reduceFunc(reduced, arr[i], i, arr);
				}
			}

			return reduced;
		};

	function identity(x) {
		return x;
	}

	function crash(fatalError) {
		if(typeof monitorApi.reportUnhandled === 'function') {
			monitorApi.reportUnhandled();
		} else {
			enqueue(function() {
				throw fatalError;
			});
		}

		throw fatalError;
	}

	return when;
});
})(typeof define === 'function' && define.amd ? define : function (factory) { module.exports = factory(_dereq_); });

}).call(this,_dereq_("FWaASH"))
},{"FWaASH":4}]},{},[2])
(2)
});
