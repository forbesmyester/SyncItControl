(function (root, factory) { // UMD from https://github.com/umdjs/umd/blob/master/returnExports.js
	"use strict";
	if (typeof exports === 'object') {
		module.exports = factory(require('add-events'));
	} else if (typeof define === 'function' && define.amd) {
		define(['add-events'],factory);
	} else {
		throw "Not currently tested!";
	}
}(this, function (addEvents) {

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

}));
