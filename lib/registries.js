'use strict';

const constants = require('./constants');

const _ = require('lodash');
const async = require('async');
const AWS = require('aws-sdk');
const fs = require('fs');
const url = require('url');

const DOCKER_CONFIG_DIR = '/root/.docker';
const DOCKER_AUTH_CONFIG_FILE = `${DOCKER_CONFIG_DIR}/config.json`;
const WRITE_INTERVAL = (1000 * 60 * 60); // one hour

class Registries {
    constructor(config, host) {
        this.config = config;
        this.host = host;

        const orchestrator = this.host.getOrchestrator();

        if(orchestrator === 'kubernetes') {
            this.write_registries_to_file();

            // forces registries to be rewritten every hour
            // to satisfy regsitry providers that expire credentials
            // such as AWS ECR: http://docs.aws.amazon.com/AmazonECR/latest/userguide/Registries.html
            this.sync_on_interval = setInterval(() => {
                this.write_registries_to_file();
            }, WRITE_INTERVAL);

            const subscriber = this.host.getApi().subscribeDistributedKey(constants.myriad.REGISTRIES);

            subscriber.on('message', () => {
                this.write_registries_to_file();
            });

            subscriber.on('error', (err) => {
                console.error(err);
            });
        } else if(orchestrator === 'containership') {
            this.host.core.scheduler.follower.container.add_pre_pull_middleware('docker', 'authentication', (options, callback) => {
                this.inject_registries(options, callback);
            });
        } else {
            console.error(`Invalid host orchestrator: ${orchestrator}. Refusing to operate on registries`);
        }
    }

    get_registry_configs(callback) {
        this.host.getApi().getDistributedKey(constants.myriad.REGISTRIES, (err, registries) => {
            if(err || !registries) {
                console.error('Error reading registries from distributed state');
                return callback(err);
            } else {
                registries.push({
                    username: this.config.core.organization,
                    password: this.config.core.api_key,
                    serveraddress: url.parse(constants.environment.CLOUD_REGISTRY_BASE_URL).host
                });

                async.map(registries, (registry, callback) => {
                    if(registry.provider === 'amazon_ec2_registry') {
                        const options = {
                            accessKeyId: registry.username,
                            secretAccessKey: registry.password,
                            region: registry.email || 'us-east-1'
                        };

                        const ecr = new AWS.ECR(options);

                        ecr.getAuthorizationToken((err, results) => {
                            if(err) {
                                return callback();
                            } else {
                                results = results.authorizationData[0];
                                const decrypted_token = Buffer.from(results.authorizationToken, 'base64').toString('ascii');
                                const username_password = decrypted_token.split(':');

                                return callback(null, {
                                    username: username_password[0],
                                    password: username_password[1],
                                    serveraddress: registry.serveraddress
                                });
                            }
                        });
                    } else {
                        return callback(null, registry);
                    }
                }, (err, registries) => {
                    if(err) {
                        return callback(err);
                    } else {
                        return callback(null, _.compact(registries));
                    }
                });
            }
        });
    }

    write_registries_to_file() {
        console.log('Writing registries to file');

        this.get_registry_configs((err, registry_configs) => {
            if(err) {
                console.error(`Could not write registries to file: ${err.message}`);
            } else {
                const docker_config = {
                    auths: {},
                    HttpHeaders: {
                        'User-Agent': 'containership.plugin.cloud'
                    }
                };

                _.forEach(_.keyBy(registry_configs, 'serveraddress'), (registry_config, server_address) => {
                    // handles legacy dockerhub registry provider integrations
                    if(registry_config.serveraddress === 'docker.io') {
                        server_address = `https://index.docker.io/v1/`;
                    } else {
                        server_address = `https://${server_address}`;
                    }

                    docker_config.auths[server_address] = {
                        auth: new Buffer(`${registry_config.username}:${registry_config.password}`).toString('base64')
                    };
                });

                fs.mkdir(DOCKER_CONFIG_DIR, (err) => {
                    if(err && err.code !== 'EEXIST') {
                        console.error(`Failed to create docker config directory (${DOCKER_CONFIG_DIR}): ${err.message}`);
                    } else {
                        // overwrite existing docker auth config file
                        fs.writeFile(DOCKER_AUTH_CONFIG_FILE, JSON.stringify(docker_config, null, 2), (err) => {
                            if(err) {
                                console.error(`Error writing docker auth config file: ${err.message}`);
                            }
                        });
                    }
                });
            }
        });
    }


    inject_registries(options, callback) {
        console.log('Injecting auth middleware');

        // clear registry auth array
        options.auth = [];

        this.get_registry_configs((err, registry_configs) => {
            if(err) {
                console.error(`Could not inject registries into middleware ${err.message}`);
                return callback();
            } else {
                // need to set an empty auth objct to pull public images
                if(registry_configs.length === 0) {
                    options.auth.push({});
                } else {
                    let registry_domain;

                    const image_parts = options.image.split('/');

                    if(image_parts.length === 2 && !image_parts[0].includes('.')) {
                        registry_domain = 'docker.io';
                    } else{
                        registry_domain = image_parts[0];
                    }

                    _.forEach(registry_configs, (registry_config) => {
                        // this checks to see if the server address begins with the registry domain of the image being pulled
                        // http/https in the serveraddress is optional, and it must match the entire serveraddress's domain
                        // although it can optionally continue with a path proceeded by a /
                        if(new RegExp(`^((https|http)://)?${registry_domain}($|/)`).test(registry_config.serveraddress)) {
                            options.auth.push({
                                authconfig: {
                                    email: registry_config.email,
                                    username: registry_config.username,
                                    password: registry_config.password,
                                    serveraddress: registry_config.serveraddress,
                                    auth: ''
                                }
                            });
                        }
                    });
                }

                return callback();
            }
        });
    }
}

module.exports = Registries;
