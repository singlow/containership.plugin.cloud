'use strict';

const crypto = require('crypto');

module.exports = {
    md5:(message) => {
        return crypto.createHash('md5').update(message).digest('hex');
    }
};
