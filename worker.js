import ms from 'ms';
import moment from 'moment';
import log4js from 'log4js';
import config from './config';
import connectDb, { waitDb, dbRedis } from './controllers/connection';
import { archiveExpiredSessions } from './controllers/_session';
import { createQueue } from './controllers/queue';

const logger = log4js.getLogger('worker');

export async function configure(startStamp) {
    logger.info('Application Hash: ' + config.hash);

    await connectDb({
        redis: config.redis,
        mongo: { uri: config.mongo.connection, poolSize: config.mongo.pool },
        logger,
    });

    moment.locale(config.lang); // Set global language for momentjs

    logger.info(`Worker started up in ${(Date.now() - startStamp) / 1000}s`);

    waitDb.then(() => {
        sessionQueue();
    });
}

/**
 * Setup queue for session jobs.
 */
function sessionQueue() {
    createQueue('session').then((sessionQueue) => {
        sessionQueue.process('archiveExpiredSessions', function(job){
            return archiveExpiredSessions();
        });

        // Add archiveExpiredSessions periodic job.
        sessionQueue.add('archiveExpiredSessions', {}, {
            removeOnComplete: true,
            removeOnFail: true,
            repeat: { every: ms('5m') },
        });
    });
}

