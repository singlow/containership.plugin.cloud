'use strict';

const constants = require('./constants');
const Firewall = require('./firewall');
const middleware = require('./middleware');

const _ = require('lodash');
const async = require('async');
const request = require('request');
const scheduler = require('node-schedule');

let cache = {};

module.exports = {

    initialize: function(core, config) {
        const firewall = new Firewall(core);
        firewall.enable();

        core.api.server.server.post('/:api_version/cluster/backup',
            middleware.version,
            core.api.server.middleware.get_handler('applications', 'get'),
            (req, res, next) => {
                const handler = req.handler;
                delete req.handler;

                handler.backup.volumes(core, req, res, next);
            },
            core.api.server.middleware.handle_response
        );

        function register_cluster(callback) {
            const attributes = core.cluster.legiond.get_attributes();

            // defaults provider to open_source
            let provider = 'open_source';

            // overrides provider if cloud-hints plugin detected a hosting provider
            if(attributes.tags && attributes.tags.cloud) {
                provider = attributes.tags.cloud.provider;
            }

            if(!core.cluster_id) {
                core.loggers['containership-cloud'].log('warn', 'Unable to register cluster with ContainerShip Cloud: core.cluster_id is undefined!');
                return callback();
            }

            const options = {
                url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/clusters/${core.cluster_id}`,
                method: 'POST',
                timeout: 10000,
                headers: {
                    Authorization: `Bearer ${config.api_key}`
                },
                json: {
                    provider: provider,
                    ipaddress: attributes.address.public,
                    port: core.options['api-port'],
                    api_version: core.api.server.api_version || 'v1'
                }
            };

            if(attributes.praetor.leader) {
                core.loggers['containership-cloud'].log('debug', 'Registering cluster with ContainerShip Cloud');
                request(options, (err, response) => {
                    if(err) {
                        core.loggers['containership-cloud'].log('warn', `Unable to register cluster with ContainerShip Cloud: ${err.message}`);
                    } else if(response.statusCode !== 201) {
                        core.loggers['containership-cloud'].log('warn', `Unable to register cluster with ContainerShip Cloud: API returned ${response.statusCode}.`);
                    }

                    return callback();
                });
            } else {
                return callback();
            }
        }

        function sync_cluster_details(callback) {
            const attributes = core.cluster.legiond.get_attributes();

            if(!core.cluster_id) {
                core.loggers['containership-cloud'].log('warn', 'Unable to sync cluster details from ContainerShip Cloud: core.cluster_id is undefined!');
                return callback();
            }

            if(attributes.praetor.leader) {
                const options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/clusters/${core.cluster_id}`,
                    method: 'GET',
                    timeout: 10000,
                    headers: {
                        Authorization: `Bearer ${config.api_key}`
                    },
                    json: true
                };

                request(options, (err, response) => {
                    if(err) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch cluster details from ContainerShip Cloud: ${err.message}`);
                        return callback();
                    } else if(response.statusCode !== 200) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch cluster details from ContainerShip Cloud: API returned ${response.statusCode}.`);
                        return callback();
                    } else {
                        async.parallel({
                            set_cluster_details: (callback) => {
                                const cluster_details = {
                                    environment: response.body.environment
                                };

                                if(!cache.cluster_details || !_.isEqual(cache.cluster_details, cluster_details)) {
                                    core.cluster.myriad.persistence.set(constants.myriad.CLUSTER_DETAILS, JSON.stringify(cluster_details), (err) => {
                                        if(err) {
                                            core.loggers['containership-cloud'].log('warn', `Error persisting cluster details to myriad-kv: ${err.message}`);
                                        } else {
                                            cache.cluster_details = cluster_details;
                                        }

                                        return callback();
                                    });
                                } else {
                                    return callback();
                                }
                            },

                            set_snapshotting_configuration: (callback) => {
                                const snapshotting_configuration = response.body.snapshotting_configuration;

                                if(!cache.snapshotting_configuration || !_.isEqual(cache.snapshotting_configuration, snapshotting_configuration)) {
                                    core.cluster.myriad.persistence.set(constants.myriad.SNAPSHOTTING_CONFIGURATION, JSON.stringify(snapshotting_configuration), (err) => {
                                        if(err) {
                                            core.loggers['containership-cloud'].log('warn', `Error persisting snapshotting configuration to myriad-kv: ${err.message}`);
                                        } else {
                                            cache.snapshotting_configuration = snapshotting_configuration;
                                            cluster_snapshot.setup(core, config);
                                        }

                                        return callback();
                                    });
                                } else {
                                    return callback();
                                }

                            }
                        }, callback);
                    }
                });
            } else {
                cluster_snapshot.cancel();
                return callback();
            }
        }

        function sync_firewalls(callback) {
            const attributes = core.cluster.legiond.get_attributes();

            if(!core.cluster_id) {
                core.loggers['containership-cloud'].log('warn', 'Unable to fetch firewalls from ContainerShip Cloud: core.cluster_id is undefined!');
                return callback();
            }

            if(attributes.praetor.leader) {
                const options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/clusters/${core.cluster_id}/firewalls`,
                    method: 'GET',
                    timeout: 10000,
                    headers: {
                        Authorization: `Bearer ${config.api_key}`
                    },
                    json: true
                };

                request(options, (err, response) => {
                    if(err) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch firewalls from ContainerShip Cloud: ${err.message}`);
                        return callback();
                    } else if(response.statusCode !== 200) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch firewalls from ContainerShip Cloud: API returned ${response.statusCode}.`);
                        return callback();
                    } else if(!cache.firewalls || !_.isEqual(cache.firewalls, response.body)) {
                        core.cluster.myriad.persistence.set(constants.myriad.FIREWALLS, JSON.stringify(response.body), (err) => {
                            if(err) {
                                core.loggers['containership-cloud'].log('warn', `Error persisting firewalls to myriad-kv: ${err.message}`);
                            } else {
                                cache.firewalls = response.body;
                            }

                            return callback();
                        });
                    } else {
                        return callback();
                    }
                });
            } else {
                return callback();
            }
        }

        function sync_loadbalancers(callback) {
            const attributes = core.cluster.legiond.get_attributes();

            if(!core.cluster_id) {
                core.loggers['containership-cloud'].log('warn', 'Unable to fetch loadbalancers from ContainerShip Cloud: core.cluster_id is undefined!');
                return callback();
            }

            if(attributes.praetor.leader) {
                const options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/clusters/${core.cluster_id}/loadbalancers`,
                    method: 'GET',
                    timeout: 10000,
                    headers: {
                        Authorization: `Bearer ${config.api_key}`
                    },
                    json: true
                };

                request(options, (err, response) => {
                    if(err) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch loadbalancers from ContainerShip Cloud: ${err.message}`);
                        return callback();
                    } else if(response.statusCode !== 200) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch loadbalancers from ContainerShip Cloud: API returned ${response.statusCode}.`);
                        return callback();
                    } else if(!cache.loadbalancers || !_.isEqual(cache.loadbalancers, response.body)) {
                        core.cluster.myriad.persistence.set(constants.myriad.LOADBALANCERS, JSON.stringify(response.body), (err) => {
                            if(err) {
                                core.loggers['containership-cloud'].log('warn', `Error persisting loadbalancers to myriad-kv: ${err.message}`);
                            } else {
                                cache.loadbalancers = response.body;
                            }

                            return callback();
                        });
                    } else {
                        return callback();
                    }
                });
            } else {
                return callback();
            }
        }

        function sync_registries(callback) {
            const attributes = core.cluster.legiond.get_attributes();

            if(attributes.praetor.leader) {
                const options = {
                    url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${config.organization}/registries`,
                    method: 'GET',
                    timeout: 10000,
                    headers: {
                        Authorization: `Bearer ${config.api_key}`
                    },
                    json: true
                };

                request(options, (err, response) => {
                    if(err) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch registries from ContainerShip Cloud: ${err.message}`);
                        return callback();
                    } else if(response.statusCode !== 200) {
                        core.loggers['containership-cloud'].log('warn', `Unable to fetch registries from ContainerShip Cloud: API returned ${response.statusCode}.`);
                        return callback();
                    } else if(!cache.registries || !_.isEqual(cache.registries, response.body)) {
                        core.cluster.myriad.persistence.set(constants.myriad.REGISTRIES, JSON.stringify(response.body), (err) => {
                            if(err) {
                                core.loggers['containership-cloud'].log('warn', `Error persisting registries to myriad-kv: ${err.message}`);
                            } else {
                                cache.registries = response.body;
                            }

                            return callback();
                        });
                    } else {
                        return callback();
                    }
                });
            } else {
                return callback();
            }
        }

        async.forever((callback) => {
            setTimeout(() => {
                async.parallel([
                    register_cluster,
                    sync_cluster_details,
                    sync_firewalls,
                    sync_loadbalancers,
                    sync_registries
                ], callback);
            }, 15000);
        });
    }

};


