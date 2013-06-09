#!/usr/bin/env node
var express = require('express'),
	http = require('http'),
	app, server, io, db,

	Session,

	async = require('async'),
	path = require('path'),
	fs = require('fs'),
	os = require('os'),
	cookie = require('express/node_modules/cookie'),
	Utils = require('./commons/Utils.js'),
	log4js = require('log4js'),
	argv = require('optimist').argv,

	mkdirp = require('mkdirp'),
	mongoose = require('mongoose'),
	ms = require('ms'), // Tiny milisecond conversion utility
	errS = require('./controllers/errors.js').err;

/**
 * log the cheese logger messages to a file, and the console ones as well.
 */
console.log('\n');
mkdirp.sync('./logs');
log4js.configure('./log4js.json', {cwd: './logs'});
var logger = log4js.getLogger("app.js");

/**
 * Включаем "наши" модули
 */
require('./commons/JExtensions.js');

var interfaces = os.networkInterfaces();
var addresses = [];
for (var k in interfaces) {
	if (interfaces.hasOwnProperty(k)) {
		for (var k2 in interfaces[k]) {
			if (interfaces[k].hasOwnProperty(k2)) {
				var address = interfaces[k][k2];
				if (address.family === 'IPv4' && !address.internal) {
					addresses.push(address.address);
				}
			}
		}
	}
}


global.appVar = {}; //Глоблальный объект для хранения глобальных переменных приложения

var pkg = JSON.parse(fs.readFileSync(__dirname + '/package.json', 'utf8')),
	conf = JSON.parse(fs.readFileSync(argv.conf || __dirname + '/config.json', 'utf8')),

	land = argv.land || conf.land || 'dev', //Окружение (dev, test, prod)
	domain = argv.domain || conf.domain || addresses[0] || '127.0.0.1', //Адрес сервера для клинетов
	port = argv.port || conf.port || 3000, //Порт сервера
	uport = argv.uport || conf.uport || 8888, //Порт сервера загрузки фотографий
	host = domain + (port === 80 ? '' : ':' + port),//Имя хоста (адрес+порт)
	moongoUri = argv.mongo || conf.mongo,
	smtp = conf.smtp,

	storePath = path.normalize(argv.storePath || conf.storePath || (__dirname + "/../store/")), //Путь к папке хранилища
	noServePublic = argv.noServePublic || conf.noServePublic || false, //Флаг, что node не должен раздавать статику скриптов
	noServeStore = argv.noServeStore || conf.noServeStore || false; //Флаг, что node не должен раздавать статику хранилища

logger.info('Starting Node[' + process.versions.node + '] with v8[' + process.versions.v8 + '] and Express[' + express.version + '] on process pid:' + process.pid);
logger.info('Platform: ' + process.platform + ', architecture: ' + process.arch + ', cpu cores: ' + os.cpus().length);

mkdirp.sync(storePath + "incoming");
mkdirp.sync(storePath + "private");
mkdirp.sync(storePath + "public");

