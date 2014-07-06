define(['module'], function (module) {
	'use strict';

	return {
		load: function (name, req, onLoad, config) {
			if (config.isBuild) {
				onLoad(null); //avoid errors on the optimizer
				return;
			}

			req(['underscore', 'socket.io', 'Utils', 'Params', 'knockout', 'knockout.mapping'], function (_, io, Utils, P, ko, ko_mapping) {
				var loaded,
					socket = io(location.host, {
						reconnectionDelay: 800,  //Изначальный интервал (в мс) между попытками реконнекта браузера, каждый следующий растет экспоненциально
						reconnectionDelayMax: 10000, //Максимальный интервал (в мс) между попытками реконнекта браузера, до него дорастет предыдущий параметр
						reconnectionAttempts: 100 ////Максимальное колво попыток реконнекта браузера, после которого будет вызванно событие reconnect_failed
					});

				socket.on('error', function (reason) {
					console.log('Unable to connect socket: ', reason);
				});
				socket.on('connect', function () {
					if (!loaded) {
						console.log('Connected to server');
						loaded = true;
						onLoad(socket);
					}
				});

				socket.on('disconnect', function () {
					console.log('Disconnected from server ');
				});
				socket.on('reconnecting', function (attempt) {
					console.log('Trying to reconnect to server %d time', attempt);
				});
				socket.on('reconnect_failed', function (attempt) {
					console.log('Failed to reconnect for %d attempts. Stopped trying', socket.io.reconnectionAttempts());
				});
				socket.on('reconnect', function () {
					console.log('ReConnected to server');
					//После реконнекта заново запрашиваем initData
					socket.emit('giveInitData', location.pathname);
				});

				socket.on('updateCookie', updateCookie);
				socket.on('takeInitData', function (data) {
					if (!data || data.error) {
						console.log('takeInitData receive error!', data.error);
						return;
					}

					//Обновляем настройки
					P.updateSettings(data.p);

					//Обновляем куки
					if (Utils.isType('object', data.cook)) {
						updateCookie(data.cook);
					}
				});

				function updateCookie(obj) {
					Utils.cookie.setItem(obj.key, obj.value, obj['max-age'], obj.path, obj.domain, null);
				}
			});
		}
	};
});