const cluster_snapshot = {

    job: null,

    setup: (core, config) => {
        cluster_snapshot.cancel();

        if(cache.snapshotting_configuration && cache.snapshotting_configuration.schedule) {
            const snapshot_options = {
                api_key: config.api_key,
                cluster_id: core.cluster_id,
                organization: config.organization,
                persist_data: cache.snapshotting_configuration && cache.snapshotting_configuration.persist_data ? cache.snapshotting_configuration : false
            };

            cluster_snapshot.job = scheduler.scheduleJob(cache.snapshotting_configuration.schedule, () => {
                cluster_snapshot.request(snapshot_options, (err, snapshot_details) => {
                    if(err) {
                        core.loggers['containership-cloud'].log('error', `Failed to create cluster snapshot: ${err.message}`);
                    } else {
                        core.loggers['containership-cloud'].log('verbose', `Successfully created cluster snapshot: ${snapshot_details.id} (${snapshot_details.notes})`);
                    }
                });
            });
        } else if(cache.snapshotting_configuration) {
            core.loggers['containership-cloud'].log('error', 'Invalid snapshotting configuration! Refusing to setup cluster snapshotting!');
        }
    },

    cancel: () => {
        if(cluster_snapshot.job) {
            cluster_snapshot.job.cancel();
        }
    },

    request: (snapshot_options, callback) => {
        const options = {
            url: `${constants.environment.CLOUD_API_BASE_URL}/v2/organizations/${snapshot_options.organization}/backups`,
            method: 'POST',
            timeout: 5000,
            headers: {
                Authorization: `Bearer ${snapshot_options.api_key}`
            },
            json: {
                cluster_id: snapshot_options.cluster_id,
                notes: `Scheduled ContainerShip Cloud Snapshot (${new Date().toISOString()})`,
                persist_data: snapshot_options.persist_data
            }
        };

        request(options, (err, response) => {
            if(err) {
                return callback(err);
            } else if(response && response.statusCode !== 201) {
                return callback(new Error(`Received ${response.statusCode} response from API!`));
            } else {
                return callback(null, response.body);
            }
        });

    }

};
