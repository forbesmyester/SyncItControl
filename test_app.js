var express = require('express');
var path = require('path');
var logger = require('morgan');
browserify = require('browserify-middleware');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(logger('dev'));


var browserifyFiles = [
	'/emitting-queue.js',
	'/index.js',
	'/StoreSequenceId.js',
	'/test_app.js',
	'/node_modules/sync-it/addLocking.js',
	'/node_modules/sync-it/AsyncLocalStorage.js',
	'/node_modules/sync-it/browser-lib.js',
	'/node_modules/sync-it/browser-lib.umd.js',
	'/node_modules/sync-it/Constant.js',
	'/node_modules/sync-it/dontListLocallyDeletedDatakeys.js',
	'/node_modules/sync-it/FakeLocalStorage.js',
	'/node_modules/sync-it/makeAsync.js',
	'/node_modules/sync-it/SyncItBuffer.js',
	'/node_modules/sync-it/syncItCallbackToPromise.js',
	'/node_modules/sync-it/SyncIt.js',
	'/node_modules/sync-it/SyncLocalStorage.js',
	'/node_modules/sync-it/test_app.js',
	'/node_modules/sync-it/updateResult.js',
	'/node_modules/sync-it/Path/AsyncLocalStorage.js',
	'/node_modules/get_tlid_encoder_decoder/index.js',
	'/node_modules/eventsource-monitor/index.js'
];

for (var i=0; i<browserifyFiles.length; i++) {
	app.get(
		browserifyFiles[i],
		browserify(
			'.' + browserifyFiles[i],
			{
				standalone: browserifyFiles[i].substr(1).replace(/\..*/,'').replace(/\//,'_')
			}
		)
	);
}

app.use(express.static(path.join(__dirname, '.')));

/// catch 404 and forward to error handler
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

/// error handlers

// development error handler
// will print stacktrace
app.use(function(err, req, res, next) {
	res.status(err.status || 500);
	res.render('error', {
		message: err.message,
		error: err
	});
});

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: {}
    });
});


app.listen(3000);
