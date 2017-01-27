'use strict';

const constants = require('./constants');
const MyriadClient = require('./myriad');

const _ = require('lodash');
const async = require('async');
const semver = require('semver');
const Tesserarius = require('tesserarius');

class Firewall {

    constructor(core) {
        this.core = core;

        // ensure we get the physical network interface if legiond-interface is set to a virtual interface
        const legiond_interface = this.core.options['legiond-interface'].split(':')[0];

        this.options = {
            chain: 'ContainerShip',
            initial_rules: [
                {
                    policy: 'ACCEPT',
                    interface: 'lo'
                },
                {
                    policy: 'ACCEPT',
                    state: ['ESTABLISHED', 'RELATED']
                },
                {
                    interface: legiond_interface,
                    policy: 'ACCEPT',
                    protocol: 'tcp',
                    destination_port: 2666
                },
                {
                    interface: legiond_interface,
                    policy: 'ACCEPT',
                    protocol: 'tcp',
                    destination_port: 2777
                },
                {
                    interface: legiond_interface,
                    policy: 'ACCEPT',
                    protocol: 'tcp',
                    destination_port: this.core.options['api-port'],
                    mode: 'leader'
                }
            ]
        };

        this.tesserarius = new Tesserarius();
        this.myriad_client = new MyriadClient(this.core);
    }

    enable() {
        const containership_version = this.myriad_client.get_containership_version();
        if(containership_version && semver.gte(containership_version, '1.8.0-0')) {
            this.reset_rules((err) => {
                if(err) {
                    this.core.loggers['containership-cloud'].log('error', 'Unable to reset firewall rules!');
                    this.core.loggers['containership-cloud'].log('debug', err.message);
                } else {
                    this.set_rules();
                }
            });

            const subscriber = this.myriad_client.subscribe(constants.myriad.FIREWALLS_REGEX);

            subscriber.on('message', (message) => {
                if(message.type === 'data') {
                    this.set_rules();
                }
            });

            this.core.cluster.legiond.on('node_added', () => {
                this.set_rules();
            });
            this.core.cluster.legiond.on('node_removed', () => {
                this.set_rules();
            });
        } else {
            this.core.loggers['containership-cloud'].log('error', 'Plugin requires vesrion 1.8.0 of containership or greater! Refusing to enable the firewall!');
        }
    }

    set_rules() {
        this.core.loggers['containership-cloud'].log('verbose', 'Updating firewall rules');

        this.get_cloud_rules((err, cloud_rules) => {
            if(err) {
                this.core.loggers['containership-cloud'].log('error', `Error fetching containership cloud firewall rules: ${err.message}`);
            }

            const rules = _.union(this.get_initial_rules(), this.get_host_rules(), cloud_rules);

            this.tesserarius.set_rules(this.options.chain, rules, (err) => {
                if(err) {
                    this.core.loggers['containership-cloud'].log('error', 'Unable to apply new firewall rules!');
                    this.core.loggers['containership-cloud'].log('debug', err.message);
                } else {
                    this.core.loggers['containership-cloud'].log('verbose', 'Sucessfully applied new firewall rules!');
                }
            });
        });
    }

    get_initial_rules() {
        const rules = [];

        _.forEach(this.options.initial_rules, (rule) => {
            if(rule.mode && this.core.options.mode === rule.mode || !rule.mode) {
                rules.push(_.omit(rule, 'mode'));
            }
        });

        return rules;
    }

    get_host_rules() {
        const rules = [];
        const peers = this.core.cluster.legiond.get_peers();

        _.forEach(peers, (peer) => {
            if(this.core.options.mode === 'leader') {
                _.forEach(_.keys(peer.address), (scope) => {
                    rules.push({
                        policy: 'ACCEPT',
                        protocol: 'tcp',
                        destination_port: this.core.options['api-port'],
                        source: peer.address[scope]
                    });
                });
            } else {
                _.forEach(_.keys(peer.address), (scope) => {
                    rules.push({
                        policy: 'ACCEPT',
                        protocol: 'tcp',
                        destination_port: `${this.core.scheduler.options.loadbalancer.min_port}:${this.core.scheduler.options.loadbalancer.max_port}`,
                        source: peer.address[scope]
                    });

                    rules.push({
                        policy: 'ACCEPT',
                        protocol: 'tcp',
                        destination_port: `${this.core.scheduler.options.container.min_port}:${this.core.scheduler.options.container.max_port}`,
                        source: peer.address[scope]
                    });
                });
            }
        });

        return rules;
    }

    get_cloud_rules(callback) {
        this.core.cluster.myriad.persistence.get(constants.myriad.FIREWALLS, (err, firewalls) => {
            if(err) {
                return callback(err, []);
            } else {
                try {
                    firewalls = JSON.parse(firewalls);

                    firewalls = _.map(firewalls, (rule) => {
                        const new_rule = {
                            destination_port: rule.port,
                            policy: 'ACCEPT',
                            protocol: rule.protocol
                        };

                        if(rule.source !== '0.0.0.0/0') {
                            new_rule.source = rule.source;
                        }

                        return new_rule;
                    });

                    return callback(null, firewalls);
                } catch(err) {
                    return callback(err, []);
                }
            }
        });
    }

    reset_rules(callback) {
        async.series([
            (callback) => {
                // flush ContainerShip chain
                this.tesserarius.flush(this.options.chain, (err) => {
                    if(err) {
                        this.tesserarius.create_chain(this.options.chain, callback);
                    } else {
                        return callback();
                    }
                });
            },
            (callback) => {
                // flush INPUT chain
                this.tesserarius.flush('INPUT', callback);
            },
            (callback) => {
                // set default policy on INPUT chain to 'DROP'
                this.tesserarius.set_policy('INPUT', 'DROP', callback);
            },
            (callback) => {
                // add ContainerShip chain to INPUT chain
                this.tesserarius.set_rules('INPUT', [
                    {
                        policy: this.options.chain
                    }
                ], callback);
            }
        ], callback);
    }

}

module.exports = Firewall;
