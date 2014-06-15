# SyncItControl

Manages SyncIt and EventSourceMonitor to hopefully produce a simple API which can help you create full SyncIt based projects, easily.

## What SyncIt does do

[SyncIt](https://github.com/forbesmyester/SyncIt) provides a way to track changes to local data and feed in data from a server, which is an essential component for building HTML5 applications that can work offline, but synchronize their data online when there is an internet connection.

## What SyncIt does not do

What SyncIt does not provide is a way to detect when an internet connection becomes available, monitoring specific datasets on the server for changes or uploading / downloading the changes to / from the server.

## What SyncItControl can do to help

It does this using the following methods:

 * Establishing a connection to the server using Server Sent Events (EventSource).
 * Downloading any changes which are on the server and feeding them into SyncIt.
 * Uploads any local changes to the server.
 * Continues to monitor for both local and remote changes so that can be applied / uploaded immediately.
 * Goes into a "DISCONNECTED" state when the EventSource errors, client code can pick this up and call `connect()` when a network connection is detected (or after a set amount of time).

## How does it fit into the SyncIt eco system

On the client you have Both SyncIt and SyncItControl. Your App will perform `get()` and `set()` operations on SyncIt and SyncItControl will manage uploading and downloading changes to / from the server and conflict resolution with the callback that you provide.

![The SyncIt eco system: Where does SyncItControl sit](bin/README/img/eco-system.png)

## How does SyncItControl Work?

SyncItControl uses EventSource to monitor an internet connection for changes from other users/devices but during this process it will also download all changes which it may have missed while being offline. It will also hook into some SyncIt events so it can detect when it needs to upload new data which it will do with a HTTP POST.

It will do all this by using a State Machine type of system which is constructed like the following:

![Current State Diagram](./bin/README/img/process.png)

Current State Diagram... Note that any state shown can go to Error state.

Analyze will end up going to either one of three states:

 1. All Dataset - If all datasets are known.
 2. Missing Dataset - If we know that we are completely lacking any of the datasets which was passed into the constructor.
 3. Adding Dataset - If all previous datasets were known but we have added one which is unknown.

If it enteres missing "Missing Dataset" SyncItControl will fire the "available" event until after it has had an initial data load for that dataset.

## How do you use SyncItControl?

There are lots of components that are required to use SyncItControl... I could hide some of this complexity, and I still might but for testing purposes it is better that the be exposed. For normal usage I suggest that you refer to the [SyncItBootstrap](https://github.com/forbesmyester/SyncItBootstrap) project.

```javascript
// A timestamp for tLIdEncodeDecoder, must be static within code as it is used
// to generate Id's which need to be sequential.
var tLIdEncoderDecoderTimestamp = new Date(2014, 1, 1, 1, 1, 1, 1).getTime(),

// Create the instance of tLIdEncoderDecoder https://github.com/forbesmyester/getTLIdEncoderDecoder
var tLIdEncoderDecoder = getTLIdEncoderDecoder(tLIdEncoderDecoderTimestamp, 2),

// SyncLocalStorage is a wrapper around LocalStorage which is also namespaced
// and can store structured data, is is part of the SyncIt package stored at
// see https://github.com/forbesmyester/SyncIt.
var asyncLocalStorage = new AsyncLocalStorage(
	window.localStorage,
	'sic-state',
	JSON.stringify,
	JSON.parse
);

// When SyncItControl needs to upload data because SyncIt has told it that there
// is some this function will be called with one Queueitem (see SyncIt) and a
// callback function. That callback function should be called with two
// parameters which are whether an error has occurred and the sequenceId which
// the data was added as.
var uploadChangeFunc = function(queueitem, next) {
	next(null, "537f81cea749525c12eb986a");
};

// We need an EventSourceMonitor so SyncItControl can monitor the connection
// and be notified of new data.
var eventSourceMonitor = new EventSourceMonitor(
	function(urlEncodedDatasets) {
		return new window.EventSource('/sync/' + deviceId + '?' + urlEncodedDatasets);
	}
);

// Lastly before creating an instance of SyncItControl we need to supply a
// function that will take care of resolving conflicts when they occur. This
// is required because SyncItControl will be the one calling SyncIt.feed()
// when new data is supplied via downloadDatasetFunc() or from the
// EventSourceMonitor. This is a perfectly acceptable implementation which
// just takes the latest timestamp (as supplied by the client), but depending
// on your app it might make sense to write your own. See the documentation
// for SyncIt.feed() for more information.
var conflictResolutionFunction = function(
	dataset,
	datakey,
	storedrecord,
	localChanges,
	remoteChanges,
	resolved
) {
	var lastRemoteTs = null,
		lastLocalTs = null;

	remoteChanges.map(function(c) { lastRemoteTs = c.t; });
	localChanges.map(function(c) { lastLocalTs = c.t; });

	if (lastLocalTs > lastRemoteTs) {
		return resolved(true, localChanges);
	}

	return resolved(true,[]);
};

var syncItControl = new SyncItControl(
	syncIt, // An instance of SyncIt (see https://github.com/forbesmyester/SyncIt)
	eventSourceMonitor,
	asyncLocalStorage,
	uploadChangeFunc,
	conflictResolutionFunction
);
```

Phew! After all that we should see how we use it SyncItControl with SyncIt. Firstly you would continue to use SyncIt exactly as before, except that you would probably never have a need to call SyncIt.feed() again.

```javascript
syncIt.set('cars', 'Subaru', { "Seats": "Leather" }, function(err,result) {
	if (err) {
		// Something went wront... throw?
	}
	alert("The data stored in cars.subaru has been updated"
});
syncIt.get('cars', 'Subaru', function(err,result) {
		if (err) {
			// Something went wront... throw?
		}
		console.log(
			'The data stored in cars.subaru is: ' +
			JSON.stringify(result)
		);
	}
);
```

It maybe that due to user interaction or new information from elsewhere that you want to also use SyncIt / SyncItControl with extra datasets... This is as easy as calling SyncItControl.addMonitoredDataset(). The first parameter is the name of the dataset to add and the second is a callback when it is ready for use.

```javascript
syncItControl.addDatasets(['boats'], function() {
	console.log("The 'boats' dataset is now ready for use");
});
```

The only other thing you may well need to do is watch for when the state of SyncIt entered "disconnected", in which case you will probably want to try and reconnect, at least if the browser reports that there is a data connection. In this situation I am taking the easy way out and attempting to reconnect 10 seconds later!

```javascript
syncItControl.on('entered-state', function(state) {
	if (state === 'DISCONNECTED') {
		setTimeout(function() {
			syncItControl.connect();
		}, 10000);
	}
});
```

## Source Code

Source code is prepared using [Browserify](http://browserify.org/) which is also compatible with Node.JS. There is a UMD bundle which can be used with AMD or a vanilla browser (where it will export a global called called SyncItControl.
