'use strict';

const constants = require('./constants');
const Firewall = require('./firewall');
const SSH_Keys = require('./ssh_keys');

const { ContainershipPlugin, ApiBuilder } = require('@containership/containership.plugin');
const _ = require('lodash');
const request = require('request');
const tarfs = require('tar-fs');

class ContainershipCloudPlugin extends ContainershipPlugin {

    constructor() {
        super({
            name: 'cloud',
            description: 'A plugin to interface with Containership Cloud.',
            types: ['core']
        });

        this.cloudCache = {};
    }

    initializeRoutes(org, cluster) {
        this.routes = {
            cluster: {
                register: `/v2/organizations/${org}/clusters/${cluster}`,
                instances: `/v2/organizations/${org}/clusters/${cluster}/instances`,
                ips: `/v2/organizations/${org}/clusters/${cluster}/instances/ips`,
                details: `/v2/organizations/${org}/clusters/${cluster}`,
                firewalls: `/v2/organizations/${org}/clusters/${cluster}/firewalls`,
                loadbalancers: `/v2/organizations/${org}/clusters/${cluster}/loadbalancers`,
                registries: `/v2/organizations/${org}/clusters/${cluster}/registries`,
                ssh_keys: `/v2/organizations/${org}/clusters/${cluster}/ssh_keys`
            }
        }
    }

    apiRequest(verb, endpoint, data, cb) {
        const { api_key, organization } = this.config.core;
        const clusterId = this.host.getClusterId();

        if(api_key && organization) {
            const options = {
                baseUrl: constants.environment.CLOUD_API_BASE_URL,
                url: endpoint,
                method: verb,
                timeout: 15000,
                headers: {
                    Authorization: `Bearer ${api_key}`
                },
                body: data,
                json: true
            };

            const logError = (err) => {
                console.error('ERROR in cloud plugin: ' + verb + ' // ' + constants.environment.CLOUD_API_BASE_URL + ' / ' + endpoint + ' -> ' + JSON.stringify(err.message));
            };

            request(options, (err, response) => {
                if(err) {
                    logError(err);
                } else if(response.statusCode !== 200 && response.statusCode !== 201) {
                    logError(new Error(response.body));
                } else if(cb) {
                    return cb(response.body);
                }
            });

        } else {
            if(cb) {
                return cb(new Error(`Required paramaters not available fetching ${endpoint}`));
            } }
    }

    apiPost(route, body, cb) {
        this.apiRequest('POST', route, body, cb);
    }

    apiGet(route, cb) {
        this.apiRequest('GET', route, {}, cb);
    }

    registerCluster(cb) {
        const body = {
            ipaddress: this.host.getApiIP(),
            port: this.host.getApiPort(),
            api_version: this.host.getApiVersion()
        };

        this.apiPost(_.get(this.routes, ['cluster', 'register']), body, cb);
    }


    fetchCluster(cb) {
        this.apiGet(_.get(this.routes, ['cluster', 'instances']), cb);
    }

    fetchClusterIps(cb) {
        this.apiGet(_.get(this.routes, ['cluster', 'ips']), cb);
    }

    fetchClusterDetails(cb) {
        this.apiGet(_.get(this.routes, ['cluster', 'details']), cb);
    }

    fetchLoadBalancers(cb) {
        this.apiGet(_.get(this.routes, ['cluster', 'loadbalancers']), cb);
    }

    fetchRegistries(cb) {
        this.apiGet(_.get(this.routes, ['cluster', 'registries']), cb);
    }

    fetchSSHKeys(cb) {
        this.apiGet(_.get(this.routes, ['cluster', 'ssh_keys']), cb);
    }

    isCached(k, v) {
        return _.isEqual(this.cloudCache[k], v);
    }

    setDistributedValueAndCache(k, v) {
        this.host.getApi().setDistributedKey(k, v, (err) => {
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
            const autoTerminationConfiguration = _.pick(resp, 'auto_termination_configuration');

            this.setDistributedValueIfNeeded(constants.myriad.CLUSTER_DETAILS, clusterDetails);
            this.setDistributedValueIfNeeded(constants.myriad.SNAPSHOTTING_CONFIGURATION, snapshottingConfiguration);
            this.setDistributedValueIfNeeded(constants.myriad.AUTO_TERMINATION_CONFIGURATION, autoTerminationConfiguration);

        });
    }

