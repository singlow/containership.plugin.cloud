'use strict';

const constants = require('@containership/containership.cloud.constants');

constants.environment.AUTH_API_BASE_URL = process.env.CS_AUTH_API_BASE_URL || constants.environment.DEFAULT_AUTH_API_BASE_URL;
constants.environment.BUILD_API_BASE_URL = process.env.CS_BUILD_API_BASE_URL || constants.environment.DEFAULT_BUILD_API_BASE_URL;
constants.environment.CLOUD_API_BASE_URL = process.env.CS_CLOUD_API_BASE_URL || constants.environment.DEFAULT_CLOUD_API_BASE_URL;
constants.environment.CLOUD_REGISTRY_BASE_URL = process.env.CS_CLOUD_REGISTRY_BASE_URL || constants.environment.DEFAULT_CLOUD_REGISTRY_BASE_URL;

module.exports = constants;
