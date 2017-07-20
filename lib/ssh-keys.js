'use strict';

const logger = require('./logger');
const constants = require('./constants');

const _ = require('lodash');
const fs = require('fs');

const PLUGINS_DIR = '/opt/containership/plugins';
const SSH_PATH = `${PLUGINS_DIR}/cloud`;

class SSH_Keys {
    constructor(host) {
        this.host = host;

        this.write_keys();

        const subscriber = this.host.getApi().subscribeDistributedKey(constants.myriad.SSH_KEYS);

        subscriber.on('message', () => {
            this.write_keys();
        });

        subscriber.on('error', (err) => {
            logger.error(err);
        });
    }

    get_keys(callback) {
        this.host.getApi().getDistributedKey(constants.myriad.SSH_KEYS, callback);
    }

    write_keys() {
        logger.info('Updating SSH keys');

        this.host.getApi().getDistributedKey(constants.myriad.SSH_KEYS, (err, keys) => {
            if(err) {
                logger.error(`Error fetching containership cloud ssh keys: ${err.message}`);
            } else {
                try {
                    if(!fs.existsSync(PLUGINS_DIR)) {
                        fs.mkdirSync(PLUGINS_DIR);
                    }

                    if(!fs.existsSync(SSH_PATH)) {
                        fs.mkdirSync(SSH_PATH);
                    }

                    let keyFile = '';

                    _.forEach(keys, (key) => {
                        keyFile += `# ${key.user_id} ${key.name}\n${key.key}\n\n`;
                    });

                    fs.writeFile(`${SSH_PATH}/authorized_keys`, keyFile, (err) => {
                        if(err) {
                            logger.error(`Unable to write ssh keys: ${err.message}`);
                        } else {
                            logger.info('Successfully wrote authorized keys file!');
                        }
                    });
                } catch (err) {
                    logger.error(JSON.stringify(err));
                }
            }
        });
    }
}

module.exports = SSH_Keys;
