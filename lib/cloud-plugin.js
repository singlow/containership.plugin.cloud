const _ = require('lodash');
const request = require('request');
const tarfs = require('tar-fs');

const { ContainershipPlugin, ApiBuilder } = require('containership.plugin.v2');
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

        console.log("Registering cluster: " + JSON.stringify(body));

        this.apiRequest('POST', (org, cluster) => `/v2/organizations/${org}/clusters/${cluster}`, body, cb);
    }


    fetchCluster(cb) {
        this.apiRequest('GET', (org, cluster) => `/v2/organizations/${org}/clusters/${cluster}/instances`, {}, cb);
    }

    fetchClusterIps(cb) {
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
        this.host.getApi().setDistributedKey(k, v, (err) => {
            console.log("Setting distributed key [" + k + "," + v + "] with err: " + JSON.stringify(err));
            if(!err) {
                this.cloudCache[k] = v;
            }
        });
    }

    setDistributedValueIfNeeded(k, v) {
        console.log("Checking cache for: " + k + " and value " + v);
        if(!this.isCached(k, v)) {
            console.log("SETTING!");
            this.setDistributedValueAndCache(k,v);
        }
    }

    syncClusterDetails() {
        this.fetchClusterDetails((resp) => {
            const clusterDetails = _.pick(resp, 'environment');
            const snapshottingConfiguration = _.pick(resp, 'snapshotting_configuration');

            console.log("Sync Cluster Details: " + JSON.stringify(resp));
            console.log("\n---------------\nSNAPSHOT CONFIG: \n" + JSON.stringify(snapshottingConfiguration));

            this.setDistributedValueIfNeeded(constants.myriad.CLUSTER_DETAILS, clusterDetails);
            this.setDistributedValueIfNeeded(constants.myriad.SNAPSHOTTING_CONFIGURATION, snapshottingConfiguration);

        });
    }

    syncLoadBalancers() {
        this.fetchLoadBalancers((resp) => {
            console.log("Sync Load Balancers: " + JSON.stringify(resp));
            this.setDistributedValueIfNeeded(constants.myriad.LOADBALANCERS, resp);
        });
    }

    syncRegistries() {
        const attrs = core.cluster.legiond.get_attributes();

        this.fetchRegistries((resp) => {
            console.log("Sync Registries: " + JSON.stringify(resp));
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

        setInterval(() => {
            this.registerCluster();
            this.syncClusterDetails();
            this.syncLoadBalancers();
            //this.syncRegistries();
        }, ContainershipCloudPlugin.SYNC_INTERVAL);
    }

    startFollower(host) {
        super.startFollower(host);
    }

    backupRequestLeader(host, req, res) {
        const api = host.getApi();
        api.getApplications((apps) => {
            api.getHosts((hosts) => {

                const hostsContainerWithIP = _.map(hosts, (h) => {
                    return _.set(h, "containers",
                        _.map(h.containers, (c) => {
                            return _.set(c, "hostIP", _.get(h, ["address", "private"]));
                        }));
                });

                //Find the host containers that belong to an pplication.
                const getContainersFn = _.flow(
                    _.partial(_.values, _),
                    _.partial(_.map, _, (h) => {
                        return h.containers;
                    }),
                    _.partial(_.flattenDeep, _)
                );

                const hostContainers = getContainersFn(hostsContainerWithIP);
                const appContainers = getContainersFn(apps);

                const managedContainers = _.filter(hostContainers, (hc) => {
                    return _.some(appContainers, (ac) => {
                        return hc.id === ac.id;
                    });
                });

                _.each(managedContainers, (mc) => {
                    _.each(mc.volumes, (v) => {
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

                res.sendStatus(200);

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

        console.log("Backup with: " + JSON.stringify(options));

        tarfs.pack(req.body.path).pipe(request(options));

    }

    getApiRoutes(host) {
        const api = host.getApi();

        return new ApiBuilder()
            .get("/cluster/backup", (req, res) => {

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

ContainershipCloudPlugin.SYNC_INTERVAL =  15000;

module.exports = ContainershipCloudPlugin;