async.waterfall([
	function connectMongo(cb) {
		db = mongoose.createConnection() // http://mongoosejs.com/docs/api.html#connection_Connection
			.once('open', openHandler)
			.once('error', errFirstHandler);
		db.open(moongoUri, {server: { auto_reconnect: true }, db: {safe: true}});

		function openHandler() {
			var admin = new mongoose.mongo.Admin(db.db);
			admin.buildInfo(function (err, info) {
				logger.info('Mongoose[' + mongoose.version + '] connected to MongoDB[' + info.version + ', x' + info.bits + '] at: ' + moongoUri);
				cb(null);
			});
			db.removeListener('error', errFirstHandler);
			db.on('error', function (err) {
				logger.error("Connection error to MongoDB at: " + moongoUri);
				logger.error(err && (err.message || err));
			});
			db.on('reconnected', function () {
				logger.info("Reconnected to MongoDB at: " + moongoUri);
			});
		}
		function errFirstHandler(err) {
			logger.error("Connection error to MongoDB at: " + moongoUri);
			cb(err);
		}

//		var mc = require('mc'), // memcashed
//          memcached = new mc.Client();
//		memcached.connect(function () {
//			logger.info("Connected to the localhost memcache on port 11211");
//		});
	},

	function loadingModels(callback) {
		require(__dirname + '/models/Sessions.js').makeModel(db);
		require(__dirname + '/models/Counter.js').makeModel(db);
		require(__dirname + '/models/Settings.js').makeModel(db);
		require(__dirname + '/models/Role.js').makeModel(db);
		require(__dirname + '/models/User.js').makeModel(db);
		require(__dirname + '/models/Photo.js').makeModel(db);
		require(__dirname + '/models/Comment.js').makeModel(db);
		require(__dirname + '/models/Cluster.js').makeModel(db);
		require(__dirname + '/models/News.js').makeModel(db);
		require(__dirname + '/models/_initValues.js').makeModel(db);
		Session = db.model('Session');
		callback(null);
	},

	function appConfigure(callback) {
		var pub = '/public/';

		app = express();
		app.version = pkg.version;
		app.hash = (land === 'dev' ? app.version : Utils.randomString(10));
		logger.info('Application Hash: ' + app.hash);

		function static404(req, res) {
			res.send(404);
		}

		app.configure(function () {
			global.appVar.storePath = storePath;
			global.appVar.smtp = smtp;
			app.set('appEnv', {land: land, hash: app.hash, version: app.version, storePath: storePath, serverAddr: {domain: domain, host: host, port: port, uport: uport}});

			app.set('views', __dirname + '/views');
			app.set('view engine', 'jade');
			if (land === 'dev') {
				app.disable('view cache');
			} else {
				app.enable('view cache');
			}

			app.locals({
				pretty: false,
				appLand: land, //Решает какие скрипты вставлять в head
				appHash: app.hash //Вставляется в head страниц
			});

			//app.use(express.logger({ immediate: false, format: 'dev' }));
			app.disable('x-powered-by'); // Disable default X-Powered-By
			app.use(express.compress());
			app.use(express.favicon(__dirname + pub + 'favicon.ico', { maxAge: ms('1d') }));
			if (land === 'dev') {
				app.use('/style', require('less-middleware')({src: __dirname + pub + 'style', force: true, once: false, compress: false, debug: false}));
				//prod: app.use('/style', require('less-middleware')({src: __dirname + pub + '/style', force: false, once: true, compress: true, yuicompress: true, optimization: 2, debug: false}));
			}
			if (!noServePublic) {
				app.use(express.static(__dirname + pub, {maxAge: ms('2d')}));
			}
			if (!noServeStore) {
				app.use('/_avatar', express.static(__dirname + 'public/avatars', {maxAge: ms('2d')}));
				app.use('/_p', express.static(storePath + 'public/photos', {maxAge: ms('7d')}));
				app.get('/_avatar/*', static404);
				app.get('/_p/*', static404);
			}

			app.use(express.bodyParser());
			app.use(express.cookieParser());
			app.use(express.session({ cookie: {maxAge: ms('12h')}, secret: 'PastvuSess', key: 'pastvu.exp' })); //app.use(express.session({ cookie: {maxAge: ms('12h')}, store: mongo_store, secret: 'PastVuSess', key: 'pastvu.exp' }));
			app.use(express.methodOverride());

			app.use(app.router);
		});
		callback(null);
	},

	function (callback) {
		server = http.createServer(app);
		io = require('socket.io').listen(server);

		callback(null);
	},
	function ioConfigure(callback) {
		io.set('transports', ['websocket', 'xhr-polling', 'jsonp-polling', 'htmlfile']);
		io.set('authorization', function (handshakeData, callback) {
			var handshakeCookieString = handshakeData.headers.cookie || '';

			handshakeData.cookie = cookie.parse(handshakeCookieString);
			handshakeData.sessionID = handshakeData.cookie['pastvu.sid'] || 'sidcap';

			Session.findOne({key: handshakeData.sessionID}).populate('user').exec(function (err, session) {
				if (err) {
					return callback('Error: ' + err, false);
				}
				if (!session) {
					session = new Session({});
				}
				session.key = Utils.randomString(12); // При каждом заходе регенирируем ключ
				session.stamp = new Date(); // При каждом заходе продлеваем действие ключа
				session.save();
				if (session.user) {
					console.info("%s entered", session.user.login);
				}

				handshakeData.session = session;

				return callback(null, true);
			});
		});

		if (land === 'dev') {
			io.set('log level', 1);
		} else {
			io.set('browser client', false);
			io.enable('browser client minification');  // send minified client
			io.enable('browser client etag');          // apply etag caching logic based on version number
			io.enable('browser client gzip');          // gzip the file
			io.set('log level', 1);                    // reduce logging
		}
		callback(null);
	},
	function loadingControllers(callback) {
		require('./controllers/_session.js').loadController(app, db, io);
		require('./controllers/mail.js').loadController(app);
		require('./controllers/auth.js').loadController(app, db, io);
		require('./controllers/index.js').loadController(app, db, io);
		require('./controllers/photo.js').loadController(app, db, io);
		require('./controllers/comment.js').loadController(app, db, io);
		require('./controllers/profile.js').loadController(app, db, io);
		require('./controllers/admin.js').loadController(app, db, io);
		if (land !== 'prod') {
			require('./controllers/tpl.js').loadController(app);
		}
		require('./controllers/registerRoutes.js').loadController(app);
		require('./controllers/systemjs.js').loadController(app, db);
		require('./controllers/errors.js').registerErrorHandling(app);

		callback(null);
	}
],
	function finish(err) {
		if (err) {
			logger.fatal(err && (err.message || err));
			setTimeout(function () {
				process.exit(1); // Запускаем в setTimeout, т.к. в некоторых консолях в противном случае не выводятся предыдущие console.log
			}, 100);
		} else {
			/**
			 * Set zero for unlimited listeners
			 * http://nodejs.org/docs/latest/api/events.html#events_emitter_setmaxlisteners_n
			 */
			server.setMaxListeners(0);
			io.setMaxListeners(0);
			process.setMaxListeners(0);
			/**
			 * Handling uncaught exceptions
			 */
			process.on('uncaughtException', function (err) {
				// Add here storage for saving and resuming
				logger.fatal("PROCESS uncaughtException: " + (err && (err.message || err)));
				logger.trace(err && (err.stack || err));
			});

			server.listen(port);
			logger.info('Express server listening %s in %s-mode \n', host, land.toUpperCase());
		}
	}
);