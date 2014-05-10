(function (root, factory) { // UMD from https://github.com/umdjs/umd/blob/master/returnExports.js
	"use strict";
	if (typeof exports === 'object') {
		module.exports = factory(require('mout/array/filter'));
	} else if (typeof define === 'function' && define.amd) {
		define(['mout/array/filter'],factory);
	} else {
		throw "Not currently tested!";
	}
}(this, function (arrayFilter) {

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

Cls.prototype.setItem = function(sureAmSynced, dataset, fromSequenceId) {

	var current;

	if (!this._changes.hasOwnProperty(dataset)) {
		this._changes[dataset] = [];
	}

	if (!sureAmSynced) {
		return this._changes[dataset].push(fromSequenceId);
	}

	current = this._stateConfig.getItem(dataset);

	if ((current === null) && (fromSequenceId === null)) {
		this._stateConfig.setItem(dataset, null);
	}

	this._changes[dataset].push(fromSequenceId);
	this._changes[dataset].push(this._stateConfig.getItem(dataset));

	this._changes[dataset] = arrayFilter(this._changes[dataset], function(element) {
		return element !== null;
	});
	
	if (this._changes[dataset].length === 0) { return; }

	this._changes[dataset] = this._changes[dataset].sort(this._compareFunc);
	if (
		(current === null) || 
		(this._compareFunc(current, this._changes[dataset].slice(-1)[0]) < 0)
	) {
		this._stateConfig.setItem(dataset, this._changes[dataset].slice(-1)[0]);
	}

	this._changes[dataset] = [];

};

return Cls;

}));

