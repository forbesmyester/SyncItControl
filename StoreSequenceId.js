module.exports = (function (arrayFilter) {

"use strict";

// Author: Matthew Forrester <matt_at_keyboardwritescode.com>
// Copyright: Matthew Forrester
// License: MIT/BSD-style

var Cls = function(stateConfig, compareFunc) {
	this._stateConfig = stateConfig;
	this._compareFunc = compareFunc;
	this._changes = {};
};

Cls.prototype.getItem = function(dataset) {
	return this._stateConfig.getItem(dataset);
};

Cls.prototype.findKeys = function(q) {
	return this._stateConfig.findKeys(q);
};

Cls.prototype._flushDataset = function(dataset) {
	this._changes[dataset].push(this._stateConfig.getItem(dataset));

	this._changes[dataset] = arrayFilter(this._changes[dataset], function(element) {
		return element !== null;
	});

	if (this._changes[dataset].length === 0) {
		return this._stateConfig.setItem(dataset, null);
	}

	this._stateConfig.setItem(dataset, this._changes[dataset].sort(this._compareFunc).pop());

	this._changes[dataset] = [];
};

Cls.prototype.flush = function() {
	var k;
	for (k in this._changes) {
		if (this._changes.hasOwnProperty(k)) {
			this._flushDataset(k);
		}
	}
};

Cls.prototype.setItem = function(sureAmSynced, dataset, fromSequenceId) {

	var current;

	if (!this._changes.hasOwnProperty(dataset)) {
		this._changes[dataset] = [];
	}

	this._changes[dataset].push(fromSequenceId);

	if (!sureAmSynced) {
		return;
	}

	this.flush();

};

return Cls;

}(require('mout/array/filter')));