    syncLoadBalancers() {
        this.fetchLoadBalancers((resp) => {
            this.setDistributedValueIfNeeded(constants.myriad.LOADBALANCERS, resp);
        });
    }

    syncRegistries() {
        this.fetchRegistries((resp) => {
            this.setDistributedValueIfNeeded(constants.myriad.REGISTRIES, resp);
        });
    }

    syncSSHKeys() {
        this.fetchSSHKeys((resp) => {
            this.setDistributedValueIfNeeded(constants.myriad.SSH_KEYS, resp);
        });
    }

    start(host) {
        this.host = host;

        super.start(host);

        const { organization } = this.config.core;
        const clusterId = this.host.getClusterId();

        this.initializeRoutes(organization, clusterId);

        /*
        const firewall = new Firewall(host);
        firewall.enable();
        */

        // enable SSH key management
        new SSH_Keys(host);

        this.fetchClusterIps((cidr) => {
            this.host.getApi().discoverPeers(cidr);
        });
    }

    startLeader(host) {
        super.startLeader(host);

        try {
            setInterval(() => {
                this.registerCluster();
                this.syncClusterDetails();
                this.syncLoadBalancers();
                this.syncRegistries();
                this.syncSSHKeys();
            }, ContainershipCloudPlugin.SYNC_INTERVAL);
        } catch(err) {
            console.error('Failed with err: ' + err);
        }
    }

    startFollower(host) {
        super.startFollower(host);
    }

    backupRequestLeader(host, req, res) {
        const api = host.getApi();
        api.getApplications((apps) => {
            api.getHosts((hosts) => {

                const hostsContainerWithIP = _.map(hosts, (h) => {
                    return _.set(h, 'containers',
                        _.map(h.containers, (c) => {
                            return _.set(c, 'hostIP', _.get(h, ['address', 'private']));
                        }));
                });

                //Find the host containers that belong to an application.
                const getContainersFn = _.flow(
                    _.values,
                    _.partial(_.map, _, (h) => {
                        return h.containers;
                    }),
                    _.flattenDeep
                );

                const hostContainers = getContainersFn(hostsContainerWithIP);
                const appContainers = getContainersFn(apps);

                const managedContainers = _.filter(hostContainers, (hc) => {
                    return _.some(appContainers, (ac) => {
                        return hc.id === ac.id;
                    });
                });

                _.forEach(managedContainers, (mc) => {
                    _.forEach(mc.volumes, (v) => {
                        request({
                            url: `http://${mc.hostIP}:9443/v1/cloud/cluster/backup`,
                            json: true,
                            method: 'POST',
                            body: {
                                path: v.host,
                                container_id: mc.id,
                                backup_id: req.query.CSC_BACKUP_ID,
                                volume_id: _.last(_.split(v.host, '/'))
                            }
                        }, (hostErr, hostRes, body) => {
                        });
                    });
                });

                res.json(apps);
            });
        });
    }

    backupRequestFollower(host, req, res) {
        const { api_key, organization } = this.config.core;

        const options = {
            url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${organization}/backups/${req.body.backup_id}/containers/${req.body.container_id}/volumes/${req.body.volume_id}`,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${api_key}`
            }
        };

        tarfs.pack(req.body.path).pipe(request(options));
    }

    getApiRoutes(host) {
        super.getApiRoutes(host);

        const api = host.getApi();

        return new ApiBuilder()
            .get('/cluster/backup', (req, res) => {
                if(host.isLeader()) {
                    this.backupRequestLeader(host, req, res);
                } else {
                    this.backupRequestFollower(host, req, res);
                }

            }).post('/cluster/backup', (req, res) => {
                if(host.isLeader()) {
                    this.backupRequestLeader(host, req, res);
                } else {
                    this.backupRequestFollower(host, req, res);
                }
            }).value();
    }
}

ContainershipCloudPlugin.SYNC_INTERVAL = 15000;

module.exports = ContainershipCloudPlugin;
