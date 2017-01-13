'use strict';

const MyriadKVClient = require('myriad-kv-client');

class MyriadClient {

    constructor(core) {
        const attributes = core.cluster.legiond.get_attributes();

        this.client = new MyriadKVClient({
            host: attributes.address[core.options['legiond-scope']],
            port: 2666
        });

        this.core = core;
    }


    get_containership_version() {
        const attributes = this.core.cluster.legiond.get_attributes();
        return attributes && attributes.metadata && attributes.metadata.containership && attributes.metadata.containership.version;
    }

    subscribe(pattern) {
        if(this.client.subscribe) {
            return this.client.subscribe(pattern);
        }
    }

}

module.exports = MyriadClient;
