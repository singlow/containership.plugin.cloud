const _ = require('lodash');
const request = require('request');
const { ContainershipPlugin } = require('containership.plugin.v2');
const constants = require('./constants');

class ContainershipCloudPlugin extends ContainershipPlugin {


    constructor() {
        super({
            name: 'cloud',
            description: 'A plugin to interface with Containership Cloud.',
            types: ['core', 'cli']
        });

        this.cloudCache = {};

    }

    apiRequest(verb, endpoint, data, cb) {
        const { api_key, organization } = this.config.core;
        const clusterId = this.host.getClusterId();

        if(api_key && organization) {
            const options = {
                baseUrl: constants.environment.CLOUD_API_BASE_URL,
                url: _.isFunction(endpoint) ? endpoint(organization, clusterId) : endpoint,
                method: verb,
                timeout: 15000,
                headers: {
                    Authorization: `Bearer ${api_key}`
                },
                body: data,
                json: true
            };

            const logError = (err) => {
                console.log("ERROR in cloud plugin: " + verb + " // " + constants.environment.CLOUD_API_BASE_URL + " / " + endpoint(organization, clusterId) + " -> " + JSON.stringify(err.message));
            };

            request(options, (err, response) => {
                if(err) {
                    console.log("Straight err: " + err);
                    logError(err);
                } else if(response.statusCode !== 200 && response.statusCode !== 201) {
                    console.log("Strange response code: " + response.statusCode);
                    logError(new Error(response.body));
                } else {
                    if(cb) cb(response.body);
                }
            });

        } else {
            if(cb) cb(new Error(`Required paramaters not available fetching ${endpoint}`));
        }
    }

    registerCluster(cb) {
        const body = {
            ipaddress: this.host.getApiIP(),
            port: this.host.getApiPort(),
            api_version: this.host.getApiVersion()
        };

        this.apiRequest('POST', (org, cluster) => `/v2/organizations/${org}/clusters/${cluster}`, body, cb);
    }


    fetchCluster(cb) {
        this.apiRequest('GET', (org, cluster) => `/v2/organizations/${org}/clusters/${cluster}/instances/ips`, {}, cb);
    }

    fetchClusterDetails(cb) {
        this.apiRequest('GET', (org, cluster) => `/v2/organizations/${org}/clusters/${cluster}`, {}, cb);
    }

    fetchLoadBalancers(cb) {
        this.apiRequest('GET', (org, cluster) => `/v2/organizations/${org}/clusters/${cluster}/loadbalancers`, {}, cb);
    }

    fetchRegistries(cb) {
        this.apiRequest('GET', (org, cluster) => `/v2/organizations/${org}/clusters/${cluster}/registries`, {}, cb);
    }

    isCached(k, v) {
        return _.isEqual(this.cloudCache[k], v);
    }

    setDistributedValueAndCache(k, v) {
        host.getApi().setDistributedKey(k, v, (cb) => {
            if(!err) {
                this.cloudCache[k] = v;
            }
        });
    }

    setDistributedValueIfNeeded(k, v) {
        if(!this.isCached(k, v)) {
            this.setDistributedValueAndCache(k,v);
        }
    }

    syncClusterDetails() {
        this.fetchClusterDetails((resp) => {
            const clusterDetails = _.pick(resp, 'environment');
            const snapshottingConfiguration = _.pick(resp, 'snapshotting_configuration');

            this.setDistributedValueIfNeeded(constants.myriad.CLUSTER_DETAILS, clusterDetails);
            this.setDistributedValueIfNeeded(constants.myriad.SNAPSHOTTING_CONFIGURATION, clusterDetails);

        });
    }

    syncLoadBalancers() {
        this.fetchLoadBalancers((resp) => {
            this.setDistributedValueIfNeeded(constants.myriad.LOADBALANCERS, resp);
        });
    }

    syncRegistries() {
        const attrs = core.cluster.legiond.get_attributes();

        this.fetchRegistries((resp) => {
            this.setDistributedValueIfNeeded(constants.myriad.REGISTRIES, resp);
        });

    }

    start(host) {
        this.host = host;

        super.start(host);

        this.fetchCluster((cidr) => {
            this.host.getApi().discoverPeers(cidr);
        });

    }

    startLeader(host) {
        super.startLeader(host);

        this.registerCluster((resp) => {
            console.log("BACK FROM REGISTER CLUSTER: " + ":" + JSON.stringify(resp));
        });

        setTimeout(() => {
            this.registerCluster();
            //this.syncClusterDetails();
            //this.syncLoadBalancers();
            //this.syncRegistries();
        }, ContainershipCloudPlugin.SYNC_INTERVAL);
    }

    startFollower(host) {
        super.startFollower(host);
    }
}

ContainershipCloudPlugin.SYNC_INTERVAL =  15000;

module.exports = ContainershipCloudPlugin;
